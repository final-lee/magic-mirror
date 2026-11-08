// 정책·점검과 계정 개요 테스트용 샘플. fixtures.ts의 계정·주제와 같은 시나리오다.
import { ACCOUNT, REGION, TOPIC_ARN } from "./fixtures";
import type { SnsAccountOverview, SnsFinding, SnsMessaging, SnsTopicPolicy } from "./types";

export const publicFinding: SnsFinding = {
  check: "publicPolicy", level: "high", topicArn: TOPIC_ARN, topicName: "orders-events.fifo",
  summary: "아무나(Principal *) 조건 없이 쓸 수 있는 문장이 있어요", detail: null, items: ["모든 주체(*)가 sns:Subscribe 가능, 조건 없음"],
};
export const unencryptedFinding: SnsFinding = { check: "unencrypted", level: "medium", topicArn: TOPIC_ARN, topicName: "orders-events.fifo", summary: "저장 시 암호화(KMS)가 꺼져 있어요", detail: null, items: [] };
export const signatureFinding: SnsFinding = { check: "signatureV1", level: "low", topicArn: TOPIC_ARN, topicName: "orders-events.fifo", summary: "서명 버전 1(SHA1)을 쓰고 있어요", detail: "서명 버전 2(SHA256)로 바꾸는 것을 권장해요.", items: [] };

export function samplePolicy(over: Partial<SnsTopicPolicy> = {}): SnsTopicPolicy {
  return {
    topicArn: TOPIC_ARN,
    policy: "{}",
    statements: [
      { index: 0, sid: "open", effect: "Allow", sentence: "모든 주체(*)가 sns:Subscribe 가능, 조건 없음", principals: [{ kind: "anyone", value: "*", account: null }], notAction: false, actions: ["sns:Subscribe"], conditions: [], scope: "public" },
      { index: 1, sid: null, effect: "Allow", sentence: `서비스 events.amazonaws.com가 sns:Publish 가능, aws:SourceAccount · StringEquals · ${ACCOUNT}`, principals: [{ kind: "service", value: "events.amazonaws.com", account: null }], notAction: false, actions: ["sns:Publish"], conditions: [`aws:SourceAccount · StringEquals · ${ACCOUNT}`], scope: "service" },
      { index: 2, sid: "block", effect: "Deny", sentence: "계정 999999999999가 sns:Publish 거부, 조건 없음", principals: [{ kind: "account", value: "999999999999", account: "999999999999" }], notAction: false, actions: ["sns:Publish"], conditions: [], scope: "crossAccount" },
    ],
    statementsError: null,
    access: [
      { principal: { kind: "anyone", value: "*", account: null }, effect: "Allow", canPublish: false, canSubscribe: true, statement: 0, scope: "public", conditions: [] },
      { principal: { kind: "service", value: "events.amazonaws.com", account: null }, effect: "Allow", canPublish: true, canSubscribe: false, statement: 1, scope: "service", conditions: [`aws:SourceAccount · StringEquals · ${ACCOUNT}`] },
    ],
    validation: [{ level: "securityWarning", code: "PASS_ROLE_WITH_STAR_IN_RESOURCE", message: "Principal이 너무 넓어요", learnMore: "https://docs.aws.amazon.com/example" }],
    findings: [publicFinding, unencryptedFinding, signatureFinding],
    errors: [],
    ...over,
  };
}

const ORDERS = `arn:aws:sns:${REGION}:${ACCOUNT}:orders`;
const ALERTS = `arn:aws:sns:${REGION}:${ACCOUNT}:alerts`;

export function sampleOverview(over: Partial<SnsAccountOverview> = {}): SnsAccountOverview {
  return {
    account: ACCOUNT, region: REGION, start: 0, end: 86_400_000,
    topics: [
      { arn: ALERTS, name: "alerts", fifo: false, subscriptions: 2, pending: 1, published: 1200, delivered: 1190, failed: 10, filteredOut: 0, error: null },
      { arn: ORDERS, name: "orders", fifo: false, subscriptions: 3, pending: 0, published: 50, delivered: 50, failed: 0, filteredOut: 4, error: null },
    ],
    orphans: [
      { subscriptionArn: `${ORDERS}:aaaa`, topicArn: ORDERS, protocol: "sqs", endpoint: `arn:aws:sqs:${REGION}:${ACCOUNT}:gone-queue`, reason: "endpointMissing" },
      { subscriptionArn: `arn:aws:sns:${REGION}:${ACCOUNT}:deleted:bbbb`, topicArn: `arn:aws:sns:${REGION}:${ACCOUNT}:deleted`, protocol: "lambda", endpoint: `arn:aws:lambda:${REGION}:${ACCOUNT}:function:fn`, reason: "topicMissing" },
    ],
    pending: [{ topicArn: ALERTS, topicName: "alerts", protocol: "email", endpoint: "ops@example.com" }],
    findings: [
      { check: "publicPolicy", level: "high", topicArn: ALERTS, topicName: "alerts", summary: "아무나(Principal *) 조건 없이 쓸 수 있는 문장이 있어요", detail: null, items: [] },
      { check: "signatureV1", level: "low", topicArn: ALERTS, topicName: "alerts", summary: "서명 버전 1(SHA1)을 쓰고 있어요", detail: null, items: [] },
      { check: "signatureV1", level: "low", topicArn: ORDERS, topicName: "orders", summary: "서명 버전 1(SHA1)을 쓰고 있어요", detail: null, items: [] },
    ],
    checks: [
      { id: "publicPolicy", level: "high", title: "정책이 공개돼 있어요" },
      { id: "signatureV1", level: "low", title: "서명 버전 1(SHA1)이에요" },
    ],
    metrics: [{ name: "NumberOfMessagesPublishedPerAccount", stat: "Sum", value: 1250 }],
    metricsAvailable: true, truncated: false, errors: [],
    ...over,
  };
}

export function sampleMessaging(over: Partial<SnsMessaging> = {}): SnsMessaging {
  return {
    sms: {
      sandbox: true,
      sandboxNumbers: [{ phone: "+82******1234", status: "Verified" }],
      originationNumbers: [{ phoneNumber: "+12065550100", status: "ACTIVE", country: "US", routeType: "Transactional", capabilities: ["SMS"] }],
      attributes: { DefaultSMSType: "Transactional", MonthlySpendLimit: "1" },
      monthSpentUsd: 0.5, successRate: 98.5,
    },
    apps: [
      { arn: `arn:aws:sns:${REGION}:${ACCOUNT}:app/APNS/ios`, name: "ios", platform: "APNS", enabled: true, certExpiry: "2027-01-02T03:04:05Z", attributes: {}, endpoints: 12, disabledEndpoints: 3, endpointsTruncated: false, error: null },
      { arn: `arn:aws:sns:${REGION}:${ACCOUNT}:app/GCM/android`, name: "android", platform: "GCM", enabled: false, certExpiry: null, attributes: {}, endpoints: 1000, disabledEndpoints: 7, endpointsTruncated: true, error: null },
    ],
    errors: [],
    ...over,
  };
}
