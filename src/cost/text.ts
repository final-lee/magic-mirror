// 비용 탭의 화면 문구. 테스트는 다시 적지 않고 이 상수와 비교한다.
import type { CostMetric, CostPeriod } from "./types";

export const COST_TITLE = "💰 비용";

export const PERIOD_LABEL: Record<CostPeriod, string> = {
  thisMonth: "이번 달",
  lastMonth: "지난달",
  last30Days: "최근 30일",
  last6Months: "최근 6개월",
};
export const PERIODS: CostPeriod[] = ["thisMonth", "lastMonth", "last30Days", "last6Months"];
export const PERIOD_GROUP = "기간";

export const METRIC_LABEL: Record<CostMetric, string> = { UnblendedCost: "청구액", AmortizedCost: "상각 비용" };
export const METRIC_HINT: Record<CostMetric, string> = {
  UnblendedCost: "청구서에 찍히는 금액",
  AmortizedCost: "약정 선결제를 기간에 나눠 반영한 금액",
};
export const METRIC_SELECT = "지표";
export const EXCLUDE_CREDITS = "크레딧·환불 빼기";

export const ORG_NOTE = "조직 관리 계정이면 조직 전체 합계예요";
export const REFRESH = "새로고침";
export const LOADING = "불러오는 중…";
export const ACCOUNT_LABEL = "계정";

export const CARD_TOTAL = "합계";
export const ESTIMATED = "추정 포함";
export const CARD_FORECAST = "월말 예상";
export const forecastBand = (low: string, high: string) => `80% 구간 ${low} ~ ${high}`;
export const CARD_COMPARE = "비교 기간 대비";
export const COMPARE_ZERO = "비교 기간 금액이 0이에요";

export const NO_DATA_YET = "이번 달 데이터가 아직 없어요";
export const SHOW_LAST_MONTH = "지난달 보기";

export const CHART_LABEL = "비용 추이";
export const OTHER_SERIES = "기타";
export const CHART_EMPTY = "이 기간에는 비용이 없어요";

export const GROUP_LABEL = { service: "서비스", region: "리전", usageType: "사용 유형", tag: "태그" } as const;
export const GROUP_SELECT = "묶는 기준";
export const TAG_KEY_SELECT = "태그 키";
export const NO_ACTIVE_TAGS = "Billing 콘솔에서 비용 할당 태그를 켜야 해요";
export const BREAKDOWN_LABEL = "비용 분해";
export const COL = { label: "항목", current: "이번 기간", previous: "비교 기간", delta: "증감액", deltaPct: "증감률", share: "비중" } as const;
export const smallRows = (n: number) => `작은 항목 ${n}개`;
export const BREADCRUMB_LABEL = "분해 경로";
export const CRUMB_ROOT = "전체";
export const BREAKDOWN_EMPTY = "이 기간에는 비용이 없어요";
export const DRILL_HINT = "눌러서 이 항목으로 내려가기";

export const PERMISSIONS_HINT = "필요한 권한: ce:GetCostAndUsage, ce:GetCostForecast, ce:ListCostAllocationTags";
export const MEMBER_BLOCKED_HINT = "관리 계정이 멤버 계정의 Cost Explorer 접근을 막았을 수 있어요";

/** 요청 하나의 값(USD). Cost Explorer API 요금표 기준 */
export const REQUEST_PRICE = 0.01;
export const usageLine = (n: number, dollars: string) => `이번 달 앱이 보낸 Cost Explorer 요청 ${n}건 · 약 ${dollars}`;
