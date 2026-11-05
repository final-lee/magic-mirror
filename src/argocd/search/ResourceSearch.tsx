import { useDeferredValue, useMemo, useState } from "react";
import { ErrorState } from "../../components/ErrorState";
import { Highlight } from "../../components/Highlight";
import { tokenize } from "../../lib/fuzzy";
import { ArgoChips } from "../ArgoChips";
import { clusterText } from "../argoGroup";
import { ArgoMultiSelect } from "../ArgoMultiSelect";
import { ArgoBadge } from "../argoParts";
import { ARGO_HEALTH_GROUP, ARGO_HEALTH_STATUSES, ARGO_SYNC_GROUP, ARGO_SYNC_STATUSES, LOADING } from "../text";
import type { ArgoResourceFocus } from "../types";
import {
  type AppRef, type FilterKey, type IndexEntry, type SearchFilters, NO_FILTERS, NO_NAMESPACE, countBy, filterEntries, filtersActive, focusOf, healthOf, namespaceValue, searchEntries, syncOf,
} from "./argoIndex";
import {
  H_SEARCH_APP, H_SEARCH_CLUSTER, H_SEARCH_KIND, H_SEARCH_NAME, H_SEARCH_NAMESPACE, SEARCH_CLEAR, SEARCH_CLUSTER_FILTER, SEARCH_CLUSTER_SCOPED, SEARCH_DUPLICATE_CHIP, SEARCH_DUPLICATE_FILTER,
  SEARCH_DUPLICATE_TITLE, SEARCH_EMPTY, SEARCH_FROM_TREE, SEARCH_FROM_TREE_BADGE, SEARCH_KIND_FILTER, SEARCH_LABEL, SEARCH_NAMESPACE_FILTER, SEARCH_NO_MATCH, SEARCH_PLACEHOLDER, SEARCH_RESULTS_LABEL,
  searchApps, searchLimited, searchMoreApps, searchOpenApp, searchSummary,
} from "./text";
import { useArgoIndex } from "./useArgoIndex";

/** 한 번에 그리는 결과 수. 잘 맞는 것부터 자른다 */
export const RESULT_LIMIT = 500;
/** 앱 칸에 이름을 늘어놓는 수. 나머지는 +N으로 */
const APPS_SHOWN = 3;

interface Props {
  /** ArgoCD 서버 주소 */
  url: string;
  live: boolean;
  /** 결과의 앱이나 행을 눌렀을 때: 그 앱의 상세를 그 리소스를 고른 채로 연다 */
  onOpen: (app: AppRef, resource: ArgoResourceFocus) => void;
}

const toggled = <T,>(set: ReadonlySet<T>, v: T): Set<T> => {
  const next = new Set(set);
  if (!next.delete(v)) next.add(v);
  return next;
};

const byText = (a: { text: string }, b: { text: string }) => a.text.localeCompare(b.text);

/** 서버 하나의 모든 리소스를 한 곳에서 찾는 화면: 앱 목록의 리소스 요약과 열어 본 앱의 트리를 색인해 퍼지로 찾고 거른다 */
export function ResourceSearch({ url, live, onOpen }: Props) {
  const { apps, entries } = useArgoIndex(url, live);
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const [filters, setFilters] = useState<SearchFilters>(NO_FILTERS);
  const set = (key: Exclude<FilterKey, "duplicatesOnly">, value: string) => setFilters((f) => ({ ...f, [key]: toggled(f[key], value) }));
  const clear = (key: Exclude<FilterKey, "duplicatesOnly">) => setFilters((f) => ({ ...f, [key]: new Set<string>() }));

  const tokens = useMemo(() => tokenize(deferred), [deferred]);
  const searched = useMemo(() => searchEntries(entries, deferred), [entries, deferred]);
  const visible = useMemo(() => filterEntries(searched, filters), [searched, filters]);

  // 선택지 옆의 개수는 그 종류의 선택만 뺀 나머지 조건에 맞는 항목 기준이라, 고르는 중에도 자기 숫자는 변하지 않는다
  const facets = useMemo(() => {
    const kinds = countBy(filterEntries(searched, filters, ["kinds"]), (e) => e.kind);
    const namespaces = countBy(filterEntries(searched, filters, ["namespaces"]), namespaceValue);
    const clusters = countBy(filterEntries(searched, filters, ["clusters"]), (e) => e.cluster);
    const status = filterEntries(searched, filters, ["health", "sync"]);
    return {
      kinds: [...new Set(entries.map((e) => e.kind))].map((value) => ({ value, text: value, count: kinds.get(value) ?? 0 })).sort(byText),
      namespaces: [...new Set(entries.map(namespaceValue))]
        .map((value) => ({ value, text: value === NO_NAMESPACE ? SEARCH_CLUSTER_SCOPED : value, count: namespaces.get(value) ?? 0 }))
        .sort(byText),
      clusters: [...new Set(entries.map((e) => e.cluster))].map((value) => ({ value, text: clusterText(value), count: clusters.get(value) ?? 0 })).sort(byText),
      health: Object.fromEntries(countBy(status, healthOf)),
      sync: Object.fromEntries(countBy(status, syncOf)),
      duplicates: filterEntries(searched, filters, ["duplicatesOnly"]).filter((e) => e.duplicate).length,
    };
  }, [entries, searched, filters]);

  const shown = visible.slice(0, RESULT_LIMIT);
  const open = (e: IndexEntry, app: AppRef) => onOpen(app, focusOf(e));

  let body;
  if (apps.isPending) body = <div className="empty">{LOADING}</div>;
  else if (entries.length === 0) body = !apps.isError && <div className="empty">{SEARCH_EMPTY}</div>;
  else if (visible.length === 0) body = <div className="empty">{SEARCH_NO_MATCH}</div>;
  else {
    body = (
      <table className="k8s-table argo-table" aria-label={SEARCH_RESULTS_LABEL}>
        <thead>
          <tr>
            <th>{H_SEARCH_KIND}</th>
            <th>{H_SEARCH_NAME}</th>
            <th>{H_SEARCH_NAMESPACE}</th>
            <th>{H_SEARCH_CLUSTER}</th>
            <th>Sync</th>
            <th>Health</th>
            <th>{H_SEARCH_APP}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((e) => {
            const first = e.refs[0].app;
            return (
              <tr
                key={e.id}
                className="argo-row"
                tabIndex={0}
                onClick={() => open(e, first)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" && ev.target === ev.currentTarget) open(e, first);
                }}
              >
                <td className="mono">
                  <Highlight text={e.kind} tokens={tokens} />
                </td>
                <td className="mono k8s-wrap">
                  <Highlight text={e.name} tokens={tokens} />
                  {e.duplicate && (
                    <span className="k8s-chip argo-chip argo-chip-warn" title={SEARCH_DUPLICATE_TITLE}>
                      {SEARCH_DUPLICATE_CHIP}
                    </span>
                  )}
                  {!e.managed && (
                    <span className="k8s-chip argo-chip" title={SEARCH_FROM_TREE}>
                      {SEARCH_FROM_TREE_BADGE}
                    </span>
                  )}
                </td>
                <td className="mono">{e.namespace ? <Highlight text={e.namespace} tokens={tokens} /> : ""}</td>
                <td className="mono">{clusterText(e.cluster)}</td>
                <td>
                  <ArgoBadge status={e.sync} />
                </td>
                <td>
                  <ArgoBadge status={e.health} />
                </td>
                <td className="k8s-wrap" title={e.duplicate ? searchApps(e.refs.length) : undefined}>
                  {e.refs.slice(0, APPS_SHOWN).map((r) => (
                    <button
                      key={`${r.app.namespace}/${r.app.name}`}
                      className="btn small tone-secondary argo-app-link"
                      aria-label={searchOpenApp(r.app.name)}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        open(e, r.app);
                      }}
                    >
                      <Highlight text={r.app.name} tokens={tokens} />
                    </button>
                  ))}
                  {e.refs.length > APPS_SHOWN && <span className="dim">{searchMoreApps(e.refs.length - APPS_SHOWN)}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }

  return (
    <div className="argo">
      {apps.isError && <ErrorState error={apps.error} profile="" compact onRetry={() => void apps.refetch()} />}
      <div className="argo-bar">
        <input type="search" className="k8s-filter" aria-label={SEARCH_LABEL} placeholder={SEARCH_PLACEHOLDER} autoComplete="off" spellCheck={false} value={query} onChange={(e) => setQuery(e.target.value)} />
        <ArgoChips
          label={ARGO_SYNC_GROUP}
          statuses={ARGO_SYNC_STATUSES}
          counts={facets.sync}
          picked={filters.sync}
          onToggle={(s) => set("sync", s)}
          dot={(s) => `argo-lvl-${s}`}
        />
        <ArgoChips
          label={ARGO_HEALTH_GROUP}
          statuses={ARGO_HEALTH_STATUSES}
          counts={facets.health}
          picked={filters.health}
          onToggle={(s) => set("health", s)}
          dot={(s) => `argo-lvl-${s}`}
        />
        <ArgoMultiSelect label={SEARCH_KIND_FILTER} options={facets.kinds} picked={filters.kinds} onToggle={(v) => set("kinds", v)} onClear={() => clear("kinds")} />
        <ArgoMultiSelect label={SEARCH_NAMESPACE_FILTER} options={facets.namespaces} picked={filters.namespaces} onToggle={(v) => set("namespaces", v)} onClear={() => clear("namespaces")} />
        <ArgoMultiSelect label={SEARCH_CLUSTER_FILTER} options={facets.clusters} picked={filters.clusters} onToggle={(v) => set("clusters", v)} onClear={() => clear("clusters")} />
        <div className="k8s-levels" role="group" aria-label={SEARCH_DUPLICATE_FILTER}>
          <button
            className="k8s-lvl argo-lvl argo-lvl-OutOfSync"
            aria-pressed={filters.duplicatesOnly}
            title={SEARCH_DUPLICATE_TITLE}
            onClick={() => setFilters((f) => ({ ...f, duplicatesOnly: !f.duplicatesOnly }))}
          >
            {SEARCH_DUPLICATE_FILTER} <span className="k8s-lvl-n">{facets.duplicates.toLocaleString("ko-KR")}</span>
          </button>
        </div>
        {filtersActive(filters) && (
          <button className="btn small tone-secondary" onClick={() => setFilters(NO_FILTERS)}>
            {SEARCH_CLEAR}
          </button>
        )}
        {entries.length > 0 && <span className="dim k8s-push">{searchSummary(visible.length, entries.length)}</span>}
      </div>
      <div className="argo-scroll">
        {body}
        {visible.length > RESULT_LIMIT && <p className="dim argo-limit">{searchLimited(RESULT_LIMIT)}</p>}
      </div>
    </div>
  );
}
