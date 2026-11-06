// 데모용 SQS 탭(📬) 명령 흉내: sqs_* 명령과 큐 상세의 CloudWatch 지표(resource_metrics, service가 sqs일 때만).
// 큐 10개가 원본 → DLQ 다섯 쌍이다: orders(DLQ에 12개 쌓임, 생산자·소비자 흐름이 가장 풍부), payments.fifo(FIFO), notifications(소비자 멈춤),
// emails(DLQ 보관 기간이 짧음, DLQ 메시지를 옮기는 작업이 진행 중), thumbnails(정상).
// 목록의 행(sqs/queues)은 이 모듈이 sqsResources로 내놓는다.
import type { MetricChart, ResourceMetrics } from "../../src/api/types";
import type {
  FlowEdgeKind, FlowNode, PolicyGrant, SqsActivity, SqsApplyResult, SqsChange, SqsChangeRecord, SqsFinding, SqsFlow, SqsMessage, SqsMoveTask, SqsOverview, SqsPeek,
  SqsPeekable, SqsPreview, SqsQueue, SqsRegionFlow,
} from "../../src/sqs/types";

type Args = Record<string, any>;

const ACCOUNT = "123456789012";
const PARTNER = "210987654321";
const REGION = "ap-northeast-2";
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW0 = Date.now();

/** 같은 값이 나오는 난수(데모를 열 때마다 화면이 같아야 한다) */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s: string) => [...s].reduce((n, c) => (Math.imul(n, 31) + c.charCodeAt(0)) | 0, 7);
const hex = (r: () => number, n: number) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join("");
const uuid = (r: () => number) => `${hex(r, 8)}-${hex(r, 4)}-4${hex(r, 3)}-a${hex(r, 3)}-${hex(r, 12)}`;

const urlOf = (name: string) => `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/${name}`;
const arnOf = (name: string) => `arn:aws:sqs:${REGION}:${ACCOUNT}:${name}`;
const nameOfArn = (arn: string) => arn.slice(arn.lastIndexOf(":") + 1);
const topicArn = (name: string, account = ACCOUNT) => `arn:aws:sns:${REGION}:${account}:${name}`;
const ruleArn = (name: string) => `arn:aws:events:${REGION}:${ACCOUNT}:rule/${name}`;
const functionArn = (name: string) => `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${name}`;
const roleArn = (name: string) => `arn:aws:iam::${ACCOUNT}:role/${name}`;

// ───────────────────────── 진단 문구(백엔드 health.rs와 같다) ─────────────────────────
const finding = (id: SqsFinding["id"], level: SqsFinding["level"], summary: string, detail: string): SqsFinding => ({ id, level, summary, detail });
const dlqBacklogOnDlq = (n: number) =>
  finding("dlqBacklog", "fail", `DLQ에 ${n}개가 쌓여 있어요`, "소비자가 처리하지 못해 옮겨진 메시지예요. 메시지 탭에서 원인을 확인하고 다시 보내거나 지워 주세요");
const dlqBacklogOnSource = (dlq: string, n: number) =>
  finding("dlqBacklog", "fail", `DLQ \`${dlq}\`에 ${n}개가 쌓여 있어요`, "이 큐에서 처리에 실패한 메시지가 DLQ로 옮겨졌어요");
const stalled = (n: number) =>
  finding("stalled", "warn", `보이는 메시지 ${n}개가 있는데 최근 15분 동안 받아 간 곳이 없어요`, "소비자가 멈췄거나 연결이 끊겼을 수 있어요");
const dlqRetentionShort = (dlq: string, dlqRetention: number, retention: number) =>
  finding(
    "dlqRetentionShort", "warn", "DLQ 보관 기간이 원본 큐보다 길지 않아요",
    `DLQ \`${dlq}\`의 보관 기간은 ${dlqRetention}초, 이 큐는 ${retention}초예요. Standard 큐에서는 DLQ로 옮겨져도 처음 넣은 시각 기준으로 만료돼서 DLQ에서 살아 있는 시간이 짧아져요`,
  );
const noEncryption = () => finding("noEncryption", "info", "저장 시 암호화가 꺼져 있어요", "SSE-SQS나 KMS 키로 암호화할 수 있어요");

// ───────────────────────── 큐 ─────────────────────────
interface Spec {
  name: string;
  fifo?: boolean;
  visible: number;
  inFlight: number;
  delayed?: number;
  visibility: number;
  retention: number;
  waitTime: number;
  dlq?: { name: string; max: number };
  kmsKey?: string;
  sse?: boolean;
  activity: SqsActivity;
  createdDays: number;
  /** 큐 정책에서 보내기를 허용하는 SNS 토픽·규칙(이름) */
  senders?: string[];
}

const RETENTION_4D = 345_600;
const RETENTION_14D = 1_209_600;

const SPECS: Spec[] = [
  { name: "orders-queue", visible: 184, inFlight: 23, visibility: 120, retention: RETENTION_4D, waitTime: 20, dlq: { name: "orders-dlq", max: 5 }, activity: { oldestAgeSec: 42, received15m: 1_420, emptyReceives15m: 36 }, createdDays: 412, senders: ["order-events", "partner-orders", "order-timeout-sweep"] },
  { name: "orders-dlq", visible: 12, inFlight: 0, visibility: 30, retention: RETENTION_14D, waitTime: 0, activity: { oldestAgeSec: 5_820, received15m: 0, emptyReceives15m: 0 }, createdDays: 412 },
  { name: "payments.fifo", fifo: true, visible: 7, inFlight: 3, visibility: 300, retention: RETENTION_4D, waitTime: 20, dlq: { name: "payments-dlq.fifo", max: 3 }, kmsKey: "alias/payments", activity: { oldestAgeSec: 9, received15m: 868, emptyReceives15m: 12 }, createdDays: 301, senders: ["payment-events.fifo"] },
  { name: "payments-dlq.fifo", fifo: true, visible: 0, inFlight: 0, visibility: 300, retention: RETENTION_14D, waitTime: 0, kmsKey: "alias/payments", activity: { oldestAgeSec: 0, received15m: 0, emptyReceives15m: 0 }, createdDays: 301 },
  { name: "notifications-queue", visible: 1_840, inFlight: 0, visibility: 60, retention: RETENTION_4D, waitTime: 10, dlq: { name: "notifications-dlq", max: 5 }, sse: true, activity: { oldestAgeSec: 7_480, received15m: 0, emptyReceives15m: 0 }, createdDays: 188, senders: ["notification-events"] },
  { name: "notifications-dlq", visible: 0, inFlight: 0, visibility: 60, retention: RETENTION_14D, waitTime: 0, sse: true, activity: { oldestAgeSec: 0, received15m: 0, emptyReceives15m: 0 }, createdDays: 188 },
  { name: "emails-queue", visible: 96, inFlight: 8, visibility: 180, retention: RETENTION_4D, waitTime: 20, dlq: { name: "emails-dlq", max: 4 }, sse: true, activity: { oldestAgeSec: 310, received15m: 2_104, emptyReceives15m: 41 }, createdDays: 266, senders: ["email-requests"] },
  { name: "emails-dlq", visible: 61, inFlight: 0, visibility: 180, retention: RETENTION_4D, waitTime: 0, sse: true, activity: { oldestAgeSec: 27_900, received15m: 0, emptyReceives15m: 0 }, createdDays: 266 },
  { name: "thumbnails-queue", visible: 3, inFlight: 2, visibility: 90, retention: RETENTION_4D, waitTime: 20, dlq: { name: "thumbnails-dlq", max: 5 }, sse: true, activity: { oldestAgeSec: 4, received15m: 530, emptyReceives15m: 18 }, createdDays: 97, senders: ["prod-uploads"] },
  { name: "thumbnails-dlq", visible: 0, inFlight: 0, visibility: 90, retention: RETENTION_14D, waitTime: 0, sse: true, activity: { oldestAgeSec: 0, received15m: 0, emptyReceives15m: 0 }, createdDays: 97 },
];
const specOf = (name: string) => SPECS.find((s) => s.name === name)!;
const dlqNames = new Set(SPECS.flatMap((s) => (s.dlq ? [s.dlq.name] : [])));
const sourcesOf = (name: string) => SPECS.filter((s) => s.dlq?.name === name).map((s) => arnOf(s.name));

/** 보내기를 허용하는 큐 정책(원문 JSON). 문장마다 서비스 주체와 aws:SourceArn 조건이 있다 */
function senderArn(sender: string): { arn: string; service: string; sid: string } {
  if (sender === "order-timeout-sweep") return { arn: ruleArn(sender), service: "events.amazonaws.com", sid: "AllowOrderTimeoutRule" };
  if (sender === "prod-uploads") return { arn: "arn:aws:s3:::prod-uploads", service: "s3.amazonaws.com", sid: "AllowUploadBucket" };
  if (sender === "partner-orders") return { arn: topicArn(sender, PARTNER), service: "sns.amazonaws.com", sid: "AllowPartnerOrders" };
  return { arn: topicArn(sender), service: "sns.amazonaws.com", sid: `Allow${sender.replace(/(^|[-.])(\w)/g, (_m, _d, c: string) => c.toUpperCase())}` };
}
function policyOf(spec: Spec): { json: string; grants: PolicyGrant[] } | null {
  const statements: Record<string, unknown>[] = (spec.senders ?? []).map((s) => {
    const { arn, service, sid } = senderArn(s);
    return { Sid: sid, Effect: "Allow", Principal: { Service: service }, Action: "sqs:SendMessage", Resource: arnOf(spec.name), Condition: { ArnEquals: { "aws:SourceArn": arn } } };
  });
  if (spec.name === "orders-queue") {
    statements.push({ Sid: "AllowOrderWorker", Effect: "Allow", Principal: { AWS: roleArn("order-worker") }, Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], Resource: arnOf(spec.name) });
  }
  if (statements.length === 0) return null;
  const grants: PolicyGrant[] = statements.map((st) => {
    const principal = st.Principal as { Service?: string; AWS?: string };
    const cond = st.Condition as { ArnEquals?: Record<string, string> } | undefined;
    const sources = cond?.ArnEquals ? [cond.ArnEquals["aws:SourceArn"]] : [];
    return {
      sid: st.Sid as string,
      effect: "Allow" as const,
      principals: [principal.Service ?? principal.AWS ?? "*"],
      actions: Array.isArray(st.Action) ? (st.Action as string[]) : [st.Action as string],
      conditions: sources.map((s) => `aws:SourceArn ArnEquals ${s}`),
      sources,
      public: false,
    };
  });
  return { json: JSON.stringify({ Version: "2012-10-17", Id: `${spec.name}-policy`, Statement: statements }), grants };
}

function findingsOf(spec: Spec): SqsFinding[] {
  const out: SqsFinding[] = [];
  const dlq = spec.dlq ? specOf(spec.dlq.name) : null;
  if (dlqNames.has(spec.name) && spec.visible > 0) out.push(dlqBacklogOnDlq(spec.visible));
  else if (dlq && dlq.visible > 0) out.push(dlqBacklogOnSource(dlq.name, dlq.visible));
  if (!dlqNames.has(spec.name) && spec.visible > 0 && spec.activity.received15m === 0) out.push(stalled(spec.visible));
  if (!spec.fifo && dlq && dlq.retention <= spec.retention) out.push(dlqRetentionShort(dlq.name, dlq.retention, spec.retention));
  if (!spec.sse && !spec.kmsKey) out.push(noEncryption());
  const rank = { fail: 0, warn: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

function queueOf(spec: Spec): SqsQueue {
  const policy = policyOf(spec);
  const isDlq = dlqNames.has(spec.name);
  return {
    url: urlOf(spec.name),
    arn: arnOf(spec.name),
    name: spec.name,
    fifo: !!spec.fifo,
    visible: spec.visible,
    inFlight: spec.inFlight,
    delayed: spec.delayed ?? 0,
    visibilityTimeout: spec.visibility,
    retention: spec.retention,
    delay: 0,
    maxSize: 262_144,
    waitTime: spec.waitTime,
    redrive: spec.dlq ? { dlqArn: arnOf(spec.dlq.name), maxReceiveCount: spec.dlq.max } : null,
    redriveAllow: isDlq ? JSON.stringify({ redrivePermission: "byQueue", sourceQueueArns: sourcesOf(spec.name) }) : null,
    sseManaged: !!spec.sse,
    kmsKey: spec.kmsKey ?? null,
    contentDedup: spec.fifo ? true : null,
    dedupScope: spec.fifo ? "messageGroup" : null,
    throughputLimit: spec.fifo ? "perMessageGroupId" : null,
    policy: policy?.json ?? null,
    createdAt: NOW0 - spec.createdDays * DAY,
    modifiedAt: NOW0 - Math.max(2, spec.createdDays % 40) * DAY,
    sources: sourcesOf(spec.name),
    isDlq,
    activity: spec.activity,
    tags: { Team: spec.name.startsWith("payments") ? "payments" : "commerce", Env: "prod", Service: spec.name.replace(/-(queue|dlq)$|\.fifo$/g, "") },
    findings: findingsOf(spec),
    error: null,
  };
}

const QUEUES: SqsQueue[] = SPECS.map(queueOf);
const queueByUrl = (url: string) => QUEUES.find((q) => q.url === url) ?? QUEUES[0];

/** 목록의 행은 demo.tsx의 RESOURCES 대신 여기서 낸다(값은 어댑터 src-tauri/src/adapters/sqs.rs와 같다) */
const human = (secs: number) => {
  const d = Math.floor(secs / 86_400);
  const h = Math.floor((secs % 86_400) / 3600);
  return d > 0 ? (h > 0 ? `${d}d ${h}h` : `${d}d`) : `${h}h`;
};
export const sqsResources: Record<string, unknown[]> = {
  "sqs/queues": QUEUES.map((q) => ({
    id: q.url,
    name: q.name,
    arn: q.arn,
    values: {
      name: q.name,
      type: q.fifo ? "FIFO" : "Standard",
      messages: String(q.visible),
      in_flight: String(q.inFlight),
      delayed: String(q.delayed),
      dlq: q.redrive ? nameOfArn(q.redrive.dlqArn) : "",
      retention: human(q.retention),
      encryption: q.kmsKey ? "KMS" : q.sseManaged ? "SSE-SQS" : "None",
      url: q.url,
    },
    tags: q.tags,
    fields: [
      { label: "Visibility timeout (s)", value: String(q.visibilityTimeout) },
      { label: "Redrive policy", value: q.redrive ? JSON.stringify({ deadLetterTargetArn: q.redrive.dlqArn, maxReceiveCount: q.redrive.maxReceiveCount }) : "" },
    ],
    raw: JSON.stringify({ name: q.name, url: q.url }, null, 2),
    consoleUrl: null,
  })),
};

function overview(): SqsOverview {
  return { queues: QUEUES, truncated: false, activityAt: NOW0 - 40_000, activityError: null };
}

// ───────────────────────── 흐름 ─────────────────────────
const node = (n: Partial<FlowNode> & Pick<FlowNode, "kind" | "id" | "label">): FlowNode => ({ state: null, allowedByPolicy: null, crossAccount: false, detail: [], jump: null, ...n });
const row = (label: string, value: string) => ({ label, value });
const snsNode = (topic: string, o: { allowed: boolean | null; account?: string; state?: string; filter?: string; raw?: boolean }): FlowNode => {
  const cross = (o.account ?? ACCOUNT) !== ACCOUNT;
  const arn = topicArn(topic, o.account);
  return node({
    kind: "sns", id: arn, label: topic, state: o.state ?? "Confirmed", allowedByPolicy: o.allowed, crossAccount: cross,
    detail: [
      row("토픽", arn),
      ...(o.filter ? [row("필터 정책", o.filter)] : []),
      row("원본 그대로 전달", o.raw ? "예" : "아니요(SNS 봉투에 싸서 전달)"),
      ...(cross ? [row("계정", `${o.account} (다른 계정이라 읽지 않아요)`)] : []),
    ],
    jump: cross ? null : { kind: "resource", service: "sns", type: "topics", id: arn },
  });
};
const lambdaNode = (name: string, state: string, timeout: number, batch: number): FlowNode =>
  node({
    kind: "lambda", id: functionArn(name), label: name, state,
    detail: [row("매핑 UUID", uuid(rng(hash(name)))), row("배치 크기", String(batch)), row("최대 동시성", "10"), row("부분 실패 보고", "ReportBatchItemFailures"), row("함수 제한 시간(초)", String(timeout))],
    jump: { kind: "resource", service: "lambda", type: "functions", id: name },
  });
const ruleNode = (name: string): FlowNode =>
  node({
    kind: "rule", id: ruleArn(name), label: name, state: "ENABLED", allowedByPolicy: true,
    detail: [row("이벤트 버스", "default"), row("이벤트 패턴", '{"source":["magic.orders"],"detail-type":["Order Timeout"]}')],
  });
const queueNode = (arn: string, withMax?: number): FlowNode => {
  const q = QUEUES.find((x) => x.arn === arn)!;
  return node({
    kind: "queue", id: arn, label: q.name,
    detail: [row("메시지", `보이는 ${q.visible}개 · 처리 중 ${q.inFlight}개`), ...(withMax ? [row("maxReceiveCount", String(withMax))] : [])],
    jump: { kind: "queue", url: q.url },
  });
};

interface FlowSpec {
  producers: FlowNode[];
  consumers: FlowNode[];
  /** 흐름 진단(health.rs flow_findings와 같은 문구) */
  findings: SqsFinding[];
}
const orderWorker = node({
  kind: "principal", id: roleArn("order-worker"), label: "order-worker", state: null, allowedByPolicy: null,
  detail: [row("종류", "역할"), row("판정", "허용"), row("근거 정책", "AllowOrderWorker(큐 정책)")],
  jump: { kind: "iam", arn: roleArn("order-worker") },
});
const legacySync = snsNode("legacy-order-sync", { allowed: false });
const FLOWS: Record<string, FlowSpec> = {
  "orders-queue": {
    producers: [
      snsNode("order-events", { allowed: true, filter: '{"eventType":["order.created","order.updated"]}' }),
      snsNode("partner-orders", { allowed: true, account: PARTNER }),
      ruleNode("order-timeout-sweep"),
      legacySync,
    ],
    consumers: [lambdaNode("order-processor", "Enabled", 30, 10)],
    findings: [
      finding(
        "subscriptionDenied", "fail", "큐 정책이 연결된 출처 1곳의 전송을 허용하지 않아요",
        "SNS `legacy-order-sync`. 이 출처가 보낸 메시지는 큐에 들어오지 못하고 버려져요. 큐 정책에 sqs:SendMessage 허용(aws:SourceArn 조건)을 더해야 해요",
      ),
      finding(
        "visibilityVsLambda", "warn", "소비 Lambda의 제한 시간 × 6이 보이지 않는 시간(120초)보다 길어요",
        "`order-processor`(제한 시간 30초). 처리 중에 메시지가 다시 보여서 두 번 처리될 수 있어요. 보이지 않는 시간을 제한 시간의 6배 이상으로 잡는 것을 AWS가 권장해요",
      ),
    ],
  },
  "payments.fifo": { producers: [snsNode("payment-events.fifo", { allowed: true, raw: true })], consumers: [lambdaNode("payment-ledger", "Enabled", 20, 5)], findings: [] },
  "notifications-queue": {
    producers: [snsNode("notification-events", { allowed: true })],
    consumers: [lambdaNode("notification-sender", "Disabled", 15, 10)],
    findings: [finding("noConsumer", "warn", "이 큐를 받아 가는 소비자가 보이지 않아요", "활성 Lambda 연결과 실행 중인 Pipe가 없어요. IAM으로 계산하면 ECS·EC2 같은 다른 소비자도 찾아봐요")],
  },
  "emails-queue": { producers: [snsNode("email-requests", { allowed: true })], consumers: [lambdaNode("email-sender", "Enabled", 30, 10)], findings: [] },
  "thumbnails-queue": {
    producers: [node({ kind: "s3", id: "arn:aws:s3:::prod-uploads", label: "prod-uploads", allowedByPolicy: true, detail: [row("이벤트", "s3:ObjectCreated:*")], jump: { kind: "resource", service: "s3", type: "buckets", id: "prod-uploads" } })],
    consumers: [lambdaNode("thumbnail-generator", "Enabled", 10, 10)],
    findings: [],
  },
};

function flowOf(url: string, withIam: boolean): SqsFlow {
  const q = queueByUrl(url);
  const spec = FLOWS[q.name] ?? { producers: [], consumers: [], findings: [] };
  const policy = policyOf(specOf(q.name));
  const iamConsumers = withIam && q.name === "orders-queue" ? [orderWorker] : [];
  return {
    producers: spec.producers,
    consumers: [...spec.consumers, ...iamConsumers],
    dlq: q.redrive ? queueNode(q.redrive.dlqArn, q.redrive.maxReceiveCount) : null,
    sources: q.sources.map((arn) => queueNode(arn, specOf(nameOfArn(arn)).dlq?.max)),
    policy: policy?.grants ?? [],
    findings: spec.findings,
    gaps: [],
    iam: withIam,
  };
}

function regionFlow(): SqsRegionFlow {
  const nodes: FlowNode[] = [];
  const edges: SqsRegionFlow["edges"] = [];
  const add = (n: FlowNode) => {
    if (!nodes.some((x) => x.id === n.id)) nodes.push({ ...n, allowedByPolicy: null, detail: [], state: n.kind === "lambda" ? n.state : null });
  };
  const edge = (from: string, to: string, kind: FlowEdgeKind) => edges.push({ from, to, kind });
  for (const q of QUEUES) {
    const spec = FLOWS[q.name];
    if (!spec) continue;
    for (const p of spec.producers.filter((n) => n.kind === "sns")) {
      add(p);
      add(queueNode(q.arn));
      edge(p.id, q.arn, "subscription");
    }
    for (const c of spec.consumers) {
      add(queueNode(q.arn));
      add(c);
      edge(q.arn, c.id, "esm");
    }
  }
  for (const q of QUEUES.filter((x) => x.redrive)) {
    add(queueNode(q.arn));
    add(queueNode(q.redrive!.dlqArn));
    edge(q.arn, q.redrive!.dlqArn, "dlq");
  }
  // 결제 큐의 메시지를 원장 큐가 아닌 Pipe로 정산 Step Functions에 넘긴다
  add(node({ kind: "pipe", id: `arn:aws:pipes:${REGION}:${ACCOUNT}:pipe/payments-to-settlement`, label: "payments-to-settlement", state: "RUNNING" }));
  edge(arnOf("payments.fifo"), `arn:aws:pipes:${REGION}:${ACCOUNT}:pipe/payments-to-settlement`, "pipe");
  return { nodes, edges, gaps: [] };
}

// ───────────────────────── 엿보기·메시지 ─────────────────────────
const peekable = (url: string): SqsPeekable => {
  const q = queueByUrl(url);
  if (q.isDlq) return { allowed: true, reason: null };
  const consumed = FLOWS[q.name]?.consumers.some((c) => c.state === "Enabled");
  return consumed
    ? { allowed: false, reason: "소비자가 있는 큐는 엿볼 수 없어요. 받는 순간 소비자에게서 숨겨지고 수신 횟수가 늘어요" }
    : { allowed: true, reason: null };
};

const utf8 = (s: string) => new TextEncoder().encode(s).length;
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, ".000Z");

/** DLQ에서 받은 메시지 n개: SNS 봉투 4개, EventBridge 이벤트 2개, base64 본문 1개, 나머지는 주문 JSON */
function receiveFrom(q: SqsQueue, n: number): SqsMessage[] {
  const r = rng(hash(q.name) ^ 0x51);
  const source = q.sources[0] ?? q.arn;
  const customers = ["u-48210", "u-48217", "u-48224", "u-48231", "u-48245", "u-48252"];
  const skus = ["MM-A4", "MM-STAND", "MM-LED", "MM-CASE", "MM-CABLE"];
  const reasons = ["payment-timeout", "stock-unavailable", "address-invalid"];
  const out: SqsMessage[] = [];
  for (let i = 0; i < n; i++) {
    const orderId = `ORD-20261106-${String(48 + i * 3).padStart(4, "0")}`;
    const sent = NOW0 - (110 - i * 8) * MIN - Math.floor(r() * 40) * 1000;
    const order = { orderId, customerId: customers[i % customers.length], items: [{ sku: skus[i % skus.length], qty: 1 + (i % 3) }], amount: 29_000 + (i % 5) * 38_000, currency: "KRW" };
    let body: string;
    let messageAttributes: SqsMessage["messageAttributes"] = [];
    if (i % 3 === 0 && i < 12) {
      // SNS 봉투(RawMessageDelivery가 꺼진 구독)
      body = JSON.stringify({
        Type: "Notification", MessageId: uuid(r), TopicArn: topicArn("order-events"), Subject: "order.created", Message: JSON.stringify(order),
        Timestamp: iso(sent - 800), SignatureVersion: "1", MessageAttributes: { eventType: { Type: "String", Value: "order.created" } },
      });
    } else if (i === 4 || i === 10) {
      body = JSON.stringify({
        version: "0", id: uuid(r), "detail-type": "Order Timeout", source: "magic.orders", account: ACCOUNT, time: iso(sent - 300), region: REGION,
        resources: [ruleArn("order-timeout-sweep")], detail: { orderId, reason: reasons[i % reasons.length], pendingMinutes: 30 + i },
      });
    } else if (i === 7) {
      body = b64(JSON.stringify({ orderId, type: "order.refund", customerId: order.customerId, amount: order.amount, reason: "customer-request" }));
    } else {
      body = JSON.stringify({ orderId, type: i % 2 ? "order.updated" : "order.created", customerId: order.customerId, items: order.items, amount: order.amount, currency: "KRW", error: i % 4 === 1 ? "inventory-lock-timeout" : undefined });
      messageAttributes = [{ name: "eventType", dataType: "String", value: i % 2 ? "order.updated" : "order.created" }];
    }
    const attributes: Record<string, string> = {
      SenderId: "AIDAJ5CIFMFT7QXZDJB7M",
      SentTimestamp: String(sent),
      ApproximateReceiveCount: String(i % 4 === 0 ? 7 : 6),
      ApproximateFirstReceiveTimestamp: String(sent + 4_000),
      DeadLetterQueueSourceArn: source,
    };
    if (i % 2 === 0) attributes.AWSTraceHeader = `Root=1-${hex(r, 8)}-${hex(r, 24)};Parent=${hex(r, 16)};Sampled=1`;
    out.push({ messageId: uuid(r), body, md5: hex(r, 32), attributes, messageAttributes, size: utf8(body) });
  }
  return out;
}

// ───────────────────────── 변경 ─────────────────────────
const call = (api: string, params: Record<string, string>) => ({ api, params });

function preview(url: string, change: SqsChange): SqsPreview {
  const q = queueByUrl(url);
  const base = { diff: [], expectedVersion: `${q.visible}:${q.inFlight}:${q.modifiedAt}`, confirmName: null as string | null };
  switch (change.kind) {
    case "receive":
      return {
        ...base,
        title: `\`${q.name}\`에서 메시지 최대 ${change.max}개 받아 보기 (보류 ${change.holdSecs}초)`,
        calls: [call("sqs:ReceiveMessage", { QueueUrl: q.url, MaxNumberOfMessages: "10", VisibilityTimeout: String(change.holdSecs), WaitTimeSeconds: "1", MessageSystemAttributeNames: "All", MessageAttributeNames: "All" })],
        impact: [
          `최대 ${change.max}개가 찰 때까지 되풀이해서 받아요. 새 메시지가 없는 응답이 두 번 이어지면 멈춰요`,
          "받은 메시지는 보류 시간 동안 소비자에게서 숨겨져요",
          "받은 메시지의 수신 횟수가 1 늘어요",
          ...(q.redrive ? [`이미 maxReceiveCount(${q.redrive.maxReceiveCount})에 닿은 메시지는 이 수신에서 DLQ로 옮겨질 수 있어요`] : []),
        ],
        warnings: q.fifo ? [{ level: "warn", message: "보류 시간 동안 받은 메시지의 그룹이 멈춰요" }] : [],
      };
    case "moveTask": {
      const params: Record<string, string> = { SourceArn: q.arn };
      if (change.destinationArn) params.DestinationArn = change.destinationArn;
      if (change.maxPerSecond) params.MaxNumberOfMessagesPerSecond = String(change.maxPerSecond);
      const to = change.destinationArn ?? q.sources[0];
      const dest = QUEUES.find((x) => x.arn === to);
      return {
        ...base,
        title: `DLQ \`${q.name}\`의 메시지 전체 재처리`,
        calls: [call("sqs:StartMessageMoveTask", params)],
        impact: [
          change.destinationArn ? `보이는 메시지 약 ${q.visible}개를 \`${nameOfArn(change.destinationArn)}\`로 옮겨요` : `메시지마다 원래 원본 큐로 돌아가요: ${q.sources.map((s) => `\`${nameOfArn(s)}\``).join(", ")}`,
          ...(change.maxPerSecond ? [`초당 최대 ${change.maxPerSecond}개씩 옮겨요`] : []),
          "옮긴 메시지는 대상 큐의 소비자가 다시 처리해요",
        ],
        warnings: dest && dest.visible > 0 ? [{ level: "warn", message: `대상 큐 \`${dest.name}\`에 이미 ${dest.visible}개가 쌓여 있어요` }] : [],
      };
    }
    case "cancelMoveTask":
      return { ...base, title: `\`${q.name}\`의 이동 작업 중단`, calls: [call("sqs:CancelMessageMoveTask", { TaskHandle: change.taskHandle })], impact: [`이미 옮긴 ${MOVE_RUNNING.moved}개는 돌아오지 않아요`], warnings: [] };
    case "resend": {
      const dest = change.destinationUrl.slice(change.destinationUrl.lastIndexOf("/") + 1);
      return {
        ...base,
        title: `메시지 ${change.messageIds.length}개를 \`${dest}\`로 다시 보내기`,
        calls: [
          call("sqs:SendMessageBatch", { QueueUrl: change.destinationUrl, Entries: `${change.messageIds.length}개 (10개씩)` }),
          call("sqs:DeleteMessageBatch", { QueueUrl: q.url, Entries: "보내는 데 성공한 메시지만 (10개씩)" }),
        ],
        impact: [`고른 메시지 ${change.messageIds.length}개를 \`${dest}\`로 보내요`, "보내는 데 성공한 메시지만 DLQ에서 지워요"],
        warnings: [],
      };
    }
    case "deleteMessages":
      return {
        ...base,
        title: `\`${q.name}\`에서 메시지 ${change.messageIds.length}개 삭제`,
        calls: [call("sqs:DeleteMessageBatch", { QueueUrl: q.url, Entries: `${change.messageIds.length}개 (10개씩)` })],
        impact: [`고른 메시지 ${change.messageIds.length}개를 큐에서 지워요. 되돌릴 수 없어요`],
        warnings: [],
      };
    case "purge":
      return {
        ...base,
        title: `\`${q.name}\` 비우기`,
        calls: [call("sqs:PurgeQueue", { QueueUrl: q.url })],
        impact: [`보이는 메시지 ${q.visible}개와 처리 중 ${q.inFlight}개가 모두 지워져요 (합계 ${q.visible + q.inFlight}개)`],
        warnings: [{ level: "warn", message: "되돌릴 수 없어요. 60초에 한 번만 할 수 있어요" }],
        confirmName: q.name,
      };
  }
}

/** 적용 응답: 받기는 메시지 세션을, 나머지는 한 줄 안내를 돌려준다 */
function apply(url: string, change: SqsChange): SqsApplyResult {
  const q = queueByUrl(url);
  switch (change.kind) {
    case "receive": {
      const messages = receiveFrom(q, Math.min(change.max, 12));
      const peek: SqsPeek = { peekId: `peek-${hex(rng(hash(q.name)), 8)}`, queueUrl: q.url, expiresAt: Date.now() + change.holdSecs * 1000, messages, stoppedReason: change.max > messages.length ? "empty" : "max" };
      return { message: `메시지 ${messages.length}개를 받았어요. ${change.holdSecs}초 동안 소비자에게서 숨겨져요`, peek, items: [] };
    }
    case "moveTask":
      return { message: "이동 작업을 시작했어요", peek: null, items: [] };
    case "cancelMoveTask":
      return { message: `이동 작업을 중단했어요. 이미 옮긴 ${MOVE_RUNNING.moved}개는 돌아오지 않아요`, peek: null, items: [] };
    case "resend": {
      const items = change.messageIds.map((id) => ({ id, ok: true, error: null }));
      return { message: `메시지 ${items.length}개를 \`${change.destinationUrl.slice(change.destinationUrl.lastIndexOf("/") + 1)}\`로 보내고 DLQ에서 지웠어요`, peek: null, items };
    }
    case "deleteMessages": {
      const items = change.messageIds.map((id) => ({ id, ok: true, error: null }));
      return { message: `메시지 ${items.length}개를 지웠어요`, peek: null, items };
    }
    case "purge":
      return { message: "큐를 비웠어요. 반영까지 최대 60초 걸릴 수 있어요", peek: null, items: [] };
  }
}

const MOVE_RUNNING: SqsMoveTask = {
  taskHandle: "AQEB6nR4Pm1tT0wV3sJ8dZk5cYb2xQ9uFhLr7eGoXiNa0vWqCjDsMyKtEpHg4bZfOlUwR1nTxVaS3mYe8dQc=",
  status: "RUNNING", sourceArn: arnOf("emails-dlq"), destinationArn: arnOf("emails-queue"), maxPerSecond: 50, moved: 214, toMove: 275, failureReason: null, startedAt: NOW0 - 4 * MIN,
};
const MOVE_DONE: SqsMoveTask = {
  taskHandle: null, status: "COMPLETED", sourceArn: arnOf("orders-dlq"), destinationArn: arnOf("orders-queue"), maxPerSecond: null, moved: 38, toMove: 38, failureReason: null, startedAt: NOW0 - 26 * HOUR,
};
function moveTasks(url: string): SqsMoveTask[] {
  const q = queueByUrl(url);
  if (q.name === "emails-dlq") return [MOVE_RUNNING];
  if (q.name === "orders-dlq") return [MOVE_DONE];
  return [];
}

function changes(): SqsChangeRecord[] {
  const rec = (id: string, ago: number, name: string, c: SqsChange, ok: boolean, count: number | null, error: string | null = null): SqsChangeRecord => {
    const p = preview(urlOf(name), c);
    return { id, at: iso(NOW0 - ago), profile: "prod", region: REGION, queueUrl: urlOf(name), queueName: name, kind: c.kind, summary: p.title, calls: p.calls, ok, error, count };
  };
  return [
    rec("c1", 27 * HOUR, "orders-dlq", { kind: "moveTask", destinationArn: null, maxPerSecond: null }, true, 38),
    rec("c2", 5 * HOUR, "thumbnails-dlq", { kind: "purge" }, false, null, "60초에 한 번만 비울 수 있어요. 잠시 뒤에 다시 해 주세요"),
    rec("c3", 95 * MIN, "orders-dlq", { kind: "receive", max: 12, holdSecs: 300 }, true, 12),
    rec("c4", 88 * MIN, "orders-dlq", { kind: "resend", peekId: "p", messageIds: ["a", "b", "c"], destinationUrl: urlOf("orders-queue"), edits: {} }, true, 3),
    rec("c5", 4 * MIN, "emails-dlq", { kind: "moveTask", destinationArn: arnOf("emails-queue"), maxPerSecond: 50 }, true, 275),
  ];
}

// ───────────────────────── 지표 ─────────────────────────
const SPAN: Record<string, number> = { "1h": HOUR, "3h": 3 * HOUR, "12h": 12 * HOUR, "1d": DAY, "3d": 3 * DAY, "1w": 7 * DAY };
function metrics(a: Args): ResourceMetrics {
  const name = a.row.name as string;
  const spec = specOf(name);
  const span = SPAN[a.range as string] ?? 3 * HOUR;
  const points = 36;
  const step = span / points;
  const end = Math.floor(NOW0 / step) * step;
  const times = Array.from({ length: points }, (_, i) => end - (points - 1 - i) * step);
  const r = rng(hash(name));
  const dlq = dlqNames.has(name);
  const series = (f: (i: number) => number) => [{ label: "", times, values: times.map((_, i) => Math.max(0, Math.round(f(i)))) }];
  const wave = (base: number, amp: number) => (i: number) => base + amp * Math.sin(i / 4.2) + (r() - 0.5) * amp * 0.6;
  const rate = spec.activity.received15m === 0 ? 0 : (spec.activity.received15m ?? 0) / 3;
  const stuck = spec.activity.received15m === 0 && !dlq;
  const charts: MetricChart[] = [
    { metric: "ApproximateNumberOfMessagesVisible", stat: "Maximum", unit: "count", series: series(dlq ? (i) => (i < points - 14 ? 0 : spec.visible) : stuck ? (i) => spec.visible * (0.2 + i / points) : wave(spec.visible, spec.visible * 0.3)) },
    { metric: "ApproximateNumberOfMessagesNotVisible", stat: "Maximum", unit: "count", series: series(wave(spec.inFlight, Math.max(1, spec.inFlight * 0.4))) },
    { metric: "ApproximateAgeOfOldestMessage", stat: "Maximum", unit: "seconds", series: series(dlq ? (i) => (i < points - 14 ? 0 : (spec.activity.oldestAgeSec ?? 0) - (points - 1 - i) * 60) : stuck ? (i) => (spec.activity.oldestAgeSec ?? 0) * (i / points) : wave(spec.activity.oldestAgeSec ?? 0, 12)) },
    { metric: "NumberOfMessagesSent", stat: "Sum", unit: "count", series: series(dlq ? (i) => (i === points - 14 ? spec.visible : 0) : wave(rate * 1.02, rate * 0.25)) },
    { metric: "NumberOfMessagesReceived", stat: "Sum", unit: "count", series: series(stuck || dlq ? (i) => (dlq && i >= points - 14 && i < points - 12 ? 36 : 0) : wave(rate, rate * 0.25)) },
    { metric: "NumberOfMessagesDeleted", stat: "Sum", unit: "count", series: series(stuck || dlq ? () => 0 : wave(rate * 0.96, rate * 0.25)) },
    { metric: "NumberOfEmptyReceives", stat: "Sum", unit: "count", series: series(stuck || dlq ? () => 0 : wave((spec.activity.emptyReceives15m ?? 0) / 3, 4)) },
  ];
  return { namespace: "AWS/SQS", region: REGION, charts, period: Math.round(step / 1000), start: times[0], end: end + step, daily: false, note: null };
}

export function sqsMock(cmd: string, a: Args): unknown {
  switch (cmd) {
    case "sqs_overview": return overview();
    case "sqs_queue": return queueByUrl(a.url);
    case "sqs_flow": return flowOf(a.url, !!a.withIam);
    case "sqs_region_flow": return regionFlow();
    case "sqs_peekable": return peekable(a.url);
    case "sqs_preview": return preview(a.url, a.change);
    case "sqs_apply": return apply(a.url, a.change);
    case "sqs_release": case "sqs_save_jsonl": return null;
    case "sqs_move_tasks": return moveTasks(a.url);
    case "sqs_changes": return changes();
    case "resource_metrics": return a.service === "sqs" ? metrics(a) : undefined;
    default: return undefined;
  }
}
