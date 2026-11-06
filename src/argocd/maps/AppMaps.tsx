import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ARGO_ENVS } from "../argoEnv";
import { clusterOf, clusterText, levelOf, rowKey } from "../argoGroup";
import { useAppHistory } from "../detail/queries";
import { argoKeys, useApps, useArgoEvents } from "../queries";
import { cachedTrees } from "../search/useArgoIndex";
import { ARGO_ENV_TEXT, ARGO_HOOK, ARGO_PRUNING, MAP_TEXT } from "../text";
import type { ArgoApp, ArgoAppRow, ArgoTreeNode, ResRef } from "../types";
import { appHierarchy, appSetSiblings, appTimeline, appVersion, resourceGraph } from "./appModel";
import type { AppBranch } from "./model";
import { NetworkMap } from "./NetworkMap";
import "./maps.css";

type Tab = "network" | "relations" | "hierarchy" | "sets" | "versions" | "timeline";
const tabs: Tab[] = ["network", "relations", "hierarchy", "sets", "versions", "timeline"];
const lastTab = new Map<string, Tab>();
type Identity = { namespace: string; name: string };
type Open = (app: Identity) => void;

export function AppMaps({ url, app, version, live, nodes, onResource, onApp }: { url: string; app: ArgoApp; version: string | null; live: boolean; nodes: ArgoTreeNode[]; onResource: (res: ResRef) => void; onApp: Open }) {
  const [tab, setTab] = useState<Tab>(() => lastTab.get(url) ?? "network");
  const [days, setDays] = useState(7);
  const rows = useApps(url, live).data ?? [];
  const qc = useQueryClient(); const [cacheVersion, setCacheVersion] = useState(0);
  useEffect(() => qc.getQueryCache().subscribe(e => { const k = e.query.queryKey; if (e.type === "updated" && e.action.type === "success" && k[0] === "argocd" && k[1] === url && k[2] === "data" && (k[3] === "tree" || k[3] === "app")) setCacheVersion(v => v + 1); }), [qc, url]);
  const cache = useMemo(() => {
    const trees = new Map(cachedTrees(qc, url).map(t => [rowKey(t.app.namespace, t.app.name), t.nodes]));
    const details = new Map<string, ArgoApp>();
    for (const query of qc.getQueryCache().findAll({ queryKey: [...argoKeys.data(url), "app"] })) {
      const k = query.queryKey; if (typeof k[4] === "string" && typeof k[5] === "string" && query.state.data) details.set(rowKey(k[4], k[5]), query.state.data as ArgoApp);
    }
    return { trees, details };
  }, [qc, url, cacheVersion]);
  const since = useMemo(() => new Date(Date.now() - days * 86400000).toISOString(), [days]);
  const events = useArgoEvents(tab === "timeline" ? url : "", since);
  const history = useAppHistory(url, app.namespace, app.name, version, tab === "timeline");
  const currentTab = tab === "sets" && !app.appSet ? "network" : tab;
  const change = (next: Tab) => { setTab(next); lastTab.set(url, next); };
  return <div className="argo-maps"><div className="k8s-tabs argo-map-tabs" role="tablist" aria-label={MAP_TEXT.tabs}>{tabs.map(t => <button key={t} role="tab" aria-selected={currentTab === t} disabled={t === "sets" && !app.appSet} title={t === "sets" && !app.appSet ? MAP_TEXT.noSet : undefined} onClick={() => change(t)}>{MAP_TEXT[t]}</button>)}</div>
    {currentTab === "network" && <NetworkMap nodes={nodes} onOpen={onResource} />}
    {currentTab === "relations" && <Relations app={app} nodes={nodes} onOpen={onResource} />}
    {currentTab === "hierarchy" && <Hierarchy rows={rows} app={app} onOpen={onApp} />}
    {currentTab === "sets" && <SetGraph app={app} rows={rows} onOpen={onApp} />}
    {currentTab === "versions" && <VersionMap app={app} rows={rows} trees={cache.trees} details={cache.details} onOpen={onApp} />}
    {currentTab === "timeline" && <Timeline app={app} events={events.data ?? []} history={history.data ?? app.history} days={days} setDays={setDays} />}
  </div>;
}

function Relations({ app, nodes, onOpen }: { app: ArgoApp; nodes: ArgoTreeNode[]; onOpen: (res: ResRef) => void }) {
  const graph = useMemo(() => resourceGraph(nodes, app.resources), [nodes, app.resources]);
  const columns = new Map<number, typeof graph.vertices>();
  for (const vertex of graph.vertices) columns.set(vertex.layer, [...(columns.get(vertex.layer) ?? []), vertex]);
  const positions = new Map<string, { x: number; y: number }>([["app", { x: 8, y: 35 }]]);
  for (const [layer, vertices] of columns) vertices.forEach((v, i) => positions.set(v.row.key, { x: layer * 220 + 8, y: i * 65 + 35 }));
  const width = (Math.max(0, ...columns.keys()) + 1) * 220; const height = Math.max(110, ...[...columns.values()].map(c => c.length * 65 + 40));
  return <div className="argo-map-graph"><svg width={width} height={height} aria-label={MAP_TEXT.relations}>
    <g className={`argo-map-state ${app.health === "Degraded" ? "err" : app.syncStatus === "OutOfSync" ? "warn" : "ok"}`}><rect x="8" y="35" width="190" height="44" rx="5"/><text x="18" y="61">{app.name}</text></g>
    {graph.edges.map((e, i) => { const a = positions.get(e.from); const b = positions.get(e.to); return a && b ? <path key={i} className="argo-map-edge" d={`M ${a.x + 190} ${a.y + 22} C ${a.x + 205} ${a.y + 22}, ${b.x - 15} ${b.y + 22}, ${b.x} ${b.y + 22}`}/> : null; })}
    {graph.vertices.map(({ row }) => { const p = positions.get(row.key)!; const tone = row.health === "Degraded" || row.health === "Missing" ? "err" : row.sync === "OutOfSync" || (row.health && row.health !== "Healthy") ? "warn" : "ok"; const mark = [row.hook ? ARGO_HOOK : "", row.requiresPruning ? ARGO_PRUNING : ""].filter(Boolean).join(" · "); return <g key={row.key} className={`argo-map-node ${tone}`} transform={`translate(${p.x},${p.y})`} role="button" tabIndex={0} onClick={() => onOpen(row)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(row); } }}><title>{`${row.kind} ${row.name} ${mark}`}</title><rect width="190" height="48" rx="5"/><text x="8" y="18">{row.kind} {row.name.length > 17 ? `${row.name.slice(0, 16)}…` : row.name}</text><text x="8" y="37">{mark || row.sync || row.health || "—"}</text></g>; })}
  </svg></div>;
}
function Branch({ branch, app, onOpen }: { branch: AppBranch; app: ArgoApp; onOpen: Open }) {
  const current = branch.row.name === app.name && branch.row.namespace === app.namespace;
  return <li><details open><summary><span className={`argo-map-dot ${branch.level}`}/><button className="argo-map-link" aria-current={current ? "true" : undefined} onClick={e => { e.preventDefault(); onOpen(branch.row); }}>{branch.row.name}</button>{branch.cycle && ` (${MAP_TEXT.cycle})`}</summary>{branch.children.length > 0 && <ul>{branch.children.map((b, i) => <Branch key={`${rowKey(b.row.namespace, b.row.name)}:${i}`} branch={b} app={app} onOpen={onOpen}/>)}</ul>}</details></li>;
}
function Hierarchy({ rows, app, onOpen }: { rows: ArgoAppRow[]; app: ArgoApp; onOpen: Open }) {
  const forest = useMemo(() => appHierarchy(rows, app), [rows, app]);
  return <div className="argo-map-scroll">{forest.length ? <ul className="argo-map-tree">{forest.map((b, i) => <Branch key={`${rowKey(b.row.namespace, b.row.name)}:${i}`} branch={b} app={app} onOpen={onOpen}/>)}</ul> : <div className="empty">{MAP_TEXT.empty}</div>}</div>;
}
function SetGraph({ app, rows, onOpen }: { app: ArgoApp; rows: ArgoAppRow[]; onOpen: Open }) {
  const siblings = appSetSiblings(rows, app, app.appSet);
  return <div className="argo-map-graph"><svg width="790" height={Math.max(100, siblings.length * 58 + 45)} aria-label={MAP_TEXT.sets}><text className="argo-map-heading" x="8" y="20">ApplicationSet</text><text className="argo-map-heading" x="270" y="20">Application</text><text className="argo-map-heading" x="530" y="20">{MAP_TEXT.cluster}</text><g className="argo-map-state"><rect x="8" y="35" width="210" height="40" rx="5"/><text x="18" y="60">{app.appSet}</text></g>{siblings.map((row, i) => { const y = 35 + i * 58; const selected = row.name === app.name && row.namespace === app.namespace; return <g key={rowKey(row.namespace, row.name)}><path className="argo-map-edge" d={`M 218 55 C 242 55, 246 ${y + 20}, 270 ${y + 20} M 480 ${y + 20} H 530`}/><g className={`argo-map-node ${levelOf(row)}${selected ? " selected" : ""}`} role="button" tabIndex={0} aria-label={selected ? `${row.name} (${MAP_TEXT.selected})` : row.name} onClick={() => onOpen(row)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(row); } }}><rect x="270" y={y} width="210" height="40" rx="5"/><text x="280" y={y + 25}>{row.name}</text></g><g className="argo-map-state"><rect x="530" y={y} width="240" height="40" rx="5"/><text x="540" y={y + 25}>{clusterText(clusterOf(row)) || "—"}</text></g></g>; })}</svg></div>;
}
function VersionMap({ app, rows, trees, details, onOpen }: { app: ArgoApp; rows: ArgoAppRow[]; trees: Map<string, ArgoTreeNode[]>; details: Map<string, ArgoApp>; onOpen: Open }) {
  const group = useMemo(() => appVersion(rows, app, trees, details), [rows, app, trees, details]);
  if (!group) return <div className="empty">{MAP_TEXT.empty}</div>;
  return <div className="argo-map-scroll"><table className="argo-map-table"><thead><tr>{ARGO_ENVS.map(e => <th key={e}>{ARGO_ENV_TEXT[e]}</th>)}</tr></thead><tbody><tr>{ARGO_ENVS.map(env => <td key={env}>{group.cells[env]?.map(c => <button key={rowKey(c.row.namespace, c.row.name)} className={`argo-map-version ${c.drift ? "drift" : ""}`} title={c.drift ? MAP_TEXT.drift : undefined} onClick={() => onOpen(c.row)}><b>{c.row.name}</b><span>{c.revision || "—"}{c.target && ` / ${c.target}`}</span>{c.images.map(im => <small key={im}>{im}</small>)}</button>) ?? "—"}</td>)}</tr></tbody></table></div>;
}
function Timeline({ app, events, history, days, setDays }: { app: ArgoApp; events: Parameters<typeof appTimeline>[0]; history: Parameters<typeof appTimeline>[2]; days: number; setDays: (days: number) => void }) {
  const now = Date.now(); const start = now - days * 86400000; const items = appTimeline(events, app, history, now, days);
  return <div className="argo-map-scroll"><div className="argo-map-controls"><select aria-label={MAP_TEXT.range} value={days} onChange={e => setDays(Number(e.target.value))}><option value={1}>{MAP_TEXT.day}</option><option value={7}>{MAP_TEXT.week}</option><option value={30}>{MAP_TEXT.month}</option></select></div><div className="argo-map-axis"><span>{new Date(start).toLocaleString()}</span><span>{new Date(now).toLocaleString()}</span></div><div className="argo-map-lane"><span>{app.name}</span><div className="argo-map-track">{items.map(item => { const left = Math.max(0, Math.min(100, (item.start - start) / (now - start) * 100)); const right = Math.max(left, Math.min(100, (item.end - start) / (now - start) * 100)); return <span key={item.key} className={`argo-map-bar ${item.failed ? "err" : "ok"}`} style={{ left: `${left}%`, width: `${Math.max(0.7, right - left)}%` }} title={[new Date(item.end).toLocaleString(), `${MAP_TEXT.revision}: ${item.revision || "—"}`, `${MAP_TEXT.initiator}: ${item.initiatedBy || "—"}`, `${MAP_TEXT.message}: ${item.message || "—"}`].join("\n")} />; })}</div></div>{items.length === 0 && <div className="empty">{MAP_TEXT.empty}</div>}</div>;
}
