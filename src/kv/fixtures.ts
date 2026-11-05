// 테스트(와 데모)용 샘플. 한 시나리오에서 값을 맞춰 두었다: `sessions` 복제 그룹(Valkey 8.0, 클러스터 모드 꺼짐, 기본 노드 하나와 복제 노드 둘, TLS, 사용자 그룹 app-users).
import type {
  KvBigKey,
  KvBullCounts,
  KvBullFlow,
  KvBullFlowNode,
  KvBullTopology,
  KvBullTransitions,
  KvBullJob,
  KvBullQueue,
  KvBullQueueView,
  KvBytes,
  KvClient,
  KvKeyName,
  KvKeyRow,
  KvKeyView,
  KvNode,
  KvNodeInfo,
  KvOverview,
  KvSlowEntry,
  KvTarget,
  KvTargetInfo,
  KvUser,
} from "./types";

export const ARN = "arn:aws:elasticache:ap-northeast-2:123456789012:replicationgroup:sessions";

export const kvTarget: KvTarget = { profile: "prod", region: "ap-northeast-2", kind: "replicationGroup", id: "sessions" };

export const appUsers: KvUser[] = [
  { id: "default", name: "default", auth: "no-password", status: "active", access: "off -@all" },
  { id: "app-reader", name: "app-reader", auth: "password", status: "active", access: "on ~* +@read -@dangerous" },
  { id: "app-iam", name: "app-iam", auth: "iam", status: "active", access: "on ~* +@all -@dangerous" },
];

export function sampleTargetInfo(over: Partial<KvTargetInfo> = {}): KvTargetInfo {
  return {
    arn: ARN,
    identifier: "sessions",
    kind: "replicationGroup",
    engine: "valkey",
    engineVersion: "8.0.1",
    endpoint: "master.sessions.x1y2z3.apn2.cache.amazonaws.com",
    port: 6379,
    readerEndpoint: "replica.sessions.x1y2z3.apn2.cache.amazonaws.com",
    tls: true,
    clusterMode: false,
    serverless: false,
    authTokenEnabled: false,
    userGroupIds: ["app-users"],
    users: appUsers,
    iamSupported: true,
    ...over,
  };
}

export function nodeInfo(node: string, over: Partial<KvNodeInfo> = {}): KvNodeInfo {
  return {
    node,
    version: "8.0.1",
    role: "master",
    usedMemory: 412 * 1024 * 1024,
    usedMemoryPeak: 520 * 1024 * 1024,
    maxMemory: 1024 * 1024 * 1024,
    fragmentation: 1.12,
    hits: 9_300_000,
    misses: 700_000,
    opsPerSec: 4210,
    connectedClients: 86,
    evictedKeys: 0,
    expiredKeys: 1_820_000,
    uptimeSeconds: 12 * 86_400 + 3 * 3600,
    replicationLagSeconds: null,
    keyspace: [{ db: 0, keys: 1_240_000, expires: 1_198_000 }],
    ...over,
  };
}

export const standaloneNodes: KvNode[] = [
  { id: "sessions-001", address: "10.0.1.10:6379", role: "primary", shard: null, slots: null },
  { id: "sessions-002", address: "10.0.2.11:6379", role: "replica", shard: null, slots: null },
  { id: "sessions-003", address: "10.0.3.12:6379", role: "replica", shard: null, slots: null },
];

export function sampleOverview(over: Partial<KvOverview> = {}): KvOverview {
  return {
    mode: "standalone",
    engine: "valkey",
    version: "8.0.1",
    database: 0,
    databases: [0, 1],
    dbsize: 1_240_000,
    nodes: standaloneNodes,
    info: [
      nodeInfo("10.0.1.10:6379"),
      nodeInfo("10.0.2.11:6379", { role: "slave", opsPerSec: 120, replicationLagSeconds: 0, keyspace: [{ db: 0, keys: 1_240_000, expires: 1_198_000 }] }),
      nodeInfo("10.0.3.12:6379", { role: "slave", opsPerSec: 95, replicationLagSeconds: 1, keyspace: [{ db: 0, keys: 1_239_990, expires: 1_197_990 }] }),
    ],
    unsupported: [],
    login: { mode: "user", user: "app-reader", database: 0 },
    ...over,
  };
}

export function serverlessOverview(over: Partial<KvOverview> = {}): KvOverview {
  return sampleOverview({
    mode: "serverless",
    databases: [0],
    nodes: [{ id: "feature-flags", address: "feature-flags-x1y2z3.serverless.apn2.cache.amazonaws.com:6379", role: "primary", shard: null, slots: null }],
    info: [nodeInfo("feature-flags-x1y2z3.serverless.apn2.cache.amazonaws.com:6379", { maxMemory: null })],
    unsupported: ["slowlog", "clients", "memory", "encoding"],
    login: { mode: "none", user: "", database: 0 },
    ...over,
  });
}

export const name = (text: string): KvKeyName => ({ text, base64: null });
export const bytes = (text: string): KvBytes => {
  const utf8 = new TextEncoder().encode(text);
  return { text, base64: btoa(String.fromCharCode(...utf8)), bytes: utf8.length };
};
/** UTF-8이 아닌 바이트 값 */
export const binary = (...values: number[]): KvBytes => ({ text: null, base64: btoa(String.fromCharCode(...values)), bytes: values.length });

export const sampleKeys: KvKeyRow[] = [
  { name: name("session:2026:u-1001"), type: "hash", ttlMs: 3_600_000 },
  { name: name("session:2026:u-1002"), type: "hash", ttlMs: 1_800_000 },
  { name: name("session:2025:u-0007"), type: "hash", ttlMs: null },
  { name: name("cache:product:42"), type: "string", ttlMs: 90_000 },
  { name: name("cache:product:43"), type: "string", ttlMs: 7_200_000 },
  { name: name("ratelimit:ip:10.0.0.1"), type: "string", ttlMs: 30_000 },
  { name: name("leaderboard"), type: "zset", ttlMs: null },
  { name: name("queue:emails"), type: "list", ttlMs: null },
  { name: name("standalone"), type: "string", ttlMs: null },
];

export function sampleKeyView(over: Partial<KvKeyView> = {}): KvKeyView {
  return {
    name: name("cache:product:42"),
    type: "string",
    ttlMs: 90_000,
    length: 52,
    memory: 112,
    encoding: "embstr",
    value: { type: "string", value: bytes('{"id":42,"name":"Magic Mirror","tags":["a","b"],"price":19900}'), truncated: false },
    next: null,
    ...over,
  };
}

export const slowEntries: KvSlowEntry[] = [
  { node: "10.0.1.10:6379", id: 12, time: 1_793_900_000, micros: 18_400, args: ["SMEMBERS", "tags:all"], client: "10.0.4.7:51000", name: "orders-api" },
  { node: "10.0.1.10:6379", id: 11, time: 1_793_899_900, micros: 952, args: ["HGETALL", "session:2026:u-1001"], client: "10.0.4.8:51044", name: "" },
];

export const clientRows: KvClient[] = [
  { node: "10.0.1.10:6379", id: "101", addr: "10.0.4.7:51000", name: "orders-api", user: "app-reader", db: 0, age: 3600, idle: 2, cmd: "get", flags: "N", own: false },
  { node: "10.0.1.10:6379", id: "102", addr: "10.0.9.9:40000", name: "magic-mirror", user: "app-reader", db: 0, age: 12, idle: 0, cmd: "client|list", flags: "N", own: true },
];

export const bigKeys: KvBigKey[] = [
  { name: name("leaderboard"), type: "zset", size: 18_874_368 },
  { name: name("queue:emails"), type: "list", size: 4_194_304 },
];

// 🐂 Bull
const counts = (over: Partial<KvBullCounts> = {}): KvBullCounts => ({ wait: 0, active: 0, delayed: 0, prioritized: 0, waitingChildren: 0, paused: 0, completed: 0, failed: 0, ...over });
const flat = (n: number) => Array.from({ length: 60 }, () => n);

export function sampleBullQueue(over: Partial<KvBullQueue> = {}): KvBullQueue {
  return {
    prefix: "bull",
    name: "emails",
    flavor: "bullmq",
    version: "bullmq:5.12.0",
    paused: false,
    counts: counts({ wait: 12, active: 3, delayed: 4, completed: 18_420, failed: 7 }),
    workers: 3,
    repeatables: 2,
    metrics: true,
    recent: { completed: flat(30), failed: flat(0) },
    ...over,
  };
}

export const BULL_NOW = 1_793_900_000_000;

export function sampleBullQueueView(over: Partial<KvBullQueueView> = {}): KvBullQueueView {
  return {
    queue: sampleBullQueue(),
    bucketStart: BULL_NOW - 59 * 60_000,
    daily: null,
    waitMs: { p50: 120, p95: 1800, max: 4200 },
    processMs: { p50: 340, p95: 2600, max: 9000 },
    samples: 100,
    waitHistogram: [
      { upToMs: 100, count: 41 },
      { upToMs: 1000, count: 44 },
      { upToMs: 10_000, count: 15 },
    ],
    processHistogram: [
      { upToMs: 100, count: 12 },
      { upToMs: 1000, count: 70 },
      { upToMs: 10_000, count: 18 },
    ],
    oldestWaitingAt: BULL_NOW - 42_000,
    nextDelayedAt: BULL_NOW + 90_000,
    failedReasons: [{ reason: "connect ECONNREFUSED 10.0.8.4:587", count: 5, lastAt: BULL_NOW - 120_000 }],
    workers: [{ name: "bull:ZW1haWxz:w:mailer-1", addr: "10.0.4.7:51200", age: 7200, idle: 1 }],
    ...over,
  };
}

export function sampleBullJob(over: Partial<KvBullJob> = {}): KvBullJob {
  return {
    id: "184",
    name: "send-welcome",
    state: "failed",
    timestamp: BULL_NOW - 600_000,
    processedOn: BULL_NOW - 590_000,
    finishedOn: BULL_NOW - 588_000,
    attemptsMade: 3,
    progress: "40",
    failedReason: "connect ECONNREFUSED 10.0.8.4:587",
    delayUntil: null,
    priority: null,
    data: '{"to":"a@example.com","template":"welcome"}',
    dataTruncated: false,
    opts: '{"attempts":3,"backoff":{"type":"exponential","delay":1000}}',
    returnvalue: null,
    stacktrace: ["Error: connect ECONNREFUSED 10.0.8.4:587\n    at TCPConnectWrap.afterConnect"],
    logs: ["connecting to smtp", "retrying in 2s"],
    parent: null,
    children: [],
    ...over,
  };
}

// 🐂 그래프: 흐름 place-order(orders) → send-receipt(emails)·charge-card(payments, 실패)·ship(shipping, 기다리는 중)
const flowNode = (queue: string, id: string, name: string, over: Partial<KvBullFlowNode> = {}): KvBullFlowNode => ({
  key: `bull:${queue}:${id}`, prefix: "bull", queue, id, name, state: "completed", timestamp: BULL_NOW - 600_000, finishedOn: BULL_NOW - 590_000, failedReason: null, pending: 0, done: 0, failed: 0, ...over,
});
export function sampleBullFlow(over: Partial<KvBullFlow> = {}): KvBullFlow {
  return {
    root: "bull:orders:77",
    focus: "bull:emails:185",
    nodes: [
      flowNode("orders", "77", "place-order", { state: "waitingChildren", pending: 1, done: 1, failed: 1 }),
      flowNode("emails", "185", "send-receipt"),
      flowNode("payments", "301", "charge-card", { state: "failed", failedReason: "card_declined" }),
      flowNode("shipping", "412", "ship", { state: "wait", finishedOn: null }),
    ],
    edges: [
      { parent: "bull:orders:77", child: "bull:emails:185", status: "done" },
      { parent: "bull:orders:77", child: "bull:payments:301", status: "failed" },
      { parent: "bull:orders:77", child: "bull:shipping:412", status: "pending" },
    ],
    truncated: false,
    ...over,
  };
}

export function sampleBullTransitions(over: Partial<KvBullTransitions> = {}): KvBullTransitions {
  return {
    from: BULL_NOW - 3_600_000,
    to: BULL_NOW,
    firstAt: BULL_NOW - 3_600_000,
    events: 5_000,
    truncated: false,
    pairs: [
      { prev: null, event: "added", count: 1000 },
      { prev: null, event: "waiting", count: 940 },
      { prev: null, event: "delayed", count: 60 },
      { prev: "delayed", event: "waiting", count: 55 },
      { prev: "waiting", event: "active", count: 990 },
      { prev: "active", event: "completed", count: 930 },
      { prev: "active", event: "failed", count: 40 },
      { prev: "failed", event: "waiting", count: 0 },
      { prev: "active", event: "delayed", count: 20 },
      { prev: null, event: "stalled", count: 3 },
      { prev: null, event: "retries-exhausted", count: 6 },
      { prev: "active", event: "progress", count: 700 },
    ],
    ...over,
  };
}

export function sampleBullTopology(over: Partial<KvBullTopology> = {}): KvBullTopology {
  const c = (over: Partial<KvBullCounts> = {}): KvBullCounts => ({ wait: 0, active: 0, delayed: 0, prioritized: 0, waitingChildren: 0, paused: 0, completed: 100, failed: 0, ...over });
  const worker = (queue: string, host: string, i: number) => ({ queue, name: `bull:${queue}:w:${i}`, addr: `${host}:${50000 + i}`, host, age: 3600, idle: 1 });
  return {
    queues: [
      { name: "orders", flavor: "bullmq", paused: false, counts: c({ waitingChildren: 4, active: 2 }) },
      { name: "emails", flavor: "bullmq", paused: false, counts: c({ wait: 3 }) },
      { name: "payments", flavor: "bullmq", paused: false, counts: c({ wait: 12, failed: 4 }) },
      { name: "reports", flavor: "bullmq", paused: false, counts: c({ wait: 220 }) },
    ],
    links: [
      { from: "orders", to: "emails", jobs: 40 },
      { from: "orders", to: "payments", jobs: 40 },
    ],
    workers: [worker("orders", "10.0.4.7", 1), worker("orders", "10.0.4.8", 2), worker("emails", "10.0.4.8", 3), worker("payments", "10.0.5.2", 4)],
    sampled: 120,
    ...over,
  };
}
