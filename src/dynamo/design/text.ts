export const SAMPLE = "샘플 더 읽기";
export const DISCLAIMER = "샘플 기준이라 드문 엔티티는 빠질 수 있어요. Scan은 한 번에 한 페이지씩 읽어요.";
export const ENTITIES = "엔티티";
export const PATTERNS = "인덱스와 접근 패턴";
export const DIAGNOSTICS = "진단";
export const SAMPLE_DONE = "마지막 페이지까지 읽었어요";

export const sampleCount = (count: number) => `${count.toLocaleString("ko-KR")}개 아이템`;
export const entityHeading = (name: string, count: number, total: number) => `${name} · ${count.toLocaleString("ko-KR")}개 (${(count / total * 100).toFixed(1)}%)`;
export const EXAMPLES = "예시 키";
export const COL_ATTRIBUTE = "속성";
export const COL_RATE = "등장률";
export const COL_TYPE = "타입";
export const attributeRate = (count: number, total: number) => `${Math.round(count / total * 100)}%`;

export const COL_TARGET = "대상";
export const COL_PATTERN = "접근 패턴";
export const COL_ENTITY = "엔티티";
export const COL_ITEMS = "아이템";
export const COL_NOTE = "비고";
export const PATTERN_TITLE = "눌러서 이 키로 아이템 탭에서 읽어 봐요";
export const SINGLE_GET = "단건 조회";
export const MULTI_QUERY = "여러 건 조회";
export const SPARSE = "희소";
export const OVERLOADED = "여러 엔티티";
export const SK_RANGE = (name: string) => `${name} 범위`;
export const ANY_VALUE = "<값>";
export const patternCount = (count: number, total: number) => `${count}/${total}`;

/** 샘플 전체 중 몇 개인지. 0이 아니면 1% 아래도 1%로 적는다 */
export const ofSample = (total: number, count: number) =>
  `샘플 ${total.toLocaleString("ko-KR")}개 중 ${count.toLocaleString("ko-KR")}개(${Math.max(1, Math.round(count / total * 100))}%)`;

interface Message { summary: string; detail: string | null }

export const TTL_MILLIS = (total: number, count: number): Message => ({
  summary: `${ofSample(total, count)}의 TTL 값이 밀리초 단위로 보여요`,
  detail: "TTL은 초 단위 Unix 시간이어야 지워져요.",
});
export const TTL_MISSING = (total: number, count: number): Message => ({
  summary: `${ofSample(total, count)}에 TTL 속성이 없어요`,
  detail: null,
});
export const TTL_NOT_NUMBER = (total: number, count: number): Message => ({
  summary: `${ofSample(total, count)}의 TTL 값이 숫자가 아니에요`,
  detail: "숫자가 아닌 TTL은 지워지지 않아요.",
});
export const TTL_EXPIRED = (total: number, count: number): Message => ({
  summary: `${ofSample(total, count)}에 만료된 TTL이 남아 있어요`,
  detail: "삭제에는 보통 며칠 걸려요.",
});
export const LARGE_ITEM = (total: number, count: number): Message => ({
  summary: `${ofSample(total, count)}의 추정 크기가 100 KB 이상이에요`,
  detail: "아이템 한도는 400 KB예요.",
});
export const HOT_KEY = (total: number, count: number): Message => ({
  summary: `샘플 ${total.toLocaleString("ko-KR")}개 중 20% 이상을 차지하는 파티션 키 값이 ${count}개 있어요`,
  detail: "Scan 샘플은 분포를 대략 따라요.",
});
export const MIXED_TYPE = (entity: string, attribute: string, types: string[], entityCount: number, count: number): Message => ({
  summary: `${entity}: ${attribute}의 타입이 ${types.join(", ")}로 섞여 있어요 (${entityCount}개 중 ${count}개에 있어요)`,
  detail: null,
});
export const VERSION_ATTR = (entity: string, attribute: string, entityCount: number, count: number): Message => ({
  summary: `${entity}: ${attribute} 속성이 버전 번호로 보여요 (${entityCount}개 중 ${count}개에 있어요)`,
  detail: null,
});
