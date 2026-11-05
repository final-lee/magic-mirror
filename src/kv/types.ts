// Rust(src-tauri/src/kv*)와 같은 모양이다. 모든 JSON은 camelCase.

export type KvKind = "replicationGroup" | "serverlessCache" | "cacheCluster";
export interface KvTarget {
  profile: string;
  region: string;
  kind: KvKind;
  id: string;
}

export interface KvUser {
  id: string;
  name: string;
  auth: "iam" | "password" | "no-password";
  status: string;
  access: string;
}
export interface KvTargetInfo {
  arn: string;
  identifier: string;
  kind: KvKind;
  engine: "valkey" | "redis";
  engineVersion: string;
  endpoint: string;
  port: number;
  readerEndpoint: string | null;
  tls: boolean;
  clusterMode: boolean;
  serverless: boolean;
  authTokenEnabled: boolean;
  userGroupIds: string[];
  /** null = 읽지 못함(권한 없음, 사용자 그룹 없음) */
  users: KvUser[] | null;
  /** Valkey 7.2+ 또는 Redis OSS 7.0+, 그리고 TLS */
  iamSupported: boolean;
}

export type KvAuthMode = "none" | "password" | "user" | "iam";
/** 대상 ARN별로 설정 `kvLogins`에 기억한다(비밀 없음) */
export interface KvLoginSaved {
  mode: KvAuthMode;
  user: string;
  database: number;
}
export interface KvLogin extends KvLoginSaved {
  /** null = 키체인에 있는 것을 쓴다(필요한데 없으면 오류) */
  password: string | null;
  /** true면 password를 키체인에 저장한다. false이고 password를 줬으면 저장해 둔 것을 지운다 */
  rememberPassword: boolean;
}

export interface KvNode {
  id: string;
  address: string;
  role: "primary" | "replica";
  shard: string | null;
  slots: string | null;
}
export interface KvKeyspace {
  db: number;
  keys: number;
  expires: number;
}
export interface KvNodeInfo {
  /** KvNode.address */
  node: string;
  version: string;
  role: string;
  usedMemory: number;
  usedMemoryPeak: number;
  maxMemory: number | null;
  fragmentation: number | null;
  hits: number;
  misses: number;
  opsPerSec: number;
  connectedClients: number;
  evictedKeys: number;
  expiredKeys: number;
  uptimeSeconds: number;
  replicationLagSeconds: number | null;
  keyspace: KvKeyspace[];
}
export type KvFeature = "slowlog" | "clients" | "memory" | "encoding";
export interface KvOverview {
  mode: "cluster" | "standalone" | "serverless";
  engine: string;
  version: string;
  /** 고른 DB 번호와, DB 선택에 보일 번호들(클러스터 모드 꺼짐만. 아니면 [0]) */
  database: number;
  databases: number[];
  /** 기본 노드들의 DBSIZE 합(고른 DB) */
  dbsize: number;
  nodes: KvNode[];
  info: KvNodeInfo[];
  /** 서버리스는 넷 모두 */
  unsupported: KvFeature[];
  login: KvLoginSaved;
}

/** 키 이름은 바이너리일 수 있다. text는 손실 있는 표시용이고, UTF-8이 아니면 base64가 정확한 바이트다. 키를 가리킬 때 이 객체를 그대로 돌려보낸다. */
export interface KvKeyName {
  text: string;
  base64: string | null;
}
export type KvType = "string" | "hash" | "list" | "set" | "zset" | "stream" | "json" | "other";
/** null = 만료 없음 */
export interface KvKeyRow {
  name: KvKeyName;
  type: KvType;
  ttlMs: number | null;
}
export interface KvScanPage {
  keys: KvKeyRow[];
  cursor: string | null;
  scanned: number;
}

/** UTF-8이 아니면 text는 null */
export interface KvBytes {
  text: string | null;
  base64: string;
  bytes: number;
}
export type KvValue =
  | { type: "string"; value: KvBytes; truncated: boolean }
  | { type: "hash"; entries: { field: KvBytes; value: KvBytes }[] }
  | { type: "list"; start: number; items: KvBytes[] }
  | { type: "set"; members: KvBytes[] }
  | { type: "zset"; start: number; members: { member: KvBytes; score: number }[] }
  | {
      type: "stream";
      summary: { length: number; groups: number; firstId: string | null; lastId: string | null } | null;
      entries: { id: string; fields: { field: KvBytes; value: KvBytes }[] }[];
    }
  | { type: "json"; text: string; truncated: boolean }
  | { type: "other"; typeName: string };
export interface KvKeyView {
  name: KvKeyName;
  type: KvType;
  ttlMs: number | null;
  length: number | null;
  memory: number | null;
  encoding: string | null;
  /** 첫 쪽, 또는 page가 가리킨 쪽 */
  value: KvValue;
  /** 컬렉션의 다음 쪽을 가리키는 불투명 커서 */
  next: string | null;
}

export interface KvSlowEntry {
  node: string;
  id: number;
  time: number;
  micros: number;
  args: string[];
  client: string;
  name: string;
}
export interface KvClient {
  node: string;
  id: string;
  addr: string;
  name: string;
  user: string;
  db: number;
  age: number;
  idle: number;
  cmd: string;
  flags: string;
  own: boolean;
}
export interface KvBigKey {
  name: KvKeyName;
  type: KvType;
  size: number;
}
export type KvBigKeysMessage =
  | { type: "progress"; scanned: number; total: number }
  | { type: "done"; basis: "memory" | "length"; keys: KvBigKey[]; scanned: number; stopped: boolean };

// 🐂 Bull 큐(BullMQ와 옛 Bull v3). 큐 상태를 Redis 키로 읽어 보인다(읽기만).
export type KvBullFlavor = "bullmq" | "bull";
export type KvBullState = "wait" | "active" | "delayed" | "prioritized" | "waitingChildren" | "paused" | "completed" | "failed";
export type KvBullCounts = Record<KvBullState, number>;
export interface KvBullQueue {
  prefix: string;
  name: string;
  flavor: KvBullFlavor;
  version: string | null;
  paused: boolean;
  counts: KvBullCounts;
  /** CLIENT LIST를 못 쓰면(서버리스·권한 없음) null */
  workers: number | null;
  /** ZCARD <q>:repeat */
  repeatables: number;
  /** <q>:metrics:completed 가 있다 */
  metrics: boolean;
  /** 최근 60개의 1분 칸(오래된 것이 앞). completed·failed를 끝난 시각으로 ZCOUNT */
  recent: { completed: number[]; failed: number[] };
}
export interface KvBullQueuesPage {
  queues: KvBullQueue[];
  scanned: number;
  truncated: boolean;
  cursor: string | null;
}
export interface KvBullPercentiles {
  p50: number;
  p95: number;
  max: number;
}
export interface KvBullQueueView {
  queue: KvBullQueue;
  /** recent[0]의 시작(ms epoch) */
  bucketStart: number;
  /** 지표 키가 있으면: 분당 수(최대 1440, 오래된 것이 앞) */
  daily: { start: number; completed: number[]; failed: number[] } | null;
  /** 최근 끝난 100개 작업의 대기·처리 시간(ms) */
  waitMs: KvBullPercentiles | null;
  processMs: KvBullPercentiles | null;
  samples: number;
  waitHistogram: { upToMs: number; count: number }[];
  processHistogram: { upToMs: number; count: number }[];
  /** wait 꼬리 작업의 timestamp */
  oldestWaitingAt: number | null;
  /** delayed 첫 점수에서 계산한 다음 지연 작업 시각 */
  nextDelayedAt: number | null;
  /** 최근 실패 100개를 failedReason으로 묶은 것(많은 순) */
  failedReasons: { reason: string; count: number; lastAt: number | null }[];
  workers: { name: string; addr: string; age: number; idle: number }[] | null;
}
export interface KvBullJobRow {
  id: string;
  name: string;
  state: KvBullState;
  timestamp: number | null;
  processedOn: number | null;
  finishedOn: number | null;
  attemptsMade: number;
  progress: string | null;
  failedReason: string | null;
  delayUntil: number | null;
  priority: number | null;
}
export interface KvBullJobsPage {
  jobs: KvBullJobRow[];
  total: number;
}
export interface KvBullJob extends KvBullJobRow {
  /** 원문(보통 JSON). 1MiB까지 */
  data: string;
  dataTruncated: boolean;
  opts: string | null;
  returnvalue: string | null;
  stacktrace: string[];
  /** 최근 100줄 */
  logs: string[];
  parent: { queueKey: string; id: string } | null;
  /** 남은 자식(dependencies)과 끝난 자식(processed, 반환값) */
  children: { key: string; done: boolean; result: string | null }[];
}
