import { PRIVILEGE_ORDER, batchSummary, changeSummary, grantWhat, privilegeList, targetLabel } from "./changeText";
import { addBobToWriters, createAppAudit, createCarol, dropAppAudit, grantAuditRead, resetAlicePassword, revokeAuditRead, samplePreview } from "./fixtures";
import type { PgChange, PgGrantItem, PgGrantTarget } from "./types";

// 백엔드 pg::change::text::summary와 글자까지 같아야 한다. 아래 예는 그 쪽 시험(QB1)의 예와 같고, 나머지는 전역 제약의 "Summaries"와 "What"이다.

const grant = (grantee: string, add: boolean, items: PgGrantItem[]): PgChange => ({ kind: "grant", database: "orders", grantee, add, items });
const item = (target: PgGrantTarget, ...privileges: string[]): PgGrantItem => ({ target, privileges });

describe("changeSummary: one exact summary per kind", () => {
  test("create role", () => {
    expect(changeSummary(createAppAudit)).toBe("역할 만들기: app_audit");
    expect(changeSummary(createCarol)).toBe("역할 만들기: carol");
  });

  test("membership: 넣기 and 빼기, and the ADMIN OPTION pair when admin is set", () => {
    const m = (add: boolean, admin: boolean): PgChange => ({ kind: "membership", group: "app_read", member: "alice", add, admin });
    expect(changeSummary(m(true, false))).toBe("그룹에 넣기: alice → app_read");
    expect(changeSummary(m(false, false))).toBe("그룹에서 빼기: alice → app_read");
    expect(changeSummary(m(true, true))).toBe("ADMIN OPTION 주기: alice → app_read");
    expect(changeSummary(m(false, true))).toBe("ADMIN OPTION 빼기: alice → app_read");
  });

  test("attributes, password, drop role", () => {
    const attrs: PgChange = {
      kind: "attributes",
      role: "alice",
      set: { login: true, createDb: false, createRole: false, inherit: true, connectionLimit: -1, validUntil: null },
    };
    expect(changeSummary(attrs)).toBe("속성 바꾸기: alice");
    expect(changeSummary(resetAlicePassword)).toBe("비밀번호 재설정: alice");
    expect(changeSummary(dropAppAudit)).toBe("역할 삭제: app_audit");
  });

  test("terminate names the role and the pid", () => {
    expect(changeSummary({ kind: "terminate", pid: 4242, role: "bob", backendStart: null })).toBe("세션 끊기: bob (pid 4242)");
    expect(changeSummary({ kind: "terminate", pid: 4242, role: "bob", backendStart: "2026-10-28T12:00:00Z" })).toBe("세션 끊기: bob (pid 4242)");
  });

  test("grant and revoke of one item name the item and its privileges", () => {
    expect(changeSummary(grantAuditRead)).toBe("권한 주기: app_read · audit 스키마의 모든 테이블 SELECT");
    expect(changeSummary(revokeAuditRead)).toBe("권한 빼기: app_read · audit 스키마의 모든 테이블 SELECT");
    expect(changeSummary(grant("app_read", true, [item({ kind: "allTables", schema: "app" }, "SELECT")]))).toBe("권한 주기: app_read · app 스키마의 모든 테이블 SELECT");
  });

  test("PUBLIC reads as 모든 역할(PUBLIC)", () => {
    expect(changeSummary(grant("PUBLIC", false, [item({ kind: "database", name: "orders" }, "CONNECT")]))).toBe("권한 빼기: 모든 역할(PUBLIC) · 데이터베이스 orders CONNECT");
  });

  test("several items collapse to a count", () => {
    const items = [item({ kind: "relation", schema: "app", name: "orders" }, "SELECT"), item({ kind: "relation", schema: "app", name: "order_items" }, "SELECT"), item({ kind: "schema", name: "app" }, "USAGE")];
    expect(changeSummary(grant("app_read", true, items))).toBe("권한 주기: app_read · 객체 3개");
  });

  test("default privileges name the creator and the grantee", () => {
    const d = (add: boolean, grantee: string): PgChange => ({
      kind: "defaultPrivilege",
      database: "orders",
      creator: "app_owner",
      schema: "app",
      objectType: "tables",
      grantee,
      privileges: ["SELECT"],
      add,
    });
    expect(changeSummary(d(true, "app_read"))).toBe("기본 권한 주기: app_owner → app_read");
    expect(changeSummary(d(false, "app_read"))).toBe("기본 권한 빼기: app_owner → app_read");
    expect(changeSummary(d(false, "PUBLIC"))).toBe("기본 권한 빼기: app_owner → 모든 역할(PUBLIC)");
  });

  test("several items count the objects, for a revoke from everyone too", () => {
    const two = grant("PUBLIC", false, [item({ kind: "relation", schema: "app", name: "a" }, "SELECT"), item({ kind: "relation", schema: "app", name: "b" }, "SELECT")]);
    expect(changeSummary(two)).toBe("권한 빼기: 모든 역할(PUBLIC) · 객체 2개");
  });

  test("privileges are joined with a comma and a space, in the order of the privilege list and once each, whatever order they came in", () => {
    const on = (...privileges: string[]) => changeSummary(grant("app_read", true, [item({ kind: "relation", schema: "app", name: "orders" }, ...privileges)]));
    expect(on("INSERT", "UPDATE", "DELETE")).toBe("권한 주기: app_read · app.orders INSERT, UPDATE, DELETE");
    expect(on("INSERT", "SELECT", "INSERT")).toBe("권한 주기: app_read · app.orders SELECT, INSERT");
  });

  test("a revoke of the same privileges reads the same list", () => {
    expect(changeSummary(grant("app_read", false, [item({ kind: "schema", name: "app" }, "CREATE", "USAGE")]))).toBe("권한 빼기: app_read · 스키마 app USAGE, CREATE");
  });

  test("agrees with the summaries the fixtures carry", () => {
    expect(changeSummary(samplePreview().change)).toBe(samplePreview().summary);
    expect(changeSummary(addBobToWriters)).toBe("그룹에 넣기: bob → app_write");
  });
});

describe("targetLabel", () => {
  test("database, schema and the two bulk targets", () => {
    expect(targetLabel({ kind: "database", name: "orders" })).toBe("데이터베이스 orders");
    expect(targetLabel({ kind: "schema", name: "app" })).toBe("스키마 app");
    expect(targetLabel({ kind: "allTables", schema: "app" })).toBe("app 스키마의 모든 테이블");
    expect(targetLabel({ kind: "allSequences", schema: "app" })).toBe("app 스키마의 모든 시퀀스");
  });

  test("a relation or sequence is schema.name, a function adds the signature the server printed", () => {
    expect(targetLabel({ kind: "relation", schema: "app", name: "orders" })).toBe("app.orders");
    expect(targetLabel({ kind: "sequence", schema: "app", name: "orders_id_seq" })).toBe("app.orders_id_seq");
    expect(targetLabel({ kind: "function", schema: "app", name: "touch_order", signature: "order_id integer" })).toBe("app.touch_order(order_id integer)");
    expect(targetLabel({ kind: "function", schema: "app", name: "now2", signature: "" })).toBe("app.now2()");
  });
});

describe("privilegeList", () => {
  test("is the declaration order of the backend's Privilege, which is the order the server's ACL names come in", () => {
    expect(PRIVILEGE_ORDER).toEqual(["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN", "EXECUTE", "USAGE", "CREATE", "CONNECT", "TEMPORARY"]);
    expect(privilegeList([...PRIVILEGE_ORDER].reverse())).toBe(PRIVILEGE_ORDER.join(", "));
  });

  test("lists each privilege once", () => {
    expect(privilegeList(["SELECT", "SELECT", "INSERT", "SELECT"])).toBe("SELECT, INSERT");
    expect(privilegeList([])).toBe("");
  });

  test("a name the list does not know goes last, in the order it came, instead of breaking the summary", () => {
    expect(privilegeList(["WHATEVER", "USAGE", "ANOTHER", "SELECT"])).toBe("SELECT, USAGE, WHATEVER, ANOTHER");
  });

  test("does not reorder the caller's array", () => {
    const given = ["USAGE", "SELECT"];
    privilegeList(given);
    expect(given).toEqual(["USAGE", "SELECT"]);
  });
});

describe("grantWhat", () => {
  test("one item is its label and privileges, anything else is a count", () => {
    expect(grantWhat([item({ kind: "schema", name: "app" }, "USAGE", "CREATE")])).toBe("스키마 app USAGE, CREATE");
    expect(grantWhat([item({ kind: "schema", name: "app" }, "USAGE"), item({ kind: "schema", name: "audit" }, "USAGE")])).toBe("객체 2개");
  });
});

test("a batch is 변경 N개", () => {
  expect(batchSummary(3)).toBe("변경 3개");
  expect(batchSummary(1)).toBe("변경 1개");
});
