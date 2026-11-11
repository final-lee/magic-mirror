// 테스트(와 데모)용 샘플. 한 시나리오에서 값을 맞춰 두었다: 계정 123456789012의 FIFO 주제 `orders-events.fifo`(고객 관리 키, 아카이브 30일)와 구독 넷 — SQS(필터·DLQ·raw), Lambda, 다른 계정·리전의 SQS(본문 범위 필터), 확인 대기 이메일.
import type { SnsSubscription, SnsTopic, TopicOverview } from "./types";
import type { SnsTopicRef } from "./targets";

export const ACCOUNT = "123456789012";
export const REGION = "ap-northeast-2";
export const TOPIC_ARN = `arn:aws:sns:${REGION}:${ACCOUNT}:orders-events.fifo`;

export const snsTarget: SnsTopicRef = { profile: "personal", region: REGION, topicArn: TOPIC_ARN, topicName: "orders-events.fifo" };

export const QUEUE_ARN = `arn:aws:sqs:${REGION}:${ACCOUNT}:orders-queue.fifo`;
export const QUEUE_URL = `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/orders-queue.fifo`;
export const FUNCTION_ARN = `arn:aws:lambda:${REGION}:${ACCOUNT}:function:order-processor`;
export const PARTNER_QUEUE_ARN = "arn:aws:sqs:us-east-1:999999999999:partner-queue";
export const DLQ_ARN = `arn:aws:sqs:${REGION}:${ACCOUNT}:orders-dlq`;

export const subArn = (id: string) => `${TOPIC_ARN}:${id}`;
export const PENDING_KEY = `${TOPIC_ARN}#pending#9f86d081884c`;

export const sampleOverview: TopicOverview = {
  kmsKey: "alias/orders",
  awsManagedKey: false,
  fifo: true,
  contentBasedDeduplication: true,
  fifoThroughputScope: "MessageGroup",
  archiveRetentionDays: 30,
  beginningArchiveTime: "2026-10-01T00:00:00Z",
  signatureVersion: 1,
  tracing: "Active",
  deliveryLogging: [
    { protocol: "Lambda", successRole: null, failureRole: null, sampleRate: 0 },
    { protocol: "SQS", successRole: `arn:aws:iam::${ACCOUNT}:role/sns-feedback`, failureRole: `arn:aws:iam::${ACCOUNT}:role/sns-failure`, sampleRate: 25 },
    { protocol: "HTTP", successRole: null, failureRole: null, sampleRate: 0 },
    { protocol: "Application", successRole: null, failureRole: null, sampleRate: 0 },
    { protocol: "Firehose", successRole: null, failureRole: null, sampleRate: 0 },
  ],
  httpDeliveryPolicy: [
    { key: "http.defaultHealthyRetryPolicy.minDelayTarget", value: "20" },
    { key: "http.defaultHealthyRetryPolicy.numRetries", value: "3" },
    { key: "http.disableSubscriptionOverrides", value: "false" },
  ],
  displayName: null,
  confirmedCount: 3,
  pendingCount: 1,
  deletedCount: 0,
};

export const sqsSubscription: SnsSubscription = {
  key: subArn("aaaa"),
  arn: subArn("aaaa"),
  protocol: "sqs",
  endpoint: QUEUE_ARN,
  state: "confirmed",
  filter: { policy: { event_type: ["order.created", { prefix: "order.p" }] }, scope: "MessageAttributes" },
  summary: "event_type ∈ {order.created, {\"prefix\":\"order.p\"}} · 속성 범위", filterErrors: [],
  raw: true,
  dlqArn: DLQ_ARN,
  target: { kind: "sqs", arn: QUEUE_ARN, url: QUEUE_URL, fifo: true, kmsKey: "alias/aws/sqs", policy: null, redrivePolicy: null, error: null },
  attributes: {
    Protocol: "sqs",
    Endpoint: QUEUE_ARN,
    RawMessageDelivery: "true",
    FilterPolicy: '{"event_type":["order.created",{"prefix":"order.p"}]}',
    RedrivePolicy: `{"deadLetterTargetArn":"${DLQ_ARN}"}`,
    SubscriptionArn: subArn("aaaa"),
  },
  error: null,
};

export const lambdaSubscription: SnsSubscription = {
  key: subArn("bbbb"),
  arn: subArn("bbbb"),
  protocol: "lambda",
  endpoint: FUNCTION_ARN,
  state: "confirmed",
  filter: null,
  summary: null, filterErrors: [],
  raw: false,
  dlqArn: null,
  target: { kind: "lambda", arn: FUNCTION_ARN, policy: null, error: null },
  attributes: { Protocol: "lambda", Endpoint: FUNCTION_ARN, RawMessageDelivery: "false", SubscriptionArn: subArn("bbbb") },
  error: null,
};

export const partnerSubscription: SnsSubscription = {
  key: subArn("cccc"),
  arn: subArn("cccc"),
  protocol: "sqs",
  endpoint: PARTNER_QUEUE_ARN,
  state: "confirmed",
  filter: { policy: { detail: { status: ["paid"] } }, scope: "MessageBody" },
  summary: "detail.status ∈ {paid} · 본문 범위", filterErrors: [],
  raw: false,
  dlqArn: null,
  target: null,
  attributes: { Protocol: "sqs", Endpoint: PARTNER_QUEUE_ARN, FilterPolicyScope: "MessageBody", FilterPolicy: '{"detail":{"status":["paid"]}}' },
  error: { kind: "accessDenied", action: "sqs:GetQueueAttributes" },
};

export const pendingSubscription: SnsSubscription = {
  key: PENDING_KEY,
  arn: null,
  protocol: "email",
  endpoint: "ops@example.com",
  state: "pending",
  filter: null,
  summary: null, filterErrors: [],
  raw: false,
  dlqArn: null,
  target: null,
  attributes: {},
  error: null,
};

export function sampleTopic(over: Partial<SnsTopic> = {}): SnsTopic {
  return {
    arn: TOPIC_ARN,
    name: "orders-events.fifo",
    region: REGION,
    account: ACCOUNT,
    fifo: true,
    attributes: { FifoTopic: "true", KmsMasterKeyId: "alias/orders", SubscriptionsConfirmed: "3", SubscriptionsPending: "1" },
    overview: sampleOverview,
    subscriptions: [sqsSubscription, lambdaSubscription, partnerSubscription, pendingSubscription],
    tags: { team: "orders" },
    dataProtectionPolicy: null,
    errors: [],
    ...over,
  };
}
