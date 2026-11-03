import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { parse } from "yaml";
import { invoke } from "../api/invoke";
import { useSettings } from "../api/queries";
import { ErrorState } from "../components/ErrorState";
import { SERIES_COLORS } from "../cost/DailyChart";
import * as t from "./text";
import type { K8sObjectView, K8sTarget, ObjectRef } from "./types";

type Endpoint = { namespace: string; name: string; port: number };
type Series = { name: string; values: [number, number][] };
type Graphs = { cpu: Series[]; memory: Series[] };
type Reference = { name: string; value: number; limit: boolean };
const keyOf = (e: Endpoint) => `${e.namespace}/${e.name}:${e.port}`;

/** Kubernetes 수량을 CPU 코어 또는 바이트로 바꾼다. */
function quantity(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const m = String(value).match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(n|u|m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/);
  if (!m) return null;
  const scales: Record<string, number> = { n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6 };
  const n = Number(m[1]) * (scales[m[2]] ?? 1);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function references(yaml: string, pod: boolean, cpu: boolean): Reference[] {
  try {
    const obj = parse(yaml);
    const containers = (pod ? obj?.spec?.containers : obj?.spec?.template?.spec?.containers) as { name: string; resources?: { requests?: Record<string, unknown>; limits?: Record<string, unknown> } }[] | undefined;
    if (!Array.isArray(containers) || containers.length === 0) return [];
    const result: Reference[] = [];
    for (const limit of [false, true]) {
      const vals = containers.map((c) => ({ name: c.name, value: quantity(c.resources?.[limit ? "limits" : "requests"]?.[cpu ? "cpu" : "memory"]) }));
      if (pod) {
        for (const v of vals) if (v.value !== null) result.push({ name: v.name, value: v.value, limit });
      } else if (vals.every((v) => v.value !== null)) {
        result.push({ name: "Pod", value: vals.reduce((sum, v) => sum + (v.value ?? 0), 0), limit });
      }
    }
    return result;
  } catch { return []; }
}

function Chart({ title, series, refs, hours }: { title: string; series: Series[]; refs: Reference[]; hours: number }) {
  const points = series.flatMap((s) => s.values);
  if (!points.length) return <section><h4>{title}</h4><div className="empty small">{t.PROM_EMPTY}</div></section>;
  const end = Math.max(...points.map(([x]) => x));
  const start = end - hours * 3600;
  const max = Math.max(1e-12, ...points.map(([, y]) => y), ...refs.map((r) => r.value));
  const x = (v: number) => Math.max(0, Math.min(600, (v - start) / (end - start) * 600));
  const y = (v: number) => 150 - Math.max(0, v) / max * 145;
  return (
    <section>
      <h4>{title}</h4>
      <div className="dim">{max.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
      <svg viewBox="0 0 600 150" preserveAspectRatio="none" width="100%" height="150" role="img" aria-label={title}>
        {refs.map((r, i) => <line key={`${r.name}-${r.limit}`} x1="0" x2="600" y1={y(r.value)} y2={y(r.value)} stroke={SERIES_COLORS[i % SERIES_COLORS.length]} strokeDasharray={r.limit ? "6 3" : "2 3"}><title>{`${r.name} ${r.limit ? t.PROM_LIMIT : t.PROM_REQUEST}: ${r.value}`}</title></line>)}
        {series.map((s, i) => <polyline key={s.name} points={s.values.map(([a, b]) => `${x(a)},${y(b)}`).join(" ")} fill="none" stroke={SERIES_COLORS[i % SERIES_COLORS.length]} strokeWidth="2" vectorEffect="non-scaling-stroke"><title>{s.name}</title></polyline>)}
      </svg>
      <div className="cost-legend">{series.map((s, i) => <span key={s.name}><i className="cost-swatch" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />{s.name}</span>)}</div>
      {refs.length > 0 && <div className="dim">{refs.map((r) => `${r.name} ${r.limit ? t.PROM_LIMIT : t.PROM_REQUEST}: ${r.value.toLocaleString()}`).join(" · ")}</div>}
      <div className="dim">{new Date(start * 1000).toLocaleString()} — {new Date(end * 1000).toLocaleString()}</div>
    </section>
  );
}

export function UsageGraphs({ target, objectRef, view, live, ssoProfile }: { target: K8sTarget; objectRef: ObjectRef; view: K8sObjectView; live: boolean; ssoProfile: string }) {
  const { settings, update } = useSettings();
  const clusterKey = JSON.stringify([target.profile, target.region, target.cluster]);
  const saved = settings?.k8sPrometheus?.[clusterKey];
  const [hours, setHours] = useState(1);
  const [manual, setManual] = useState(false);
  const [namespace, setNamespace] = useState("");
  const [name, setName] = useState("");
  const [port, setPort] = useState("9090");
  const candidates = useQuery({ queryKey: ["k8s", "prometheus", target], queryFn: () => invoke<Endpoint[]>("k8s_prometheus_candidates", { target, profile: ssoProfile }), enabled: live, retry: false });
  const server = saved ?? (candidates.data?.length === 1 ? candidates.data[0] : undefined);
  const graphs = useQuery({ queryKey: ["k8s", "prometheusGraphs", target, server, objectRef, hours], queryFn: () => invoke<Graphs>("k8s_prometheus_graphs", { target, server, kind: objectRef.kind, namespace: objectRef.namespace, name: objectRef.name, hours, profile: ssoProfile }), enabled: live && !!server && !!objectRef.namespace, retry: false });
  const choose = (e: Endpoint) => { update({ k8sPrometheus: { ...settings?.k8sPrometheus, [clusterKey]: e } }); setManual(false); };
  const pod = objectRef.kind.kind === "Pod" && objectRef.kind.group === "";
  return (
    <div>
      <p className="dim">{t.PROM_AMP}</p>
      {candidates.isError && <ErrorState error={candidates.error} profile={ssoProfile} compact onRetry={() => void candidates.refetch()} onLoggedIn={() => void candidates.refetch()} />}
      {candidates.isLoading && <div className="empty">{t.LOADING}</div>}
      {candidates.data?.length === 0 && !saved && <p>{t.PROM_NONE}</p>}
      {(candidates.data || saved) && <label>{t.PROM_SERVER} <select value={server ? keyOf(server) : ""} onChange={(e) => { const found = candidates.data?.find((c) => keyOf(c) === e.target.value); if (found) choose(found); }}><option value="">{t.PROM_SELECT}</option>{saved && !candidates.data?.some((c) => keyOf(c) === keyOf(saved)) && <option value={keyOf(saved)}>{keyOf(saved)}</option>}{candidates.data?.map((c) => <option key={keyOf(c)} value={keyOf(c)}>{keyOf(c)}</option>)}</select></label>}
      <button className="btn tone-secondary" onClick={() => setManual(!manual)}>{t.PROM_MANUAL}</button>
      {manual && <div><label>{t.PROM_NAMESPACE}<input value={namespace} onChange={(e) => setNamespace(e.target.value)} /></label><label>{t.PROM_NAME}<input value={name} onChange={(e) => setName(e.target.value)} /></label><label>{t.PROM_PORT}<input type="number" min="1" max="65535" value={port} onChange={(e) => setPort(e.target.value)} /></label><button className="btn tone-primary" disabled={!namespace || !name || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535} onClick={() => choose({ namespace, name, port: Number(port) })}>{t.PROM_SELECT}</button></div>}
      {server && <label>{t.PROM_PERIOD} <select value={hours} onChange={(e) => setHours(Number(e.target.value))}><option value={1}>1h</option><option value={6}>6h</option><option value={24}>24h</option></select></label>}
      {graphs.isError && <ErrorState error={graphs.error} profile={ssoProfile} compact onRetry={() => void graphs.refetch()} onLoggedIn={() => void graphs.refetch()} />}
      {server && graphs.isLoading && <div className="empty">{t.LOADING}</div>}
      {graphs.data && <><Chart title={t.PROM_CPU} series={graphs.data.cpu} refs={references(view.yaml, pod, true)} hours={hours} /><Chart title={t.PROM_MEMORY} series={graphs.data.memory} refs={references(view.yaml, pod, false)} hours={hours} /></>}
    </div>
  );
}
