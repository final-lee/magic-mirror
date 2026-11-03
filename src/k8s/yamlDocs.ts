import { parseAllDocuments } from "yaml";
import { BUILTIN } from "./kinds";
import * as t from "./text";
import type { K8sChange, K8sKindRef } from "./types";

/** Secret 값을 가린 표시. 백엔드(read/secret.rs)와 같다 */
export const MASK = "••••";
/** 한 번에 만들 수 있는 문서 수(백엔드 미리보기 보관 한도와 같다) */
export const MAX_DOCUMENTS = 50;

export interface YamlProblem {
  /** 글 안의 위치(글자 번호) */
  from: number;
  to: number;
  line: number;
  column: number;
  message: string;
}

export type YamlObject = Record<string, unknown>;

export interface YamlDocument {
  /** 붙여 넣은 글에서 몇 번째 문서인지(1부터, 빈 문서도 센다) */
  index: number;
  object: YamlObject | null;
  /** 이 문서를 객체로 읽지 못한 이유 */
  error: string | null;
}

/** 구문 오류. 편집기의 밑줄과 목록이 같은 것을 쓴다. */
export function yamlProblems(text: string): YamlProblem[] {
  const problems: YamlProblem[] = [];
  for (const doc of parseAllDocuments(text)) {
    for (const error of doc.errors) {
      const [from, to] = error.pos;
      const position = error.linePos?.[0];
      problems.push({ from, to, line: position?.line ?? 1, column: position?.col ?? 1, message: error.message.split("\n")[0] });
    }
  }
  return problems;
}

/** 문서를 나눠 객체로 읽는다. 구문 오류가 있는 문서와 객체가 아닌 문서는 error에 이유를 담는다. 아무것도 없는 문서는 건너뛴다. */
export function parseDocuments(text: string): YamlDocument[] {
  const out: YamlDocument[] = [];
  parseAllDocuments(text).forEach((doc, i) => {
    const index = i + 1;
    if (doc.errors.length > 0) {
      out.push({ index, object: null, error: t.YAML_SYNTAX_ERROR });
      return;
    }
    const value: unknown = doc.toJS();
    if (value === null || value === undefined) return;
    if (typeof value !== "object" || Array.isArray(value)) {
      out.push({ index, object: null, error: t.YAML_NOT_OBJECT });
      return;
    }
    out.push({ index, object: value as YamlObject, error: null });
  });
  return out;
}

const textOf = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** apiVersion을 그룹과 버전으로 가른다. 핵심 그룹은 "v1"뿐이다. */
function splitApiVersion(apiVersion: string): { group: string; version: string } {
  const slash = apiVersion.indexOf("/");
  return slash < 0 ? { group: "", version: apiVersion } : { group: apiVersion.slice(0, slash), version: apiVersion.slice(slash + 1) };
}

export type Resolved = { change: K8sChange; error: null } | { change: null; error: string };

/**
 * 문서 하나를 적용 변경으로 바꾼다. 종류는 이 클러스터가 내주는 종류에서 apiVersion·kind로 찾고,
 * 네임스페이스가 없는 문서는 고른 네임스페이스로 보낸다(모든 네임스페이스를 골랐으면 오류).
 */
export function resolveChange(object: YamlObject, kinds: K8sKindRef[], selectedNamespace: string | null): Resolved {
  const apiVersion = textOf(object.apiVersion);
  const kindName = textOf(object.kind);
  const metadata = object.metadata;
  const meta = typeof metadata === "object" && metadata !== null && !Array.isArray(metadata) ? (metadata as YamlObject) : {};
  const name = textOf(meta.name);
  if (!apiVersion || !kindName) return { change: null, error: t.YAML_NO_KIND };
  if (!name) return { change: null, error: t.YAML_NO_NAME };
  const { group, version } = splitApiVersion(apiVersion);
  const kind = [...kinds, ...BUILTIN].find((k) => k.group === group && k.version === version && k.kind === kindName);
  if (!kind) return { change: null, error: t.yamlKindUnknown(apiVersion, kindName) };
  const given = textOf(meta.namespace);
  if (!kind.namespaced) {
    return given ? { change: null, error: t.yamlNotNamespaced(kindName) } : { change: { kind, namespace: null, name, type: "apply", object, force: false }, error: null };
  }
  const namespace = given ?? selectedNamespace;
  if (!namespace) return { change: null, error: t.YAML_NO_NAMESPACE };
  return { change: { kind, namespace, name, type: "apply", object, force: false }, error: null };
}
