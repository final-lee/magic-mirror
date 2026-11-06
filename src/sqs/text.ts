import type { FindingLevel, FlowNodeKind, SqsFlow } from "./types";
import type { Health } from "./group";

// 사용자에게 보이는 문구(탭·목록·개요·흐름). 메시지·변경 화면의 문구는 각 폴더의 text.ts에 있다.

export const tabTitle = (region: string) => `📬 SQS · ${region}`;
export const OPEN_SQS_TAB = "SQS 탭에서 열기";

// 위쪽 줄
export const VIEW_GROUP = "보기";
export const VIEW_LIST = "목록";
export const VIEW_MAP = "지도";
export const REREAD = "다시 읽기";
export const READING = "읽는 중…";
export const queueCount = (n: number) => `큐 ${n}개`;
export const problemCount = (n: number) => `문제 있는 큐 ${n}개`;
export const TRUNCATED = "큐가 너무 많아 일부만 보여요";
export const activityFailed = (error: string) => `최근 15분 활동을 읽지 못해 일부 진단을 건너뛰었어요: ${error}`;
export const activityAt = (time: string) => `활동 ${time} 기준`;
export const LOADING = "불러오는 중…";

// 목록
export const LIST_LABEL = "큐 목록";
export const FIND_PLACEHOLDER = "큐 이름 찾기";
export const PROBLEM_ONLY = "문제 있는 큐만";
export const NO_QUEUES = "이 리전에 큐가 없어요";
export const NO_MATCH = "맞는 큐가 없어요";
export const COL_VISIBLE = "보이는";
export const COL_IN_FLIGHT = "처리 중";
export const COL_DELAYED = "지연";
export const BADGE_FIFO = "FIFO";
export const BADGE_DLQ = "DLQ";
export const sourceBadge = (n: number) => `원본 ${n}개`;
export const NESTED_DLQ = "원본 큐의 DLQ";

export const HEALTH: Record<Health, { dot: "red" | "yellow" | "green" | ""; label: string }> = {
  fail: { dot: "red", label: "문제가 있어요" },
  warn: { dot: "yellow", label: "확인이 필요해요" },
  ok: { dot: "green", label: "정상이에요" },
  unknown: { dot: "", label: "속성을 읽지 못했어요" },
};

// 상세
export const DETAIL_PICK = "왼쪽에서 큐를 골라 주세요";
export const QUEUE_GONE = "이 큐가 목록에 없어요. 지워졌을 수 있어요";
export const DETAIL_TABS = { overview: "개요", flow: "흐름", messages: "메시지", log: "기록" } as const;
export const DETAIL_TABS_LABEL = "큐 상세";
export const COPY_URL = "URL 복사";
export const COPIED = "복사했어요";
export const OPEN_QUEUE = "열기";

// 개요
export const STAT_VISIBLE = "보이는 메시지";
export const STAT_IN_FLIGHT = "처리 중";
export const STAT_DELAYED = "지연";
export const STAT_OLDEST = "가장 오래된 메시지";
export const STAT_RECEIVED = "최근 15분 수신";
export const STAT_EMPTY_RECEIVES = "최근 15분 빈 수신";
export const NO_ACTIVITY = "최근 15분 지표를 읽지 못했어요";
export const NO_DATA = "—";
export const FINDINGS_TITLE = "진단";
export const FINDINGS_OK = "지적할 문제가 없어요";
export const FINDING_LEVEL: Record<FindingLevel, { icon: string; label: string }> = {
  fail: { icon: "✕", label: "실패" },
  warn: { icon: "▲", label: "주의" },
  info: { icon: "ⓘ", label: "정보" },
};
export const ATTRS_TITLE = "속성";
export const TAGS_TITLE = "태그";
export const NO_TAGS = "태그가 없어요";
export const POLICY_TITLE = "큐 정책";
export const POLICY_NONE = "큐 정책이 없어요";
export const READ_FAILED = "속성을 읽지 못했어요";
export const ATTR = {
  url: "URL",
  arn: "ARN",
  kind: "종류",
  visibility: "가시성 제한 시간",
  retention: "보관 기간",
  delay: "전송 지연",
  maxSize: "최대 메시지 크기",
  waitTime: "수신 대기 시간",
  dlq: "DLQ",
  sources: "이 큐를 DLQ로 쓰는 큐",
  redriveAllow: "Redrive 허용 정책",
  encryption: "암호화",
  contentDedup: "내용 기반 중복 제거",
  dedupScope: "중복 제거 범위",
  throughput: "처리량 제한",
  created: "만든 시각",
  modified: "바꾼 시각",
} as const;
export const KIND_FIFO = "FIFO";
export const KIND_STANDARD = "Standard";
export const seconds = (n: number) => `${n.toLocaleString("ko-KR")}초`;
export const maxReceive = (n: number) => `${n}번 받으면 이동`;
export const SSE_MANAGED = "SSE-SQS";
export const SSE_NONE = "없음";
export const kmsKey = (key: string) => `KMS · ${key}`;
export const ON = "켜짐";
export const OFF = "꺼짐";
export const SHORT_POLLING = "짧은 폴링";
export const POLICY_SHOW = "정책 원문 보기";

// 흐름
export const FLOW_LOADING = "흐름을 읽는 중이에요…";
export const FLOW_PRODUCERS = "생산자";
export const FLOW_CONSUMERS = "소비자";
export const FLOW_DLQ = "DLQ";
export const FLOW_QUEUE = "큐";
export const FLOW_SOURCES = "이 큐를 DLQ로 쓰는 큐";
export const NO_PRODUCERS = "보내는 곳이 보이지 않아요";
export const NO_CONSUMERS = "받아 가는 곳이 보이지 않아요";
export const NO_IAM_YET = "IAM으로 계산하면 보내거나 받을 수 있는 역할·사용자도 찾아요";
export const CALC_IAM = "IAM으로 계산";
export const RECALC_IAM = "IAM 다시 계산";
export const CALCULATING = "계산 중…";
export const IAM_DONE = "IAM으로 계산한 결과를 포함했어요";
export const FLOW_FINDINGS = "흐름 진단";
export const FLOW_FINDINGS_OK = "흐름에서 찾은 문제가 없어요";
export const FLOW_POLICY = "정책 문장";
export const FLOW_GAPS = "읽지 못한 부분";
export const gap = (section: string, error: string) => `${section}: ${error}`;
export const NODE_KIND: Record<FlowNodeKind, { icon: string; label: string }> = {
  sns: { icon: "📣", label: "SNS 토픽" },
  rule: { icon: "📅", label: "EventBridge 규칙" },
  pipe: { icon: "🔀", label: "Pipe" },
  s3: { icon: "🪣", label: "S3 버킷" },
  lambda: { icon: "λ", label: "Lambda" },
  principal: { icon: "🔐", label: "IAM 주체" },
  serviceAccount: { icon: "☸️", label: "서비스 어카운트" },
  queue: { icon: "📬", label: "큐" },
};
export const POLICY_ALLOWED = "정책 허용";
export const POLICY_DENIED = "정책이 허용하지 않아요";
export const POLICY_UNKNOWN = "정책 판단 불가";
export const CROSS_ACCOUNT = "다른 계정";
export const CROSS_ACCOUNT_TITLE = "다른 계정의 리소스라 읽지 않았어요";
export const NODE_OPEN = "열기";
export const NODE_DETAIL = "자세히";
export const NODE_DETAIL_HIDE = "접기";
export const POLICY_COL = { effect: "효과", principals: "주체", actions: "동작", conditions: "조건" } as const;
export const POLICY_PUBLIC = "누구나";
export const POLICY_PUBLIC_TITLE = "조건 없이 모든 주체에게 열려 있어요";
export const NO_POLICY = "큐 정책이 없어요";
export const flowSummary = (flow: SqsFlow) => `생산자 ${flow.producers.length} · 소비자 ${flow.consumers.length}`;

// 리전 지도
export const MAP_LABEL = "리전 흐름 지도";
export const MAP_LOADING = "리전 흐름을 읽는 중이에요…";
export const MAP_EMPTY = "그릴 연결이 없어요";
export const MAP_NOTE = "SNS 구독, Lambda 이벤트 소스 매핑, Pipe, DLQ 연결만 그려요(EventBridge 규칙과 IAM은 큐 상세의 흐름에서 봐요)";
export const MAP_LEGEND = { fail: "문제 있음", warn: "주의", dlq: "DLQ 연결" } as const;
export const MAP_EDGE: Record<"subscription" | "rule" | "esm" | "pipe" | "dlq", string> = {
  subscription: "구독",
  rule: "규칙",
  esm: "이벤트 소스",
  pipe: "Pipe",
  dlq: "DLQ",
};
export const mapNodeOpen = (label: string) => `${label} 열기`;
