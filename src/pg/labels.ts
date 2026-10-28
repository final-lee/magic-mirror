import type { PgCoverage, PgObjectKind, PgObjectRef, PgRoleKind } from "./types";

export const ROLE_KIND_LABEL: Record<PgRoleKind, string> = { user: "사용자", group: "그룹" };

/** 값이 없는 칸에 보이는 표시. 이 탭의 모든 표가 같은 것을 쓴다. */
export const DASH = "—";

/** 이름순. 역할 목록의 정렬과 같은 비교다(대소문자를 가리지 않는다). */
export const collate = (a: string, b: string) => a.localeCompare(b, "ko", { sensitivity: "base" });

export const OBJECT_KIND_LABEL: Record<PgObjectKind, string> = {
  database: "데이터베이스",
  schema: "스키마",
  table: "테이블",
  view: "뷰",
  matview: "구체화 뷰",
  partitioned: "파티션 테이블",
  foreign: "외부 테이블",
  sequence: "시퀀스",
  function: "함수",
};

/** 스키마의 테이블 가운데 몇 개에 권한이 있는지 */
export const COVERAGE_LABEL: Record<PgCoverage, string> = { all: "모든 테이블", some: "일부 테이블", none: "없음" };

/** 권한은 있지만 데이터베이스 CONNECT나 스키마 USAGE가 없어 쓸 수 없는 칸의 설명. reason은 "CONNECT 없음" 또는 "USAGE 없음". */
export const unusableText = (reason: string) => `권한은 있지만 실제로는 못 써요 (${reason})`;

/** 보이는 권한의 출처가 그룹, PUBLIC, 미리 정의된 역할뿐인 칸(inheritedOnly)의 설명. 역할 상세와 권한 표가 함께 쓴다. */
export const INHERITED_ONLY_TEXT = "그룹·PUBLIC으로만 받음";

/**
 * 확인 문구 입력 칸의 안내. 문구는 쌍점 뒤에 둔다: 역할 이름 같은 문구에 조사를 직접 붙이면 받침에 따라 틀린 말이 된다.
 * 변경 하나짜리와 묶음의 미리보기 창이 같은 말을 쓴다.
 */
export const confirmLabel = (confirmText: string) => `확인하려면 입력하세요: ${confirmText}`;

/** 객체가 너무 많아 데이터베이스를 일부만 읽었을 때 알리는 말. 그 스냅숏으로 만든 화면이 모두 같은 말을 쓴다. */
export const TRUNCATED_TEXT = "객체가 많아 일부만 읽었어요";

/**
 * 백엔드가 보내는 시각(ISO 8601 UTC, YYYY-MM-DDTHH:MM:SSZ)의 날짜. 점검이 "2026-11-30에 만료돼요"라고 말하는 UTC 날짜와 같다.
 * 로컬 날짜로 바꾸면 한국에서는 UTC 15시부터 다음 날이라 두 화면이 하루 어긋난다.
 */
export const utcDay = (iso: string) => iso.slice(0, 10);

/** 사람이 읽는 객체 이름: schema.name, 함수는 인자까지. 데이터베이스와 스키마는 이름만이다. */
export function objectName(o: PgObjectRef): string {
  const base = o.kind === "database" || o.kind === "schema" || !o.schema ? o.name : `${o.schema}.${o.name}`;
  return o.signature === null ? base : `${base}(${o.signature})`;
}
