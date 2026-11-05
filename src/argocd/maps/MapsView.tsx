import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ARGO_ENVS, envOf } from "../argoEnv";
import { clusterOf, clusterText, groupLevel, levelOf, projectOf, rowKey, tally } from "../argoGroup";
import { argoKeys, useApps, useAppsets, useArgoEvents } from "../queries";
import { ARGO_ENV_TEXT, MAP_TEXT } from "../text";
import type { ArgoApp, ArgoAppRow, ArgoHistory, ArgoHistoryEntry, ArgoTreeNode, ArgoViewState } from "../types";
import { appForest, matrix, timeline, timelineLanes, versions, type AppBranch, type Dimension } from "./model";
import { cachedTrees } from "../search/useArgoIndex";
import "./maps.css";

type MapTab = "matrix" | "versions" | "sets" | "hierarchy" | "timeline";
const tabs: MapTab[] = ["matrix", "versions", "sets", "hierarchy", "timeline"];
type Open = (row: ArgoAppRow, history?: boolean) => void;

export function MapsView({ url, live, onOpen, onFilter }: { url: string; live: boolean; onOpen: Open; onFilter: (state: ArgoViewState) => void }) {
  const [tab, setTab] = useState<MapTab>("matrix");
  const apps = useApps(url, live); const sets = useAppsets(url, live); const rows = apps.data ?? [];
  const qc = useQueryClient(); const [cacheVersion, setCacheVersion] = useState(0);
  useEffect(() => qc.getQueryCache().subscribe(e => { const k = e.query.queryKey; if (e.type === "updated" && e.action.type === "success" && k[0] === "argocd" && k[1] === url && k[2] === "data" && ["tree", "app", "read"].includes(String(k[3]))) setCacheVersion(v => v + 1); }), [qc, url]);
  const cached = useMemo(() => {
    const trees = new Map(cachedTrees(qc, url).map(t => [rowKey(t.app.namespace, t.app.name), t.nodes]));
    const details = new Map<string, ArgoApp>(); const histories = new Map<string, (ArgoHistory | ArgoHistoryEntry)[]>();
    for (const query of qc.getQueryCache().findAll({ queryKey: argoKeys.data(url) })) {
      const k = query.queryKey; if (typeof k[4] !== "string" || typeof k[5] !== "string") continue;
      const id = rowKey(k[4], k[5]);
      if (k[3] === "app" && query.state.data) { const app = query.state.data as ArgoApp; details.set(id, app); if (app.history?.length && !histories.has(id)) histories.set(id, app.history); }
      if (k[3] === "read" && k[6] === "history" && Array.isArray(query.state.data)) histories.set(id, query.state.data as ArgoHistoryEntry[]);
    }
    return { trees, details, histories };
  }, [qc, url, cacheVersion]);
  return <div className="argo-maps"><div className="k8s-tabs" role="tablist" aria-label={MAP_TEXT.tabs}>{tabs.map(t => <button role="tab" aria-selected={tab === t} key={t} onClick={() => setTab(t)}>{MAP_TEXT[t]}</button>)}</div>
    {tab === "matrix" && <Matrix rows={rows} onFilter={onFilter}/>}
    {tab === "versions" && <Versions rows={rows} trees={cached.trees} apps={cached.details} onOpen={onOpen}/>}
    {tab === "sets" && <SetGraph rows={rows} sets={sets.data ?? []} onOpen={onOpen}/>}
    {tab === "hierarchy" && <Hierarchy rows={rows} onOpen={onOpen}/>}
    {tab === "timeline" && <Timeline url={url} rows={rows} histories={cached.histories} onOpen={onOpen}/>}
  </div>;
}

function Matrix({ rows, onFilter }: { rows: ArgoAppRow[]; onFilter: (state: ArgoViewState) => void }) {
  const [dim, setDim] = useState<Dimension>("cluster"); const data = useMemo(() => matrix(rows, dim), [rows, dim]);
  return <div className="argo-map-scroll"><div className="argo-map-controls"><select aria-label={MAP_TEXT.cluster} value={dim} onChange={e => setDim(e.target.value as Dimension)}><option value="cluster">{MAP_TEXT.cluster}</option><option value="project">{MAP_TEXT.project}</option></select></div>
    <table className="argo-map-table"><thead><tr><th>{MAP_TEXT.env}</th>{data.columns.map(c => <th key={c}>{(dim === "cluster" ? clusterText(c) : c) || "—"}</th>)}</tr></thead><tbody>{ARGO_ENVS.map(env => <tr key={env}><th>{ARGO_ENV_TEXT[env]}</th>{data.columns.map(col => { const cell = data.cells.get(JSON.stringify([env, col])); return <td key={col}>{cell ? <button className={`argo-map-cell ${cell.level}`} onClick={() => onFilter({ sync: [], health: [], envs: [env], clusters: dim === "cluster" ? [col] : [], projects: dim === "project" ? [col] : [], labels: [], groupBy: null, thenBy: null })}><b>{cell.rows.length}</b><small>{MAP_TEXT.tally(cell.tally)}</small></button> : "—"}</td>; })}</tr>)}</tbody></table>
  </div>;
}
function Versions({ rows, trees, apps, onOpen }: { rows: ArgoAppRow[]; trees: Map<string, ArgoTreeNode[]>; apps: Map<string, ArgoApp>; onOpen: Open }) {
  const [only, setOnly] = useState(false); const groups = useMemo(() => versions(rows, trees, apps), [rows, trees, apps]);
  return <div className="argo-map-scroll"><label className="argo-map-controls"><input type="checkbox" checked={only} onChange={e => setOnly(e.target.checked)}/>{MAP_TEXT.driftOnly}</label><table className="argo-map-table"><thead><tr><th>{MAP_TEXT.app}</th>{ARGO_ENVS.map(e => <th key={e}>{ARGO_ENV_TEXT[e]}</th>)}</tr></thead><tbody>{groups.filter(g => !only || g.drift).map((g, i) => <tr key={`${g.name}:${i}`}><th>{g.name}</th>{ARGO_ENVS.map(env => <td key={env}>{g.cells[env]?.map(c => <button key={rowKey(c.row.namespace, c.row.name)} className={`argo-map-version ${c.drift ? "drift" : ""}`} title={c.drift ? MAP_TEXT.drift : undefined} onClick={() => onOpen(c.row)}><b>{c.row.name}</b><span>{c.revision || "—"}{c.target && ` / ${c.target}`}</span>{c.images.map(im => <small key={im}>{im}</small>)}</button>) ?? "—"}</td>)}</tr>)}</tbody></table></div>;
}
function SetGraph({ rows, sets, onOpen }: { rows: ArgoAppRow[]; sets: { name: string; namespace: string; status: string | null; message: string | null; generators: string[] }[]; onOpen: Open }) {
  const grouped = new Map<string, ArgoAppRow[]>(); for (const row of rows) if (row.values.appSet) { const key = rowKey(row.namespace, row.values.appSet); grouped.set(key, [...(grouped.get(key) ?? []), row]); }
  for (const set of sets) { const key = rowKey(set.namespace, set.name); if (!grouped.has(key)) grouped.set(key, []); }
  const entries = [...grouped].sort(([a], [b]) => a.localeCompare(b)); let y = 38;
  const elements = entries.map(([set, apps]) => { const top = y; const height = Math.max(1, apps.length) * 58; y += height + 18; return { set, apps, top, level: groupLevel(sets.find(s => rowKey(s.namespace, s.name) === set) ?? null, tally(apps)) }; });
  return <div className="argo-map-graph"><svg width="790" height={Math.max(y, 100)} role="img" aria-label={MAP_TEXT.sets}><text className="argo-map-heading" x="10" y="20">ApplicationSet</text><text className="argo-map-heading" x="270" y="20">Application</text><text className="argo-map-heading" x="530" y="20">{MAP_TEXT.cluster}</text>{elements.map(g => <g key={g.set}><g className={`argo-map-state ${g.level}`}><rect x="10" y={g.top} width="210" height="40" rx="5"/><text x="20" y={g.top + 25}>{g.set}</text></g>{g.apps.map((app, i) => { const py = g.top + i * 58; return <g key={rowKey(app.namespace, app.name)}><path className="argo-map-edge" d={`M 220 ${g.top + 20} C 245 ${g.top + 20}, 245 ${py + 20}, 270 ${py + 20} M 480 ${py + 20} H 530`}/><g className={`argo-map-node ${levelOf(app)}`} role="button" tabIndex={0} onClick={() => onOpen(app)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(app); } }}><rect x="270" y={py} width="210" height="40" rx="5"/><text x="280" y={py + 25}>{app.name}</text></g><g className={`argo-map-state ${groupLevel(null, tally(rows.filter(r => clusterOf(r) === clusterOf(app))))}`}><rect x="530" y={py} width="240" height="40" rx="5"/><text x="540" y={py + 25}>{clusterText(clusterOf(app)) || "—"}</text></g></g>; })}</g>)}</svg>{!entries.length && <div className="empty">{MAP_TEXT.empty}</div>}</div>;
}
function Branch({ branch, onOpen }: { branch: AppBranch; onOpen: Open }) {
  return <li><details open><summary><span className={`argo-map-dot ${branch.level}`}/><button className="argo-map-link" onClick={e => { e.preventDefault(); onOpen(branch.row); }}>{branch.row.name}</button>{branch.cycle && ` (${MAP_TEXT.cycle})`}</summary>{branch.children.length > 0 && <ul>{branch.children.map((child, i) => <Branch key={`${rowKey(child.row.namespace, child.row.name)}:${i}`} branch={child} onOpen={onOpen}/>)}</ul>}</details></li>;
}
function Hierarchy({ rows, onOpen }: { rows: ArgoAppRow[]; onOpen: Open }) {
  const forest = useMemo(() => appForest(rows).filter(b => b.children.length), [rows]);
  return <div className="argo-map-scroll">{forest.length ? <ul className="argo-map-tree">{forest.map((b, i) => <Branch key={`${rowKey(b.row.namespace, b.row.name)}:${i}`} branch={b} onOpen={onOpen}/>)}</ul> : <div className="empty">{MAP_TEXT.empty}</div>}</div>;
}
function Timeline({ url, rows, histories, onOpen }: { url: string; rows: ArgoAppRow[]; histories: Map<string, (ArgoHistory | ArgoHistoryEntry)[]>; onOpen: Open }) {
  const [days, setDays] = useState(7); const [env, setEnv] = useState(""); const [project, setProject] = useState(""); const since = useMemo(() => new Date(Date.now() - days * 86400000).toISOString(), [days]); const events = useArgoEvents(url, since);
  const now = useMemo(() => Date.now(), [days, events.data, histories]);
  const lanes = useMemo(() => timelineLanes(timeline(events.data ?? [], histories, now, days)), [events.data, histories, now, days]);
  const projects = [...new Set(rows.map(projectOf).filter(Boolean))].sort(); const filtered = rows.filter(r => (!env || envOf(r).env === env) && (!project || projectOf(r) === project));
  const start = now - days * 86400000;
  return <div className="argo-map-scroll"><div className="argo-map-controls"><select aria-label={MAP_TEXT.range} value={days} onChange={e => setDays(Number(e.target.value))}><option value={1}>{MAP_TEXT.day}</option><option value={7}>{MAP_TEXT.week}</option><option value={30}>{MAP_TEXT.month}</option></select><select aria-label={MAP_TEXT.env} value={env} onChange={e => setEnv(e.target.value)}><option value="">{MAP_TEXT.all}</option>{ARGO_ENVS.map(e => <option key={e} value={e}>{ARGO_ENV_TEXT[e]}</option>)}</select><select aria-label={MAP_TEXT.project} value={project} onChange={e => setProject(e.target.value)}><option value="">{MAP_TEXT.all}</option>{projects.map(p => <option key={p}>{p}</option>)}</select></div><div className="argo-map-axis"><span>{new Date(start).toLocaleString()}</span><span>{new Date(now).toLocaleString()}</span></div>{filtered.map(row => { const lane = lanes.get(rowKey(row.namespace, row.name)) ?? []; if (!lane.length) return null; return <div className="argo-map-lane" key={rowKey(row.namespace, row.name)}><button className="argo-map-link" onClick={() => onOpen(row, true)}>{row.name}</button><div className="argo-map-track">{lane.map(item => { const left = Math.max(0, Math.min(100, (item.start - start) / (now - start) * 100)); const right = Math.max(left, Math.min(100, (item.end - start) / (now - start) * 100)); return <button key={item.key} className={`argo-map-bar ${item.failed ? "err" : "ok"}`} style={{ left: `${left}%`, width: `${Math.max(0.7, right - left)}%` }} title={[new Date(item.end).toLocaleString(), `${MAP_TEXT.revision}: ${item.revision || "—"}`, `${MAP_TEXT.initiator}: ${item.initiatedBy || "—"}`, `${MAP_TEXT.message}: ${item.message || "—"}`].join("\n")} onClick={() => onOpen(row, true)} aria-label={`${row.name} ${new Date(item.end).toLocaleString()}`}/>; })}</div></div>; })}</div>;
}
