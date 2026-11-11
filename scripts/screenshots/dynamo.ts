// 데모용 DynamoDB 탭(🗄) 명령 흉내: dynamo_* 명령과 resource_metrics(DynamoDB 테이블).
// 테이블 shop-main은 단일 테이블 설계 표본이다: USER·ORDER·LINE·PRODUCT·SESSION 아이템이 한 테이블에 겹쳐 있고 GSI1은 여러 엔티티가 함께 쓴다.
// 목록의 행(dynamodb/tables)은 dynamoResources가 같은 테이블 정의에서 만든다.
import type { MetricChart, MetricRange, ResourceMetrics } from "../../src/api/types";
import { table as baseTable, gsi } from "../../src/dynamo/fixtures";
import type { Item, ItemPage, ReadRequest } from "../../src/dynamo/items/types";
import type { Connections, StreamPoll, StreamRecord } from "../../src/dynamo/stream/types";
import type { DynamoOverview, DynamoTable, Finding, TopKeys } from "../../src/dynamo/types";

type Args = Record<string, any>;

const ACCOUNT = "123456789012";
const REGION = "ap-northeast-2";
const MIN = 60_000;
const DAY = 86_400_000;
const GB = 1024 ** 3;
const NOW0 = Date.now();

const arnOf = (name: string) => `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${name}`;
const streamArn = (name: string) => `${arnOf(name)}/stream/2026-09-14T03:20:11.482`;
const lambdaArn = (name: string) => `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${name}`;

const finding = (id: Finding["id"], level: Finding["level"], summary: string, detail: string | null = null, index: string | null = null): Finding => ({ id, level, summary, detail, index });

// ───────────────────────── 테이블 ─────────────────────────
const SHOP_MAIN: DynamoTable = baseTable("shop-main", {
  arn: arnOf("shop-main"),
  keys: { pk: { name: "PK", type: "S" }, sk: { name: "SK", type: "S" } },
  attributeTypes: { PK: "S", SK: "S", GSI1PK: "S", GSI1SK: "S", GSI2PK: "S", GSI2SK: "S" },
  indexes: [
    gsi("GSI1", { pk: { name: "GSI1PK", type: "S" }, sk: { name: "GSI1SK", type: "S" }, projection: { type: "ALL", attrs: [] }, read: 100, write: 100, itemCount: 4_821_330, sizeBytes: 1.1 * GB }),
    gsi("GSI2", { pk: { name: "GSI2PK", type: "S" }, sk: { name: "GSI2SK", type: "S" }, projection: { type: "KEYS_ONLY", attrs: [] }, read: 10, write: 10, itemCount: 1_903_118, sizeBytes: 0.2 * GB }),
  ],
  billing: { mode: "provisioned", read: 200, write: 100 },
  scaling: [
    { index: null, dimension: "read", min: 50, max: 400, targetUtilization: 70 },
    { index: null, dimension: "write", min: 25, max: 200, targetUtilization: 70 },
    { index: "GSI1", dimension: "read", min: 25, max: 200, targetUtilization: 70 },
    { index: "GSI1", dimension: "write", min: 25, max: 100, targetUtilization: 70 },
  ],
  ttl: { status: "ENABLED", attribute: "expiresAt" },
  pitr: { status: "ENABLED", days: 35 },
  stream: { arn: streamArn("shop-main"), viewType: "NEW_AND_OLD_IMAGES" },
  sse: { type: "KMS", kmsKey: "alias/shop-data" },
  replicas: [{ region: "us-east-1", status: "ACTIVE", class: "STANDARD" }],
  contributorInsights: "ENABLED",
  resourcePolicy: false,
  itemCount: 4_821_330,
  sizeBytes: 1.9 * GB,
  createdAt: NOW0 - 418 * DAY,
  findings: [
    finding("gsiBackpressure", "fail", "인덱스 `GSI1`이 쓰기를 따라가지 못해요(12건 스로틀)", "GSI가 밀리면 원본 테이블의 쓰기도 함께 스로틀돼요. 이 인덱스의 쓰기 용량을 늘려 주세요", "GSI1"),
    finding("throttled", "warn", "인덱스 `GSI1` 최근 1시간 동안 12건이 스로틀됐어요(읽기 0, 쓰기 12)", "요청이 용량을 넘어 거절된 횟수예요. 용량을 늘리거나 특정 키에 몰리는 접근을 나눠 주세요", "GSI1"),
    finding("noAutoScaling", "warn", "프로비저닝 인덱스 `GSI2`에 오토스케일링이 없어요", "트래픽이 늘면 용량이 고정돼 스로틀될 수 있어요. Application Auto Scaling을 연결하거나 온디맨드 모드를 고려해 보세요", "GSI2"),
  ],
});

const SHOP_SESSIONS: DynamoTable = baseTable("shop-sessions", {
  arn: arnOf("shop-sessions"),
  keys: { pk: { name: "sessionId", type: "S" }, sk: null },
  attributeTypes: { sessionId: "S" },
  ttl: { status: "ENABLED", attribute: "expiresAt" },
  pitr: { status: "DISABLED", days: null },
  deletionProtection: false,
  contributorInsights: "DISABLED",
  resourcePolicy: false,
  itemCount: 38_204,
  sizeBytes: 21 * 1024 * 1024,
  createdAt: NOW0 - 305 * DAY,
  findings: [
    finding("pitrOff", "warn", "특정 시점 복구(PITR)가 꺼져 있어요", "실수로 지우거나 덮어쓴 데이터를 시점으로 되돌릴 수 없어요"),
    finding("deletionProtectionOff", "info", "삭제 보호가 꺼져 있어요", "실수로 테이블을 지우는 것을 막아 주는 설정이에요"),
  ],
});

const SHOP_AUDIT_LOG: DynamoTable = baseTable("shop-audit-log", {
  arn: arnOf("shop-audit-log"),
  keys: { pk: { name: "tenantId", type: "S" }, sk: { name: "ts", type: "N" } },
  attributeTypes: { tenantId: "S", ts: "N" },
  class: "STANDARD_INFREQUENT_ACCESS",
  ttl: { status: "DISABLED", attribute: null },
  contributorInsights: "DISABLED",
  resourcePolicy: false,
  itemCount: 212_480_912,
  sizeBytes: 61.4 * GB,
  createdAt: NOW0 - 611 * DAY,
});

const SHOP_RATELIMITS: DynamoTable = baseTable("shop-ratelimits", {
  arn: arnOf("shop-ratelimits"),
  keys: { pk: { name: "bucket", type: "S" }, sk: null },
  attributeTypes: { bucket: "S" },
  billing: { mode: "provisioned", read: 20, write: 20 },
  scaling: [],
  ttl: { status: "ENABLED", attribute: "resetAt" },
  contributorInsights: "DISABLED",
  resourcePolicy: false,
  itemCount: 5_912,
  sizeBytes: 2 * 1024 * 1024,
  createdAt: NOW0 - 202 * DAY,
  findings: [finding("noAutoScaling", "warn", "프로비저닝 테이블에 오토스케일링이 없어요", "트래픽이 늘면 용량이 고정돼 스로틀될 수 있어요. Application Auto Scaling을 연결하거나 온디맨드 모드를 고려해 보세요")],
});

const TABLES: DynamoTable[] = [SHOP_MAIN, SHOP_AUDIT_LOG, SHOP_RATELIMITS, SHOP_SESSIONS];

// ───────────────────────── 목록(리소스 브라우저) ─────────────────────────
const keyLabel = (k: { name: string; type: string } | null) => (k ? `${k.name} (${k.type})` : "");

function listRow(t: DynamoTable) {
  const values: Record<string, string> = {
    name: t.name,
    id: t.name,
    status: t.status,
    pk: keyLabel(t.keys.pk),
    sk: keyLabel(t.keys.sk),
    gsis: String(t.indexes.filter((i) => i.kind === "gsi").length),
    billing: t.billing.mode === "provisioned" ? "PROVISIONED" : "PAY_PER_REQUEST",
    class: t.class,
    stream: t.stream?.viewType ?? "",
    items: String(t.itemCount),
    size: String(Math.round(t.sizeBytes)),
  };
  const fields: { label: string; value: string }[] = [
    { label: "Provisioned", value: t.billing.mode === "provisioned" ? `${t.billing.read} RCU / ${t.billing.write} WCU` : "" },
    { label: "Global indexes", value: t.indexes.map((i) => i.name).join(", ") },
    { label: "Local indexes", value: "" },
    ...(t.stream ? [{ label: "Stream ARN", value: t.stream.arn }] : []),
    { label: "Created", value: new Date(t.createdAt ?? NOW0).toISOString().slice(0, 16).replace("T", " ") },
  ];
  return { id: t.name, name: t.name, arn: t.arn, values, tags: { Team: "commerce", Env: "prod" }, fields, raw: JSON.stringify({ TableName: t.name, ...values }, null, 2), consoleUrl: null };
}

export const dynamoResources: Record<string, unknown[]> = { "dynamodb/tables": TABLES.map(listRow) };

// ───────────────────────── 아이템: 단일 테이블 설계 표본 ─────────────────────────
const S = (value: string) => ({ S: value });
const N = (value: number | string) => ({ N: String(value) });
const dayAgo = (n: number) => new Date(NOW0 - n * DAY).toISOString().slice(0, 10);
const isoAgo = (n: number, hour = 9) => `${dayAgo(n)}T${String(hour).padStart(2, "0")}:14:07Z`;
const secondsFromNow = (hours: number) => Math.round(NOW0 / 1000 + hours * 3600);

const USERS = [
  { id: "u-1001", name: "김하늘", email: "haneul.kim@example.com", plan: "pro", zip: S("06164") },
  { id: "u-1002", name: "이도윤", email: "doyun.lee@example.com", plan: "free", zip: S("04524") },
  { id: "u-1003", name: "박서연", email: "seoyeon.park@example.com", plan: "pro", zip: S("13529") },
  { id: "u-1004", name: "최지후", email: "jihu.choi@example.com", plan: "free", zip: N(48058) },
  { id: "u-1005", name: "정다은", email: "daeun.jung@example.com", plan: "team", zip: S("34134") },
];
const PRODUCTS = [
  { sku: "TS-0042", title: "Magic 티셔츠", price: "24.00", stock: 312, tags: ["apparel", "cotton"] },
  { sku: "MG-0007", title: "거울 머그", price: "12.50", stock: 88, tags: ["kitchen"] },
  { sku: "ST-0310", title: "스티커 팩", price: "4.90", stock: 1500, tags: ["stationery", "bundle"] },
  { sku: "HD-0021", title: "후드 집업", price: "58.00", stock: 41, tags: ["apparel", "winter"] },
  { sku: "NB-0105", title: "노트북 파우치", price: "31.00", stock: 120, tags: ["accessory"] },
  { sku: "CP-0008", title: "캡 모자", price: "19.00", stock: 0, tags: ["apparel"] },
];
// 주문: [사용자, 며칠 전, 상태, 합계, 상품 줄]
const ORDERS: [string, number, string, string, [string, number][]][] = [
  ["u-1001", 1, "PENDING", "48.00", [["TS-0042", 2]]],
  ["u-1001", 3, "SHIPPED", "12.50", [["MG-0007", 1]]],
  ["u-1001", 9, "DELIVERED", "62.90", [["HD-0021", 1], ["ST-0310", 1]]],
  ["u-1001", 18, "DELIVERED", "24.00", [["TS-0042", 1]]],
  ["u-1001", 31, "DELIVERED", "31.00", [["NB-0105", 1]]],
  ["u-1001", 47, "CANCELLED", "19.00", []],
  ["u-1001", 66, "DELIVERED", "9.80", []],
  ["u-1002", 2, "PENDING", "58.00", [["HD-0021", 1]]],
  ["u-1003", 5, "SHIPPED", "36.50", [["TS-0042", 1], ["MG-0007", 1]]],
  ["u-1004", 12, "DELIVERED", "4.90", []],
  ["u-1005", 21, "DELIVERED", "93.00", []],
];

function buildItems(): Item[] {
  const items: Item[] = [];
  USERS.forEach((u, i) => {
    items.push({
      PK: S(`USER#${u.id}`), SK: S("PROFILE"), name: S(u.name), email: S(u.email), plan: S(u.plan), zip: u.zip,
      createdAt: S(isoAgo(400 - i * 37)), revision: N(3 + i), GSI1PK: S(`EMAIL#${u.email}`), GSI1SK: S(`USER#${u.id}`),
      address: { M: { city: S("서울"), line1: S(`테헤란로 ${100 + i * 7}`) } },
    });
  });
  ORDERS.forEach(([user, ago, status, total, lines], i) => {
    const orderId = `o-${77310 - i * 13}`;
    const date = dayAgo(ago);
    items.push({
      PK: S(`USER#${user}`), SK: S(`ORDER#${date}#${orderId}`), orderId: S(orderId), status: S(status), total: N(total), currency: S("USD"),
      placedAt: S(isoAgo(ago, 8 + (i % 9))), revision: N(1 + (status === "DELIVERED" ? 3 : 0)), lines: N(lines.length),
      GSI1PK: S(`STATUS#${status}`), GSI1SK: S(`${date}#${orderId}`), shipTo: { M: { city: S("서울"), zip: S("06164") } },
    });
    lines.forEach(([sku, qty], line) => {
      const price = PRODUCTS.find((p) => p.sku === sku)!.price;
      items.push({ PK: S(`ORDER#${orderId}`), SK: S(`LINE#${String(line + 1).padStart(3, "0")}`), sku: S(sku), qty: N(qty), price: N(price), GSI2PK: S(`PRODUCT#${sku}`), GSI2SK: S(`ORDER#${orderId}`) });
    });
  });
  PRODUCTS.forEach((p) => {
    items.push({ PK: S(`PRODUCT#${p.sku}`), SK: S("META"), title: S(p.title), price: N(p.price), stock: N(p.stock), tags: { SS: p.tags }, active: { BOOL: p.stock > 0 } });
  });
  // 세션: TTL은 초 단위 Unix 시간이어야 한다. 하나는 밀리초로 넣었고, 하나는 이미 지났지만 아직 남아 있다
  [
    ["3f9c1d7e-5b2a-4c8e-9a61-0d2f7b4c8e11", "u-1001", secondsFromNow(7)],
    ["8a4e6b20-1c3d-4f57-b8a9-6e0d5c2f1a34", "u-1003", secondsFromNow(26)],
    ["c71d02ab-9e48-4a6f-8b3c-1f5a7d9e2c60", "u-1002", NOW0 + 6 * 3_600_000],
    ["19b8f3c4-6d27-4e0a-a5f1-b3c9e7d1a852", "u-1004", secondsFromNow(-30)],
  ].forEach(([id, user, expires], i) => {
    items.push({ PK: S(`SESSION#${id}`), SK: S("SESSION"), userId: S(String(user)), createdAt: S(isoAgo(0, 4 + i)), expiresAt: N(String(Math.round(Number(expires)))), device: S(i % 2 ? "ios" : "web") });
  });
  return items;
}
const ITEMS = buildItems();
const PAGE = 24;

const attrString = (value: unknown) => String((value as { S?: string; N?: string } | undefined)?.S ?? (value as { N?: string } | undefined)?.N ?? "");

function consumed(count: number, scanned: number, kind: ReadRequest["kind"]) {
  return kind === "scan" ? Math.max(0.5, Math.ceil(scanned * 0.5) / 2) : Math.max(0.5, Math.round(count * 0.5 * 10) / 10);
}

function read(req: ReadRequest): ItemPage {
  if (req.kind === "query") {
    const pk = attrString(req.pk);
    const prefix = req.sk && req.sk.op === "begins_with" ? attrString(req.sk.values[0]) : "";
    const hits = ITEMS.filter((item) => attrString(item[req.index ? (req.keySchema.pk.name) : "PK"]) === pk && attrString(item.SK).startsWith(prefix));
    const sorted = req.forward ? hits : [...hits].reverse();
    return {
      items: sorted, lastKey: null, nextToken: null, count: sorted.length, scannedCount: sorted.length, consumed: consumed(sorted.length, sorted.length, "query"),
      request: {
        api: "Query",
        params: {
          TableName: "shop-main",
          KeyConditionExpression: prefix ? "#n0 = :v0 AND begins_with(#n1, :v1)" : "#n0 = :v0",
          ExpressionAttributeNames: prefix ? { "#n0": "PK", "#n1": "SK" } : { "#n0": "PK" },
          ExpressionAttributeValues: prefix ? { ":v0": req.pk, ":v1": { S: prefix } } : { ":v0": req.pk },
          ScanIndexForward: req.forward,
          ReturnConsumedCapacity: "TOTAL",
        },
        cli: prefix
          ? `aws dynamodb query --table-name shop-main --key-condition-expression '#n0 = :v0 AND begins_with(#n1, :v1)' --expression-attribute-names '{"#n0":"PK","#n1":"SK"}' --expression-attribute-values '{":v0":{"S":"${pk}"},":v1":{"S":"${prefix}"}}' --return-consumed-capacity TOTAL`
          : `aws dynamodb query --table-name shop-main --key-condition-expression '#n0 = :v0' --expression-attribute-names '{"#n0":"PK"}' --expression-attribute-values '{":v0":{"S":"${pk}"}}' --return-consumed-capacity TOTAL`,
      },
    };
  }
  const second = req.kind === "scan" ? req.startKey !== null : req.nextToken !== null;
  const items = second ? ITEMS.slice(PAGE) : ITEMS.slice(0, PAGE);
  const more = !second;
  return {
    items, lastKey: req.kind === "scan" && more ? { PK: ITEMS[PAGE - 1].PK, SK: ITEMS[PAGE - 1].SK } : null, nextToken: req.kind === "partiql" && more ? "AAAA" : null,
    count: items.length, scannedCount: items.length, consumed: consumed(items.length, items.length, "scan"),
    request: {
      api: req.kind === "partiql" ? "ExecuteStatement" : "Scan",
      params: req.kind === "partiql" ? { Statement: req.statement } : { TableName: "shop-main", ReturnConsumedCapacity: "TOTAL" },
      cli: req.kind === "partiql" ? `aws dynamodb execute-statement --statement '${req.statement}'` : "aws dynamodb scan --table-name shop-main --return-consumed-capacity TOTAL",
    },
  };
}

// ───────────────────────── 연결·스트림 ─────────────────────────
const connections = (name: string): Connections => {
  if (name !== "shop-main") return { stream: null, esms: [], pipes: [], kinesis: [], replicas: [], gaps: [], findings: [] };
  const searchSync = lambdaArn("shop-search-sync");
  return {
    stream: SHOP_MAIN.stream,
    esms: [
      { id: "6f1a-projector", function: lambdaArn("shop-order-projector"), state: "Enabled", batchSize: 100, startingPosition: "LATEST", parallelization: 2, bisect: true, retries: 5, maxAge: 3600, failureDestination: `arn:aws:sqs:${REGION}:${ACCOUNT}:shop-projector-dlq`, filters: ['{"eventName":["INSERT","MODIFY"]}'], iteratorAgeMs: 1_200 },
      { id: "9c3e-search", function: searchSync, state: "Enabled", batchSize: 50, startingPosition: "TRIM_HORIZON", parallelization: 1, bisect: false, retries: -1, maxAge: -1, failureDestination: null, filters: [], iteratorAgeMs: 41_000 },
    ],
    pipes: [{ name: "shop-audit-forward", state: "RUNNING", target: `arn:aws:events:${REGION}:${ACCOUNT}:event-bus/shop-audit` }],
    kinesis: [{ arn: `arn:aws:kinesis:${REGION}:${ACCOUNT}:stream/shop-main-cdc`, state: "ACTIVE", precision: "MICROSECOND" }],
    replicas: [{ region: "us-east-1", status: "ACTIVE", class: "STANDARD", latencyMs: 840 }],
    gaps: [],
    findings: [finding("esmNoOnFailure", "warn", `${searchSync}에 실패 대상이 없고 재시도 횟수가 무제한이에요`, "처리할 수 없는 레코드가 샤드를 최대 24시간 막을 수 있어요")],
  };
};

const key = (item: Item) => ({ PK: item.PK, SK: item.SK });
const orderItem = ITEMS.find((i) => attrString(i.SK).startsWith("ORDER#") && attrString(i.status) === "PENDING")!;
const STREAM_RECORDS: StreamRecord[] = [
  { id: "r1", event: "INSERT", time: Math.round(NOW0 / 1000) - 9, keys: key(orderItem), size: 311, oldImage: null, newImage: orderItem },
  { id: "r2", event: "MODIFY", time: Math.round(NOW0 / 1000) - 6, keys: key(orderItem), size: 318, oldImage: orderItem, newImage: { ...orderItem, status: S("SHIPPED"), revision: N(2), GSI1PK: S("STATUS#SHIPPED") } },
  { id: "r3", event: "MODIFY", time: Math.round(NOW0 / 1000) - 4, keys: { PK: S("PRODUCT#TS-0042"), SK: S("META") }, size: 142, oldImage: { PK: S("PRODUCT#TS-0042"), SK: S("META"), stock: N(313) }, newImage: { PK: S("PRODUCT#TS-0042"), SK: S("META"), stock: N(312) } },
  { id: "r4", event: "REMOVE", time: Math.round(NOW0 / 1000) - 2, keys: { PK: S("SESSION#19b8f3c4-6d27-4e0a-a5f1-b3c9e7d1a852"), SK: S("SESSION") }, size: 187, oldImage: ITEMS.find((i) => attrString(i.PK).startsWith("SESSION#19b8"))!, newImage: null },
];
const polled = new Set<string>();

// ───────────────────────── 지표·상위 키 ─────────────────────────
const RANGE_MS: Record<MetricRange, number> = { "1h": 60 * MIN, "3h": 180 * MIN, "12h": 720 * MIN, "1d": 1440 * MIN, "3d": 4320 * MIN, "1w": 10080 * MIN };

function wave(seed: number, base: number, swing: number, spike?: [number, number]) {
  return (i: number, n: number) => {
    const x = (i / n) * Math.PI * 4 + seed;
    const spiky = spike && i >= n * spike[0] && i < n * (spike[0] + 0.06) ? spike[1] : 0;
    return Math.max(0, Math.round(base + Math.sin(x) * swing + Math.sin(x * 3.1 + seed) * swing * 0.3 + spiky));
  };
}

function metrics(range: MetricRange): ResourceMetrics {
  const span = RANGE_MS[range];
  const period = Math.max(60, Math.round(span / 1000 / 60 / 60) * 60);
  const end = NOW0 - (NOW0 % (period * 1000));
  const n = Math.floor(span / (period * 1000));
  const times = Array.from({ length: n }, (_, i) => end - (n - 1 - i) * period * 1000);
  const chart = (metric: string, stat: string, f: (i: number, n: number) => number): MetricChart => ({ metric, stat, unit: "count", series: [{ label: "", times, values: times.map((_, i) => f(i, n)) }] });
  const scale = period / 60;
  return {
    namespace: "AWS/DynamoDB", region: REGION, period, start: end - span, end, daily: false, note: null,
    charts: [
      chart("ConsumedReadCapacityUnits", "Sum", (i, k) => wave(1, 6200, 2400)(i, k) * scale),
      chart("ConsumedWriteCapacityUnits", "Sum", (i, k) => wave(2, 3400, 1500, [0.7, 2200])(i, k) * scale),
      chart("ProvisionedReadCapacityUnits", "Average", () => 200),
      chart("ProvisionedWriteCapacityUnits", "Average", () => 100),
      chart("ReadThrottleEvents", "Sum", () => 0),
      chart("WriteThrottleEvents", "Sum", (i, k) => (i >= k * 0.7 && i < k * 0.76 ? 4 : 0)),
    ],
  };
}

const TOP_KEYS: TopKeys = {
  windowSecs: 3600,
  groups: [
    { kind: "accessed", withSortKey: false, entries: [{ keys: ["USER#u-1001"], count: 18_420 }, { keys: ["PRODUCT#TS-0042"], count: 12_310 }, { keys: ["PRODUCT#HD-0021"], count: 7_904 }, { keys: ["USER#u-1003"], count: 3_262 }, { keys: ["SESSION#3f9c1d7e-5b2a-4c8e-9a61-0d2f7b4c8e11"], count: 2_118 }] },
    { kind: "throttled", withSortKey: false, entries: [{ keys: ["PRODUCT#TS-0042"], count: 9 }, { keys: ["USER#u-1001"], count: 3 }] },
  ],
};

// ───────────────────────── 명령 ─────────────────────────
export function dynamoMock(cmd: string, a: Args): unknown {
  switch (cmd) {
    case "dynamo_overview": return { tables: TABLES, truncated: false, gaps: [] } satisfies DynamoOverview;
    case "dynamo_table": return TABLES.find((t) => t.name === a.table) ?? TABLES[0];
    case "dynamo_top_keys": return TOP_KEYS;
    case "dynamo_read": return read(a.req as ReadRequest);
    case "dynamo_connections": return connections(a.table);
    case "dynamo_stream_start": return { streamId: "demo-stream" };
    case "dynamo_stream_poll": {
      const first = !polled.has(a.streamId);
      polled.add(a.streamId);
      return { records: first ? STREAM_RECORDS : [], shards: 2, behind: 0 } satisfies StreamPoll;
    }
    case "dynamo_stream_stop": polled.delete(a.streamId); return null;
    case "dynamo_changes": case "dynamo_backups": case "dynamo_exports": return [];
    case "dynamo_buckets": return [];
    case "resource_metrics": return a.service === "dynamodb" ? metrics(a.range) : undefined;
    default: return undefined;
  }
}
