import { useState } from "react";
import { amount, bucketTick, bucketTitle, formatMoney } from "./format";
import { CHART_EMPTY, CHART_LABEL, OTHER_SERIES } from "./text";
import type { CostOverview } from "./types";

/** 상위 서비스 5개와 "기타"의 색. 마지막이 기타다 */
export const SERIES_COLORS = ["#0a84ff", "#30d158", "#ff9f0a", "#bf5af2", "#ff375f", "#8e8e93"];

const SLOT = 20;
const GAP = 3;
const HEIGHT = 160;

/**
 * 일별(최근 6개월은 월별) 비용 막대. 상위 서비스와 기타를 아래부터 쌓는다.
 * 크레딧을 빼지 않으면 음수가 나올 수 있는데, 막대는 양수만 쌓고 툴팁에는 실제 값을 보여 준다.
 */
export function DailyChart({ overview: o }: { overview: CostOverview }) {
  const [hover, setHover] = useState<number | null>(null);
  const n = o.buckets.length;
  const names = [...o.series, OTHER_SERIES];
  const stacks = o.buckets.map((b) => [...b.values, b.other].map((v) => Math.max(0, amount(v))));
  const max = Math.max(0, ...stacks.map((s) => s.reduce((a, v) => a + v, 0)));
  // 기타는 서비스가 5개보다 적어도 늘 회색이다
  const color = (k: number) => SERIES_COLORS[k < o.series.length ? k : SERIES_COLORS.length - 1];
  if (n === 0 || max === 0) return <div className="empty small">{CHART_EMPTY}</div>;

  const hasOther = o.buckets.some((b) => amount(b.other) !== 0);
  const step = Math.max(1, Math.ceil(n / 12));
  const hovered = hover === null ? null : o.buckets[hover];

  return (
    <figure className="cost-chart" aria-label={CHART_LABEL}>
      <div className="cost-chart-max dim">{formatMoney(max, o.unit)}</div>
      <div className="cost-chart-plot">
        <svg viewBox={`0 0 ${n * SLOT} ${HEIGHT}`} preserveAspectRatio="none" width="100%" height={HEIGHT} onMouseLeave={() => setHover(null)}>
          {stacks.map((parts, i) => {
            let y = HEIGHT;
            return (
              <g key={o.buckets[i].start} opacity={hover === null || hover === i ? 1 : 0.55}>
                {parts.map((v, k) => {
                  const h = (v / max) * HEIGHT;
                  y -= h;
                  return h > 0 ? <rect key={k} x={i * SLOT + GAP} y={y} width={SLOT - 2 * GAP} height={h} fill={color(k)} /> : null;
                })}
                <rect
                  className="cost-hit"
                  x={i * SLOT}
                  y={0}
                  width={SLOT}
                  height={HEIGHT}
                  fill="transparent"
                  aria-label={`${bucketTitle(o.buckets[i].start, o.granularity)} ${formatMoney(o.buckets[i].total, o.unit)}`}
                  onMouseEnter={() => setHover(i)}
                />
              </g>
            );
          })}
        </svg>
        {hovered && hover !== null && (
          <div
            className="cost-tip"
            role="tooltip"
            style={hover < n / 2 ? { left: `${((hover + 1) / n) * 100}%` } : { right: `${((n - hover) / n) * 100}%` }}
          >
            <b>{bucketTitle(hovered.start, o.granularity)}</b>
            <table>
              <tbody>
                {[...hovered.values, hovered.other].map((v, k) =>
                  amount(v) === 0 ? null : (
                    <tr key={names[k]}>
                      <td>
                        <i className="cost-swatch" style={{ background: color(k) }} />
                        {names[k]}
                      </td>
                      <td className="num">{formatMoney(v, o.unit)}</td>
                    </tr>
                  ),
                )}
                <tr className="cost-tip-total">
                  <td>합계</td>
                  <td className="num">{formatMoney(hovered.total, o.unit)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="cost-ticks dim" style={{ gridTemplateColumns: `repeat(${n}, 1fr)` }} aria-hidden="true">
        {o.buckets.map((b, i) => (
          <span key={b.start}>{i % step === 0 ? bucketTick(b.start, o.granularity) : ""}</span>
        ))}
      </div>
      <figcaption className="cost-legend">
        {names.map((name, k) =>
          k === names.length - 1 && !hasOther ? null : (
            <span key={name}>
              <i className="cost-swatch" style={{ background: color(k) }} />
              {name}
            </span>
          ),
        )}
      </figcaption>
    </figure>
  );
}
