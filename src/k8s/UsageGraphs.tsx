import { useSyncExternalStore } from "react";
import * as t from "./text";
import type { K8sContainer, K8sObjectView, K8sTarget, ObjectRef } from "./types";
import { numValue } from "./usage";
import { HISTORY_MS, historyKey, splitAtGaps, subscribeUsage, usageOf, usageVersion, type UsageSeries } from "./usageHistory";

/** 그래프의 기준선. name이 선 이름과 같으면 그 선의 색, label은 범례 글(예: "web 요청"), limit이면 긴 점선 */
export type Reference = { name: string; label: string; value: number; limit: boolean };
const COLORS = Array.from({ length: 8 }, (_, i) => `var(--log-c${i + 1})`);

/** 상세가 읽은 요청·제한을 그래프 단위로 바꾼다. 워크로드는 Pod 템플릿 합계다. */
function references(containers: K8sContainer[], pod: boolean, cpu: boolean): Reference[] {
  const relevant = containers.filter((c) => !c.init && (pod ? c.state !== "template" : c.state === "template"));
  const result: Reference[] = [];
  if (!relevant.length) return result;
  for (const limit of [false, true]) {
    const values = relevant.map((c) => {
      const value = cpu ? (limit ? c.cpuLimit : c.cpuRequest) : (limit ? c.memoryLimit : c.memoryRequest);
      return { name: c.name, value: value == null ? null : cpu ? value / 1000 : value };
    });
    if (pod) {
      for (const item of values) {
        if (item.value !== null) result.push({ name: item.name, label: `${item.name} ${limit ? t.USAGE_LIMIT : t.USAGE_REQUEST}`, value: item.value, limit });
      }
    } else if (values.every((item) => item.value !== null)) {
      result.push({ name: "Pod", label: `Pod ${limit ? t.USAGE_LIMIT : t.USAGE_REQUEST}`, value: values.reduce((sum, item) => sum + (item.value ?? 0), 0), limit });
    }
  }
  return result;
}

/** 축의 같은 단위를 유지하면서 밀리코어 또는 MiB/GiB로 표시한다. */
function axisValue(value: number, max: number, cpu: boolean): string {
  const scale = cpu ? (max < 1 ? 1000 : 1) : (max >= 1024 ** 3 ? 1 / 1024 ** 3 : 1 / 1024 ** 2);
  const unit = cpu ? (max < 1 ? "m" : " 코어") : (max >= 1024 ** 3 ? " GiB" : " MiB");
  return `${(value * scale).toLocaleString(undefined, { maximumFractionDigits: 2 })}${unit}`;
}

/** 시:분 */
function timeLabel(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 모은 값과 요청·제한(기준선)을 최근 HISTORY_MS 축 위에 그리고 범례와 눈금을 붙인다 */
export function UsageChart({ title, series, refs, end, cpu }: {
  title: string; series: UsageSeries[]; refs: Reference[]; end: number; cpu: boolean;
}) {
  const points = series.flatMap((s) => s.points);
  if (!points.length) {
    return (
      <div className="k8s-usage-chart">
        <h5>{title}</h5>
        <div className="empty small">{t.USAGE_GRAPH_EMPTY}</div>
      </div>
    );
  }
  const start = end - HISTORY_MS;
  const max = Math.max(1e-12, ...points.map(([, value]) => value), ...refs.map((r) => r.value));
  const x = (value: number) => Math.max(0, Math.min(600, (value - start) / (end - start) * 600));
  const y = (value: number) => 150 - Math.max(0, value) / max * 150;
  return (
    <div className="k8s-usage-chart">
      <h5>{title}</h5>
      <div className="k8s-usage-plot">
        <div className="k8s-usage-y-axis dim">
          {[max, max / 2, 0].map((value, i) => <span key={i}>{axisValue(value, max, cpu)}</span>)}
        </div>
        <svg viewBox="0 0 600 150" preserveAspectRatio="none" role="img" aria-label={title}>
          {[0, 75, 150].map((position) => (
            <line key={position} className="k8s-usage-grid" x1="0" x2="600" y1={position} y2={position} />
          ))}
          {refs.map((ref) => {
            const index = series.findIndex((s) => s.name === ref.name);
            const color = index < 0 ? "var(--dim)" : COLORS[index % COLORS.length];
            return (
              <line
                key={ref.label}
                x1="0" x2="600" y1={y(ref.value)} y2={y(ref.value)}
                stroke={color} strokeDasharray={ref.limit ? "6 3" : "2 3"}
                vectorEffect="non-scaling-stroke"
              >
                <title>{`${ref.label}: ${axisValue(ref.value, max, cpu)}`}</title>
              </line>
            );
          })}
          {series.map((item, i) => splitAtGaps(item.points).map((part, j) => (
            part.length === 1 ? (
              <circle
                key={`${item.name}-${j}`}
                cx={x(part[0][0])} cy={y(part[0][1])} r="2"
                fill={COLORS[i % COLORS.length]}
              >
                <title>{item.name}</title>
              </circle>
            ) : (
              <polyline
                key={`${item.name}-${j}`}
                points={part.map(([time, value]) => `${x(time)},${y(value)}`).join(" ")}
                fill="none" stroke={COLORS[i % COLORS.length]} strokeWidth="2" vectorEffect="non-scaling-stroke"
              >
                <title>{item.name}</title>
              </polyline>
            )
          )))}
        </svg>
        <div className="k8s-usage-x-axis dim">
          <span>{timeLabel(start)}</span>
          <span>{timeLabel(end)}</span>
        </div>
      </div>
      <div className="k8s-usage-legend">
        {series.map((item, i) => (
          <span key={item.name}>
            <i className="k8s-usage-swatch" style={{ background: COLORS[i % COLORS.length] }} />
            {item.name}
          </span>
        ))}
      </div>
      {refs.length > 0 && (
        <div className="dim">
          {refs.map((ref) =>
            `${ref.label}: ${axisValue(ref.value, max, cpu)}`,
          ).join(" · ")}
        </div>
      )}
    </div>
  );
}

/** 노드의 할당 가능량 기준선(목록 줄 값: 밀리코어·바이트) */
function allocatable(view: K8sObjectView, name: string, cpu: boolean): Reference[] {
  const value = numValue(view.row, cpu ? "cpuAllocatable" : "memoryAllocatable");
  return value === null ? [] : [{ name, label: t.USAGE_ALLOCATABLE, value: cpu ? value / 1000 : value, limit: true }];
}

/** Pod·워크로드·노드 상세 요약의 사용량 절: 앱이 metrics-server로부터 모아 둔 최근 사용량 */
export function UsageGraphs({ target, context, objectRef, view }: {
  target: K8sTarget; context: string; objectRef: ObjectRef; view: K8sObjectView;
}) {
  const key = historyKey(target, context);
  // 새 값을 모을 때마다 다시 그린다
  useSyncExternalStore((listener) => subscribeUsage(key, listener), () => usageVersion(key));
  const usage = usageOf(key, objectRef);
  const pod = objectRef.kind.kind === "Pod" && objectRef.kind.group === "";
  const node = objectRef.kind.kind === "Node" && objectRef.kind.group === "";
  const refs = (cpu: boolean) => (node ? allocatable(view, objectRef.name, cpu) : references(view.containers, pod, cpu));

  return (
    <section className="k8s-sect k8s-usage" aria-label={t.SEC_USAGE}>
      <h4>{t.SEC_USAGE}</h4>
      <p className="dim small">{t.USAGE_GRAPH_NOTE}</p>
      {usage.unavailable !== null ? (
        <div className="empty small">{t.METRICS_UNAVAILABLE[usage.unavailable]}</div>
      ) : usage.lastAt === null ? (
        <div className="empty small">{t.USAGE_GRAPH_WAITING}</div>
      ) : (
        <div className="k8s-usage-charts">
          <UsageChart title={t.COL_CPU} series={usage.cpu} refs={refs(true)} end={usage.lastAt} cpu />
          <UsageChart title={t.COL_MEMORY} series={usage.memory} refs={refs(false)} end={usage.lastAt} cpu={false} />
        </div>
      )}
    </section>
  );
}
