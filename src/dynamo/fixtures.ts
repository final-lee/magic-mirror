import type { DynamoIndex, DynamoTable, Finding } from "./types";

/** 시험용 기본 테이블: 온디맨드, 파티션 키 `id`(S), 인덱스 없음, PITR·삭제 보호 켬, 진단 없음 */
export function table(name: string, over: Partial<DynamoTable> = {}): DynamoTable {
  return {
    name,
    arn: `arn:aws:dynamodb:ap-northeast-2:111111111111:table/${name}`,
    status: "ACTIVE",
    keys: { pk: { name: "id", type: "S" }, sk: null },
    attributeTypes: { id: "S" },
    indexes: [],
    billing: { mode: "onDemand", read: null, write: null },
    scaling: [],
    class: "STANDARD",
    ttl: { status: "DISABLED", attribute: null },
    pitr: { status: "ENABLED", days: 35 },
    deletionProtection: true,
    stream: null,
    sse: { type: "OWNED", kmsKey: null },
    replicas: [],
    contributorInsights: "DISABLED",
    resourcePolicy: false,
    itemCount: 0,
    sizeBytes: 0,
    createdAt: null,
    findings: [],
    error: null,
    ...over,
  };
}

export const finding = (level: Finding["level"], summary = "요약"): Finding => ({ id: "pitrOff", level, summary, detail: null, index: null });

export const gsi = (name: string, over: Partial<DynamoIndex> = {}): DynamoIndex => ({
  name,
  kind: "gsi",
  pk: { name: "gpk", type: "S" },
  sk: null,
  projection: { type: "ALL", attrs: [] },
  status: "ACTIVE",
  backfilling: false,
  read: null,
  write: null,
  itemCount: 0,
  sizeBytes: 0,
  ...over,
});
