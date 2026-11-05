// 데모용 Valkey·Redis 탭(⚡) 명령 흉내: kv_* 명령.
// 복제 그룹 sessions(단일 엔드포인트, 키 트리·값), cart(샤드 3개 클러스터, Bull 큐), rate-limit(로그인 화면용, 기억한 로그인 없음), 서버리스 feature-flags.
// 목록의 행은 demo.tsx의 RESOURCES(elasticache/*)에 이미 있다. 여기서는 새 행을 더하지 않는다(kvResources는 비어 있다).
import { appUsers, bytes, name, nodeInfo, sampleOverview, sampleTargetInfo, serverlessOverview } from "../../src/kv/fixtures";
import type {
  KvBigKeysMessage, KvBullCounts, KvBullJob, KvBullJobRow, KvBullQueue, KvBullQueueView, KvBullState, KvClient, KvKeyRow, KvKeyView, KvNode, KvNodeInfo, KvOverview, KvSlowEntry,
  KvTargetInfo, KvType, KvUser, KvValue,
} from "../../src/kv/types";

type Args = Record<string, any>;

const ACCOUNT = "123456789012";
const REGION = "ap-northeast-2";
const MIN = 60_000;
const HOUR = 3_600_000;
const MI = 1024 * 1024;
const NOW0 = Date.now();
const arnOf = (id: string) => `arn:aws:elasticache:${REGION}:${ACCOUNT}:replicationgroup:${id}`;
const SERVERLESS_ARN = `arn:aws:elasticache:${REGION}:${ACCOUNT}:serverlesscache:feature-flags`;

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
const between = (r: () => number, lo: number, hi: number) => Math.round(lo + r() * (hi - lo));

// ───────────────────────── 대상 ─────────────────────────
const users = (group: string): KvUser[] => appUsers.map((u) => ({ ...u, id: `${group}-${u.id}` }));
const sessionsUsers: KvUser[] = [
  { id: "default", name: "default", auth: "no-password", status: "active", access: "off -@all" },
  { id: "app-reader", name: "app-reader", auth: "password", status: "active", access: "on ~* +@read -@dangerous" },
  { id: "app-writer", name: "app-writer", auth: "password", status: "active", access: "on ~session:* ~cache:* +@read +@write -@dangerous" },
  { id: "app-iam", name: "app-iam", auth: "iam", status: "active", access: "on ~* +@read +info +client|list" },
  { id: "metrics-exporter", name: "metrics-exporter", auth: "password", status: "active", access: "on -@all +info +dbsize +slowlog|get +client|list" },
];
const TARGETS: Record<string, KvTargetInfo> = {
  sessions: sampleTargetInfo({ arn: arnOf("sessions"), identifier: "sessions", users: sessionsUsers }),
  cart: sampleTargetInfo({
    arn: arnOf("cart"), identifier: "cart", endpoint: "clustercfg.cart.x1y2z3.apn2.cache.amazonaws.com", readerEndpoint: null, clusterMode: true, userGroupIds: ["cart-users"],
    users: users("cart").map((u) => ({ ...u, name: u.name === "app-iam" ? "cart-iam" : u.name === "app-reader" ? "cart-app" : u.name })),
  }),
  "rate-limit": sampleTargetInfo({
    arn: arnOf("rate-limit"), identifier: "rate-limit", engine: "redis", engineVersion: "7.1.0", endpoint: "master.rate-limit.x1y2z3.apn2.cache.amazonaws.com",
    readerEndpoint: "replica.rate-limit.x1y2z3.apn2.cache.amazonaws.com", userGroupIds: ["ratelimit-users"],
    users: [
      { id: "default", name: "default", auth: "no-password", status: "active", access: "off -@all" },
      { id: "limiter", name: "limiter", auth: "password", status: "active", access: "on ~ratelimit:* +@read +@write -@dangerous" },
      { id: "limiter-ro", name: "limiter-ro", auth: "password", status: "active", access: "on ~ratelimit:* +@read" },
      { id: "ops-iam", name: "ops-iam", auth: "iam", status: "active", access: "on ~* +@read +info +client|list +slowlog|get" },
    ],
  }),
  "feature-flags": sampleTargetInfo({
    arn: SERVERLESS_ARN, identifier: "feature-flags", kind: "serverlessCache", serverless: true, clusterMode: false, readerEndpoint: null, authTokenEnabled: false, userGroupIds: [], users: null,
    endpoint: "feature-flags-x1y2z3.serverless.apn2.cache.amazonaws.com",
  }),
};
const targetOf = (a: Args) => TARGETS[(a.target as { id: string }).id] ?? TARGETS.sessions;

/** get_settings에 더할 값: sessions·cart·feature-flags는 로그인을 기억해 바로 연결하고, rate-limit은 로그인 화면이 뜬다. cart의 Bull prefix는 클러스터답게 {bull} */
export const kvSettings: Record<string, unknown> = {
  kvLogins: {
    [arnOf("sessions")]: { mode: "user", user: "app-reader", database: 0 },
    [arnOf("cart")]: { mode: "iam", user: "cart-iam", database: 0 },
    [SERVERLESS_ARN]: { mode: "none", user: "", database: 0 },
  },
  kvBullPrefixes: { [arnOf("cart")]: "{bull}" },
};

/** 목록의 행은 demo.tsx의 RESOURCES에 이미 있다 */
export const kvResources: Record<string, unknown[]> = {};

// ───────────────────────── 개요 ─────────────────────────
function clusterOverview(): KvOverview {
  const host = (shard: number, n: number) => `cart-000${shard}-00${n}.cart.x1y2z3.apn2.cache.amazonaws.com:6379`;
  const slots = ["0-5460", "5461-10922", "10923-16383"];
  const nodes: KvNode[] = [];
  const info: KvNodeInfo[] = [];
  const r = rng(11);
  for (let s = 1; s <= 3; s++) {
    nodes.push({ id: `cart-000${s}-001`, address: host(s, 1), role: "primary", shard: `000${s}`, slots: slots[s - 1] });
    nodes.push({ id: `cart-000${s}-002`, address: host(s, 2), role: "replica", shard: `000${s}`, slots: null });
    const keys = between(r, 780_000, 910_000);
    info.push(nodeInfo(host(s, 1), {
      version: "8.0.1", usedMemory: between(r, 2.4 * 1024, 3.1 * 1024) * MI / 1, usedMemoryPeak: 3.6 * 1024 * MI, maxMemory: 4 * 1024 * MI, fragmentation: 1.08 + s * 0.03,
      hits: between(r, 40_000_000, 52_000_000), misses: between(r, 2_000_000, 4_500_000), opsPerSec: between(r, 6_200, 9_400), connectedClients: between(r, 140, 230), evictedKeys: s === 3 ? 18_204 : 0,
      expiredKeys: between(r, 9_000_000, 14_000_000), uptimeSeconds: 41 * 86_400 + s * 3600, keyspace: [{ db: 0, keys, expires: Math.round(keys * 0.93) }],
    }));
    info.push(nodeInfo(host(s, 2), {
      version: "8.0.1", role: "slave", usedMemory: between(r, 2.4 * 1024, 3.1 * 1024) * MI, usedMemoryPeak: 3.5 * 1024 * MI, maxMemory: 4 * 1024 * MI, fragmentation: 1.1, hits: between(r, 800_000, 1_400_000),
      misses: between(r, 40_000, 90_000), opsPerSec: between(r, 180, 420), connectedClients: between(r, 12, 30), replicationLagSeconds: s === 2 ? 1 : 0, uptimeSeconds: 41 * 86_400 + s * 3600,
      keyspace: [{ db: 0, keys: between(r, 780_000, 910_000), expires: between(r, 700_000, 840_000) }],
    }));
  }
  const dbsize = info.filter((i) => i.role === "master").reduce((n, i) => n + (i.keyspace[0]?.keys ?? 0), 0);
  return sampleOverview({ mode: "cluster", databases: [0], dbsize, nodes, info, login: { mode: "iam", user: "cart-iam", database: 0 } });
}

function overviewOf(a: Args): KvOverview {
  const id = (a.target as { id: string }).id;
  if (id === "cart") return clusterOverview();
  if (id === "feature-flags") return serverlessOverview({ dbsize: 1_842, info: [nodeInfo("feature-flags-x1y2z3.serverless.apn2.cache.amazonaws.com:6379", { maxMemory: null, usedMemory: 38 * MI, usedMemoryPeak: 41 * MI, opsPerSec: 912, connectedClients: 64, keyspace: [{ db: 0, keys: 1_842, expires: 12 }], expiredKeys: 4_220 })] });
  const login = a.login as { mode: KvOverview["login"]["mode"]; user: string; database: number } | undefined;
  const base = sampleOverview({ databases: [0, 1, 3], dbsize: sessionKeys.length * 1380 });
  return login ? { ...base, database: login.database, login: { mode: login.mode, user: login.user, database: login.database } } : base;
}

// ───────────────────────── 키 ─────────────────────────
interface DemoKey extends KvKeyRow {
  value: KvValue;
  length: number;
  memory: number;
  encoding: string;
}
const iso = (ms: number) => new Date(ms).toISOString();

function hashKey(keyName: string, fields: [string, string][], ttlMs: number | null): DemoKey {
  const entries = fields.map(([f, v]) => ({ field: bytes(f), value: bytes(v) }));
  return { name: name(keyName), type: "hash", ttlMs, value: { type: "hash", entries }, length: entries.length, memory: 160 + fields.reduce((n, [f, v]) => n + f.length + v.length + 24, 0), encoding: "listpack" };
}
function stringKey(keyName: string, text: string, ttlMs: number | null, type: KvType = "string"): DemoKey {
  const value: KvValue = type === "json" ? { type: "json", text, truncated: false } : { type: "string", value: bytes(text), truncated: false };
  return { name: name(keyName), type, ttlMs, value, length: text.length, memory: 56 + text.length, encoding: text.length < 44 ? "embstr" : "raw" };
}

function buildSessionKeys(): DemoKey[] {
  const r = rng(7);
  const keys: DemoKey[] = [];
  const uas = ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X)", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) Chrome/129.0", "Mozilla/5.0 (Linux; Android 14; SM-S921N) Chrome/129.0", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/129.0"];
  const items = ["Magic Mirror 거울 A4", "스탠드 거치대", "LED 조명 키트", "방수 케이스", "충전 케이블 2m"];
  for (let i = 0; i < 300; i++) {
    const uid = 48000 + i * 7;
    const created = NOW0 - between(r, 5, 600) * MIN;
    keys.push(
      hashKey(`session:2026:u-${uid}`, [
        ["userId", String(uid)], ["email", `user${uid}@example.com`], ["ip", `10.${between(r, 0, 3)}.${between(r, 0, 250)}.${between(r, 1, 250)}`], ["userAgent", uas[i % uas.length]],
        ["createdAt", iso(created)], ["lastSeen", iso(created + between(r, 1, 90) * MIN)], ["roles", i % 9 === 0 ? "member,beta" : "member"], ["locale", "ko-KR"],
        ["cart", JSON.stringify({ items: [{ sku: `SKU-${1000 + (i % 40)}`, name: items[i % items.length], qty: 1 + (i % 3) }], total: 19900 * (1 + (i % 3)) })], ["csrf", r().toString(16).slice(2, 18)],
      ], between(r, 4, 24 * 60) * MIN),
    );
  }
  for (let i = 0; i < 120; i++) keys.push(hashKey(`session:2025:u-${30000 + i * 11}`, [["userId", String(30000 + i * 11)], ["lastSeen", iso(NOW0 - between(r, 20, 300) * 86_400_000)]], null));
  for (let i = 0; i < 200; i++) {
    const id = 1000 + i;
    keys.push(stringKey(`cache:product:${id}`, JSON.stringify({ id, name: `상품 ${id}`, price: between(r, 5, 90) * 1000, stock: between(r, 0, 400), tags: ["new", i % 3 ? "sale" : "best"], updatedAt: iso(NOW0 - between(r, 1, 600) * MIN) }), between(r, 1, 120) * MIN));
  }
  for (let i = 0; i < 30; i++) keys.push(stringKey(`cache:category:${i + 1}`, JSON.stringify({ id: i + 1, children: between(r, 0, 12) }), between(r, 30, 180) * MIN));
  for (let i = 0; i < 80; i++) keys.push(stringKey(`ratelimit:ip:10.0.${between(r, 0, 200)}.${between(r, 1, 250)}:${i}`, String(between(r, 1, 100)), between(r, 3, 60) * 1000));
  for (let i = 0; i < 60; i++) keys.push(stringKey(`ratelimit:user:u-${48000 + i * 13}`, String(between(r, 1, 30)), between(r, 5, 60) * 1000));
  for (let i = 0; i < 40; i++) keys.push(stringKey(`lock:order:ORD-2026-${118000 + i * 17}`, `worker-${between(r, 1, 6)}`, between(r, 3, 30) * 1000));
  for (let i = 0; i < 50; i++) keys.push(hashKey(`user:profile:${48000 + i * 19}`, [["name", `사용자 ${i}`], ["tier", i % 5 ? "basic" : "plus"], ["joined", iso(NOW0 - between(r, 30, 900) * 86_400_000)]], null));
  const members = Array.from({ length: 40 }, (_, i) => ({ member: bytes(`u-${48000 + i * 7}`), score: 9800 - i * 173 + (i % 3) * 11 }));
  keys.push({ name: name("leaderboard:daily:2026-11-04"), type: "zset", ttlMs: 2 * 86_400_000, value: { type: "zset", start: 0, members }, length: 4_820, memory: 312_000, encoding: "skiplist" });
  keys.push({ name: name("leaderboard:daily:2026-11-03"), type: "zset", ttlMs: 86_400_000, value: { type: "zset", start: 0, members: members.slice(0, 20) }, length: 5_104, memory: 331_000, encoding: "skiplist" });
  keys.push({ name: name("queue:emails"), type: "list", ttlMs: null, value: { type: "list", start: 0, items: Array.from({ length: 30 }, (_, i) => bytes(JSON.stringify({ to: `user${48000 + i}@example.com`, template: "order-paid" }))) }, length: 3_182, memory: 2_400_000, encoding: "quicklist" });
  keys.push({ name: name("stream:events"), type: "stream", ttlMs: null, value: { type: "stream", summary: { length: 18_420, groups: 2, firstId: `${NOW0 - 6 * HOUR}-0`, lastId: `${NOW0}-3` }, entries: Array.from({ length: 12 }, (_, i) => ({ id: `${NOW0 - i * 1000}-0`, fields: [{ field: bytes("event"), value: bytes(i % 3 ? "page.view" : "order.paid") }, { field: bytes("user"), value: bytes(`u-${48000 + i * 7}`) }] })) }, length: 18_420, memory: 4_100_000, encoding: "stream" });
  keys.push(stringKey("feature:flags", JSON.stringify({ checkoutV2: { enabled: true, rollout: 0.35 }, darkMode: { enabled: true, rollout: 1 }, newSearch: { enabled: false, rollout: 0, allow: ["staff"] } }), null, "json"));
  keys.push(stringKey("config:maintenance", "off", null));
  keys.push(stringKey("counter:visits", "8421907", null));
  return keys;
}
const sessionKeys = buildSessionKeys();

function otherKeys(id: string): DemoKey[] {
  const r = rng(id.length);
  if (id === "cart") {
    const queues = ["orders", "emails", "webhooks", "reports", "image-resize", "notifications", "billing-sync", "legacy-sync"];
    return [
      ...Array.from({ length: 150 }, (_, i) => hashKey(`cart:u-${48000 + i * 7}`, [["items", String(between(r, 1, 6))], ["total", String(between(r, 5, 90) * 1000)]], between(r, 10, 600) * MIN)),
      ...queues.flatMap((q) => [hashKey(`{bull}:${q}:meta`, [["version", "bullmq:5.12.0"]], null), stringKey(`{bull}:${q}:id`, String(between(r, 1000, 90_000)), null)]),
    ];
  }
  if (id === "rate-limit") return Array.from({ length: 120 }, (_, i) => stringKey(`ratelimit:ip:10.0.${between(r, 0, 200)}.${between(r, 1, 250)}:${i}`, String(between(r, 1, 100)), between(r, 3, 60) * 1000));
  return Array.from({ length: 24 }, (_, i) => stringKey(`flag:${["checkout", "search", "dark-mode", "reco"][i % 4]}:${i}`, JSON.stringify({ enabled: i % 2 === 0, rollout: (i % 5) / 4 }), null, "json"));
}
const keysOf = (id: string) => (id === "sessions" ? sessionKeys : otherKeys(id));

/** SCAN MATCH의 글로브를 정규식으로 */
function globToRegExp(pattern: string): RegExp {
  const body = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`);
}

function scan(a: Args) {
  const all = keysOf((a.target as { id: string }).id);
  const re = globToRegExp(a.pattern || "*");
  const matched = all.filter((k) => re.test(k.name.text) && (!a.typeFilter || k.type === a.typeFilter));
  const from = a.cursor ? Number(a.cursor) : 0;
  const page = matched.slice(from, from + (a.count || 1000));
  const next = from + page.length;
  return { keys: page.map(({ name: n, type, ttlMs }) => ({ name: n, type, ttlMs })), cursor: next < matched.length ? String(next) : null, scanned: Math.min(all.length, next) };
}

function keyView(a: Args): KvKeyView {
  const id = (a.target as { id: string }).id;
  const found = keysOf(id).find((k) => k.name.text === a.key.text);
  const k = found ?? stringKey(a.key.text, "(데모 값)", null);
  const serverless = id === "feature-flags";
  return { name: k.name, type: k.type, ttlMs: k.ttlMs, length: k.length, memory: serverless ? null : k.memory, encoding: serverless ? null : k.encoding, value: k.value, next: null };
}

// ───────────────────────── Slow log·클라이언트·큰 키 ─────────────────────────
const slowlog = (): KvSlowEntry[] => {
  const t = Math.floor(NOW0 / 1000);
  const rows: [string[], number, string, string][] = [
    [["SMEMBERS", "tags:all"], 18_400, "10.0.4.7:51000", "orders-api"], [["HGETALL", "session:2026:u-48000"], 1_220, "10.0.4.8:51044", ""], [["ZRANGE", "leaderboard:daily:2026-11-04", "0", "-1", "WITHSCORES"], 9_800, "10.0.5.2:40122", "ranking"],
    [["SORT", "queue:emails", "BY", "nosort"], 24_100, "10.0.4.7:51030", "orders-api"], [["LRANGE", "queue:emails", "0", "-1"], 31_500, "10.0.9.9:40000", "debug"],
  ];
  return rows.map(([args, micros, client, n], i) => ({ node: "10.0.1.10:6379", id: 400 - i, time: t - i * 190, micros, args, client, name: n }));
};
const clients = (): KvClient[] =>
  Array.from({ length: 14 }, (_, i) => ({
    node: "10.0.1.10:6379", id: String(9000 + i), addr: i === 3 ? "10.0.9.9:40000" : `10.0.${4 + (i % 3)}.${7 + i}:${51000 + i * 14}`, name: i === 3 ? "magic-mirror" : ["orders-api", "web-session", "ranking", "worker"][i % 4],
    user: i === 3 ? "app-reader" : ["app-writer", "app-reader"][i % 2], db: 0, age: 3600 * (1 + (i % 7)) + i * 61, idle: i % 5, cmd: ["get", "hgetall", "zadd", "expire", "client|list"][i % 5], flags: "N", own: i === 3,
  }));

async function bigkeys(a: Args) {
  const send = (m: KvBigKeysMessage) => (a.onProgress as { onmessage: (m: KvBigKeysMessage) => void }).onmessage(m);
  for (const scanned of [800, 2_400, 4_100]) {
    send({ type: "progress", scanned, total: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const keys = keysOf((a.target as { id: string }).id).filter((k) => k.type !== "string").slice(0, 12).map((k, i) => ({ name: k.name, type: k.type, size: Math.round(k.memory * (40 - i)) }));
  send({ type: "done", basis: "memory", keys: keys.sort((x, y) => y.size - x.size), scanned: 5_000, stopped: false });
  return null;
}

// ───────────────────────── 🐂 Bull ─────────────────────────
const counts = (over: Partial<KvBullCounts>): KvBullCounts => ({ wait: 0, active: 0, delayed: 0, prioritized: 0, waitingChildren: 0, paused: 0, completed: 0, failed: 0, ...over });

/** 지난 60분(오래된 것이 앞)의 분당 수: 바닥 값 주위로 흔들린다. ramp가 있으면 뒤쪽으로 갈수록 늘어난다 */
function series(seed: number, base: number, noise: number, ramp = 0): number[] {
  const r = rng(seed);
  return Array.from({ length: 60 }, (_, i) => Math.max(0, Math.round(base + (r() - 0.5) * 2 * noise + (i >= 45 ? ((i - 44) / 15) * ramp : 0))));
}
const QUEUES: KvBullQueue[] = [
  { name: "orders", counts: counts({ wait: 3, active: 8, prioritized: 12, completed: 1_204_338, failed: 31 }), workers: 6, repeatables: 0, recent: { completed: series(1, 180, 40), failed: series(2, 0.4, 0.5) } },
  { name: "emails", counts: counts({ wait: 12, active: 3, delayed: 4, completed: 184_220, failed: 7 }), workers: 3, repeatables: 2, recent: { completed: series(3, 52, 14), failed: series(4, 0.1, 0.2) } },
  { name: "webhooks", counts: counts({ wait: 842, active: 4, delayed: 120, completed: 90_113, failed: 1_284 }), workers: 2, repeatables: 0, recent: { completed: series(5, 22, 6), failed: series(6, 1, 1, 15) } },
  { name: "reports", counts: counts({ wait: 220, completed: 3_402, failed: 12 }), workers: 0, repeatables: 1, recent: { completed: series(7, 0, 0), failed: series(8, 0, 0) } },
  { name: "image-resize", counts: counts({ paused: 58, completed: 22_901, failed: 3 }), paused: true, workers: 2, repeatables: 0, recent: { completed: series(9, 8, 4), failed: series(10, 0, 0) } },
  { name: "notifications", counts: counts({ wait: 6, active: 2, prioritized: 3, waitingChildren: 14, completed: 410_552, failed: 2 }), workers: 4, repeatables: 0, recent: { completed: series(11, 90, 20), failed: series(12, 0.05, 0.1) } },
  { name: "billing-sync", counts: counts({ delayed: 1_240, completed: 8_120 }), workers: 1, repeatables: 6, recent: { completed: series(13, 1, 1), failed: series(14, 0, 0) } },
  { name: "legacy-sync", counts: counts({ wait: 0, completed: 98_221, failed: 140 }), workers: 1, repeatables: 0, legacy: true, recent: { completed: series(15, 5, 3), failed: series(16, 0.1, 0.3) } },
].map((q: any): KvBullQueue => ({
  prefix: "{bull}", name: q.name, flavor: q.legacy ? "bull" : "bullmq", version: q.legacy ? null : "bullmq:5.12.0", paused: !!q.paused, counts: q.counts, workers: q.workers, repeatables: q.repeatables, metrics: !q.legacy, recent: q.recent,
}));

const WEBHOOK_REASONS = [
  "Request failed with status code 503 (https://hooks.partner-a.example/orders)",
  "timeout of 10000ms exceeded",
  "connect ECONNREFUSED 10.20.4.17:443",
  "Request failed with status code 429",
];
const bucketStart = () => Math.floor(NOW0 / MIN) * MIN - 59 * MIN;

function queueView(queueName: string): KvBullQueueView {
  const queue = QUEUES.find((q) => q.name === queueName) ?? QUEUES[0];
  const r = rng(queueName.length * 31);
  const bad = queueName === "webhooks";
  const daily = queue.metrics
    ? { start: Math.floor(NOW0 / MIN) * MIN - 1439 * MIN, completed: Array.from({ length: 1440 }, (_, i) => Math.max(0, Math.round((queue.recent.completed[30] || 1) * (0.55 + 0.45 * Math.sin((i / 1440) * Math.PI * 2 - 1.2)) + (r() - 0.5) * 8))), failed: Array.from({ length: 1440 }, (_, i) => (bad && i > 1380 ? between(r, 2, 12) : r() < 0.02 ? 1 : 0)) }
    : null;
  return {
    queue,
    bucketStart: bucketStart(),
    daily,
    waitMs: bad ? { p50: 1_900, p95: 14_800, max: 41_000 } : { p50: 120, p95: 1_800, max: 4_200 },
    processMs: bad ? { p50: 2_300, p95: 10_200, max: 10_400 } : { p50: 340, p95: 2_600, max: 9_000 },
    samples: 100,
    waitHistogram: bad
      ? [{ upToMs: 100, count: 6 }, { upToMs: 500, count: 14 }, { upToMs: 1_000, count: 12 }, { upToMs: 5_000, count: 33 }, { upToMs: 10_000, count: 21 }, { upToMs: 60_000, count: 14 }]
      : [{ upToMs: 100, count: 41 }, { upToMs: 500, count: 33 }, { upToMs: 1_000, count: 11 }, { upToMs: 5_000, count: 12 }, { upToMs: 10_000, count: 3 }],
    processHistogram: bad
      ? [{ upToMs: 500, count: 8 }, { upToMs: 1_000, count: 10 }, { upToMs: 5_000, count: 42 }, { upToMs: 10_000, count: 28 }, { upToMs: 60_000, count: 12 }]
      : [{ upToMs: 100, count: 12 }, { upToMs: 500, count: 48 }, { upToMs: 1_000, count: 22 }, { upToMs: 5_000, count: 15 }, { upToMs: 10_000, count: 3 }],
    oldestWaitingAt: queue.counts.wait > 0 ? NOW0 - (queue.workers === 0 ? 47 * MIN : bad ? 6 * MIN : 40_000) : null,
    nextDelayedAt: queue.counts.delayed > 0 ? NOW0 + 3 * MIN : null,
    failedReasons: bad
      ? [48, 31, 12, 9].map((count, i) => ({ reason: WEBHOOK_REASONS[i], count, lastAt: NOW0 - (40 + i * 70) * 1000 }))
      : queue.counts.failed > 0 ? [{ reason: "connect ECONNREFUSED 10.20.8.4:587", count: Math.min(100, queue.counts.failed), lastAt: NOW0 - 2 * HOUR }] : [],
    workers: queue.workers === 0 ? [] : Array.from({ length: queue.workers ?? 0 }, (_, i) => ({ name: `{bull}:${btoa(queueName)}:w:${queueName}-${i + 1}`, addr: `10.20.${4 + i}.${12 + i * 3}:${50_100 + i * 37}`, age: 7_200 + i * 3_600, idle: i % 3 })),
  };
}

const JOB_NAMES: Record<string, string> = { orders: "place-order", emails: "send-welcome", webhooks: "deliver-webhook", reports: "build-report", "image-resize": "resize", notifications: "push-notify", "billing-sync": "sync-invoices", "legacy-sync": "sync" };
function jobRow(queueName: string, state: KvBullState, i: number, top: number): KvBullJobRow {
  const r = rng(i * 7 + queueName.length);
  const id = String(top - i);
  const created = NOW0 - (i * 41 + 12) * 1000 * (state === "wait" ? 0.5 : 3);
  const finished = state === "completed" || state === "failed";
  return {
    id, name: JOB_NAMES[queueName] ?? "job", state, timestamp: created, processedOn: state === "wait" || state === "delayed" || state === "paused" || state === "prioritized" ? null : created + between(r, 40, 4_000),
    finishedOn: finished ? created + between(r, 4_200, 12_000) : null, attemptsMade: state === "failed" ? between(r, 3, 5) : finished ? 1 : 0,
    progress: state === "active" || state === "failed" ? String(between(r, 10, 95)) : finished ? "100" : null, failedReason: state === "failed" ? (queueName === "webhooks" ? WEBHOOK_REASONS[i % WEBHOOK_REASONS.length] : "connect ECONNREFUSED 10.20.8.4:587") : null,
    delayUntil: state === "delayed" ? NOW0 + (i + 1) * 20_000 : null, priority: state === "prioritized" ? 1 + (i % 4) : null,
  };
}
function jobsPage(a: Args) {
  const queue = QUEUES.find((q) => q.name === a.name) ?? QUEUES[0];
  const total = queue.counts[a.state as KvBullState] ?? 0;
  const top = 90_412;
  const n = Math.max(0, Math.min(a.count, total - a.start));
  return { jobs: Array.from({ length: n }, (_, i) => jobRow(queue.name, a.state, a.start + i, top)), total };
}
function job(a: Args): KvBullJob {
  const queue = QUEUES.find((q) => q.name === a.name) ?? QUEUES[0];
  const row = jobRow(queue.name, queue.counts.failed > 0 ? "failed" : "completed", 90_412 - Number(a.id), 90_412);
  const bad = queue.name === "webhooks";
  return {
    ...row, id: String(a.id),
    data: JSON.stringify(bad ? { event: "order.paid", orderId: `ORD-2026-${118_000 + (Number(a.id) % 900)}`, url: "https://hooks.partner-a.example/orders", payload: { amount: 59_800, currency: "KRW", items: [{ sku: "SKU-1007", qty: 2 }] } } : { id: a.id }),
    dataTruncated: false, opts: JSON.stringify({ attempts: 5, backoff: { type: "exponential", delay: 2000 }, removeOnComplete: 1000, removeOnFail: 5000 }), returnvalue: row.state === "completed" ? '{"ok":true}' : null,
    stacktrace: row.state === "failed"
      ? [`Error: ${row.failedReason}\n    at Axios.request (/app/node_modules/axios/lib/core/Axios.js:45:15)\n    at async deliver (/app/dist/jobs/webhooks.js:31:18)\n    at async Worker.processJob (/app/node_modules/bullmq/dist/cjs/classes/worker.js:517:28)`, `Error: timeout of 10000ms exceeded\n    at RedirectableRequest.handleRequestTimeout (/app/node_modules/axios/lib/adapters/http.js:581:16)`]
      : [],
    logs: ["POST https://hooks.partner-a.example/orders", "응답 대기 10s…", "시간 초과, 2초 뒤 다시 시도(2/5)"], parent: queue.name === "notifications" ? { queueKey: "{bull}:orders", id: "55120" } : null, children: [],
  };
}

export const KV_DEMO_NOW = NOW0;

/** kv_* 명령에 답한다. 모르는 명령이면 undefined */
export function kvMock(cmd: string, a: Args): unknown {
  switch (cmd) {
    case "kv_target": return targetOf(a);
    case "kv_open": case "kv_overview": return overviewOf(a);
    case "kv_scan": return scan(a);
    case "kv_key": return keyView(a);
    case "kv_slowlog": return slowlog();
    case "kv_clients": return clients();
    case "kv_bigkeys": return bigkeys(a);
    case "kv_bigkeys_stop": case "kv_close": case "kv_forget_password": return null;
    case "kv_bull_queues": return a.prefix === "{bull}" ? { queues: QUEUES, scanned: 41_280, truncated: false, cursor: null } : { queues: [], scanned: 3_120, truncated: false, cursor: null };
    case "kv_bull_queue": return queueView(a.name);
    case "kv_bull_jobs": return jobsPage(a);
    case "kv_bull_job": return job(a);
    default: return undefined;
  }
}
