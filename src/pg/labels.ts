import type { PgCoverage, PgObjectKind, PgObjectRef, PgRoleKind } from "./types";

export const ROLE_KIND_LABEL: Record<PgRoleKind, string> = { user: "사용자", group: "그룹" };

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

/** 사람이 읽는 객체 이름: schema.name, 함수는 인자까지. 데이터베이스와 스키마는 이름만이다. */
export function objectName(o: PgObjectRef): string {
  const base = o.kind === "database" || o.kind === "schema" || !o.schema ? o.name : `${o.schema}.${o.name}`;
  return o.signature === null ? base : `${base}(${o.signature})`;
}
