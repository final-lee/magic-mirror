import { PG_VIEW_LABEL, roleRoute, samePgRoute, type PgRoute, type PgView } from "./route";

test("the seven views have the labels of the menu", () => {
  const views: PgView[] = ["findings", "roles", "privileges", "defaults", "whoCan", "sessions", "changes"];
  expect(views.map((v) => PG_VIEW_LABEL[v])).toEqual(["점검", "역할", "권한", "기본 권한", "누가 할 수 있나", "세션", "변경 기록"]);
  expect(Object.keys(PG_VIEW_LABEL).sort()).toEqual([...views].sort());
});

test("the same screen is the same view and id; the sub-tab is only what was being looked at", () => {
  const detail: PgRoute = { view: "roles", id: "alice" };
  expect(samePgRoute(detail, { ...detail })).toBe(true);
  expect(samePgRoute(detail, { ...detail, tab: "members" })).toBe(true);
  expect(samePgRoute({ view: "privileges" }, { view: "privileges" })).toBe(true);
  expect(samePgRoute(detail, { view: "roles", id: "bob" })).toBe(false);
  expect(samePgRoute(detail, { view: "roles" })).toBe(false);
  expect(samePgRoute({ view: "roles" }, { view: "sessions" })).toBe(false);
});

test("a role's detail is the roles view with the role name as id", () => {
  expect(roleRoute("alice")).toEqual({ view: "roles", id: "alice" });
});
