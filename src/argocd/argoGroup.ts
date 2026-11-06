import { ARGO_ENVS, envOf } from "./argoEnv";
import {
  ARGO_ENV_TEXT, ARGO_GROUP_CLUSTER, ARGO_GROUP_ENV, ARGO_GROUP_NAMESPACE, ARGO_GROUP_NONE, ARGO_GROUP_PROJECT, ARGO_GROUP_SET, ARGO_IN_CLUSTER, ARGO_NO_CLUSTER,
  ARGO_NO_LABEL, ARGO_NO_NAMESPACE, ARGO_NO_PROJECT, ARGO_UNGROUPED, argoGroupLabel,
} from "./text";
import type { ArgoAppRow, ArgoAppSetRow } from "./types";

/** 눈여겨볼 앱: 어긋났거나, 건강하지 않거나, 오류 조건이 있거나, 마지막 작업이 실패 */
export const isProblem = (r: ArgoAppRow): boolean =>
  r.values.sync === "OutOfSync" ||
  r.values.health !== "Healthy" ||
  Number(r.values.errors ?? 0) > 0 ||
  r.values.operation === "Failed" ||
  r.values.operation === "Error";

export type ArgoLevel = "err" | "warn" | "ok";

/**
 * 앱 하나의 심각도. 오류(빨강): 오류 조건, Degraded·Missing, 작업 Failed·Error.
 * 주의(노랑): 그 밖의 문제(OutOfSync, Progressing·Unknown 등). 나머지는 정상.
 */
export function levelOf(r: ArgoAppRow): ArgoLevel {
  const v = r.values;
  if (Number(v.errors ?? 0) > 0 || v.health === "Degraded" || v.health === "Missing" || v.operation === "Failed" || v.operation === "Error") return "err";
  return isProblem(r) ? "warn" : "ok";
}

const LEVEL_RANK: Record<ArgoLevel, number> = { err: 0, warn: 1, ok: 2 };

export const bySeverityThenName = (a: ArgoAppRow, b: ArgoAppRow) =>
  LEVEL_RANK[levelOf(a)] - LEVEL_RANK[levelOf(b)] || a.name.localeCompare(b.name) || a.namespace.localeCompare(b.namespace);

/** 묶음의 앱을 한 칸씩 센다: 오류 > OutOfSync > 그 밖의 주의 > 정상 */
export interface Tally {
  err: number;
  outOfSync: number;
  caution: number;
  ok: number;
}

export function tally(apps: ArgoAppRow[]): Tally {
  const t: Tally = { err: 0, outOfSync: 0, caution: 0, ok: 0 };
  for (const r of apps) {
    const level = levelOf(r);
    if (level === "err") t.err++;
    else if (level === "ok") t.ok++;
    else if (r.values.sync === "OutOfSync") t.outOfSync++;
    else t.caution++;
  }
  return t;
}

/** 묶음 색: ApplicationSet 자체가 Error이거나 오류 앱이 있으면 빨강, 주의 앱이 있으면 노랑 */
export const groupLevel = (set: ArgoAppSetRow | null, t: Tally): ArgoLevel => (set?.status === "Error" || t.err > 0 ? "err" : t.outOfSync + t.caution > 0 ? "warn" : "ok");

export const rowKey = (namespace: string, name: string) => `${namespace}/${name}`;

export const IN_CLUSTER = ["https://kubernetes.default.svc", "in-cluster"];
/** 같은 클러스터를 가리키는 두 표기(이름·서버 주소)를 하나로 */
export const IN_CLUSTER_KEY = "in-cluster";

/** 대상 클러스터. 이 ArgoCD가 있는 클러스터(in-cluster)는 어떻게 적었든 IN_CLUSTER_KEY. 없으면 "" */
export const clusterOf = (r: ArgoAppRow): string => {
  const d = r.values.destination ?? "";
  return IN_CLUSTER.includes(d) ? IN_CLUSTER_KEY : d;
};
export const clusterText = (cluster: string) => (cluster === IN_CLUSTER_KEY ? ARGO_IN_CLUSTER : cluster);
export const projectOf = (r: ArgoAppRow): string => r.values.project ?? "";
export const namespaceOf = (r: ArgoAppRow): string => r.values.destNamespace ?? "";

/** 묶는 기준. label:<키>는 그 레이블의 값으로 묶는다 */
export type GroupDim = "none" | "set" | "env" | "cluster" | "project" | "namespace" | `label:${string}`;

const LABEL_PREFIX = "label:";
export const labelDim = (key: string): GroupDim => `${LABEL_PREFIX}${key}`;
export const labelKey = (dim: GroupDim): string | null => (dim.startsWith(LABEL_PREFIX) ? dim.slice(LABEL_PREFIX.length) : null);

const PLAIN_DIMS: readonly string[] = ["none", "set", "env", "cluster", "project", "namespace"];
/** 설정에 남긴 글을 기준으로 되읽는다. 모르는 글(손으로 고친 설정 등)이면 null */
export const parseDim = (text: string | null | undefined): GroupDim | null => {
  if (!text) return null;
  if (PLAIN_DIMS.includes(text)) return text as GroupDim;
  return text.startsWith(LABEL_PREFIX) && text.length > LABEL_PREFIX.length ? (text as GroupDim) : null;
};

/** 데이터에 있는 레이블 키(이름 순) */
export const labelKeys = (rows: ArgoAppRow[]): string[] => [...new Set(rows.flatMap((r) => Object.keys(r.labels)))].sort((a, b) => a.localeCompare(b));

/** 기준의 이름(선택 목록에 보이는 글) */
export function dimText(dim: GroupDim): string {
  const key = labelKey(dim);
  if (key !== null) return argoGroupLabel(key);
  const texts: Record<string, string> = {
    none: ARGO_GROUP_NONE,
    set: ARGO_GROUP_SET,
    env: ARGO_GROUP_ENV,
    cluster: ARGO_GROUP_CLUSTER,
    project: ARGO_GROUP_PROJECT,
    namespace: ARGO_GROUP_NAMESPACE,
  };
  return texts[dim];
}

/** 기준 값이 없는 앱을 모아 둔 묶음의 이름 */
function noneText(dim: GroupDim): string {
  if (labelKey(dim) !== null) return ARGO_NO_LABEL;
  const texts: Record<string, string> = { set: ARGO_UNGROUPED, cluster: ARGO_NO_CLUSTER, project: ARGO_NO_PROJECT, namespace: ARGO_NO_NAMESPACE };
  return texts[dim];
}

/** 앱이 속할 묶음의 키와 이름. 기준 값이 없으면 null(맨 뒤의 "없음" 묶음) */
function bucketOf(dim: GroupDim, r: ArgoAppRow): { key: string; name: string } | null {
  const named = (v: string, name = v) => (v === "" ? null : { key: v, name });
  const key = labelKey(dim);
  if (key !== null) return named(r.labels[key] ?? "");
  switch (dim) {
    case "set": {
      const owner = r.values.appSet;
      return owner ? { key: rowKey(r.namespace, owner), name: owner } : null;
    }
    case "env": {
      const { env } = envOf(r);
      return { key: env, name: ARGO_ENV_TEXT[env] };
    }
    case "cluster":
      return named(clusterOf(r), clusterText(clusterOf(r)));
    case "project":
      return named(projectOf(r));
    case "namespace":
      return named(namespaceOf(r));
    default:
      return null;
  }
}

/** 묶음 하나. 접힘 기억에 쓰는 id는 같은 기준 안에서만 유일하다 */
export interface Group {
  id: string;
  /** null이면 기준 값이 없는 앱들 */
  key: string | null;
  name: string;
  set: ArgoAppSetRow | null;
  apps: ArgoAppRow[];
}

/**
 * rows를 dim으로 묶는다. 순서는 어느 기준이든 빨강(오류) → 노랑(주의) → 정상이 먼저다(사용자 결정 2026-11-02: 정상보다 문제 묶음이 밑에 오면 안 된다).
 * 같은 색 안에서는 값이 없는 묶음("없음")이 맨 뒤, 그 밖은 환경이면 정해진 순서, 나머지는 이름 순.
 * ApplicationSet 기준일 때만 sets의 것도 만들고(앱이 없는 것 포함), 조건을 걸었을 때(filtering)는 앱이 하나도 안 남은 ApplicationSet을 감춘다.
 */
export function buildGroups(dim: Exclude<GroupDim, "none">, rows: ArgoAppRow[], sets: ArgoAppSetRow[], filtering: boolean): Group[] {
  const byKey = new Map<string, Group>();
  if (dim === "set") for (const s of sets) byKey.set(rowKey(s.namespace, s.name), { id: rowKey(s.namespace, s.name), key: rowKey(s.namespace, s.name), name: s.name, set: s, apps: [] });
  const none: Group = { id: "", key: null, name: noneText(dim), set: null, apps: [] };
  for (const r of rows) {
    const b = bucketOf(dim, r);
    if (!b) {
      none.apps.push(r);
      continue;
    }
    // 목록에 없는 ApplicationSet(권한이 없거나 이미 지워진 것)도 이름만 달고 묶는다
    const g = byKey.get(b.key) ?? { id: b.key, key: b.key, name: b.name, set: null, apps: [] };
    g.apps.push(r);
    byKey.set(b.key, g);
  }
  const groups = [...byKey.values()].filter((g) => g.apps.length > 0 || !filtering);
  if (none.apps.length > 0) groups.push(none);
  const rank = (g: Group) => LEVEL_RANK[groupLevel(g.set, tally(g.apps))];
  const envRank = (g: Group) => ARGO_ENVS.indexOf(g.key as (typeof ARGO_ENVS)[number]);
  const sameTier = (a: Group, b: Group) => (dim === "env" ? envRank(a) - envRank(b) : a.name.localeCompare(b.name));
  return groups.sort((a, b) => rank(a) - rank(b) || Number(a.key === null) - Number(b.key === null) || sameTier(a, b));
}
