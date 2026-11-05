import { fuzzyRank, tokenize } from "../../lib/fuzzy";
import { clusterOf, rowKey } from "../argoGroup";
import { ARGO_HEALTH_STATUSES, ARGO_SYNC_STATUSES } from "../text";
import type { ArgoAppRow, ArgoResourceFocus, ArgoTreeNode } from "../types";

export interface AppRef {
  namespace: string;
  name: string;
}

/** 리소스 하나에 대한 앱 하나의 시각. managed는 앱의 status.resources에 있다는 뜻(트리에서만 보이면 false) */
export interface IndexRef {
  app: AppRef;
  sync: string | null;
  health: string | null;
  managed: boolean;
  hook: boolean;
  requiresPruning: boolean;
}

export interface IndexEntry {
  /** 클러스터·group·kind·namespace·name으로 정한 식별자 */
  id: string;
  /** 배포 대상 클러스터(in-cluster는 IN_CLUSTER_KEY). 모르면 "" */
  cluster: string;
  group: string;
  kind: string;
  namespace: string | null;
  name: string;
  /** 이 리소스를 보는 앱들. 관리하는 앱(managed)이 앞에 온다 */
  refs: IndexRef[];
  /** 앱의 status.resources에서 온 리소스인가(아니면 열어 본 트리에서만 찾은 하위 리소스) */
  managed: boolean;
  sync: string | null;
  health: string | null;
  /** hook이 아닌 리소스를 둘 이상의 앱이 관리한다 */
  duplicate: boolean;
}

/** 이미 읽어 둔 리소스 트리 하나와 그 앱 */
export interface TreeInput {
  app: AppRef;
  nodes: ArgoTreeNode[];
}

const sep = "\u0000";
export const entryId = (cluster: string, group: string, kind: string, namespace: string | null, name: string) => [cluster, group, kind, namespace ?? "", name].join(sep);

/** 앱 목록 행의 status.resources 요약과 열어 본 트리의 노드를 하나의 색인으로 모은다. 같은 리소스는 앱이 달라도 한 항목이고 refs에 앱이 쌓인다. */
export function buildIndex(apps: readonly ArgoAppRow[], trees: readonly TreeInput[]): IndexEntry[] {
  const byId = new Map<string, IndexEntry>();
  const clusterByApp = new Map(apps.map((a) => [rowKey(a.namespace, a.name), clusterOf(a)]));

  const entryFor = (cluster: string, group: string, kind: string, namespace: string | null, name: string, managed: boolean): IndexEntry => {
    const id = entryId(cluster, group, kind, namespace, name);
    let entry = byId.get(id);
    if (!entry) {
      entry = { id, cluster, group, kind, namespace: namespace || null, name, refs: [], managed, sync: null, health: null, duplicate: false };
      byId.set(id, entry);
    }
    return entry;
  };

  for (const app of apps) {
    const ref: AppRef = { namespace: app.namespace, name: app.name };
    const cluster = clusterOf(app);
    for (const r of app.resources ?? []) {
      const entry = entryFor(cluster, r.group, r.kind, r.namespace ?? null, r.name, true);
      entry.managed = true;
      entry.refs.push({ app: ref, sync: r.status ?? null, health: r.health ?? null, managed: true, hook: r.hook ?? false, requiresPruning: r.requiresPruning ?? false });
    }
  }

  for (const tree of trees) {
    const cluster = clusterByApp.get(rowKey(tree.app.namespace, tree.app.name));
    // 앱 목록에서 사라진 앱의 트리는 쓰지 않는다
    if (cluster === undefined) continue;
    for (const node of tree.nodes) {
      const entry = entryFor(cluster, node.group, node.kind, node.namespace, node.name, false);
      const own = entry.refs.find((r) => r.app.namespace === tree.app.namespace && r.app.name === tree.app.name);
      if (own) own.health ??= node.health;
      else entry.refs.push({ app: tree.app, sync: null, health: node.health, managed: false, hook: false, requiresPruning: false });
    }
  }

  const entries = [...byId.values()];
  for (const e of entries) {
    e.refs.sort((a, b) => Number(b.managed) - Number(a.managed));
    e.sync = e.refs.find((r) => r.sync !== null)?.sync ?? null;
    e.health = e.refs.find((r) => r.health !== null)?.health ?? null;
    e.duplicate = e.refs.filter((r) => r.managed && !r.hook).length > 1;
  }
  return entries;
}

/** 알려진 상태가 아니거나 없으면 Unknown 칸으로 센다(앱 목록과 같은 규칙) */
const bucket = (value: string | null, list: readonly string[]) => (value && list.includes(value) ? value : "Unknown");
export const syncOf = (e: IndexEntry) => bucket(e.sync, ARGO_SYNC_STATUSES);
export const healthOf = (e: IndexEntry) => bucket(e.health, ARGO_HEALTH_STATUSES);

/** 고른 값들(비면 거르지 않는다). 종류마다 OR, 종류끼리 AND */
export interface SearchFilters {
  kinds: Set<string>;
  namespaces: Set<string>;
  clusters: Set<string>;
  health: Set<string>;
  sync: Set<string>;
  duplicatesOnly: boolean;
}

export const NO_FILTERS: SearchFilters = { kinds: new Set(), namespaces: new Set(), clusters: new Set(), health: new Set(), sync: new Set(), duplicatesOnly: false };

export type FilterKey = keyof SearchFilters;

/** 클러스터 범위 리소스(네임스페이스 없음)를 고르는 값 */
export const NO_NAMESPACE = "";
export const namespaceValue = (e: IndexEntry) => e.namespace ?? NO_NAMESPACE;

const tests: { [K in FilterKey]: (e: IndexEntry, f: SearchFilters) => boolean } = {
  kinds: (e, f) => f.kinds.size === 0 || f.kinds.has(e.kind),
  namespaces: (e, f) => f.namespaces.size === 0 || f.namespaces.has(namespaceValue(e)),
  clusters: (e, f) => f.clusters.size === 0 || f.clusters.has(e.cluster),
  health: (e, f) => f.health.size === 0 || f.health.has(healthOf(e)),
  sync: (e, f) => f.sync.size === 0 || f.sync.has(syncOf(e)),
  duplicatesOnly: (e, f) => !f.duplicatesOnly || e.duplicate,
};

/** skip에 든 조건은 무시하고 거른다(선택지 옆 개수를 그 종류만 빼고 세려고) */
export function filterEntries(entries: readonly IndexEntry[], filters: SearchFilters, skip: readonly FilterKey[] = []): IndexEntry[] {
  const keys = (Object.keys(tests) as FilterKey[]).filter((k) => !skip.includes(k));
  return entries.filter((e) => keys.every((k) => tests[k](e, filters)));
}

export const filtersActive = (f: SearchFilters) => f.kinds.size + f.namespaces.size + f.clusters.size + f.health.size + f.sync.size > 0 || f.duplicatesOnly;

/** 검색 글자 칸: 이름이 가장 중요하고 그다음 종류·네임스페이스·앱 이름 */
export const searchFields = (e: IndexEntry) => [e.name, e.kind, e.namespace, ...e.refs.map((r) => r.app.name)];

const byKindNamespaceName = (a: IndexEntry, b: IndexEntry) => a.kind.localeCompare(b.kind) || (a.namespace ?? "").localeCompare(b.namespace ?? "") || a.name.localeCompare(b.name);

/** 검색어가 있으면 잘 맞는 순, 없으면 종류·네임스페이스·이름 순 */
export function searchEntries(entries: readonly IndexEntry[], query: string): IndexEntry[] {
  if (tokenize(query).length === 0) return [...entries].sort(byKindNamespaceName);
  return fuzzyRank(entries, query, searchFields).map((r) => r.item);
}

/** 값별 개수(고른 조건 밖의 항목은 세지 않는다). 값은 많은 순이 아니라 이름 순으로 돌려준다 */
export function countBy(entries: readonly IndexEntry[], of: (e: IndexEntry) => string): Map<string, number> {
  const n = new Map<string, number>();
  for (const e of entries) n.set(of(e), (n.get(of(e)) ?? 0) + 1);
  return n;
}

export const focusOf = (e: IndexEntry): ArgoResourceFocus => ({ group: e.group, kind: e.kind, namespace: e.namespace, name: e.name });
