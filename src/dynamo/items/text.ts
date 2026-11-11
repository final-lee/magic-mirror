export const SCAN_WARNING = "Scan은 테이블 전체를 1 MB씩 읽어요. 필터는 읽은 뒤에 거르므로 비용을 줄이지 않아요.";
export const PARTIQL_WARNING = "WHERE에 키 조건이 없으면 Scan과 같아요.";
export const READ_FIRST = "첫 페이지 읽기";
export const NEXT_PAGE = "다음 페이지";
export const PAGE_LIMIT = "페이지 개수";
export const PAGE_LIMIT_PLACEHOLDER = "기본(1 MB까지)";
export const NEW_ITEM = "새 아이템";
export const REQUEST = "보낸 요청";
export const EXPORT = "내보내기…";
export const CLOSE = "닫기";
export const COPY = "복사";
export const NO_ITEMS = "읽어 온 아이템이 없어요.";
export const pageSummary = (count: number, scanned: number, consumed: string, total: string) =>
  `Count ${count} · ScannedCount ${scanned} · 소비 ${consumed} RCU · 누적 ${total} RCU`;
