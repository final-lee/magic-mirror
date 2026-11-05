import { bucketLabel } from "./bull";
import { formatCount } from "./format";

interface BarsProps {
  completed: readonly number[];
  failed: readonly number[];
  width: number;
  height: number;
  /** 칸마다 마우스를 올리면 보이는 이름 */
  title?: (index: number, c: number, f: number) => string;
}

/** 칸마다 완료(초록)를 아래에, 실패(빨강)를 그 위에 쌓은 막대. 모두 0이면 바닥 선만 그린다. */
function StackedBars({ completed, failed, width, height, title }: BarsProps) {
  const n = Math.max(completed.length, failed.length);
  const sums = Array.from({ length: n }, (_, i) => (completed[i] ?? 0) + (failed[i] ?? 0));
  const max = Math.max(1, ...sums);
  const step = width / Math.max(1, n);
  const barW = Math.max(1, step - (step > 4 ? 1 : 0));
  return (
    <>
      <line className="kv-chart-base" x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} />
      {Array.from({ length: n }, (_, i) => {
        const c = completed[i] ?? 0;
        const f = failed[i] ?? 0;
        const ch = (c / max) * (height - 2);
        const fh = (f / max) * (height - 2);
        return (
          <g key={i}>
            {title && <title>{title(i, c, f)}</title>}
            {c > 0 && <rect className="kv-bar-c" x={i * step} y={height - 1 - ch} width={barW} height={ch} />}
            {f > 0 && <rect className="kv-bar-f" x={i * step} y={height - 1 - ch - fh} width={barW} height={fh} />}
          </g>
        );
      })}
    </>
  );
}

/** 큐 카드의 작은 처리량 그림(최근 60분) */
export function Sparkline({ completed, failed, label }: { completed: readonly number[]; failed: readonly number[]; label: string }) {
  return (
    <svg className="kv-spark" viewBox="0 0 120 28" preserveAspectRatio="none" role="img" aria-label={label}>
      <StackedBars completed={completed} failed={failed} width={120} height={28} />
    </svg>
  );
}

interface ChartProps {
  completed: readonly number[];
  failed: readonly number[];
  /** 왼쪽 끝 칸의 이름(예: "14:03")과 오른쪽 끝 이름 */
  from: string;
  to: string;
  label: string;
  title?: (index: number, c: number, f: number) => string;
}

/** 큐 상세의 처리량 막대 그림. 왼쪽 위에 가장 큰 칸의 값, 아래에 시간 축 두 끝이 있다. */
export function ThroughputChart({ completed, failed, from, to, label, title }: ChartProps) {
  const max = Math.max(1, ...completed.map((c, i) => c + (failed[i] ?? 0)));
  return (
    <figure className="kv-chart">
      <svg viewBox="0 0 600 110" preserveAspectRatio="none" role="img" aria-label={label}>
        <StackedBars completed={completed} failed={failed} width={600} height={110} title={title} />
      </svg>
      <figcaption className="dim">
        <span>{from}</span>
        <span>{`${formatCount(max)}/칸`}</span>
        <span>{to}</span>
      </figcaption>
    </figure>
  );
}

/** 분포 그림: 한계 이하(≤)마다 가로 막대와 개수 */
export function Histogram({ buckets, label }: { buckets: readonly { upToMs: number; count: number }[]; label: string }) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <div className="kv-hist" role="group" aria-label={label}>
      {buckets.map((b) => (
        <div key={b.upToMs} className="kv-hist-row">
          <span className="dim mono kv-hist-label">{bucketLabel(b.upToMs)}</span>
          <span className="kv-hist-bar" aria-hidden="true">
            <span style={{ width: `${(b.count / max) * 100}%` }} />
          </span>
          <span className="mono num">{b.count}</span>
        </div>
      ))}
    </div>
  );
}
