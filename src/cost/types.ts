// 비용 명령의 입력과 출력. `src-tauri/src/cost/model.rs`와 같은 모양이다. 금액은 모두 소수 문자열이다.

export type CostPeriod = "thisMonth" | "lastMonth" | "last30Days" | "last6Months";
export type CostMetric = "UnblendedCost" | "AmortizedCost";
export type CostGroupBy = { kind: "service" | "region" | "usageType" } | { kind: "tag"; key: string };
export type CostDimension = "SERVICE" | "REGION" | "USAGE_TYPE";
/** 태그 값이 빈 문자열이면 "이 태그가 없는 비용" */
export type CostFilter = { dimension: CostDimension; value: string } | { tag: string; value: string };

export interface CostQuery {
  period: CostPeriod;
  metric: CostMetric;
  excludeCredits: boolean;
  filters: CostFilter[];
  groupBy: CostGroupBy;
}

/** `[start, end)`, `YYYY-MM-DD` */
export interface DateRange {
  start: string;
  end: string;
}

export interface Forecast {
  /** 이번 달 전체 예상(이미 쓴 금액 포함) */
  mean: string;
  low: string;
  high: string;
}

export interface Bucket {
  start: string;
  total: string;
  /** `CostOverview.series`와 같은 순서 */
  values: string[];
  other: string;
}

export interface CostOverview {
  accountId: string;
  unit: string;
  /** 이번 달 1일에는 null */
  range: DateRange | null;
  compareRange: DateRange | null;
  granularity: "daily" | "monthly";
  total: string;
  compareTotal: string | null;
  delta: string | null;
  deltaPct: number | null;
  estimated: boolean;
  forecast: Forecast | null;
  forecastNote: string | null;
  series: string[];
  buckets: Bucket[];
  fetchedAt: string;
  requests: number;
}

export interface BreakdownRow {
  key: string;
  label: string;
  current: string;
  previous: string | null;
  delta: string | null;
  deltaPct: number | null;
  share: number;
}

export interface SmallRows {
  count: number;
  current: string;
  previous: string | null;
}

export interface CostBreakdown {
  unit: string;
  rows: BreakdownRow[];
  small: SmallRows | null;
  total: string;
  fetchedAt: string;
  requests: number;
}

export interface CostUsage {
  yearMonth: string;
  requests: number;
}
