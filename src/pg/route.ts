export type PgView = "findings" | "roles" | "privileges" | "defaults" | "whoCan" | "sessions" | "changes";

/**
 * PostgreSQL 탭 안의 위치. 정체성은 view와 id뿐이고, tab은 "그 화면에서 보던 상태"다.
 * 다른 화면으로 갔다가 뒤로 돌아오면 보던 하위 탭을 되살리려고 기록에 함께 둔다(같은 화면에서 바꿀 때는 replace).
 * 고른 데이터베이스는 화면마다 다른 것이 아니라 탭 하나에 하나라서 기록이 아니라 PgTab이 들고 있다.
 */
export interface PgRoute {
  view: PgView;
  /** 역할 상세면 역할 이름. 없으면 그 화면의 첫 모습(목록 등) */
  id?: string;
  tab?: string;
}

/**
 * 점검 항목이 권한 표를 열 때 가리키는 곳: 데이터베이스와 그 안의 스키마(데이터베이스를 가리키는 항목이면 스키마는 없다).
 * 항목이 역할도 가리키면 그 역할도 함께 와서, 표가 그 역할의 칸을 연다.
 */
export interface SchemaFocus {
  database: string;
  schema: string | null;
  role: string | null;
}

export const PG_VIEW_LABEL: Record<PgView, string> = {
  findings: "점검",
  roles: "역할",
  privileges: "권한",
  defaults: "기본 권한",
  whoCan: "누가 할 수 있나",
  sessions: "세션",
  changes: "변경 기록",
};

/** 같은 화면인지(하위 탭은 보지 않는다). useRouteHistory에 넘기는 함수라 모듈 밖에 둔다. */
export const samePgRoute = (a: PgRoute, b: PgRoute) => a.view === b.view && a.id === b.id;

export const roleRoute = (name: string): PgRoute => ({ view: "roles", id: name });
