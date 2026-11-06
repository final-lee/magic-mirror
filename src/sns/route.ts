/**
 * 주제 탭 안의 화면. 뒤 단계가 화면을 더하려면 여기 유니온에 이름을 더한다(흐름 `flow`, 진단 `diagnosis`, 필터 시험 `filter`, 정책 `policy`, 큐 엿보기 `peek`).
 * 그러면 SNS_VIEW_LABEL·SNS_VIEW_ICON(Record라 빠뜨리면 컴파일 오류)과 SnsTab의 화면 고르기(never로 끝나는 switch)가 더할 곳을 알려 준다.
 */
export type SnsView = "overview" | "subscriptions" | "subscription" | "flow" | "diagnosis" | "filter" | "policy" | "peek" | "changes" | "metrics";

/**
 * 탭 안의 위치. 정체성은 view와 화면이 가리키는 대상이다.
 * `subscription` 화면은 `subscription`에 구독 키(구독 ARN, 확인 대기면 `<주제 ARN>#pending#<해시>`)를 갖는다.
 */
export interface SnsRoute {
  view: SnsView;
  /** 구독 상세가 열려 있는 구독의 key */
  subscription?: string;
  /** 큐 엿보기에서 강조할 큐 ARN */
  queue?: string;
}

export const SNS_VIEW_LABEL: Record<SnsView, string> = {
  overview: "개요",
  subscriptions: "구독",
  subscription: "구독 상세",
  flow: "흐름 지도",
  diagnosis: "배달 진단",
  filter: "필터 시험",
  policy: "정책·점검",
  peek: "큐 엿보기",
  changes: "변경 기록",
  metrics: "지표",
};

export const SNS_VIEW_ICON: Record<SnsView, string> = {
  overview: "📋",
  subscriptions: "🔔",
  subscription: "🔔",
  flow: "🗺️",
  diagnosis: "🩺",
  filter: "🔎",
  policy: "🛡️",
  peek: "👀",
  changes: "📝",
  metrics: "📊",
};

/** 메뉴 항목 순서. 상세 화면은 항목이 아니라 그 목록 항목 아래에서 열린다(snsNavView) */
export const SNS_NAV: { view: SnsView; gap?: boolean }[] = [{ view: "overview" }, { view: "subscriptions" }, { view: "flow" }, { view: "diagnosis" }, { view: "filter" }, { view: "policy" }, { view: "peek" }, { view: "changes" }, { view: "metrics", gap: true }];

/** 메뉴에서 어느 항목이 켜져 보일지. 목록 아래의 상세는 그 목록의 항목 */
export const snsNavView = (view: SnsView): SnsView => (view === "subscription" ? "subscriptions" : view);

export const SNS_HOME: SnsRoute = { view: "overview" };

export const snsSubscriptionRoute = (key: string): SnsRoute => ({ view: "subscription", subscription: key });

export const snsPeekRoute = (queueArn: string): SnsRoute => ({ view: "peek", queue: queueArn });

/** 같은 화면인지. useRouteHistory에 넘기는 함수라 모듈 밖에 둔다. */
export const sameSnsRoute = (a: SnsRoute, b: SnsRoute) =>
  a.view === b.view && (a.subscription ?? null) === (b.subscription ?? null) && (a.queue ?? null) === (b.queue ?? null);
