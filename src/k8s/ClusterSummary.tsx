import { useCallback, useMemo, useSyncExternalStore } from "react";
import { age, formatBytes, formatCpu } from "./format";
import { EVENTS } from "./kinds";
import { K8sError } from "./K8sError";
import * as t from "./text";
import type { K8sNodeView, K8sResources, K8sTarget } from "./types";
import { UsageChart, type Reference } from "./UsageGraphs";
import { clusterTrend, subscribeUsage, usageVersion } from "./usageHistory";
import { useK8sWatch } from "./useK8sWatch";

type Usage = { cpuMilli: number; memoryBytes: number };

export interface ClusterTotals {
  capacity: K8sResources;
  allocatable: K8sResources;
  requested: K8sResources;
  limits: K8sResources;
  /** metrics-server 사용량 합. 아는 노드가 하나도 없으면 null */
  usage: Usage | null;
}

const ZERO: K8sResources = { cpuMilli: 0, memoryBytes: 0, pods: 0 };
const add = (a: K8sResources, b: K8sResources): K8sResources => ({ cpuMilli: a.cpuMilli + b.cpuMilli, memoryBytes: a.memoryBytes + b.memoryBytes, pods: a.pods + b.pods });

/** 노드 합계. 사용량은 방금 읽은 값(live)이 있으면 그것을, 없으면 개요를 읽을 때의 값을 쓴다 */
export function clusterTotals(nodes: K8sNodeView[], live: Map<string, Usage> | null): ClusterTotals {
  let cpuMilli = 0;
  let memoryBytes = 0;
  let known = false;
  for (const n of nodes) {
    const u = live ? live.get(n.name) : n.usage;
    if (!u) continue;
    cpuMilli += u.cpuMilli;
    memoryBytes += u.memoryBytes;
    known = true;
  }
  return {
    capacity: nodes.reduce((s, n) => add(s, n.capacity), ZERO),
    allocatable: nodes.reduce((s, n) => add(s, n.allocatable), ZERO),
    requested: nodes.reduce((s, n) => add(s, n.requested), ZERO),
    limits: nodes.reduce((s, n) => add(s, n.limits), ZERO),
    usage: known ? { cpuMilli, memoryBytes } : null,
  };
}

const pctOf = (part: number, whole: number) => (whole > 0 ? (part * 100) / whole : null);
const pctText = (p: number | null) => (p === null ? "–" : `${Math.round(p)}%`);

type Arc = { label: string; value: string; pct: number | null; color: string };

/** 할당 가능량 대비 비율을 겹친 고리로 그린다(바깥부터 arcs 순서). 100%를 넘으면 고리를 가득 채우고 글로 보인다 */
function Ring({ title, arcs, extra }: { title: string; arcs: Arc[]; extra: { label: string; value: string }[] }) {
  const head = arcs.find((a) => a.pct !== null) ?? null;
  return (
    <section className="k8s-cluster-card" aria-label={title}>
      <svg className="k8s-ring" viewBox="0 0 112 112" role="img" aria-label={`${title} ${head ? `${head.label} ${pctText(head.pct)}` : ""}`}>
        {arcs.map((arc, i) => {
          const r = 48 - i * 10;
          const c = 2 * Math.PI * r;
          const filled = Math.min(100, Math.max(0, arc.pct ?? 0)) / 100 * c;
          return (
            <g key={arc.label}>
              <circle className="k8s-ring-track" cx="56" cy="56" r={r} />
              {arc.pct !== null && filled > 0 && (
                <circle cx="56" cy="56" r={r} fill="none" stroke={arc.color} strokeWidth="7" strokeLinecap="butt"
                  strokeDasharray={`${filled} ${c}`} transform="rotate(-90 56 56)" />
              )}
            </g>
          );
        })}
        <text className="k8s-ring-value" x="56" y="58" textAnchor="middle">{head ? pctText(head.pct) : "–"}</text>
        <text className="k8s-ring-label" x="56" y="72" textAnchor="middle">{head?.label ?? ""}</text>
      </svg>
      <div>
        <h5>{title}</h5>
        <table className="k8s-ring-legend">
          <tbody>
            {arcs.map((arc) => (
              <tr key={arc.label}>
                <td><i className="k8s-usage-swatch" style={{ background: arc.color }} />{arc.label}</td>
                <td className="num">{arc.value}</td>
                <td className="num dim">{pctText(arc.pct)}</td>
              </tr>
            ))}
            {extra.map((row) => (
              <tr key={row.label}>
                <td><i className="k8s-usage-swatch k8s-swatch-empty" />{row.label}</td>
                <td className="num">{row.value}</td>
                <td />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const USAGE_COLOR = "var(--chart-blue)";
const REQUEST_COLOR = "var(--chart-green)";
const LIMIT_COLOR = "var(--chart-orange)";

/** 노드 수와 상태 요약 */
function NodeCounts({ nodes }: { nodes: K8sNodeView[] }) {
  const notReady = nodes.filter((n) => !n.ready).length;
  const cordoned = nodes.filter((n) => n.unschedulable).length;
  const pressured = nodes.filter((n) => n.pressures.length > 0).length;
  return (
    <div className="k8s-node-counts">
      <span className="k8s-chip">{t.nodeCount(nodes.length)}</span>
      <span className="k8s-chip">{`Ready ${nodes.length - notReady}`}</span>
      {notReady > 0 && <span className="k8s-chip warn">{`NotReady ${notReady}`}</span>}
      {cordoned > 0 && <span className="k8s-chip warn">{`${t.CORDONED} ${cordoned}`}</span>}
      {pressured > 0 && <span className="k8s-chip warn">{`${t.NODE_PRESSURE} ${pressured}`}</span>}
    </div>
  );
}

/**
 * Lens 개요처럼 클러스터 전체를 한눈에: 노드 상태, CPU·메모리·Pod 고리(사용량·요청·제한 / 할당 가능, 용량),
 * 앱이 모은 최근 1시간 클러스터 사용량.
 */
export function ClusterSummary({ nodes, live, historyKey, metrics }: {
  nodes: K8sNodeView[];
  /** 방금 읽은 노드 사용량(metrics-server). 없으면 개요를 읽을 때의 값 */
  live: Map<string, Usage> | null;
  historyKey: string;
  /** metrics-server로 노드 사용량을 읽을 수 있는지 */
  metrics: boolean;
}) {
  const totals = clusterTotals(nodes, live);
  const subscribe = useCallback((listener: () => void) => subscribeUsage(historyKey, listener), [historyKey]);
  const version = useSyncExternalStore(subscribe, () => usageVersion(historyKey));
  const trend = useMemo(() => clusterTrend(historyKey), [historyKey, version]);
  const { allocatable: a, capacity, requested, limits, usage } = totals;
  const cpuArcs: Arc[] = [
    { label: t.SEC_USAGE, value: usage ? formatCpu(usage.cpuMilli) : "–", pct: usage ? pctOf(usage.cpuMilli, a.cpuMilli) : null, color: USAGE_COLOR },
    { label: t.USAGE_REQUEST, value: formatCpu(requested.cpuMilli), pct: pctOf(requested.cpuMilli, a.cpuMilli), color: REQUEST_COLOR },
    { label: t.USAGE_LIMIT, value: formatCpu(limits.cpuMilli), pct: pctOf(limits.cpuMilli, a.cpuMilli), color: LIMIT_COLOR },
  ];
  const memoryArcs: Arc[] = [
    { label: t.SEC_USAGE, value: usage ? formatBytes(usage.memoryBytes) : "–", pct: usage ? pctOf(usage.memoryBytes, a.memoryBytes) : null, color: USAGE_COLOR },
    { label: t.USAGE_REQUEST, value: formatBytes(requested.memoryBytes), pct: pctOf(requested.memoryBytes, a.memoryBytes), color: REQUEST_COLOR },
    { label: t.USAGE_LIMIT, value: formatBytes(limits.memoryBytes), pct: pctOf(limits.memoryBytes, a.memoryBytes), color: LIMIT_COLOR },
  ];
  const refs = (cpu: boolean): Reference[] => [
    { name: t.CLUSTER, label: t.USAGE_REQUEST, value: cpu ? requested.cpuMilli / 1000 : requested.memoryBytes, limit: false },
    { name: t.CLUSTER, label: t.USAGE_ALLOCATABLE, value: cpu ? a.cpuMilli / 1000 : a.memoryBytes, limit: true },
  ];
  const series = (cpu: boolean) => (trend ? [{ name: t.CLUSTER, points: trend.at.map((at, i): [number, number] => [at, cpu ? trend.cpu[i] : trend.memory[i]]) }] : []);
  return (
    <>
      <NodeCounts nodes={nodes} />
      <div className="k8s-cluster-cards">
        <Ring title={t.COL_CPU} arcs={cpuArcs} extra={[{ label: t.USAGE_ALLOCATABLE, value: formatCpu(a.cpuMilli) }, { label: t.USAGE_CAPACITY, value: formatCpu(capacity.cpuMilli) }]} />
        <Ring title={t.COL_MEMORY} arcs={memoryArcs} extra={[{ label: t.USAGE_ALLOCATABLE, value: formatBytes(a.memoryBytes) }, { label: t.USAGE_CAPACITY, value: formatBytes(capacity.memoryBytes) }]} />
        <Ring
          title="Pod"
          arcs={[{ label: t.PODS_RUNNING, value: String(requested.pods), pct: pctOf(requested.pods, a.pods), color: USAGE_COLOR }]}
          extra={[{ label: t.USAGE_ALLOCATABLE, value: String(a.pods) }, { label: t.USAGE_CAPACITY, value: String(capacity.pods) }]}
        />
      </div>
      {/* metrics-server가 없다는 안내는 노드 절이 한 번만 한다 */}
      {!metrics ? null : trend === null ? (
        <p className="dim">{t.USAGE_GRAPH_WAITING}</p>
      ) : (
        <>
          <p className="dim small">{t.CLUSTER_GRAPH_NOTE}</p>
          <div className="k8s-usage-charts">
            <UsageChart title={t.COL_CPU} series={series(true)} refs={refs(true)} end={trend.end} cpu />
            <UsageChart title={t.COL_MEMORY} series={series(false)} refs={refs(false)} end={trend.end} cpu={false} />
          </div>
        </>
      )}
    </>
  );
}

const WARNINGS_MAX = 8;

/** 클러스터 전체의 최근 Warning 이벤트 몇 개와 이벤트 화면으로 가는 단추 */
export function RecentWarnings({ target, context, sessionEpoch, ssoProfile, live, onOpenEvents, actionLabel, now }: {
  target: K8sTarget; context: string; sessionEpoch: number; ssoProfile: string; live: boolean; onOpenEvents: () => void;
  /** 단추 글. 없으면 이벤트 화면으로 가는 글 */
  actionLabel?: string;
  now?: number;
}) {
  const w = useK8sWatch(target, context, sessionEpoch, ssoProfile, EVENTS, null, live);
  const warnings = useMemo(
    () => w.rows.filter((r) => r.values.type === "Warning").sort((x, y) => (y.values.lastSeen ?? "").localeCompare(x.values.lastSeen ?? "")),
    [w.rows],
  );
  const at = now ?? Date.now();
  return (
    <>
      {w.error && <K8sError error={w.error} target={target} ssoProfile={ssoProfile} compact />}
      {w.status === "loading" ? (
        <div className="empty small">{t.LOADING}</div>
      ) : warnings.length === 0 ? (
        <p className="dim">{t.NO_WARNINGS}</p>
      ) : (
        <table className="k8s-table" aria-label={t.SEC_WARNINGS}>
          <thead>
            <tr><th>{t.H_TIME}</th><th>{t.H_REASON}</th><th>{t.H_OBJECT}</th><th>{t.H_MESSAGE}</th></tr>
          </thead>
          <tbody>
            {warnings.slice(0, WARNINGS_MAX).map((r) => (
              <tr key={r.uid} className="k8s-warn">
                <td title={r.values.lastSeen ?? ""}>{age(r.values.lastSeen ?? null, at)}</td>
                <td>{r.values.reason ?? ""}</td>
                <td className="mono">{r.namespace ? `${r.namespace}/${r.values.object ?? ""}` : r.values.object ?? ""}</td>
                <td>{r.values.message ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="k8s-actions">
        <button className="btn tone-nav" onClick={onOpenEvents}>{actionLabel ?? t.warningsMore(warnings.length)}</button>
      </div>
    </>
  );
}
