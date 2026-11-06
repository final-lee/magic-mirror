import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { formatBytes, formatCpu } from "../../k8s/format";
import { isHot, pct } from "../../k8s/usage";
import { rowKey } from "../argoGroup";
import { cachedTrees, useTreeVersion } from "../search/useArgoIndex";
import type { ArgoAppRow } from "../types";
import { podsOfTree, sumUsage, topUsage, type UsageRow, type UsageSum } from "./appUsage";
import { useAppTree, useAppUsage, useContextFor, useTreeLoader } from "./queries";
import { METRICS_TEXT as T } from "./text";
import type { PodReading, PodRef, UsageUnavailable } from "./types";

const TOP = 10;

const UNAVAILABLE: Record<UsageUnavailable, string> = { notInstalled: T.usageNotInstalled, forbidden: T.usageForbidden, notReady: T.usageNotReady };

/** 사용량을 요청(없으면 제한) 대비 막대로. 기준이 없으면 값만 */
function Meter({ used, request, limit, format }: { used: number | null; request: number | null; limit: number | null; format: (n: number) => string }) {
  if (used === null) return <span className="argo-metrics-note">{T.usagePending}</span>;
  const base = limit ?? request;
  const percent = pct(used, base);
  return (
    <div>
      <div>{format(used)}{percent !== null && <span className="argo-metrics-note"> · {T.usageBase(`${Math.round(percent)}%`, limit !== null ? T.usageLimit : T.usageRequest)}</span>}</div>
      {percent !== null && <div className="argo-metrics-bar-track"><div className={`argo-metrics-bar-fill${isHot(percent) ? " hot" : ""}`} style={{ width: `${Math.min(100, percent)}%` }} /></div>}
      <div className="argo-metrics-note">{T.usageRequest} {request === null ? T.usageNone : format(request)} · {T.usageLimit} {limit === null ? T.usageNone : format(limit)}</div>
    </div>
  );
}

function SumRow({ sum, label }: { sum: UsageSum; label: string }) {
  return (
    <tr className="total">
      <th>{label}<div className="argo-metrics-note">{T.usagePods(sum.reporting, sum.pods)}</div></th>
      <td><Meter used={sum.reporting ? sum.cpuMilli : null} request={sum.cpuRequest} limit={sum.cpuLimit} format={formatCpu} /></td>
      <td><Meter used={sum.reporting ? sum.memoryBytes : null} request={sum.memoryRequest} limit={sum.memoryLimit} format={formatBytes} /></td>
    </tr>
  );
}

function PodRows({ pods }: { pods: PodReading[] }) {
  return (
    <>
      {pods.map((p) => (
        <tr key={`${p.namespace}/${p.name}`}>
          <th className="mono">{p.name}</th>
          <td><Meter used={p.cpuMilli} request={p.bounds.cpuRequest} limit={p.bounds.cpuLimit} format={formatCpu} /></td>
          <td><Meter used={p.memoryBytes} request={p.bounds.memoryRequest} limit={p.bounds.memoryLimit} format={formatBytes} /></td>
        </tr>
      ))}
    </>
  );
}

/** 앱 하나의 Pod 사용량: 리소스 트리의 Pod를 대상 클러스터의 metrics-server 값과 Pod 스펙의 요청·제한에 견준다 */
function AppUsage({ url, row, live }: { url: string; row: ArgoAppRow; live: boolean }) {
  const { resolve, contexts, loading } = useContextFor(url);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const tree = useAppTree(url, row, live);
  const pods: PodRef[] = useMemo(() => podsOfTree(tree.data ?? []), [tree.data]);
  const match = resolve(row);
  const key = rowKey(row.namespace, row.name);
  const context = match?.status === "found" ? match.context.name : match?.status === "ambiguous" ? picked[key] ?? null : null;
  const usage = useAppUsage(url, context, pods, live);
  const readings = usage.data?.pods ?? [];
  return (
    <div className="argo-metrics-scroll" style={{ padding: 0 }}>
      <div className="argo-metrics-bar">
        {match?.status === "found" && <span>{T.usageContext}: <b className="mono">{match.context.name}</b></span>}
        {match?.status === "ambiguous" && (
          <label className="k8s-field">{T.usageContext}
            <select value={picked[key] ?? ""} onChange={(e) => setPicked({ ...picked, [key]: e.target.value })}>
              <option value="">{T.usageContextPick}</option>
              {match.candidates.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
          </label>
        )}
        {match?.status === "none" && <span className="err">{T.usageContextWhy(match.reason)}</span>}
        {match === null && <span className="argo-metrics-note">{loading ? T.loading : contexts.length === 0 ? T.usageContextPick : ""}</span>}
        <span className="argo-metrics-note">{T.usageRefresh}</span>
      </div>
      {tree.isPending && <div className="argo-metrics-note">{T.usageTreeLoading}</div>}
      {tree.isSuccess && pods.length === 0 && <div className="argo-metrics-note">{T.usageNoPods}</div>}
      {tree.isError && <div className="err">{String((tree.error as { message?: string })?.message ?? tree.error)}</div>}
      {usage.isError && <div className="err">{String((usage.error as { message?: string })?.message ?? usage.error)}</div>}
      {usage.data?.unavailable && <div className="err">{UNAVAILABLE[usage.data.unavailable]}</div>}
      {context !== null && pods.length > 0 && !usage.data?.unavailable && usage.data && (
        <table className="argo-metrics-table">
          <thead><tr><th>{T.usagePod}</th><th>{T.usageCpu}</th><th>{T.usageMemory}</th></tr></thead>
          <tbody>
            <SumRow sum={sumUsage(readings)} label={T.usageTotal} />
            <PodRows pods={readings} />
          </tbody>
        </table>
      )}
    </div>
  );
}

/** 한 context에 속한 앱들(트리를 읽은 것)의 사용량을 한 번에 읽어 큰 순서로 */
function ContextTop({ url, context, apps, by, live, onOpen }: { url: string; context: string; apps: { row: ArgoAppRow; pods: PodRef[] }[]; by: "cpuMilli" | "memoryBytes"; live: boolean; onOpen: (row: ArgoAppRow) => void }) {
  const pods = useMemo(() => apps.flatMap((a) => a.pods), [apps]);
  const usage = useAppUsage(url, context, pods, live);
  const rows: UsageRow[] = useMemo(() => {
    const byPod = new Map((usage.data?.pods ?? []).map((p) => [`${p.namespace}/${p.name}`, p]));
    return apps.map(({ row, pods: mine }) => ({
      key: rowKey(row.namespace, row.name), namespace: row.namespace, name: row.name,
      sum: sumUsage(mine.map((p) => byPod.get(`${p.namespace}/${p.name}`)).filter((p): p is PodReading => p !== undefined)),
    }));
  }, [apps, usage.data]);
  const byKey = useMemo(() => new Map(apps.map((a) => [rowKey(a.row.namespace, a.row.name), a.row])), [apps]);
  return (
    <div>
      <h5 className="mono">{context}</h5>
      {usage.isError && <div className="err">{String((usage.error as { message?: string })?.message ?? usage.error)}</div>}
      {usage.data?.unavailable && <div className="err">{UNAVAILABLE[usage.data.unavailable]}</div>}
      {usage.data && !usage.data.unavailable && (
        <table className="argo-metrics-table">
          <thead><tr><th>{T.usageApp}</th><th>{T.usageCpu}</th><th>{T.usageMemory}</th></tr></thead>
          <tbody>
            {topUsage(rows, by, TOP).map((r) => (
              <tr key={r.key}>
                <th><button className="argo-metrics-link" onClick={() => { const row = byKey.get(r.key); if (row) onOpen(row); }}>{r.name}</button><div className="argo-metrics-note">{T.usagePods(r.sum.reporting, r.sum.pods)}</div></th>
                <td><Meter used={r.sum.reporting ? r.sum.cpuMilli : null} request={r.sum.cpuRequest} limit={r.sum.cpuLimit} format={formatCpu} /></td>
                <td><Meter used={r.sum.reporting ? r.sum.memoryBytes : null} request={r.sum.memoryRequest} limit={r.sum.memoryLimit} format={formatBytes} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** 앱 리소스 사용량: 고른 앱의 Pod 사용량과, 트리를 읽은 앱들 중 사용량이 큰 앱 */
export function UsagePanel({ url, rows, live, onOpen }: { url: string; rows: ArgoAppRow[]; live: boolean; onOpen: (row: ArgoAppRow) => void }) {
  const qc = useQueryClient();
  const version = useTreeVersion(url);
  const trees = useMemo(() => cachedTrees(qc, url), [qc, url, version]);
  const cached = useMemo(() => new Set(trees.map((t) => rowKey(t.app.namespace, t.app.name))), [trees]);
  const loader = useTreeLoader(url, rows, cached);
  const { resolve } = useContextFor(url);
  const [selected, setSelected] = useState("");
  const [by, setBy] = useState<"cpuMilli" | "memoryBytes">("cpuMilli");
  const sorted = useMemo(() => [...rows].sort((a, b) => a.name.localeCompare(b.name)), [rows]);
  const row = sorted.find((r) => rowKey(r.namespace, r.name) === selected) ?? null;
  const groups = useMemo(() => {
    const byKey = new Map(rows.map((r) => [rowKey(r.namespace, r.name), r]));
    const found = new Map<string, { row: ArgoAppRow; pods: PodRef[] }[]>();
    for (const tree of trees) {
      const app = byKey.get(rowKey(tree.app.namespace, tree.app.name));
      const match = app ? resolve(app) : null;
      const pods = podsOfTree(tree.nodes as Parameters<typeof podsOfTree>[0]);
      if (!app || match?.status !== "found" || pods.length === 0) continue;
      found.set(match.context.name, [...(found.get(match.context.name) ?? []), { row: app, pods }]);
    }
    return [...found].sort(([a], [b]) => a.localeCompare(b));
  }, [trees, rows, resolve]);
  return (
    <div className="argo-metrics-scroll">
      <div className="argo-metrics-bar">
        <label className="k8s-field">
          {T.usageApp}
          <select value={selected} onChange={(e) => setSelected(e.target.value)}>
            <option value="">{T.usageNoApp}</option>
            {sorted.map((r) => <option key={rowKey(r.namespace, r.name)} value={rowKey(r.namespace, r.name)}>{r.name}</option>)}
          </select>
        </label>
      </div>
      {row && <AppUsage key={rowKey(row.namespace, row.name)} url={url} row={row} live={live} />}
      <h4>{T.usageTop}</h4>
      <div className="argo-metrics-bar">
        <label className="k8s-field">
          {T.usageTopBy}
          <select value={by} onChange={(e) => setBy(e.target.value as typeof by)}>
            <option value="cpuMilli">{T.usageCpu}</option>
            <option value="memoryBytes">{T.usageMemory}</option>
          </select>
        </label>
        {loader.progress === null ? (
          <button className="btn small tone-secondary" disabled={cached.size >= rows.length} onClick={() => void loader.start()}>{T.loadTrees}</button>
        ) : (
          <>
            <span>{T.loadingTrees(loader.progress.done, loader.progress.total)}</span>
            <button className="btn small tone-secondary" onClick={loader.stop}>{T.stopLoading}</button>
          </>
        )}
        <span className="argo-metrics-note">{T.usageTopNote}</span>
      </div>
      {groups.map(([context, apps]) => <ContextTop key={context} url={url} context={context} apps={apps} by={by} live={live} onOpen={onOpen} />)}
    </div>
  );
}
