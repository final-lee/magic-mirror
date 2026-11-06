import { billingShort, hasProblem, needsFastRefresh, tableHealth, visibleTables } from "./group";
import { finding, gsi, table } from "./fixtures";
import type { DynamoTable } from "./types";

describe("tableHealth", () => {
  it("가장 심한 진단 수준을 따르고, 정보 수준은 문제가 아니다", () => {
    expect(tableHealth(table("a"))).toBe("ok");
    expect(tableHealth(table("a", { findings: [finding("info")] }))).toBe("ok");
    expect(tableHealth(table("a", { findings: [finding("info"), finding("warn")] }))).toBe("warn");
    expect(tableHealth(table("a", { findings: [finding("warn"), finding("fail"), finding("info")] }))).toBe("fail");
  });

  it("읽지 못한 테이블은 모름이고 문제 있는 쪽에 든다", () => {
    const unreadable = table("a", { error: "권한 없음" });
    expect(tableHealth(unreadable)).toBe("unknown");
    expect(hasProblem(unreadable)).toBe(true);
    expect(hasProblem(table("b", { findings: [finding("info")] }))).toBe(false);
  });
});

describe("needsFastRefresh", () => {
  it("테이블이 활성이 아니거나 인덱스가 바뀌는 중일 때만 10초 갱신이 필요하다", () => {
    expect(needsFastRefresh(table("a"))).toBe(false);
    expect(needsFastRefresh(table("a", { status: "CREATING" }))).toBe(true);
    expect(needsFastRefresh(table("a", { status: "UPDATING" }))).toBe(true);
    expect(needsFastRefresh(table("a", { indexes: [gsi("g")] }))).toBe(false);
    expect(needsFastRefresh(table("a", { indexes: [gsi("g", { status: "CREATING" })] }))).toBe(true);
    expect(needsFastRefresh(table("a", { indexes: [gsi("g", { backfilling: true })] }))).toBe(true);
  });

  it("읽지 못한 테이블은 다시 읽어 봐야 소용없어서 건너뛴다", () => {
    expect(needsFastRefresh(table("a", { status: "", error: "권한 없음" }))).toBe(false);
  });
});

describe("visibleTables", () => {
  const tables = [table("orders-prod"), table("orders-dev", { findings: [finding("warn")] }), table("users", { findings: [finding("fail")] }), table("audit", { findings: [finding("info")] })];
  const names = (rows: DynamoTable[]) => rows.map((r) => r.name);

  it("조건이 없으면 순서 그대로 모두 보인다", () => {
    expect(names(visibleTables(tables, { problemOnly: false, query: "" }))).toEqual(["orders-prod", "orders-dev", "users", "audit"]);
  });

  it("문제 있는 테이블만 거르고, 찾기와 함께 쓰면 둘 다 맞는 것만 남는다", () => {
    expect(names(visibleTables(tables, { problemOnly: true, query: "" }))).toEqual(["orders-dev", "users"]);
    expect(names(visibleTables(tables, { problemOnly: true, query: "orders" }))).toEqual(["orders-dev"]);
    expect(names(visibleTables(tables, { problemOnly: false, query: "orders" }))).toEqual(["orders-prod", "orders-dev"]);
  });

  it("이름의 글자가 순서대로 들어 있으면 맞다(퍼지)", () => {
    expect(names(visibleTables(tables, { problemOnly: false, query: "odp" }))).toEqual(["orders-prod"]);
    expect(visibleTables(tables, { problemOnly: false, query: "zzz" })).toEqual([]);
  });
});

describe("billingShort", () => {
  it("온디맨드와 프로비저닝 용량을 한눈에 보인다", () => {
    expect(billingShort(table("a"))).toBe("온디맨드");
    expect(billingShort(table("a", { billing: { mode: "provisioned", read: 5, write: 10 } }))).toBe("R5 / W10");
  });
});
