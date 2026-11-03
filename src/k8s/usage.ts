import type { K8sContainerUsage, K8sKindRef, K8sMetrics, K8sMetricsUnavailable, K8sRow } from "./types";

/** 사용량을 다시 읽는 간격 */
export const METRICS_INTERVAL_MS = 15_000;
/** 요청·제한·할당 가능량의 이 비율을 넘으면 눈에 띄게 표시한다(백엔드 metrics.rs의 HOT_PERCENT와 같다) */
export const HOT_PCT = 90;

export interface Usage {
  cpuMilli: number;
  memoryBytes: number;
}

export interface WorkloadUsage extends Usage {
  pods: number;
}

export interface UsageIndex {
  /** 키: `네임스페이스/이름` */
  pods: Map<string, Usage>;
  /** 키: podKey. Pod 안 컨테이너별 사용량 */
  containers: Map<string, K8sContainerUsage[]>;
  nodes: Map<string, Usage>;
  /** 키: workloadKey. Pod의 컨트롤러 사슬을 따라 올라가며 더한 값 */
  workloads: Map<string, WorkloadUsage>;
  podsUnavailable: K8sMetricsUnavailable | null;
  nodesUnavailable: K8sMetricsUnavailable | null;
}

export const podKey = (namespace: string, name: string) => `${namespace}/${name}`;
export const workloadKey = (kind: string, namespace: string, name: string) => `${kind}|${namespace}|${name}`;

export function buildUsageIndex(m: K8sMetrics): UsageIndex {
  const pods = new Map<string, Usage>();
  const containers = new Map<string, K8sContainerUsage[]>();
  const workloads = new Map<string, WorkloadUsage>();
  for (const p of m.pods) {
    pods.set(podKey(p.namespace, p.name), { cpuMilli: p.cpuMilli, memoryBytes: p.memoryBytes });
    containers.set(podKey(p.namespace, p.name), p.containers);
    for (const o of p.owners) {
      const key = workloadKey(o.kind, p.namespace, o.name);
      const sum = workloads.get(key) ?? { cpuMilli: 0, memoryBytes: 0, pods: 0 };
      sum.cpuMilli += p.cpuMilli;
      sum.memoryBytes += p.memoryBytes;
      sum.pods += 1;
      workloads.set(key, sum);
    }
  }
  return {
    pods,
    containers,
    workloads,
    nodes: new Map(m.nodes.map((n) => [n.name, { cpuMilli: n.cpuMilli, memoryBytes: n.memoryBytes }])),
    podsUnavailable: m.podsUnavailable,
    nodesUnavailable: m.nodesUnavailable,
  };
}

/** 사용량 / 기준 × 100. 기준이 없거나 0이면 null(비워 둔다) */
export function pct(used: number, base: number | null): number | null {
  return base !== null && base > 0 ? (used * 100) / base : null;
}

export const isHot = (p: number | null) => p !== null && p > HOT_PCT;

/** 줄의 값에 든 정수 글(밀리코어·바이트). 없거나 숫자가 아니면 null */
export function numValue(row: K8sRow, key: string): number | null {
  const v = row.values[key];
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export type UsageKind = "pod" | "node" | "workload";

/** 목록에 사용량 열을 붙이는 종류. 그 밖의 종류는 null */
export function usageKindOf(kind: K8sKindRef): UsageKind | null {
  if (kind.group === "" && kind.kind === "Pod") return "pod";
  if (kind.group === "" && kind.kind === "Node") return "node";
  if (kind.group === "apps" && ["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet"].includes(kind.kind)) return "workload";
  if (kind.group === "batch" && ["Job", "CronJob"].includes(kind.kind)) return "workload";
  return null;
}

/** 이 종류의 사용량을 읽지 못하는 까닭. 읽을 수 있으면 null */
export function unavailableFor(kind: K8sKindRef, usage: UsageIndex): K8sMetricsUnavailable | null {
  const k = usageKindOf(kind);
  if (k === null) return null;
  return k === "node" ? usage.nodesUnavailable : usage.podsUnavailable;
}

export interface NamespaceUsage extends Usage {
  namespace: string;
  pods: number;
}

/** 네임스페이스별 Pod 사용량의 합 */
export function namespaceTotals(m: K8sMetrics): NamespaceUsage[] {
  const by = new Map<string, NamespaceUsage>();
  for (const p of m.pods) {
    const t = by.get(p.namespace) ?? { namespace: p.namespace, cpuMilli: 0, memoryBytes: 0, pods: 0 };
    t.cpuMilli += p.cpuMilli;
    t.memoryBytes += p.memoryBytes;
    t.pods += 1;
    by.set(p.namespace, t);
  }
  return [...by.values()];
}

/** 위에서 `limit`개: 큰 것부터, 같으면 이름 순 */
export function top(totals: NamespaceUsage[], by: "cpuMilli" | "memoryBytes", limit: number): NamespaceUsage[] {
  return [...totals].sort((a, b) => b[by] - a[by] || a.namespace.localeCompare(b.namespace)).slice(0, limit);
}
