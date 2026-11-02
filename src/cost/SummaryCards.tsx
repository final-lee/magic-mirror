import { amount, formatDelta, formatMoney, formatPct, rangeLabel } from "./format";
import { CARD_COMPARE, CARD_FORECAST, CARD_TOTAL, COMPARE_ZERO, ESTIMATED, forecastBand } from "./text";
import type { CostOverview, CostPeriod } from "./types";

/** 늘어난 비용은 빨강, 줄어든 비용은 초록 */
export function trendClass(delta: string | null): string {
  const n = amount(delta);
  return n > 0 ? "cost-up" : n < 0 ? "cost-down" : "";
}

/** 이번 기간 합계, 월말 예상(이번 달만), 비교 기간 대비 증감 */
export function SummaryCards({ overview: o, period }: { overview: CostOverview; period: CostPeriod }) {
  return (
    <div className="cost-cards">
      {o.range && (
        <section className="cost-card" aria-label={CARD_TOTAL}>
          <h3>
            {CARD_TOTAL} <span className="dim">· {rangeLabel(o.range)}</span>
          </h3>
          <div className="cost-big">{formatMoney(o.total, o.unit)}</div>
          {o.estimated && (
            <div className="cost-sub">
              <span className="iam-badge warn">{ESTIMATED}</span>
            </div>
          )}
        </section>
      )}
      {period === "thisMonth" && (o.forecast || o.forecastNote) && (
        <section className="cost-card" aria-label={CARD_FORECAST}>
          <h3>{CARD_FORECAST}</h3>
          {o.forecast ? (
            <>
              <div className="cost-big">{formatMoney(o.forecast.mean, o.unit)}</div>
              <div className="cost-sub">{forecastBand(formatMoney(o.forecast.low, o.unit), formatMoney(o.forecast.high, o.unit))}</div>
            </>
          ) : (
            <div className="cost-sub">{o.forecastNote}</div>
          )}
        </section>
      )}
      {o.range && o.compareRange && o.compareTotal !== null && o.delta !== null && (
        <section className="cost-card" aria-label={CARD_COMPARE}>
          <h3>
            {CARD_COMPARE} <span className="dim">· {rangeLabel(o.compareRange)}</span>
          </h3>
          <div className={`cost-big ${trendClass(o.delta)}`}>
            {formatDelta(o.delta, o.unit)} <span className="cost-pct">{o.deltaPct === null ? "" : formatPct(o.deltaPct)}</span>
          </div>
          <div className="cost-sub">
            {formatMoney(o.compareTotal, o.unit)}
            {o.deltaPct === null && amount(o.compareTotal) === 0 ? ` · ${COMPARE_ZERO}` : ""}
          </div>
        </section>
      )}
    </div>
  );
}
