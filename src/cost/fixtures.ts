// 비용 탭 테스트용 응답. 서비스 이름은 실제 계정에서 본 것(설계 문서 C0 결과)을 쓴다.
import type { BreakdownRow, CostBreakdown, CostOverview } from "./types";

export const ACCOUNT = "123456789012";

export function sampleOverview(over: Partial<CostOverview> = {}): CostOverview {
  return {
    accountId: ACCOUNT,
    unit: "USD",
    range: { start: "2026-10-01", end: "2026-10-04" },
    compareRange: { start: "2026-09-01", end: "2026-09-04" },
    granularity: "daily",
    total: "60.5",
    compareTotal: "50",
    delta: "10.5",
    deltaPct: 21,
    estimated: true,
    forecast: { mean: "749.67", low: "700.1", high: "799.2" },
    forecastNote: null,
    series: ["Amazon Relational Database Service", "EC2 - Other"],
    buckets: [
      { start: "2026-10-01", total: "20", values: ["12", "5"], other: "3" },
      { start: "2026-10-02", total: "20.25", values: ["12", "5.25"], other: "3" },
      { start: "2026-10-03", total: "20.25", values: ["12", "5"], other: "3.25" },
    ],
    fetchedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    requests: 3,
    ...over,
  };
}

export const row = (key: string, current: string, previous: string | null, share: number, label = key): BreakdownRow => {
  const delta = previous === null ? null : String(Number(current) - Number(previous));
  const deltaPct = previous === null || Number(previous) === 0 ? null : ((Number(current) - Number(previous)) / Number(previous)) * 100;
  return { key, label, current, previous, delta, deltaPct, share };
};

export function sampleBreakdown(over: Partial<CostBreakdown> = {}): CostBreakdown {
  return {
    unit: "USD",
    rows: [
      row("Amazon Relational Database Service", "36", "30", 59.5),
      row("EC2 - Other", "15.25", "16", 25.2),
      row("Tax", "9.25", "4", 15.3),
    ],
    small: { count: 2, current: "0.004", previous: "0.001" },
    total: "60.504",
    fetchedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    requests: 0,
    ...over,
  };
}
