import type { SnsFinding, SnsLevel, SnsReach, SnsValidationLevel } from "./types";

// 정책·점검(주제 탭)과 계정 개요 탭의 글.

export const LEVEL_LABEL: Record<SnsLevel, string> = { high: "높음", medium: "중간", low: "낮음", info: "정보" };
export const LEVEL_ORDER: Record<SnsLevel, number> = { high: 0, medium: 1, low: 2, info: 3 };
export const REACH_LABEL: Record<SnsReach, string> = { public: "공개", crossAccount: "다른 계정", service: "AWS 서비스", sameAccount: "같은 계정", unknown: "판단 불가" };
export const VALIDATION_LABEL: Record<SnsValidationLevel, string> = { error: "오류", securityWarning: "보안 경고", warning: "경고", suggestion: "제안" };

export const byLevel = (a: SnsFinding, b: SnsFinding) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level];

/** 끈 점검을 뺀다 */
export const enabledOnly = (findings: SnsFinding[], disabled: readonly string[]) => findings.filter((f) => !disabled.includes(f.check));

export const count = (n: number) => n.toLocaleString("ko-KR");

// 점검 목록(공용)
export const FINDINGS_LABEL = "점검 결과";
export const FINDINGS_EMPTY = "걸리는 점검이 없어요";
export const FINDINGS_HIDDEN = (n: number) => `꺼 둔 점검 ${n}건은 숨겼어요. 계정 개요에서 다시 켤 수 있어요`;
export const FINDING_ITEMS = "해당 항목";

// 주제 탭 정책 화면
export const POLICY_LABEL = "주제 정책·점검";
export const POLICY_LOADING = "정책을 읽는 중…";
export const SECTION_FINDINGS = "점검";
export const SECTION_STATEMENTS = "정책 문장";
export const SECTION_VALIDATION = "정책 검증(Access Analyzer)";
export const SECTION_PUBLIC = "공개 접근 검사(유료)";
export const SECTION_WHO = "누가 발행·구독할 수 있나";
export const NO_POLICY = "이 주제에는 정책이 없어요";
export const STATEMENTS_ERROR = (message: string) => `정책을 문장으로 풀지 못했어요: ${message}`;
export const DENY = "거부";
export const VALIDATION_NONE = "지적이 없어요";
export const VALIDATION_UNAVAILABLE = "검사하지 못했어요(권한이 없거나 읽기에 실패했어요)";
export const VALIDATION_NOTE = "SNS 주제는 Access Analyzer의 자원 정책 검사로 확인해요(무료).";
export const LEARN_MORE = "자세히";

export const PUBLIC_RUN = "공개 접근 검사 실행";
export const PUBLIC_RUNNING = "검사하는 중…";
export const PUBLIC_COST = "호출할 때마다 $0.002가 청구돼요";
export const PUBLIC_NOTE = `Access Analyzer의 CheckNoPublicAccess로 이 정책이 누구에게나 열려 있는지 확인해요. ${PUBLIC_COST}. 자동으로 부르지 않고 이 버튼을 누를 때만 불러요.`;
export const PUBLIC_RESULT: Record<"pass" | "fail" | "unknown", string> = {
  pass: "통과: 공개 접근이 없어요",
  fail: "실패: 공개 접근이 있어요",
  unknown: "결과를 판단할 수 없어요",
};

export const WHO_NOTE = "주제 정책이 허용한 주체예요. 같은 계정의 IAM 사용자·역할은 자기 정책으로도 쓸 수 있어서 IAM에서 따로 봐요.";
export const WHO_COLS = { principal: "주체", publish: "발행", subscribe: "구독", conditions: "조건" } as const;
export const WHO_EMPTY = "정책에서 발행·구독을 허용한 주체가 없어요";
export const WHO_ALLOWED = "가능";
export const WHO_DENIED = "거부";
export const NO_CONDITIONS = "조건 없음";
export const IAM_PUBLISH = "IAM에서 누가 발행할 수 있나 보기";
export const IAM_SUBSCRIBE = "IAM에서 누가 구독할 수 있나 보기";
export const IAM_TITLE = "IAM 워크스페이스의 '누가 할 수 있나'를 이 주제의 ARN으로 채워 열어요";

export const principalLabel = (p: { kind: string; value: string; account: string | null }) => {
  if (p.kind === "anyone") return "모든 주체(*)";
  if (p.kind === "service") return `서비스 ${p.value}`;
  if (p.kind === "account") return `계정 ${p.account ?? p.value}`;
  return p.value;
};

// 계정 개요 탭
export const ACCOUNT_TITLE = "📣 SNS";
export const ACCOUNT_LABEL = "SNS 계정 개요";
export const ACCOUNT_OPEN = "📣 SNS 개요";
export const ACCOUNT_OPEN_TITLE = "이 계정·리전의 SNS 주제, 고아·대기 구독, 점검 결과를 한눈에 봐요";
export const ACCOUNT_LOADING = "계정의 SNS를 읽는 중…";
export const REREAD = "다시 읽기";
export const READING = "읽는 중…";
export const ACCOUNT_HEAD = (account: string, region: string) => `${account} · ${region}`;
export const WINDOW_NOTE = "발행·배달·실패·걸러짐은 지난 24시간 합계예요. 주제마다 지표 4개를 읽고(GetMetricData, 지표 1,000개에 $0.01) 저절로 다시 읽지 않아요.";
export const METRICS_UNAVAILABLE = "지표를 읽지 못해서 표의 숫자는 비어 있는 값이에요";
export const TRUNCATED = "주제가 너무 많아 일부만 보여요";
export const PARTIAL = (n: number) => `일부 정보를 읽지 못했어요 (${n}건)`;
export const SECTION_TOPICS = "주제";
export const TOPICS_EMPTY = "이 리전에 SNS 주제가 없어요";
export const TOPIC_COLS = { name: "주제", published: "발행", delivered: "배달", failed: "실패", filtered: "걸러짐", subscriptions: "구독", pending: "대기", findings: "점검" } as const;
export const TOPIC_ERROR = "주제 속성을 읽지 못했어요";
export const OPEN_TOPIC = (name: string) => `${name} 주제 탭 열기`;
export const SECTION_ORPHANS = "고아 구독";
export const ORPHANS_NOTE = "주제나 엔드포인트가 없어진 구독이에요(같은 계정·리전만 확인해요).";
export const ORPHANS_EMPTY = "고아 구독이 없어요";
export const ORPHAN_REASON = { topicMissing: "주제 없음", endpointMissing: "엔드포인트 없음" } as const;
export const SECTION_PENDING = "확인 대기 구독";
export const PENDING_EMPTY = "확인 대기 구독이 없어요";
export const PENDING_NOTE = "email·http 구독은 확인하지 않으면 3일 뒤 자동으로 지워져요.";
export const SECTION_CHECKS = "점검 모음";
export const CHECKS_NOTE = "끈 점검은 모든 주제에서 빠져요. 설정에 저장돼요.";
export const CHECK_TOGGLE = (title: string) => `${title} 점검 켜기`;
export const CHECK_COUNT = (n: number) => `${n}건`;
export const SECTION_ACCOUNT_METRICS = "계정 지표(지난 24시간)";
export const ACCOUNT_METRICS_EMPTY = "차원 없는 계정 지표가 없어요";

// SMS·푸시
export const SECTION_SMS = "SMS";
export const SECTION_PUSH = "모바일 푸시";
export const MESSAGING_LOADING = "SMS·푸시 정보를 읽는 중…";
export const SANDBOX_ON = "SMS 샌드박스 안에 있어요: 확인한 번호로만 보낼 수 있어요";
export const SANDBOX_OFF = "SMS 샌드박스를 벗어났어요";
export const SANDBOX_UNKNOWN = "SMS 샌드박스 여부를 읽지 못했어요";
export const SANDBOX_NUMBERS = "샌드박스 번호";
export const SANDBOX_NUMBERS_NOTE = "번호는 가려서 보여요";
export const ORIGINATION_NUMBERS = "발신 번호";
export const ORIGINATION_EMPTY = "발신 번호가 없어요";
export const SMS_ATTRIBUTES = "SMS 속성";
export const SMS_ATTRIBUTES_EMPTY = "계정 SMS 속성이 비어 있어요";
export const MONTH_SPENT = "이번 달 지출";
export const SUCCESS_RATE = "성공률(24시간)";
export const NO_VALUE = "없음";
export const usd = (n: number) => `$${n.toFixed(2)}`;
export const percent = (n: number) => `${n.toFixed(1)}%`;
export const PUSH_EMPTY = "플랫폼 애플리케이션이 없어요";
export const PUSH_COLS = { name: "애플리케이션", platform: "플랫폼", enabled: "상태", endpoints: "엔드포인트", disabled: "비활성", cert: "인증서 만료" } as const;
export const APP_ENABLED = { true: "켜짐", false: "꺼짐", unknown: "알 수 없음" } as const;
export const endpointsText = (n: number, truncated: boolean) => `${count(n)}${truncated ? "+" : ""}`;
export const APP_ERROR = "엔드포인트를 읽지 못했어요";
export const MESSAGING_PARTIAL = (n: number) => `SMS·푸시 일부를 읽지 못했어요 (${n}건)`;
