import { emit } from "@tauri-apps/api/event";
import { ACCOUNT, REGION, TOPIC_ARN, QUEUE_ARN, QUEUE_URL, DLQ_ARN, FUNCTION_ARN, subArn, sampleTopic, sampleOverview, sqsSubscription, lambdaSubscription, pendingSubscription } from "../../src/sns/fixtures";
import { sampleMessaging } from "../../src/sns/accessFixtures";
import type { FilterInput, FilterResult, SnsAccountOverview, SnsChangeRecord, SnsChangeRequest, SnsDiagnosisReport, SnsPlan, SnsPublishers, SnsSubscription, SnsTopic, SnsTopicPolicy } from "../../src/sns/types";
import type { PeekEvent, PeekVerdict } from "../../src/sns/peekSession";

const alerts = `arn:aws:sns:${REGION}:${ACCOUNT}:alerts`;
const brokenArn = `arn:aws:sqs:${REGION}:${ACCOUNT}:billing-queue.fifo`;
const brokenUrl = `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/billing-queue.fifo`;
const dlqUrl = `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/orders-dlq`;
const statement = { Sid: "AllowSnsDelivery", Effect: "Allow", Principal: { Service: "sns.amazonaws.com" }, Action: "sqs:SendMessage", Resource: brokenArn, Condition: { ArnEquals: { "aws:SourceArn": TOPIC_ARN } } };
const broken: SnsSubscription = { ...sqsSubscription, key: subArn("cccc"), arn: subArn("cccc"), endpoint: brokenArn, filter: null, summary: null, raw: false, dlqArn: null, target: { kind: "sqs", arn: brokenArn, url: brokenUrl, fifo: true, kmsKey: null, policy: null, redrivePolicy: null, error: null }, attributes: { Protocol: "sqs", Endpoint: brokenArn }, error: null };
const https: SnsSubscription = { ...pendingSubscription, key: subArn("dddd"), arn: subArn("dddd"), protocol: "https", endpoint: "https://hooks.example.com/orders", state: "confirmed" };
const subscriptions = [{ ...sqsSubscription, target: { ...sqsSubscription.target!, kind: "sqs" as const, arn: QUEUE_ARN, url: QUEUE_URL, fifo: true, kmsKey: null, policy: JSON.stringify(statement), redrivePolicy: null, error: null } }, broken, lambdaSubscription, pendingSubscription, https];
const topic: SnsTopic = sampleTopic({ overview: { ...sampleOverview, archiveRetentionDays: 7, confirmedCount: 4 }, subscriptions, attributes: { FifoTopic: "true", KmsMasterKeyId: "alias/orders", ArchivePolicy: '{"MessageRetentionPeriod":7}', SubscriptionsConfirmed: "4", SubscriptionsPending: "1" } });
const alertTopic: SnsTopic = sampleTopic({ arn: alerts, name: "alerts", fifo: false, overview: { ...sampleOverview, fifo: false, kmsKey: null, archiveRetentionDays: null, confirmedCount: 0, pendingCount: 0 }, subscriptions: [], attributes: {} });
const report: SnsDiagnosisReport = { topicChecks: [{ id: "kms", status: "ok", summary: "고객 관리 KMS 키로 암호화되어 있어요", detail: null, fix: null }, { id: "logging", status: "ok", summary: "SQS 배달 상태 로깅이 켜져 있어요", detail: null, fix: null }], subscriptions: [{ subscription: broken.key, verdict: "큐 정책이 없어 배달할 수 없어요", checks: [{ id: "queuePolicy", status: "fail", summary: "SQS 큐 정책이 SNS 배달을 허용하지 않아요", detail: "주제에서 큐로 메시지를 보낼 수 있도록 정책을 추가하세요.", fix: { kind: "queuePolicy", queueArn: brokenArn, queueUrl: brokenUrl, statement } }] }, { subscription: sqsSubscription.key, verdict: "배달 경로가 정상이에요", checks: [{ id: "queuePolicy", status: "ok", summary: "큐 정책이 SNS 배달을 허용해요", detail: null, fix: null }, { id: "dlq", status: "ok", summary: "배달 실패 메시지를 DLQ에 보관해요", detail: null, fix: null }] }], failures: [{ destination: brokenArn, statusCode: "403", response: "AccessDenied", timestamp: "2026-11-06T08:30:00Z", attempts: 1 }], metrics: { failed: 12, filteredInvalidAttributes: 0, filteredInvalidBody: 0, redrivenToDlq: 2, delivered: 1248, published: 630 } };
const principal = { kind: "account", value: "999999999999", account: "999999999999" };
const owner = { kind: "account", value: ACCOUNT, account: ACCOUNT };
const policy: SnsTopicPolicy = { topicArn: TOPIC_ARN, policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Sid: "__default_statement_ID", Effect: "Allow", Principal: { AWS: "*" }, Action: "SNS:*", Resource: TOPIC_ARN, Condition: { StringEquals: { "AWS:SourceOwner": ACCOUNT } } }, { Sid: "PartnerSubscribe", Effect: "Allow", Principal: { AWS: "arn:aws:iam::999999999999:root" }, Action: "sns:Subscribe", Resource: TOPIC_ARN }] }, null, 2), statements: [{ index: 0, sid: "__default_statement_ID", effect: "Allow", sentence: "이 계정의 주체가 SNS 작업을 할 수 있어요", principals: [owner], notAction: false, actions: ["SNS:*"], conditions: [`AWS:SourceOwner · StringEquals · ${ACCOUNT}`], scope: "sameAccount" }, { index: 1, sid: "PartnerSubscribe", effect: "Allow", sentence: "파트너 계정이 구독할 수 있어요", principals: [principal], notAction: false, actions: ["sns:Subscribe"], conditions: [], scope: "crossAccount" }], statementsError: null, access: [{ principal: owner, effect: "Allow", canPublish: true, canSubscribe: true, statement: 0, scope: "sameAccount", conditions: [`AWS:SourceOwner · StringEquals · ${ACCOUNT}`] }, { principal, effect: "Allow", canPublish: false, canSubscribe: true, statement: 1, scope: "crossAccount", conditions: [] }], validation: [], findings: [], errors: [] };
const publishers: SnsPublishers = { publishers: [{ kind: "alarm", name: "orders-high-errors", arn: `arn:aws:cloudwatch:${REGION}:${ACCOUNT}:alarm:orders-high-errors`, principal: "cloudwatch.amazonaws.com", configured: true }, { kind: "alarm", name: "api-latency", arn: `arn:aws:cloudwatch:${REGION}:${ACCOUNT}:alarm:api-latency`, principal: "cloudwatch.amazonaws.com", configured: true }], scanned: null, errors: [] };
const now = Date.now();
const account: SnsAccountOverview = { account: ACCOUNT, region: REGION, start: now - 86400000, end: now, topics: [{ arn: TOPIC_ARN, name: topic.name, fifo: true, subscriptions: 5, pending: 1, published: 12400, delivered: 24180, failed: 12, filteredOut: 620, error: null }, { arn: alerts, name: "alerts", fifo: false, subscriptions: 0, pending: 0, published: 142, delivered: 142, failed: 0, filteredOut: 0, error: null }], orphans: [], pending: [{ topicArn: TOPIC_ARN, topicName: topic.name, protocol: "email", endpoint: "ops@example.com" }], findings: [{ check: "signatureV1", level: "low", topicArn: TOPIC_ARN, topicName: topic.name, summary: "서명 버전 1을 쓰고 있어요", detail: null, items: [] }], checks: [{ id: "signatureV1", level: "low", title: "서명 버전 1이에요" }], metrics: [{ name: "NumberOfMessagesPublishedPerAccount", stat: "Sum", value: 12542 }], metricsAvailable: true, truncated: false, errors: [] };
const eligibility: PeekVerdict[] = [{ queueArn: DLQ_ARN, queueName: "orders-dlq", queueUrl: dlqUrl, eligible: true, dlq: true, warning: null, reason: null }, { queueArn: QUEUE_ARN, queueName: "orders-queue.fifo", queueUrl: QUEUE_URL, eligible: false, dlq: false, warning: null, reason: "활성 소비자가 있어요" }];
const event = (n: number): PeekEvent => ({ session: "demo-peek", kind: "message", message: { messageId: `sqs-${n}`, snsMessageId: `sns-${n}`, topicArn: TOPIC_ARN, timestamp: "2026-11-06T08:30:00Z", body: JSON.stringify({ orderId: `ord-104${n}`, event: "order.created", amount: 42000 + n * 1000 }, null, 2), attributes: { event_type: { Type: "String", Value: "order.created" } }, failureLines: [] } });
const records: SnsChangeRecord[] = [{ id: "change-001", at: "2026-11-05T09:15:00Z", profile: "prod", region: REGION, topicArn: TOPIC_ARN, request: { kind: "archivePolicy", topicArn: TOPIC_ARN, retentionDays: 7 }, calls: [], before: null, after: { retentionDays: 7 }, undoOf: null, undone: false }];
function plan(request: SnsChangeRequest): SnsPlan { return { request, topicArn: TOPIC_ARN, calls: [{ api: "sqs:SetQueueAttributes", target: brokenUrl, body: { Policy: JSON.stringify({ Version: "2012-10-17", Statement: [statement] }, null, 2) } }], fields: [{ field: "Policy", before: null, after: statement, diff: null }], impact: [{ subscription: broken.key, check: "queuePolicy", before: "실패", after: "정상" }], warnings: [], confirm: null, fingerprint: "demo-plan", undoOf: null }; }
const resource = (id: string, name: string, arn: string, values: Record<string, string> = {}) => ({ id, name, arn, values: { id, name, ...values }, tags: {}, fields: [], raw: "{}", consoleUrl: null });
export const snsResources = { "sns/topics": [resource(TOPIC_ARN, topic.name, TOPIC_ARN, { arn: TOPIC_ARN, fifo: "true", subscriptions: "5" }), resource(alerts, "alerts", alerts, { arn: alerts, fifo: "false", subscriptions: "0" })], "sns/subscriptions": subscriptions.map(s => resource(s.key, topic.name, s.arn ?? "", { protocol: s.protocol, endpoint: s.endpoint, topicArn: TOPIC_ARN })), "sqs/queues": [resource(QUEUE_URL, "orders-queue.fifo", QUEUE_ARN), resource(brokenUrl, "billing-queue.fifo", brokenArn), resource(dlqUrl, "orders-dlq", DLQ_ARN)], "lambda/functions": [resource("order-processor", "order-processor", FUNCTION_ARN)] };
export function snsMock(cmd: string, args: Record<string, any>): unknown {
  switch (cmd) {
    case "sns_topic": return args.arn === alerts ? alertTopic : topic;
    case "sns_subscriptions_all": return subscriptions.map(s => ({ key: s.key, arn: s.arn, topicArn: TOPIC_ARN, protocol: s.protocol, endpoint: s.endpoint, state: s.state }));
    case "sns_subscribed_topics": return [TOPIC_ARN];
    case "sns_diagnose": return report;
    case "sns_filter_test": return (args.policies as FilterInput[]).map((p): FilterResult => ({ key: p.key, verdict: { matched: true, key: p.policy ? "event_type" : null, reason: p.policy ? "order.created 일치" : null }, errors: [], summary: null }));
    case "sns_publishers": return publishers;
    case "sns_topic_policy": return policy;
    case "sns_account_overview": return account;
    case "sns_messaging": return sampleMessaging();
    case "sns_changes": return records;
    case "sns_plan": return plan(args.request);
    case "sns_undo_plan": return plan({ kind: "undo", id: args.id });
    case "sns_apply": return { callsRun: args.plan.calls, error: null, recordId: "change-002" };
    case "sns_validate_policy": return [];
    case "sns_check_public_access": case "sns_check_policy_document": return { result: "pass", message: null, reasons: [], finding: null };
    case "sns_logging_roles": return [{ name: "sns-feedback", arn: `arn:aws:iam::${ACCOUNT}:role/sns-feedback` }];
    case "sns_peek_eligibility": return eligibility;
    case "sns_peek_start": for (let n = 1; n <= 3; n++) setTimeout(() => void emit("sns-peek", event(n)), n * 100); return "demo-peek";
    case "sns_peek_stop": return null;
    default: return undefined;
  }
}
