import { fuzzyRank, tokenize } from "../../lib/fuzzy";
import { BUILTIN, bookmarkKey } from "../kinds";
import type { K8sKind, K8sKindRef } from "../types";

/**
 * 종류 별칭. API 서버가 알려 주는 짧은 이름(shortNames)과 단수 이름이 먼저고, 서버가 주지 않는 k9s의 별칭만 여기서 더한다.
 * 종류 목록을 아직 못 읽었을 때(발견 실패)는 내장 종류를 이 표의 별칭으로 연다.
 * 키는 `그룹/복수형`.
 */
const EXTRA: Record<string, string[]> = {
  "/pods": ["po"],
  "/services": ["svc"],
  "/nodes": ["no"],
  "/namespaces": ["ns"],
  "/configmaps": ["cm"],
  "/secrets": ["sec"],
  "/serviceaccounts": ["sa"],
  "/persistentvolumes": ["pv"],
  "/persistentvolumeclaims": ["pvc"],
  "/endpoints": ["ep"],
  "/resourcequotas": ["quota"],
  "/limitranges": ["limits"],
  "apps/deployments": ["deploy", "dp"],
  "apps/statefulsets": ["sts"],
  "apps/daemonsets": ["ds"],
  "apps/replicasets": ["rs"],
  "batch/jobs": ["job"],
  "batch/cronjobs": ["cj"],
  "autoscaling/horizontalpodautoscalers": ["hpa"],
  "policy/poddisruptionbudgets": ["pdb"],
  "networking.k8s.io/ingresses": ["ing"],
  "networking.k8s.io/networkpolicies": ["np", "netpol"],
  "storage.k8s.io/storageclasses": ["sc"],
  "rbac.authorization.k8s.io/roles": ["ro"],
  "rbac.authorization.k8s.io/rolebindings": ["rb"],
  "rbac.authorization.k8s.io/clusterroles": ["cr"],
  "rbac.authorization.k8s.io/clusterrolebindings": ["crb"],
  "apiextensions.k8s.io/customresourcedefinitions": ["crd", "crds"],
  "scheduling.k8s.io/priorityclasses": ["pc"],
};

export interface KindEntry {
  kind: K8sKindRef;
  /** 소문자로 비교하는 이름들. 첫째가 화면에 보이는 대표 이름(복수형) */
  names: string[];
}

/** 이 종류를 가리킬 수 있는 이름: 복수형, 단수형, Kind 소문자, 짧은 이름들, 그룹까지 쓴 이름(복수형.그룹, 단수형.그룹) */
export function namesOf(kind: K8sKindRef & Partial<Pick<K8sKind, "shortNames" | "singularName">>): string[] {
  const names = new Set<string>();
  const add = (n: string | undefined) => {
    if (n) names.add(n.toLowerCase());
  };
  add(kind.plural);
  add(kind.singularName);
  add(kind.kind);
  for (const s of kind.shortNames ?? []) add(s);
  for (const s of EXTRA[bookmarkKey(kind)] ?? []) add(s);
  if (kind.group) {
    for (const n of [kind.plural, kind.singularName, kind.kind]) add(n && `${n}.${kind.group}`);
    add(`${kind.plural}.${kind.version}.${kind.group}`);
  }
  return [...names];
}

/** 이동할 수 있는 종류들. 발견한 종류가 없으면 내장 종류 */
export function kindEntries(kinds: K8sKind[]): KindEntry[] {
  const source: (K8sKindRef & Partial<K8sKind>)[] = kinds.length > 0 ? kinds : BUILTIN;
  return source.map((kind) => ({ kind: { group: kind.group, version: kind.version, kind: kind.kind, plural: kind.plural, namespaced: kind.namespaced }, names: namesOf(kind) }));
}

/** 같은 별칭이 여러 종류에 있을 때의 우선순위: 코어 그룹 > 내장 그룹 > 사용자 정의 */
function tier(entry: KindEntry, custom: Set<string>): number {
  if (entry.kind.group === "") return 0;
  return custom.has(bookmarkKey(entry.kind)) ? 2 : 1;
}

export type Resolved =
  | { ok: true; kind: K8sKindRef }
  | { ok: false; reason: "unknown" | "ambiguous"; options: K8sKindRef[] };

/**
 * `:` 뒤에 적은 이름을 종류로 바꾼다. 복수형, 단수형, Kind(소문자), 짧은 이름, 그룹을 붙인 이름(`deployments.apps`)을 모두 받는다.
 * 대소문자는 가리지 않는다. 가장 높은 우선순위에서 둘 이상이 맞으면(서로 다른 사용자 정의 그룹) ambiguous.
 */
export function resolveKind(input: string, kinds: K8sKind[]): Resolved {
  const name = input.trim().toLowerCase();
  if (!name) return { ok: false, reason: "unknown", options: [] };
  const custom = new Set(kinds.filter((k) => k.custom).map(bookmarkKey));
  const hits = kindEntries(kinds).filter((e) => e.names.includes(name));
  if (hits.length === 0) return { ok: false, reason: "unknown", options: [] };
  const best = Math.min(...hits.map((h) => tier(h, custom)));
  const top = hits.filter((h) => tier(h, custom) === best);
  if (top.length > 1) return { ok: false, reason: "ambiguous", options: top.map((h) => h.kind) };
  return { ok: true, kind: top[0].kind };
}

/** 편집 거리(삽입·삭제·교체). 오타를 가까운 이름으로 잇는 데만 쓴다 */
export function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

/** 이름 후보 하나: 어느 종류의 어떤 이름이 맞았나 */
export interface NameHit {
  kind: K8sKindRef;
  /** 입력칸에 채울 이름 */
  name: string;
  /** 그 종류의 대표 이름 외 다른 이름들(힌트로 보인다) */
  others: string[];
  /** 퍼지 점수(높을수록 잘 맞음). 검색어가 비면 0 */
  score: number;
}

/** 점수순 종류 후보. 종류마다 가장 잘 맞은 이름 하나. 검색어가 비면 앞에서부터 */
export function suggestKinds(query: string, kinds: K8sKind[], limit = 8): NameHit[] {
  const entries = kindEntries(kinds);
  const tokens = tokenize(query);
  const hit = (e: KindEntry, name: string, score: number): NameHit => ({ kind: e.kind, name, others: e.names.filter((n) => n !== name && !n.includes(".")).slice(0, 4), score });
  if (tokens.length === 0) return entries.slice(0, limit).map((e) => hit(e, e.names[0], 0));
  // 그룹을 붙인 이름(deployments.apps)은 점이 든 검색어일 때만 후보로 한다
  const qualified = query.includes(".");
  const scored: { hit: NameHit; score: number }[] = [];
  for (const e of entries) {
    const ranked = fuzzyRank(e.names.filter((n) => qualified || !n.includes(".")), query, (n) => [n]);
    if (ranked.length > 0) scored.push({ hit: hit(e, ranked[0].item, ranked[0].score), score: ranked[0].score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.hit);
}

/** 알 수 없는 이름 옆에 보일 가까운 종류 이름들: 퍼지로 맞는 것, 없으면 편집 거리 2 이내 */
export function closestNames(input: string, kinds: K8sKind[], limit = 3): string[] {
  const query = input.trim().toLowerCase();
  const fuzzy = suggestKinds(query, kinds, limit).map((h) => h.name);
  if (fuzzy.length > 0) return fuzzy;
  const near: { name: string; distance: number }[] = [];
  for (const e of kindEntries(kinds)) {
    const best = e.names.map((name) => ({ name, distance: editDistance(query, name) })).sort((a, b) => a.distance - b.distance)[0];
    if (best && best.distance <= 2) near.push(best);
  }
  return near.sort((a, b) => a.distance - b.distance).slice(0, limit).map((n) => n.name);
}
