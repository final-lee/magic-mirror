// SQS 워크스페이스의 백엔드 계약(src-tauri/src/sqs). 이름과 모양은 Rust 쪽 serde(camelCase)와 같아야 한다.
import type { PreviewWarning } from "../iam/types";

export type FindingLevel = "fail" | "warn" | "info";

/** 건강 진단 한 줄. 문구는 백엔드가 만든다 */
export interface SqsFinding {
  id: SqsFindingId;
  level: FindingLevel;
  summary: string;
  detail: string | null;
}

export type SqsFindingId =
  | "dlqBacklog"
  | "nearExpiry"
  | "stalled"
  | "publicPolicy"
  | "dlqRetentionShort"
  | "maxReceiveOne"
  | "noDlq"
  | "shortPolling"
  | "noEncryption"
  | "visibilityVsLambda"
  | "noConsumer"
  | "subscriptionDenied"
  | "kmsBlocksProducer";

/** 최근 15분 CloudWatch 값. 못 읽었으면 null */
export interface SqsActivity {
  oldestAgeSec: number | null;
  received15m: number | null;
  emptyReceives15m: number | null;
}

export interface SqsRedrive {
  dlqArn: string;
  maxReceiveCount: number;
}

export interface SqsQueue {
  url: string;
  arn: string;
  name: string;
  fifo: boolean;
  visible: number;
  inFlight: number;
  delayed: number;
  /** 초 */
  visibilityTimeout: number;
  retention: number;
  delay: number;
  /** 바이트 */
  maxSize: number;
  waitTime: number;
  redrive: SqsRedrive | null;
  /** RedriveAllowPolicy 원문(JSON) */
  redriveAllow: string | null;
  sseManaged: boolean;
  kmsKey: string | null;
  contentDedup: boolean | null;
  dedupScope: string | null;
  throughputLimit: string | null;
  /** 큐 정책 원문(JSON) */
  policy: string | null;
  /** Unix ms */
  createdAt: number | null;
  modifiedAt: number | null;
  /** 이 큐를 DLQ로 쓰는 큐의 ARN */
  sources: string[];
  isDlq: boolean;
  activity: SqsActivity | null;
  /** sqs_queue만 채운다. 목록(sqs_overview)에서는 빈 객체 */
  tags: Record<string, string>;
  findings: SqsFinding[];
  /** 속성을 읽지 못한 큐(권한 없음 등). 그때 수치는 0이다 */
  error: string | null;
}

export interface SqsOverview {
  queues: SqsQueue[];
  truncated: boolean;
  /** CloudWatch 활동을 읽은 시각(Unix ms). 못 읽었으면 null */
  activityAt: number | null;
  activityError: string | null;
}

/** 다른 화면으로 가는 길. queue는 같은 SQS 탭 안에서 고른다 */
export type SqsJump =
  | { kind: "queue"; url: string }
  | { kind: "resource"; service: string; type: string; id: string }
  | { kind: "eks"; cluster: string }
  | { kind: "iam"; arn: string };

export type FlowNodeKind = "sns" | "rule" | "pipe" | "s3" | "lambda" | "principal" | "serviceAccount" | "queue";

export interface FlowNode {
  kind: FlowNodeKind;
  /** ARN 또는 그 노드를 가리키는 고유 값 */
  id: string;
  label: string;
  /** Enabled/Disabled, ENABLED, RUNNING, PendingConfirmation … 원문 */
  state: string | null;
  /** 큐 정책이 이 출처의 SendMessage를 허용하는가. 판단할 수 없거나 해당 없으면 null */
  allowedByPolicy: boolean | null;
  crossAccount: boolean;
  detail: { label: string; value: string }[];
  jump: SqsJump | null;
}

/** 큐 정책 문장 하나를 사람이 읽을 수 있게 푼 것 */
export interface PolicyGrant {
  sid: string | null;
  effect: "Allow" | "Deny";
  principals: string[];
  actions: string[];
  /** "aws:SourceArn ArnEquals arn:…" 같은 조건 한 줄씩 */
  conditions: string[];
  /** aws:SourceArn·aws:SourceAccount 값 */
  sources: string[];
  /** 조건 없는 Principal "*" Allow */
  public: boolean;
}

export interface SqsGap {
  section: string;
  error: string;
}

export interface SqsFlow {
  producers: FlowNode[];
  consumers: FlowNode[];
  dlq: FlowNode | null;
  /** 이 큐를 DLQ로 쓰는 큐 */
  sources: FlowNode[];
  policy: PolicyGrant[];
  /** 흐름에서 나온 진단(visibilityVsLambda, noConsumer, subscriptionDenied, kmsBlocksProducer) */
  findings: SqsFinding[];
  gaps: SqsGap[];
  /** IAM 주체를 계산했는가(withIam) */
  iam: boolean;
}

export type FlowEdgeKind = "subscription" | "rule" | "esm" | "pipe" | "dlq";

export interface SqsRegionFlow {
  nodes: FlowNode[];
  edges: { from: string; to: string; kind: FlowEdgeKind }[];
  gaps: SqsGap[];
}

/** 엿보기를 할 수 있는가. 안 되면 reason이 이유다 */
export interface SqsPeekable {
  allowed: boolean;
  reason: string | null;
}

export interface SqsMessageAttribute {
  name: string;
  dataType: string;
  /** 문자열 값, Binary면 base64 */
  value: string;
}

export interface SqsMessage {
  messageId: string;
  body: string;
  md5: string;
  /** 시스템 속성: SentTimestamp, ApproximateReceiveCount, ApproximateFirstReceiveTimestamp, MessageGroupId, MessageDeduplicationId, SequenceNumber, SenderId, AWSTraceHeader, DeadLetterQueueSourceArn */
  attributes: Record<string, string>;
  messageAttributes: SqsMessageAttribute[];
  /** 본문 바이트 수 */
  size: number;
}

/** 엿보기 세션. 영수증은 백엔드만 들고 있다 */
export interface SqsPeek {
  peekId: string;
  queueUrl: string;
  /** 보류가 끝나는 시각(Unix ms) */
  expiresAt: number;
  messages: SqsMessage[];
  stoppedReason: "max" | "empty";
}

export type SqsChange =
  | { kind: "receive"; max: number; holdSecs: number }
  | { kind: "moveTask"; destinationArn: string | null; maxPerSecond: number | null }
  | { kind: "cancelMoveTask"; taskHandle: string }
  | { kind: "resend"; peekId: string; messageIds: string[]; destinationUrl: string; edits: Record<string, string> }
  | { kind: "deleteMessages"; peekId: string; messageIds: string[] }
  | { kind: "purge" };

export interface SqsPreview {
  title: string;
  calls: { api: string; params: Record<string, string> }[];
  /** 수정 후 재전송의 본문 차이 등 */
  diff: { label: string; before: string; after: string }[];
  impact: string[];
  /** level "block"이면 적용할 수 없다 */
  warnings: PreviewWarning[];
  confirmName: string | null;
  expectedVersion: string | null;
}

export interface SqsItemResult {
  id: string;
  ok: boolean;
  error: string | null;
}

export interface SqsApplyResult {
  message: string;
  /** receive일 때만 */
  peek: SqsPeek | null;
  /** resend·deleteMessages의 메시지별 결과 */
  items: SqsItemResult[];
}

export interface SqsMoveTask {
  taskHandle: string | null;
  /** RUNNING | COMPLETED | CANCELLING | CANCELLED | FAILED */
  status: string;
  sourceArn: string;
  destinationArn: string | null;
  maxPerSecond: number | null;
  moved: number;
  toMove: number | null;
  failureReason: string | null;
  /** Unix ms */
  startedAt: number;
}

export interface SqsChangeRecord {
  id: string;
  /** RFC 3339 */
  at: string;
  profile: string;
  region: string;
  queueUrl: string;
  queueName: string;
  kind: SqsChange["kind"];
  summary: string;
  calls: { api: string; params: Record<string, string> }[];
  ok: boolean;
  error: string | null;
  /** 메시지 수가 있는 변경(receive·resend·deleteMessages·purge·moveTask) */
  count: number | null;
}
