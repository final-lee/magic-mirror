export type PgView = "findings" | "roles" | "privileges" | "defaults" | "whoCan" | "sessions";

/**
 * PostgreSQL 탭 안의 위치. 정체성은 view와 id뿐이고, tab과 database는 "그 화면에서 보던 상태"다.
 * 다른 화면으로 갔다가 뒤로 돌아오면 보던 하위 탭과 고른 데이터베이스를 되살리려고 기록에 함께 둔다(같은 화면에서 바꿀 때는 replace).
 */
export interface PgRoute {
  view: PgView;
  /** 역할 상세면 역할 이름. 없으면 그 화면의 첫 모습(목록 등) */
  id?: string;
  tab?: string;
  /** 권한·기본 권한·누가 할 수 있나 화면에서 고른 데이터베이스 */
  database?: string;
}

export const PG_VIEW_LABEL: Record<PgView, string> = {
  findings: "점검",
  roles: "역할",
  privileges: "권한",
  defaults: "기본 권한",
  whoCan: "누가 할 수 있나",
  sessions: "세션",
};

/** 같은 화면인지(하위 탭이나 고른 데이터베이스는 보지 않는다). useRouteHistory에 넘기는 함수라 모듈 밖에 둔다. */
export const samePgRoute = (a: PgRoute, b: PgRoute) => a.view === b.view && a.id === b.id;

export const roleRoute = (name: string): PgRoute => ({ view: "roles", id: name });
