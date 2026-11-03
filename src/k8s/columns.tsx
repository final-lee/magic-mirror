import type { ListColumn } from "../iam/ListTable";
import { age, formatBytes, formatCpu } from "./format";
import { BUILTIN } from "./kinds";
import { kindKey } from "./targets";
import {
  COL_AGE, COL_CPU, COL_CPU_OF_ALLOCATABLE, COL_CPU_OF_LIMIT, COL_CPU_OF_REQUEST, COL_MEMORY, COL_MEMORY_OF_ALLOCATABLE, COL_MEMORY_OF_LIMIT,
  COL_MEMORY_OF_REQUEST, COL_NAME, COL_NAMESPACE, COL_PROBLEMS, COLUMN_LABELS, PROBLEM_LABELS,
} from "./text";
import type { K8sKindRef, K8sProblem, K8sRow } from "./types";
import { isHot, numValue, pct, podKey, unavailableFor, usageKindOf, workloadKey, type Usage, type UsageIndex } from "./usage";
import { HISTORY_MS, splitAtGaps, type PodTrend } from "./usageHistory";

/** 목록 줄의 Pod 사용량 기록. 앱이 아직 모으지 않았으면 null */
export type TrendOf = (namespace: string, name: string) => PodTrend | null;

/** 그래프 좌표계. 칸 크기에 맞춰 늘어난다(preserveAspectRatio none) */
const TREND_W = 100;
const TREND_H = 20;
/** 세로 눈금: 10분마다 */
const TREND_GRID = [1, 2, 3, 4, 5].map((i) => (i * TREND_W) / 6);

/**
 * 비율 칸의 작은 그래프(작업 관리자처럼 테두리·눈금 안에 면과 선): 최근 1시간의 비율(%) 추이.
 * 세로축은 0~100%이고 넘으면 최대치까지 늘리며 그때 100%를 점선으로 보인다.
 */
function TrendLine({ points, end, hot }: { points: [number, number][]; end: number; hot: boolean }) {
  const max = Math.max(100, ...points.map(([, value]) => value));
  const start = end - HISTORY_MS;
  const x = (at: number) => Math.max(0, ((at - start) / HISTORY_MS) * TREND_W);
  const y = (value: number) => TREND_H - (value / max) * TREND_H;
  return (
    <svg className={hot ? "k8s-trend hot" : "k8s-trend"} viewBox={`0 0 ${TREND_W} ${TREND_H}`} preserveAspectRatio="none" aria-hidden="true">
      {TREND_GRID.map((gx) => <line key={gx} className="k8s-trend-grid" x1={gx} x2={gx} y1="0" y2={TREND_H} />)}
      <line className="k8s-trend-grid" x1="0" x2={TREND_W} y1={TREND_H / 2} y2={TREND_H / 2} />
      {max > 100 && <line className="k8s-trend-guide" x1="0" x2={TREND_W} y1={y(100)} y2={y(100)} />}
      {splitAtGaps(points).map((part) => {
        // 값이 하나뿐인 구간도 보이게 조금 앞에서 시작하는 짧은 선으로 그린다
        const coords = part.map(([at, value]) => [x(at), y(value)] as const);
        const line = coords.length === 1 ? [[Math.max(0, coords[0][0] - 1), coords[0][1]] as const, coords[0]] : coords;
        const text = line.map(([px, py]) => `${px},${py}`).join(" ");
        return (
          <g key={part[0][0]}>
            <polygon className="k8s-trend-area" points={`${line[0][0]},${TREND_H} ${text} ${line[line.length - 1][0]},${TREND_H}`} />
            <polyline className="k8s-trend-line" points={text} />
          </g>
        );
      })}
    </svg>
  );
}

/** 종류별 값 열. 키는 백엔드 read/values.rs가 채우는 키다. */
const KIND_COLUMNS: Record<string, string[]> = {
  "/v1/pods": ["ready", "status", "restarts", "node", "ip"],
  "apps/v1/deployments": ["ready", "upToDate", "available"],
  "apps/v1/statefulsets": ["ready"],
  "apps/v1/daemonsets": ["desired", "current", "ready", "upToDate", "available"],
  "apps/v1/replicasets": ["desired", "current", "ready"],
  "batch/v1/jobs": ["completions", "status"],
  "batch/v1/cronjobs": ["schedule", "suspend", "active", "lastSchedule"],
  "/v1/services": ["type", "clusterIp", "externalIp", "ports"],
  "networking.k8s.io/v1/ingresses": ["class", "hosts", "address"],
  "networking.k8s.io/v1/networkpolicies": ["podSelector", "policyTypes"],
  "/v1/endpoints": ["endpoints"],
  "/v1/configmaps": ["keys"],
  "/v1/secrets": ["type", "keys"],
  "/v1/serviceaccounts": ["roleArn"],
  "/v1/persistentvolumeclaims": ["status", "volume", "capacity", "accessModes", "storageClass"],
  "/v1/persistentvolumes": ["capacity", "accessModes", "reclaimPolicy", "status", "claim", "storageClass"],
  "storage.k8s.io/v1/storageclasses": ["provisioner", "reclaimPolicy", "volumeBindingMode", "default"],
  "/v1/namespaces": ["status"],
  "/v1/nodes": ["status", "version", "instanceType", "zone", "group"],
  "autoscaling/v2/horizontalpodautoscalers": ["target", "min", "max", "current", "desired", "metrics"],
  "policy/v1/poddisruptionbudgets": ["minAvailable", "maxUnavailable", "disruptionsAllowed", "healthy"],
  "discovery.k8s.io/v1/endpointslices": ["addressType", "endpointReady", "ports"],
  "networking.k8s.io/v1/ingressclasses": ["controller", "default"],
  "/v1/resourcequotas": ["quota"],
  "/v1/limitranges": ["limits"],
  "rbac.authorization.k8s.io/v1/roles": ["ruleCount"],
  "rbac.authorization.k8s.io/v1/clusterroles": ["ruleCount", "aggregation"],
  "rbac.authorization.k8s.io/v1/rolebindings": ["roleRef", "subjects"],
  "rbac.authorization.k8s.io/v1/clusterrolebindings": ["roleRef", "subjects"],
  "scheduling.k8s.io/v1/priorityclasses": ["value", "globalDefault", "preemption"],
  "node.k8s.io/v1/runtimeclasses": ["handler"],
  "coordination.k8s.io/v1/leases": ["holder", "renewTime"],
  "admissionregistration.k8s.io/v1/mutatingwebhookconfigurations": ["webhookCount", "failurePolicy"],
  "admissionregistration.k8s.io/v1/validatingwebhookconfigurations": ["webhookCount", "failurePolicy"],
  "apiextensions.k8s.io/v1/customresourcedefinitions": ["apiGroup", "versions", "scope", "established"],
};

/** 내장 종류는 표대로, 그 밖의 종류(사용자 정의)는 Ready 조건 하나 */
export function valueKeys(kind: K8sKindRef): string[] {
  const builtin = BUILTIN.find((b) => b.group === kind.group && b.plural === kind.plural);
  const known = KIND_COLUMNS[kindKey(kind)] ?? (builtin && KIND_COLUMNS[kindKey(builtin)]);
  if (known) return known;
  return builtin ? [] : ["ready"];
}

export function Problems({ problems }: { problems: K8sProblem[] }) {
  if (problems.length === 0) return null;
  return (
    <span className="k8s-problems">
      {problems.map((p) => (
        <span key={p} className="k8s-problem">
          {PROBLEM_LABELS[p]}
        </span>
      ))}
    </span>
  );
}

/**
 * 비율 칸. 기준이 없으면 비우고, 90%를 넘으면 눈에 띄게 한다.
 * trend가 있으면 칸을 채우는 작은 추이 그래프 위에 숫자를 얹는다(아직 모은 값이 없으면 빈 그래프 틀만).
 */
export function Percent({ value, trend }: { value: number | null; trend?: { points: [number, number][]; end: number } | null }) {
  if (value === null) return null;
  const hot = isHot(value);
  const text = <span className={hot ? "k8s-hot" : undefined}>{`${Math.round(value)}%`}</span>;
  if (!trend) return text;
  return (
    <span className="k8s-trend-cell">
      <TrendLine points={trend.points} end={trend.end} hot={hot} />
      {text}
    </span>
  );
}

/** 이 줄의 사용량. metrics-server가 아직 모르는 객체(방금 만든 Pod, 사용량이 없는 워크로드)는 null */
function usageOf(kind: K8sKindRef, usage: UsageIndex, r: K8sRow): Usage | null {
  switch (usageKindOf(kind)) {
    case "pod":
      return usage.pods.get(podKey(r.namespace ?? "", r.name)) ?? null;
    case "node":
      return usage.nodes.get(r.name) ?? null;
    case "workload":
      return usage.workloads.get(workloadKey(kind.kind, r.namespace ?? "", r.name)) ?? null;
    default:
      return null;
  }
}

/**
 * 사용량 열. 읽을 수 없거나 사용량을 붙이지 않는 종류면 열을 만들지 않는다(빈 열을 두지 않는다).
 * Pod: CPU·메모리와 요청·제한 대비 %(k9s의 %CPU/R, %CPU/L, %MEM/R, %MEM/L, trendOf가 있으면 최근 추이 그래프와 함께), 노드: 할당 가능량 대비 %, 워크로드: Pod 사용량의 합.
 */
export function usageColumns(kind: K8sKindRef, usage: UsageIndex | null | undefined, trendOf?: TrendOf | null): ListColumn<K8sRow>[] {
  const k = usageKindOf(kind);
  if (!usage || k === null || unavailableFor(kind, usage) !== null) return [];
  const used = (r: K8sRow) => usageOf(kind, usage, r);
  const cols: ListColumn<K8sRow>[] = [
    { key: "u:cpu", label: COL_CPU, numeric: true, render: (r) => { const u = used(r); return u ? formatCpu(u.cpuMilli) : ""; }, sort: (r) => used(r)?.cpuMilli ?? null },
    { key: "u:memory", label: COL_MEMORY, numeric: true, render: (r) => { const u = used(r); return u ? formatBytes(u.memoryBytes) : ""; }, sort: (r) => used(r)?.memoryBytes ?? null },
  ];
  const ratio = (key: string, label: string, pick: (u: Usage) => number, base: string, pickTrend?: (t: PodTrend, i: number) => number): ListColumn<K8sRow> => {
    const value = (r: K8sRow) => { const u = used(r); return u ? pct(pick(u), numValue(r, base)) : null; };
    // 지금의 요청·제한을 기준으로 모아 둔 사용량의 비율을 다시 셈한다. 기록을 모으는 중인데 이 Pod의 값이 아직 없으면 빈 그래프
    const trend = (r: K8sRow) => {
      const b = numValue(r, base);
      if (!pickTrend || !trendOf || b === null || b <= 0) return null;
      const t = trendOf(r.namespace ?? "", r.name);
      if (!t) return { points: [], end: 0 };
      return { points: t.at.map((at, i): [number, number] => [at, (pickTrend(t, i) * 100) / b]), end: t.end };
    };
    return { key, label, numeric: true, render: (r) => <Percent value={value(r)} trend={trend(r)} />, sort: value };
  };
  const cpu = (u: Usage) => u.cpuMilli;
  const memory = (u: Usage) => u.memoryBytes;
  const cpuTrend = (t: PodTrend, i: number) => t.cpu[i] * 1000;
  const memoryTrend = (t: PodTrend, i: number) => t.memory[i];
  if (k === "pod") {
    cols.push(
      ratio("u:cpuRequest", COL_CPU_OF_REQUEST, cpu, "cpuRequest", cpuTrend),
      ratio("u:cpuLimit", COL_CPU_OF_LIMIT, cpu, "cpuLimit", cpuTrend),
      ratio("u:memoryRequest", COL_MEMORY_OF_REQUEST, memory, "memoryRequest", memoryTrend),
      ratio("u:memoryLimit", COL_MEMORY_OF_LIMIT, memory, "memoryLimit", memoryTrend),
    );
  } else if (k === "node") {
    cols.push(ratio("u:cpuAllocatable", COL_CPU_OF_ALLOCATABLE, cpu, "cpuAllocatable"), ratio("u:memoryAllocatable", COL_MEMORY_OF_ALLOCATABLE, memory, "memoryAllocatable"));
  }
  return cols;
}

export function columnsFor(kind: K8sKindRef, showNamespace: boolean, now: number, usage?: UsageIndex | null, trendOf?: TrendOf | null): ListColumn<K8sRow>[] {
  const cols: ListColumn<K8sRow>[] = [{ key: "name", label: COL_NAME, render: (r) => <span className="mono">{r.name}</span>, sort: (r) => r.name }];
  if (showNamespace && kind.namespaced) cols.push({ key: "namespace", label: COL_NAMESPACE, render: (r) => r.namespace ?? "", sort: (r) => r.namespace ?? "" });
  for (const key of valueKeys(kind)) {
    cols.push({ key: `v:${key}`, label: COLUMN_LABELS[key] ?? key, render: (r) => r.values[key] ?? "", sort: (r) => r.values[key] ?? null });
  }
  cols.push(...usageColumns(kind, usage, trendOf));
  cols.push({ key: "problems", label: COL_PROBLEMS, render: (r) => <Problems problems={r.problems} />, sort: (r) => r.problems.length });
  cols.push({ key: "age", label: COL_AGE, render: (r) => age(r.createdAt, now), sort: (r) => (r.createdAt ? Date.parse(r.createdAt) : null) });
  return cols;
}
