import type { Health } from "./group";
import type { FindingLevel } from "./types";

// 사용자에게 보이는 문구(탭·목록·개요). 건강 진단 문구는 백엔드(src-tauri/src/dynamo/health.rs)가 만든다.

export const tabTitle = (region: string) => `🗄 DynamoDB · ${region}`;
export const OPEN_DYNAMO_TAB = "DynamoDB 탭에서 열기";

// 위쪽 줄
export const REREAD = "다시 읽기";
export const READING = "읽는 중…";
export const LOADING = "불러오는 중…";
export const tableCount = (n: number) => `테이블 ${n}개`;
export const problemCount = (n: number) => `문제 있는 테이블 ${n}개`;
export const TRUNCATED = "테이블이 너무 많아 일부만 보여요";
export const GAPS_TITLE = "일부를 읽지 못해 그 부분의 진단을 건너뛰었어요";
export const GAP_SECTION: Record<string, string> = {
  ttl: "TTL",
  pitr: "특정 시점 복구(PITR)",
  contributorInsights: "Contributor Insights",
  resourcePolicy: "리소스 정책",
  autoscaling: "오토스케일링",
  metrics: "CloudWatch 지표",
};
export const gapLine = (section: string, error: string) => `${GAP_SECTION[section] ?? section}: ${error}`;

// 왼쪽 목록
export const LIST_LABEL = "테이블 목록";
export const FIND_PLACEHOLDER = "테이블 이름 찾기";
export const PROBLEM_ONLY = "문제 있는 테이블만";
export const NO_TABLES = "이 리전에 테이블이 없어요";
export const NO_MATCH = "맞는 테이블이 없어요";
export const SIZE_TITLE = "아이템 수와 크기는 근사값이에요. 약 6시간마다 갱신돼요";
export const STREAM_BADGE = "스트림";
export const replicaBadge = (n: number) => `복제본 ${n}`;
export const ON_DEMAND = "온디맨드";
export const provisionedShort = (read: number | null, write: number | null) => `R${read ?? "?"} / W${write ?? "?"}`;
export const PROVISIONED = "프로비저닝";
export const ITEMS = "아이템";
export const itemsAndSize = (items: string, size: string) => `${items}개 · ${size}`;

export const HEALTH: Record<Health, { dot: "red" | "yellow" | "green" | ""; label: string }> = {
  fail: { dot: "red", label: "문제가 있어요" },
  warn: { dot: "yellow", label: "확인이 필요해요" },
  ok: { dot: "green", label: "정상이에요" },
  unknown: { dot: "", label: "테이블을 읽지 못했어요" },
};

// 오른쪽 상세
export const DETAIL_PICK = "왼쪽에서 테이블을 골라 주세요";
export const tableReadFailed = (error: string) => `이 테이블을 읽지 못했어요: ${error}`;
export const TABLE_GONE = "이 테이블이 지금 목록에 없어요. 지워졌을 수 있어요";
export const DETAIL_TABS_LABEL = "테이블 상세";
/** 상세 탭 이름. 단계마다 탭이 생기므로 모두 적어 두고, 화면은 구현된 탭만 그린다(`TableDetail`의 DETAIL_TABS) */
export const DETAIL_TAB_LABELS = {
  overview: "개요",
  items: "아이템",
  design: "설계",
  stream: "스트림",
  ops: "운영",
  log: "기록",
} as const;
export const COPY_ARN = "ARN 복사";
export const COPIED = "복사했어요";

export const STATUS_LABEL: Record<string, string> = {
  ACTIVE: "활성",
  CREATING: "만드는 중",
  UPDATING: "바꾸는 중",
  DELETING: "지우는 중",
  ARCHIVING: "보관하는 중",
  ARCHIVED: "보관됨",
  INACCESSIBLE_ENCRYPTION_CREDENTIALS: "암호화 키에 접근할 수 없음",
};
export const statusLabel = (status: string) => STATUS_LABEL[status] ?? status;

// 개요
export const CARD_KEYS = "키";
export const KEY_PARTITION = "파티션 키";
export const KEY_SORT = "정렬 키";
export const NO_SORT_KEY = "없음";
export const KEY_TYPE: Record<string, string> = { S: "문자열", N: "숫자", B: "바이너리" };
export const keyLabel = (name: string, type: string) => `${name} (${KEY_TYPE[type] ?? type})`;

export const CARD_INDEXES = "인덱스";
export const NO_INDEXES = "인덱스가 없어요";
export const COL_INDEX_NAME = "이름";
export const COL_INDEX_KEYS = "키";
export const COL_INDEX_PROJECTION = "프로젝션";
export const COL_INDEX_STATUS = "상태";
export const COL_INDEX_CAPACITY = "용량";
export const COL_INDEX_SIZE = "크기·건수";
export const INDEX_KIND: Record<"gsi" | "lsi", string> = { gsi: "GSI", lsi: "LSI" };
export const PROJECTION_ALL = "전체";
export const PROJECTION_KEYS_ONLY = "키만";
export const projectionInclude = (attrs: string[]) => `포함: ${attrs.join(", ")}`;
export const BACKFILLING = "백필 중";
export const capacityLabel = (read: number | null, write: number | null) => (read === null || write === null ? "—" : `R${read} / W${write}`);

export const CARD_SETTINGS = "설정";
export const SETTING_BILLING = "용량 모드";
export const SETTING_SCALING = "오토스케일링";
export const SETTING_CLASS = "테이블 클래스";
export const SETTING_TTL = "TTL";
export const SETTING_PITR = "특정 시점 복구(PITR)";
export const SETTING_PROTECTION = "삭제 보호";
export const SETTING_STREAM = "스트림";
export const SETTING_SSE = "암호화";
export const SETTING_POLICY = "리소스 정책";
export const SETTING_REPLICAS = "글로벌 테이블 복제본";
export const SETTING_INSIGHTS = "Contributor Insights";
export const SETTING_SIZE = "아이템 수·크기";
export const SETTING_CREATED = "만든 시각";
export const UNREAD = "읽지 못했어요";
export const ON = "켜짐";
export const OFF = "꺼짐";
export const NONE = "없음";
export const HAS = "있음";
export const NOT_APPLICABLE_ON_DEMAND = "해당 없음(온디맨드)";
export const billingOnDemand = "온디맨드";
export const billingProvisioned = (read: number | null, write: number | null) => `프로비저닝 · 읽기 ${read ?? "?"} / 쓰기 ${write ?? "?"}`;
export const CLASS_LABEL: Record<string, string> = { STANDARD: "표준", STANDARD_INFREQUENT_ACCESS: "표준-IA(드문 접근)" };
export const classLabel = (c: string) => CLASS_LABEL[c] ?? c;
export const scalingLine = (scope: string, direction: string, min: number, max: number, target: number | null) =>
  `${scope} ${direction}: ${min}–${max}${target === null ? "" : `, 목표 ${target}%`}`;
export const SCALING_TABLE_SCOPE = "테이블";
export const scalingIndexScope = (name: string) => `인덱스 ${name}`;
export const DIRECTION: Record<"read" | "write", string> = { read: "읽기", write: "쓰기" };
export const ttlOn = (attribute: string | null) => (attribute ? `켜짐 · 속성 ${attribute}` : ON);
export const pitrOn = (days: number | null) => (days === null ? ON : `켜짐 · 복구 기간 ${days}일`);
export const streamOn = (viewType: string) => `켜짐 · ${viewType}`;
export const SSE_OWNED = "DynamoDB 소유 키";
export const sseKms = (key: string | null) => (key ? `KMS 키 · ${key}` : "KMS 키");
export const replicaLine = (region: string, status: string) => `${region} (${statusLabel(status)})`;
export const TTL_STATUS: Record<string, string> = { ENABLED: ON, DISABLED: OFF, ENABLING: "켜는 중", DISABLING: "끄는 중" };
export const INSIGHTS_STATUS: Record<string, string> = { ENABLED: ON, DISABLED: OFF, ENABLING: "켜는 중", DISABLING: "끄는 중", FAILED: "실패" };

export const CARD_FINDINGS = "건강 진단";
export const FINDINGS_OK = "문제가 없어요";
export const FINDING_LEVEL: Record<FindingLevel, { icon: string; label: string }> = {
  fail: { icon: "✕", label: "실패" },
  warn: { icon: "!", label: "주의" },
  info: { icon: "i", label: "정보" },
};

export const CARD_TOP_KEYS = "상위 키(최근 1시간)";
export const TOP_KEYS_LOADING = "상위 키를 읽는 중이에요…";
export const TOP_KEYS_EMPTY = "최근 1시간에 집계된 키가 없어요";
export const TOP_KEY_GROUP: Record<"accessed" | "throttled", { title: string; unit: string }> = {
  accessed: { title: "가장 많이 접근된 키", unit: "접근" },
  throttled: { title: "가장 많이 스로틀된 키", unit: "스로틀" },
};
export const topKeyGroupTitle = (kind: "accessed" | "throttled", withSortKey: boolean) => `${TOP_KEY_GROUP[kind].title}${withSortKey ? " (파티션+정렬 키)" : " (파티션 키)"}`;
export const TOP_KEY_COL_KEY = "키";
export const TOP_KEY_COL_COUNT = "횟수";
