import type { AppError } from "../api/types";

// 백엔드(src-tauri/src/sns/model.rs)가 camelCase로 보내는 모양 그대로다.

export interface SnsTopic {
  arn: string;
  name: string;
  region: string;
  account: string;
  fifo: boolean;
  /** GetTopicAttributes 응답 그대로(기본값인 키는 없다) */
  attributes: Record<string, string>;
  overview: TopicOverview;
  subscriptions: SnsSubscription[];
  tags: Record<string, string>;
  /** 데이터 보호 정책 JSON 글. 없으면 null */
  dataProtectionPolicy: string | null;
  /** 읽지 못한 항목별 오류. 나머지는 그대로 그린다 */
  errors: AppError[];
}

export interface TopicOverview {
  /** 별칭(alias/…)·키 ID·키 ARN 중 주제에 적힌 그대로 */
  kmsKey: string | null;
  awsManagedKey: boolean;
  fifo: boolean;
  contentBasedDeduplication: boolean;
  /** "Topic" | "MessageGroup" */
  fifoThroughputScope: string | null;
  archiveRetentionDays: number | null;
  beginningArchiveTime: string | null;
  signatureVersion: number;
  /** "Active" | "PassThrough" */
  tracing: string | null;
  deliveryLogging: DeliveryLogging[];
  httpDeliveryPolicy: HttpDeliveryRow[];
  displayName: string | null;
  confirmedCount: number;
  pendingCount: number;
  deletedCount: number;
}

export interface DeliveryLogging {
  protocol: string;
  successRole: string | null;
  failureRole: string | null;
  sampleRate: number | null;
}

/** EffectiveDeliveryPolicy를 점(.)으로 이은 키로 편 한 줄 */
export interface HttpDeliveryRow {
  key: string;
  value: string;
}

export interface SnsFilter {
  policy: unknown;
  scope: "MessageAttributes" | "MessageBody";
}

export type SnsSubscriptionState = "confirmed" | "pending" | "unknown";

export interface SnsSubscription {
  /** 구독 ARN. 확인 대기면 `<주제 ARN>#pending#<해시 12자리>`(리소스 브라우저 행 ID와 같다) */
  key: string;
  /** 확인 대기면 null */
  arn: string | null;
  protocol: string;
  endpoint: string;
  state: SnsSubscriptionState;
  filter: SnsFilter | null;
  summary: string | null;
  filterErrors: PolicyError[];
  raw: boolean;
  dlqArn: string | null;
  /** 해석한 엔드포인트(SQS·Lambda만) */
  target: SnsTarget | null;
  attributes: Record<string, string>;
  /** 이 구독의 속성을 읽지 못한 이유 */
  error: AppError | null;
}

export type SnsTarget =
  | { kind: "sqs"; arn: string; url: string; fifo: boolean; kmsKey: string | null; policy: string | null; redrivePolicy: string | null; error: AppError | null }
  | { kind: "lambda"; arn: string; policy: string | null; error: AppError | null };

/** 계정의 구독 목록(ListSubscriptions) 한 줄 */
export interface SnsSubscriptionRow {
  arn: string | null;
  topicArn: string;
  protocol: string;
  endpoint: string;
  state: SnsSubscriptionState;
}

export type SnsFix =
  | { kind: "queuePolicy"; queueArn: string; queueUrl: string; statement: unknown }
  | { kind: "lambdaPermission"; functionArn: string; statementId: string; sourceArn: string }
  | { kind: "kmsStatement"; keyArn: string; statement: unknown }
  | { kind: "addDlq"; subscriptionArn: string };
export type SnsCheckStatus = "ok" | "warn" | "fail" | "skip";
export interface SnsCheck { id: string; status: SnsCheckStatus; summary: string; detail: string | null; fix: SnsFix | null }
export interface SnsDiagnosis { subscription: string; checks: SnsCheck[]; verdict: string }
export interface DeliveryFailure { destination: string; statusCode: string | null; response: string | null; timestamp: string | null; attempts: number | null }
export interface TopicHourMetrics { failed: number | null; filteredInvalidAttributes: number | null; filteredInvalidBody: number | null; redrivenToDlq: number | null; delivered: number | null; published: number | null }
export interface SnsDiagnosisReport { topicChecks: SnsCheck[]; subscriptions: SnsDiagnosis[]; failures: DeliveryFailure[]; metrics: TopicHourMetrics }

export interface PolicyError { message: string; path: string | null }
export interface FilterSample { attributes: { name: string; dataType: "String" | "String.Array" | "Number" | "Binary"; value: string }[]; body: string | null }
export interface FilterInput { key: string; policy: string | null; scope: "MessageAttributes" | "MessageBody" }
export interface FilterResult { key: string; verdict: { matched: boolean; key: string | null; reason: string | null } | null; errors: PolicyError[]; summary: string | null }

// 정책·점검(S4). 백엔드 src-tauri/src/sns/{access,findings,account,messaging}.rs가 camelCase로 보내는 모양 그대로다.
export type SnsLevel = "high" | "medium" | "low" | "info";
export interface SnsCheckInfo { id: string; level: SnsLevel; title: string }
export interface SnsFinding { check: string; level: SnsLevel; topicArn: string; topicName: string; summary: string; detail: string | null; items: string[] }
export type SnsReach = "public" | "crossAccount" | "service" | "sameAccount" | "unknown";
export interface SnsPrincipal { kind: string; value: string; account: string | null }
export interface SnsStatementView { index: number; sid: string | null; effect: "Allow" | "Deny" | string; sentence: string; principals: SnsPrincipal[]; notAction: boolean; actions: string[]; conditions: string[]; scope: SnsReach }
export interface SnsAccessRow { principal: SnsPrincipal; effect: string; canPublish: boolean; canSubscribe: boolean; statement: number; scope: SnsReach; conditions: string[] }
export type SnsValidationLevel = "error" | "securityWarning" | "warning" | "suggestion";
export interface SnsPolicyFinding { level: SnsValidationLevel; code: string; message: string; learnMore: string | null }
export interface SnsTopicPolicy {
  topicArn: string;
  /** 들여쓴 정책 JSON. 정책이 없으면 null */
  policy: string | null;
  statements: SnsStatementView[];
  statementsError: string | null;
  access: SnsAccessRow[];
  /** Access Analyzer ValidatePolicy 지적. null이면 검사하지 못한 것이다(이유는 errors) */
  validation: SnsPolicyFinding[] | null;
  findings: SnsFinding[];
  errors: AppError[];
}
/** 유료 CheckNoPublicAccess 결과(호출당 $0.002). FAIL이면 finding이 주제의 점검 목록에 더할 publicPolicy 항목이다 */
export interface SnsPublicAccessReport { result: "pass" | "fail" | "unknown"; message: string | null; reasons: string[]; finding: SnsFinding | null }

export interface SnsAccountTopicRow {
  arn: string;
  name: string;
  fifo: boolean;
  /** 확인됨 + 확인 대기 */
  subscriptions: number;
  pending: number;
  published: number;
  delivered: number;
  failed: number;
  filteredOut: number;
  /** 속성을 못 읽은 주제 */
  error: AppError | null;
}
export interface SnsOrphan { subscriptionArn: string | null; topicArn: string; protocol: string; endpoint: string; reason: "topicMissing" | "endpointMissing" }
export interface SnsPendingSubscription { topicArn: string; topicName: string; protocol: string; endpoint: string }
export interface SnsAccountMetric { name: string; stat: string; value: number }
export interface SnsAccountOverview {
  account: string;
  region: string;
  /** 지표를 읽은 구간(epoch ms) */
  start: number;
  end: number;
  /** 실패 많은 순 */
  topics: SnsAccountTopicRow[];
  orphans: SnsOrphan[];
  pending: SnsPendingSubscription[];
  /** 모든 주제의 점검 결과. 끈 점검은 화면이 걸러 낸다 */
  findings: SnsFinding[];
  checks: SnsCheckInfo[];
  metrics: SnsAccountMetric[];
  /** false면 지표를 읽지 못했다(표의 숫자는 비어 있는 값) */
  metricsAvailable: boolean;
  truncated: boolean;
  errors: AppError[];
}

export interface SnsSandboxNumber { /** 가린 번호 */ phone: string; status: string }
export interface SnsOriginationNumber { phoneNumber: string; status: string; country: string | null; routeType: string | null; capabilities: string[] }
export interface SnsSmsInfo {
  /** null이면 읽지 못했다 */
  sandbox: boolean | null;
  sandboxNumbers: SnsSandboxNumber[];
  originationNumbers: SnsOriginationNumber[];
  attributes: Record<string, string>;
  /** 이번 달 지출(USD) */
  monthSpentUsd: number | null;
  /** 지난 24시간 성공률(%) */
  successRate: number | null;
}
export interface SnsPlatformApp {
  arn: string;
  name: string;
  platform: string;
  enabled: boolean | null;
  certExpiry: string | null;
  attributes: Record<string, string>;
  endpoints: number;
  disabledEndpoints: number;
  /** endpoints가 상한에서 멈춘 값이다 */
  endpointsTruncated: boolean;
  error: AppError | null;
}
export interface SnsMessaging { sms: SnsSmsInfo; apps: SnsPlatformApp[]; errors: AppError[] }

export interface SnsPublisher { kind: "alarm" | "eventbridge" | "rds" | "elasticache" | "s3" | "lambda" | "policy"; name: string; arn: string | null; principal: string | null; configured: boolean }
export interface SnsDeepScan { buckets: number; functions: number }
export interface SnsPublishers { publishers: SnsPublisher[]; scanned: SnsDeepScan | null; errors: AppError[] }

// 변경 틀(S5). 백엔드 src-tauri/src/sns/change*.rs가 camelCase로 보내는 모양 그대로다.
export type SnsFilterScope = "MessageAttributes" | "MessageBody";
/** 구독 만들기에서 고를 수 있는 프로토콜(SMS·모바일 푸시는 만들지 않는다) */
export type SnsSubscribeProtocol = "sqs" | "lambda" | "https" | "http" | "email" | "email-json";
/** 배달 상태 로깅의 프로토콜 이름(주제 속성 접두사). HTTP는 http·https 구독 모두 */
export type SnsLoggingProtocol = "Lambda" | "SQS" | "HTTP" | "Application" | "Firehose";
export type SnsPublishAttributeType = "String" | "String.Array" | "Number";
export interface SnsPublishAttribute { name: string; dataType: SnsPublishAttributeType; value: string }
/** 배달 상태 로깅에 고를 수 있는 기존 IAM 역할(SNS를 신뢰하는 역할) */
export interface SnsRole { name: string; arn: string }
export type SnsChangeRequest =
  | { kind: "queuePolicy"; topicArn: string; queueUrl: string; queueArn: string }
  | { kind: "lambdaPermission"; topicArn: string; functionArn: string }
  | { kind: "addDlq"; subscriptionArn: string; dlqArn: string }
  | { kind: "replay"; subscriptionArn: string; start: string; end?: string | null }
  | { kind: "archivePolicy"; topicArn: string; retentionDays: number | null }
  | { kind: "subscribe"; topicArn: string; protocol: SnsSubscribeProtocol; endpoint: string; filterPolicy: string | null; filterPolicyScope: SnsFilterScope | null; rawMessageDelivery: boolean; dlqArn: string | null }
  | { kind: "unsubscribe"; subscriptionArn: string }
  | { kind: "filterPolicy"; subscriptionArn: string; filterPolicy: string | null; scope: SnsFilterScope }
  | { kind: "rawDelivery"; subscriptionArn: string; enabled: boolean }
  | { kind: "subscriptionDeliveryPolicy"; subscriptionArn: string; deliveryPolicy: string | null }
  | { kind: "topicDeliveryPolicy"; topicArn: string; deliveryPolicy: string | null }
  | { kind: "topicPolicy"; topicArn: string; policy: string }
  | { kind: "deliveryLogging"; topicArn: string; protocol: SnsLoggingProtocol; successRoleArn: string | null; failureRoleArn: string | null; sampleRate: number }
  | { kind: "publish"; topicArn: string; message: string; subject: string | null; messageStructureJson: boolean; attributes: SnsPublishAttribute[]; messageGroupId: string | null; deduplicationId: string | null }
  | { kind: "undo"; id: string };
/** 보낼 AWS 호출 하나: API 이름, 대상(큐 URL·구독 ARN·함수 ARN), 본문 */
export interface SnsCall { api: string; target: string; body: unknown }
/** 바뀌는 값. diff는 글이 긴 값(정책)의 줄 차이(unified diff 글)이고 없으면 null이다 */
export interface SnsFieldChange { field: string; before: unknown; after: unknown; diff: string | null }
/** 진단 점검 하나가 이 변경으로 어떻게 바뀌는지 */
export interface SnsImpact { subscription: string; check: string; before: string; after: string }
export interface SnsPlan {
  request: SnsChangeRequest;
  topicArn: string;
  calls: SnsCall[];
  fields: SnsFieldChange[];
  impact: SnsImpact[];
  warnings: string[];
  /** 있으면 이 글을 그대로 입력해야 적용할 수 있다 */
  confirm: string | null;
  fingerprint: string;
  /** 되돌리기 계획이면 되돌리는 기록의 id */
  undoOf: string | null;
}
/** `outputs`: 호출마다의 결과값(`callsRun`과 같은 순서). 구독 만들기는 `{ subscriptionArn }`, 시험 발행은 `{ messageId, sequenceNumber }`, 그 밖에는 null */
export interface SnsApplyResult { callsRun: SnsCall[]; outputs?: unknown[]; error: string | null; recordId: string | null }
export interface SnsChangeRecord {
  id: string;
  at: string;
  profile: string;
  region: string;
  topicArn: string;
  request: SnsChangeRequest;
  calls: SnsCall[];
  before: unknown;
  after: unknown;
  undoOf: string | null;
  undone: boolean;
  /** 개인정보 보호로 되돌릴 값을 저장하지 못한 이유 */
  undoBlocked: string | null;
}
