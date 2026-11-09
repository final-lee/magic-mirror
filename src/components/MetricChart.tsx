import { formatBytes } from "../lib/format";
import type { MetricChart as Chart, MetricUnit } from "../api/types";

const COLORS = ["var(--accent)", "var(--green)", "var(--yellow)", "var(--red)", "var(--syntax-property)", "var(--syntax-number)"];
const EMPTY = "데이터 없음";

const compact = (n: number) => n.toLocaleString("ko-KR", { maximumFractionDigits: n < 10 ? 2 : n < 100 ? 1 : 0, notation: Math.abs(n) >= 100_000 ? "compact" : "standard" });

/** 단위에 맞춘 값 글 */
export function formatMetric(value: number, unit: MetricUnit): string {
  switch (unit) {
    case "percent":
      return `${compact(value)}%`;
    case "bytes":
      return formatBytes(value);
    case "bytesPerSecond":
      return `${formatBytes(value)}/초`;
    case "countPerSecond":
      return `${compact(value)}/초`;
    case "seconds":
      return value > 0 && value < 1 ? `${compact(value * 1000)}ms` : `${compact(value)}초`;
    case "milliseconds":
      return value < 1000 ? `${compact(value)}ms` : `${compact(value / 1000)}초`;
    case "microseconds":
      return value < 1000 ? `${compact(value)}µs` : `${compact(value / 1000)}ms`;
    case "count":
      return compact(value);
  }
}

/** 축의 시각: 하루를 넘는 구간이면 월/일, 아니면 시:분 */
function timeLabel(ms: number, long: boolean): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return long ? `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}` : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 간격의 두 배 넘게 비면 선을 끊는다(그 사이에 값이 없었다) */
function segments(times: number[], values: number[], periodMs: number): [number, number][][] {
  const out: [number, number][][] = [];
  times.forEach((t, i) => {
    const last = out[out.length - 1];
    if (!last || t - last[last.length - 1][0] > periodMs * 2) out.push([]);
    out[out.length - 1].push([t, values[i]]);
  });
  return out;
}

/** CloudWatch 지표 하나의 선 그래프: 제목(지표·통계), 세로 눈금, 시작·끝 시각, 선이 여럿이면 범례와 최근 값 */
export function MetricChart({ chart, start, end, period }: { chart: Chart; start: number; end: number; period: number }) {
  const title = `${chart.metric} · ${chart.stat}`;
  const all = chart.series.flatMap((s) => s.values);
  if (all.length === 0) {
    return (
      <div className="metric-chart">
        <h5>{title}</h5>
        <div className="metric-empty dim">{EMPTY}</div>
      </div>
    );
  }
  const max = Math.max(...all);
  const min = Math.min(0, ...all);
  const top = max === min ? min + 1 : max;
  const x = (t: number) => ((t - start) / Math.max(1, end - start)) * 600;
  const y = (v: number) => 120 - ((v - min) / (top - min)) * 120;
  const long = end - start > 86_400_000;
  const latest = (values: number[]) => (values.length ? formatMetric(values[values.length - 1], chart.unit) : "—");
  return (
    <div className="metric-chart">
      <h5>
        {title}
        {chart.series.length === 1 && <span className="dim metric-latest">{latest(chart.series[0].values)}</span>}
      </h5>
      <div className="metric-plot">
        <div className="metric-y dim">
          <span>{formatMetric(top, chart.unit)}</span>
          <span>{formatMetric(min + (top - min) / 2, chart.unit)}</span>
          <span>{formatMetric(min, chart.unit)}</span>
        </div>
        <svg viewBox="0 0 600 120" preserveAspectRatio="none" role="img" aria-label={title}>
          {[0, 60, 120].map((p) => (
            <line key={p} className="metric-grid" x1="0" x2="600" y1={p} y2={p} />
          ))}
          {chart.series.map((s, i) =>
            segments(s.times, s.values, period * 1000).map((part, j) =>
              part.length === 1 ? (
                <circle key={`${i}-${j}`} cx={x(part[0][0])} cy={y(part[0][1])} r="2" fill={COLORS[i % COLORS.length]} />
              ) : (
                <polyline
                  key={`${i}-${j}`}
                  points={part.map(([t, v]) => `${x(t)},${y(v)}`).join(" ")}
                  fill="none"
                  stroke={COLORS[i % COLORS.length]}
                  strokeWidth="1.6"
                  vectorEffect="non-scaling-stroke"
                />
              ),
            ),
          )}
        </svg>
        <div className="metric-x dim">
          <span>{timeLabel(start, long)}</span>
          <span>{timeLabel(end, long)}</span>
        </div>
      </div>
      {chart.series.length > 1 && (
        <div className="metric-legend">
          {chart.series.map((s, i) => (
            <span key={s.label}>
              <i style={{ background: COLORS[i % COLORS.length] }} />
              {s.label} <span className="dim">{latest(s.values)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
