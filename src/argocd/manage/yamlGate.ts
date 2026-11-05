import { parse } from "yaml";
import { yamlProblems } from "../../k8s/yamlDocs";
import { MANAGE_YAML_EMPTY, MANAGE_YAML_NOT_MAP, MANAGE_YAML_ONE_DOC, manageYamlLine } from "./text";
import type { Obj } from "./specForm";

export interface YamlGate {
  /** 미리 볼 수 있는가 */
  ok: boolean;
  /** 막는 이유(첫 줄만) */
  reason: string | null;
  value: Obj | null;
}

/**
 * 편집한 YAML을 미리 보기에 넘겨도 되는지. 구문 오류가 하나라도 있거나, 문서가 하나가 아니거나,
 * 비었거나, 키·값 묶음이 아니면 막는다(편집기 밑줄과 같은 구문 검사를 쓴다).
 */
export function gateYaml(text: string): YamlGate {
  const [first] = yamlProblems(text);
  if (first) return { ok: false, reason: manageYamlLine(first.line, first.message), value: null };
  if (text.trim() === "") return { ok: false, reason: MANAGE_YAML_EMPTY, value: null };
  let value: unknown;
  try {
    value = parse(text);
  } catch {
    return { ok: false, reason: MANAGE_YAML_ONE_DOC, value: null };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, reason: MANAGE_YAML_NOT_MAP, value: null };
  return { ok: true, reason: null, value: value as Obj };
}
