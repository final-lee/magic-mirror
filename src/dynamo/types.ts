// 백엔드(src-tauri/src/dynamo/mod.rs)와 같은 모양(serde camelCase).

/** DynamoDB 탭을 여는 대상: 프로필·리전(탭 하나)과 고를 테이블 */
export interface DynamoTarget {
  profile: string;
  region: string;
  table: string;
}

/** 키 속성 하나. type은 `S`·`N`·`B` */
export interface KeyAttr {
  name: string;
  type: string;
}

export interface Keys {
  pk: KeyAttr;
  sk: KeyAttr | null;
}

export interface Projection {
  /** `ALL` · `KEYS_ONLY` · `INCLUDE` */
  type: string;
  attrs: string[];
}

export type IndexKind = "gsi" | "lsi";

export interface DynamoIndex {
  name: string;
  kind: IndexKind;
  pk: KeyAttr;
  sk: KeyAttr | null;
  projection: Projection;
  /** `ACTIVE` · `CREATING` · `UPDATING` · `DELETING`. LSI는 늘 `ACTIVE` */
  status: string;
  backfilling: boolean;
  /** 프로비저닝 테이블의 GSI만 */
  read: number | null;
  write: number | null;
  itemCount: number;
  sizeBytes: number;
}

export type BillingMode = "onDemand" | "provisioned";

export interface Billing {
  mode: BillingMode;
  read: number | null;
  write: number | null;
}

export type ScalingDimension = "read" | "write";

/** Application Auto Scaling 대상 하나(테이블 또는 GSI의 읽기·쓰기 한쪽) */
export interface ScalingTarget {
  /** GSI 이름. 테이블 자체면 null */
  index: string | null;
  dimension: ScalingDimension;
  min: number;
  max: number;
  /** 목표 추적 정책의 목표 사용률(%) */
  targetUtilization: number | null;
}

export interface Ttl {
  /** `ENABLED` · `DISABLED` · `ENABLING` · `DISABLING` */
  status: string;
  attribute: string | null;
}

export interface Pitr {
  /** `ENABLED` · `DISABLED` */
  status: string;
  days: number | null;
}

export interface StreamSpec {
  arn: string;
  viewType: string;
}

export interface Sse {
  /** `OWNED`(DynamoDB 소유 키) · `KMS` */
  type: string;
  kmsKey: string | null;
}

export interface Replica {
  region: string;
  status: string;
  class: string | null;
}

export type FindingLevel = "fail" | "warn" | "info";

/** 진단 규칙 id. 단계마다 늘어난다 */
export type FindingId = "throttled" | "gsiBackpressure" | "indexNotActive" | "underProvisioned" | "overProvisioned" | "noAutoScaling" | "pitrOff" | "deletionProtectionOff" | "replicaUnhealthy" | "replicationLag" | "streamNoConsumer" | "esmDisabled" | "iteratorAge" | "esmNoOnFailure";

export interface Finding {
  id: FindingId;
  level: FindingLevel;
  summary: string;
  detail: string | null;
  /** 지적이 가리키는 GSI 이름. 테이블 전체면 null */
  index: string | null;
}

/**
 * 테이블 하나. ttl·pitr·scaling·contributorInsights·resourcePolicy가 null이면 그 부분을 읽지 못한 것이다(overview의 gaps).
 * error가 있으면 테이블 설명을 읽지 못한 것이고 나머지 값은 비어 있다.
 */
export interface DynamoTable {
  name: string;
  arn: string;
  /** `ACTIVE` · `CREATING` · `UPDATING` · `DELETING` · … */
  status: string;
  keys: Keys;
  attributeTypes: Record<string, string>;
  indexes: DynamoIndex[];
  billing: Billing;
  scaling: ScalingTarget[] | null;
  /** `STANDARD` · `STANDARD_INFREQUENT_ACCESS` */
  class: string;
  ttl: Ttl | null;
  pitr: Pitr | null;
  deletionProtection: boolean;
  stream: StreamSpec | null;
  sse: Sse;
  replicas: Replica[];
  /** `ENABLED` · `DISABLED` · `ENABLING` · `DISABLING` · `FAILED` */
  contributorInsights: string | null;
  resourcePolicy: boolean | null;
  itemCount: number;
  sizeBytes: number;
  /** Unix ms */
  createdAt: number | null;
  findings: Finding[];
  error: string | null;
}

/** 읽지 못한 부분. section은 `ttl` · `pitr` · `contributorInsights` · `resourcePolicy` · `autoscaling` · `metrics` */
export interface Gap {
  section: string;
  error: string;
}

export interface DynamoOverview {
  tables: DynamoTable[];
  truncated: boolean;
  gaps: Gap[];
}

export type TopKeyKind = "accessed" | "throttled";

export interface TopKeyEntry {
  keys: string[];
  count: number;
}

export interface TopKeyGroup {
  kind: TopKeyKind;
  /** 정렬 키까지 묶은 규칙인가 */
  withSortKey: boolean;
  entries: TopKeyEntry[];
}

export interface TopKeys {
  windowSecs: number;
  groups: TopKeyGroup[];
}
