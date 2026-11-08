import { formatDate } from "../lib/format";
import { kmsLabel } from "./format";
import type { DeliveryLogging, HttpDeliveryRow, SnsTopic } from "./types";

export const NAV_LABEL = "SNS 메뉴";
export const NAV_BACK = "뒤로";
export const NAV_FORWARD = "앞으로";
export const CRUMB_LABEL = "현재 위치";
export const INFO_GROUP = "주제 정보";
export const LOADING = "불러오는 중…";
export const READING = "읽는 중…";
export const REREAD = "다시 읽기";
export const SHOW_RAW = "원본 데이터 보기…";

/** 스냅샷에서 일부를 읽지 못했을 때 위쪽에 알리는 글(자세한 이유는 아래에) */
export const PARTIAL = (n: number) => `일부 정보를 읽지 못했어요 (${n}건)`;
export const PARTIAL_LABEL = "읽지 못한 항목";

// 개요
export const OVERVIEW_LABEL = "주제 개요";
export const SECTION_GENERAL = "기본";
export const SECTION_ENCRYPTION = "암호화";
export const SECTION_FIFO = "FIFO";
export const SECTION_ARCHIVE = "아카이브";
export const SECTION_SECURITY = "서명·추적";
export const SECTION_LOGGING = "배달 상태 로깅";
export const SECTION_HTTP = "HTTP(S) 배달 정책";
export const SECTION_DATA_PROTECTION = "데이터 보호 정책";
export const SECTION_TAGS = "태그";
export const NO_TAGS = "태그가 없어요";
export const HTTP_POLICY_EMPTY = "배달 정책을 읽지 못했어요";
export const HTTP_POLICY_COLS = { item: "항목", value: "값" } as const;

export const kindSentence = (fifo: boolean) => (fifo ? "FIFO 주제예요. 메시지 순서를 지키고 중복을 걸러 내요" : "표준 주제예요. 순서와 중복 제거를 보장하지 않아요");
export const subscriptionCounts = (confirmed: number, pending: number, deleted: number) =>
  `구독은 확인됨 ${confirmed}개, 확인 대기 ${pending}개, 해지됨 ${deleted}개예요`;
export const displayNameSentence = (name: string) => `표시 이름(DisplayName)은 ${name}이에요. SMS·이메일 발신자 이름으로 쓰여요`;

export function encryptionSentence(topic: SnsTopic): string {
  const o = topic.overview;
  if (!o.kmsKey) return "저장된 메시지를 암호화하지 않아요(서버 측 암호화 꺼짐)";
  const key = kmsLabel(o.kmsKey);
  if (o.awsManagedKey) {
    return `AWS 관리 키(${key})로 암호화해요. 이 키는 키 정책을 바꿀 수 없어서 CloudWatch 경보·EventBridge 같은 서비스 발행자가 이 주제에 발행하지 못해요`;
  }
  return `고객 관리 키 ${key}로 암호화해요`;
}

const THROUGHPUT_SCOPE: Record<string, string> = { Topic: "주제 전체에 처리량 한도를 걸어요", MessageGroup: "메시지 그룹마다 처리량 한도를 걸어요(높은 처리량 모드)" };

export function fifoSentences(topic: SnsTopic): string[] {
  const o = topic.overview;
  const scope = o.fifoThroughputScope;
  return [
    o.contentBasedDeduplication ? "내용 기반 중복 제거가 켜져 있어요: 본문이 같으면 5분 안에는 한 번만 받아요" : "내용 기반 중복 제거가 꺼져 있어요: 발행할 때 중복 제거 ID를 줘야 해요",
    scope ? (THROUGHPUT_SCOPE[scope] ?? `처리량 범위는 ${scope}예요`) : "처리량 범위는 기본값이에요",
  ];
}

export function archiveSentences(topic: SnsTopic): string[] {
  const o = topic.overview;
  if (o.archiveRetentionDays === null) return ["메시지 아카이브가 꺼져 있어요"];
  return [`발행한 메시지를 ${o.archiveRetentionDays}일 동안 보관해요`, ...(o.beginningArchiveTime ? [`보관은 ${formatDate(o.beginningArchiveTime)}부터 시작됐어요`] : [])];
}

export function signatureSentence(version: number): string {
  return `서명 버전은 ${version}이에요(${version === 2 ? "SHA256" : "SHA1"})`;
}

export function tracingSentence(tracing: string | null): string {
  return tracing === "Active" ? "X-Ray 추적이 켜져 있어요(Active)" : "X-Ray 추적을 켜지 않았어요(들어온 추적 헤더는 그대로 전달해요)";
}

const PROTOCOL_NAME: Record<string, string> = { Lambda: "Lambda", SQS: "SQS", HTTP: "HTTP(S)", Application: "모바일 푸시", Firehose: "Firehose" };
/** 역할 ARN을 역할 이름으로 */
const roleName = (arn: string) => arn.slice(arn.lastIndexOf("/") + 1);

/** 프로토콜 한 줄: `SQS: 켜짐 · 성공 로그 표본 100%(역할 a) · 실패 로그(역할 b)` */
export function loggingSentence(l: DeliveryLogging): { protocol: string; on: boolean; text: string } {
  const protocol = PROTOCOL_NAME[l.protocol] ?? l.protocol;
  const parts: string[] = [];
  if (l.successRole) parts.push(l.sampleRate ? `성공 로그 표본 ${l.sampleRate}%(역할 ${roleName(l.successRole)})` : `성공 로그는 표본 0%라 남기지 않아요(역할 ${roleName(l.successRole)})`);
  if (l.failureRole) parts.push(`실패 로그 전부(역할 ${roleName(l.failureRole)})`);
  return { protocol, on: parts.length > 0, text: parts.length > 0 ? `켜짐 · ${parts.join(" · ")}` : "꺼짐" };
}

const HTTP_GROUP: Record<string, string> = {
  defaultHealthyRetryPolicy: "정상 엔드포인트 재시도",
  defaultSicklyRetryPolicy: "문제 있는 엔드포인트 재시도",
  defaultThrottlePolicy: "전송 제한",
  defaultRequestPolicy: "요청",
};
const HTTP_LEAF: Record<string, string> = {
  minDelayTarget: "최소 지연(초)",
  maxDelayTarget: "최대 지연(초)",
  numRetries: "재시도 횟수",
  numNoDelayRetries: "지연 없는 재시도",
  numMinDelayRetries: "최소 지연으로 재시도",
  numMaxDelayRetries: "최대 지연으로 재시도",
  backoffFunction: "지연 늘리는 방식",
  maxReceivesPerSecond: "초당 최대 전송",
  headerContentType: "Content-Type",
  disableSubscriptionOverrides: "구독별 재정의 막기",
};

/** HTTP 배달 정책 키(`http.defaultHealthyRetryPolicy.numRetries`)의 읽기 쉬운 이름. 모르는 키는 키 그대로 */
export function httpPolicyLabel(row: HttpDeliveryRow): string {
  const segments = row.key.split(".");
  const leaf = HTTP_LEAF[segments[segments.length - 1]];
  const group = HTTP_GROUP[segments[segments.length - 2]];
  if (!leaf) return row.key;
  return group ? `${group} · ${leaf}` : leaf;
}

/** 데이터 보호 정책 JSON에서 정책 이름과 문 이름(Sid). 읽을 수 없으면 둘 다 비운다 */
export function dataProtectionInfo(policy: string): { name: string | null; statements: string[] } {
  try {
    const doc = JSON.parse(policy) as { Name?: unknown; Statement?: unknown };
    const statements = Array.isArray(doc.Statement) ? doc.Statement.flatMap((s: { Sid?: unknown }) => (typeof s?.Sid === "string" ? [s.Sid] : [])) : [];
    return { name: typeof doc.Name === "string" ? doc.Name : null, statements };
  } catch {
    return { name: null, statements: [] };
  }
}

export const DATA_PROTECTION_NONE = "데이터 보호 정책이 없어요";
export function dataProtectionSentence(policy: string): string {
  const { name, statements } = dataProtectionInfo(policy);
  const head = `데이터 보호 정책이 있어요${name ? `(${name})` : ""}`;
  return statements.length > 0 ? `${head}. 문 ${statements.length}개: ${statements.join(", ")}` : head;
}

// 구독 표
export const SUBS_LABEL = "구독 목록";
export const SUBS_COLS = { protocol: "프로토콜", endpoint: "엔드포인트", state: "상태", filter: "필터", raw: "Raw", dlq: "DLQ" } as const;
export const SUBS_EMPTY = "이 주제에는 구독이 없어요";
export const SUBS_NO_MATCH = "조건에 맞는 구독이 없어요";
export const FILTER_NONE = "필터 없음";
export const DLQ_NONE = "없음";
export const RAW_ON = "켜짐";
export const RAW_OFF = "꺼짐";
export const PROTOCOL_CHIPS = "프로토콜";
export const STATE_CHIPS = "상태";
export const ROW_ERROR = "이 구독의 속성을 읽지 못했어요";

// 구독 상세
export const SUB_LABEL = "구독 상세";
export const SUB_MISSING = "이 구독을 찾을 수 없어요. 해지됐거나 목록을 다시 읽는 사이에 바뀌었을 수 있어요";
export const SUB_BACK = "구독 목록으로";
export const SECTION_ATTRIBUTES = "속성";
export const SECTION_FILTER = "필터 정책";
export const SECTION_DLQ = "DLQ(RedrivePolicy)";
export const SECTION_DELIVERY = "배달 정책";
export const SECTION_ENDPOINT = "엔드포인트";
export const ATTRIBUTE_COLS = { key: "이름", value: "값" } as const;
export const PENDING_NOTE = "확인 대기 중인 구독이에요. 확인이 끝나기 전에는 속성을 읽을 수 없어요. 엔드포인트가 확인 링크를 누르거나 요청에 답하면 속성이 보여요. 확인하지 않으면 3일 뒤 자동으로 삭제돼요";
export const UNKNOWN_NOTE = "구독의 상태를 읽지 못했어요";
export const FILTER_SCOPE: Record<"MessageAttributes" | "MessageBody", string> = { MessageAttributes: "메시지 속성 범위", MessageBody: "본문 범위" };
export const FILTER_NONE_SENTENCE = "필터 정책이 없어서 모든 메시지를 받아요";
export const DLQ_SENTENCE_NONE = "DLQ가 없어요. 배달에 실패한 메시지는 재시도가 끝나면 버려져요";
export const RAW_SENTENCE = (on: boolean) => (on ? "Raw 전달이 켜져 있어요: SNS 봉투 없이 본문을 그대로 보내요" : "Raw 전달이 꺼져 있어요: 본문이 SNS 봉투(JSON)로 감싸져요");
export const SQS_TARGET = (fifo: boolean, kms: string | null) => `SQS 큐 · ${fifo ? "FIFO" : "표준"} · ${kms ? `KMS(${kmsLabel(kms)})` : "암호화 안 됨"}`;
export const LAMBDA_TARGET = "Lambda 함수";
export const TARGET_ERROR = "엔드포인트를 읽지 못했어요";
export const OPEN_RESOURCE = { sqs: "SQS 큐 열기", lambda: "Lambda 함수 열기" } as const;
export const OPEN_RESOURCE_OTHER_ACCOUNT = "다른 계정의 리소스라 이 프로필로 열 수 없어요";
export const OPEN_RESOURCE_UNRESOLVED = "엔드포인트를 읽지 못해 어느 행인지 알 수 없어요";

// 지표
export const METRICS_LABEL = "주제 지표";

// 역링크(SQS 큐·Lambda 함수 상세)
export const SUBSCRIBED_TOPICS = "이 리소스를 구독한 주제";
export const SUBSCRIBED_NONE = "이 리소스를 구독한 주제가 없어요";
export const SUBSCRIBED_LOADING = "구독한 주제를 찾는 중…";
export const OPEN_TOPIC = "주제 열기";
export const OTHER_ACCOUNT_TOPIC = "다른 계정의 주제";
