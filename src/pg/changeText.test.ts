import { PRIVILEGE_ORDER, batchSummary, changeSummary, grantWhat, privilegeList, targetLabel } from "./changeText";
import { addBobToWriters, createAppAudit, createCarol, dropAppAudit, grantAuditRead, resetAlicePassword, revokeAuditRead, samplePreview } from "./fixtures";
import { granteeLabel } from "./sentences";
import type { PgChange, PgGrantItem, PgGrantTarget, PgPresetChoice } from "./types";

// 백엔드 pg::change::text::summary와 글자까지 같아야 한다. 맨 아래 "QB1's examples"는 그 쪽 시험(src-tauri/src/pg/change/text/tests.rs)의 입력과 기대 글을
// 하나씩 그대로 옮긴 것이라 어느 쪽이 달라져도 시험이 깨진다. 나머지는 전역 제약의 "Summaries"와 "What"을 이 화면의 보기에 맞춘 예다.

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

test("the order of the privileges is read-only for callers: no one can sort or push into it and reorder every summary", () => {
  // @ts-expect-error 읽기 전용 목록에는 sort가 없다
  void PRIVILEGE_ORDER.sort;
  // @ts-expect-error 읽기 전용 목록에는 push가 없다
  void PRIVILEGE_ORDER.push;
  expect(PRIVILEGE_ORDER[0]).toBe("SELECT");
});

describe("QB1's examples, string for string (src-tauri/src/pg/change/text/tests.rs)", () => {
  const relation = (schema: string, name: string): PgGrantTarget => ({ kind: "relation", schema, name });
  const grantOn = (grantee: string, add: boolean, items: PgGrantItem[]): PgChange => ({ kind: "grant", database: "appdb", grantee, add, items });
  const membership = (add: boolean, admin: boolean): PgChange => ({ kind: "membership", group: "app_read", member: "alice", add, admin });
  const defaultPrivilege = (grantee: string, add: boolean): PgChange => ({
    kind: "defaultPrivilege",
    database: "appdb",
    creator: "app_owner",
    schema: "app",
    objectType: "tables",
    grantee,
    privileges: ["SELECT"],
    add,
  });

  test("creating a role names it, with or without a preset", () => {
    const plain: PgChange = { kind: "createRole", name: "alice", login: true, groups: [], connectionLimit: -1, validUntil: null, preset: null };
    expect(changeSummary(plain)).toBe("역할 만들기: alice");
    const preset: PgPresetChoice = { preset: "readOnly", database: "appdb", schemas: ["app"], creators: [], group: null, createGroup: false };
    const withPreset: PgChange = { kind: "createRole", name: "alice", login: true, groups: ["app_read"], connectionLimit: 5, validUntil: null, preset };
    expect(changeSummary(withPreset)).toBe("역할 만들기: alice");
  });

  test("a membership change reads member arrow group", () => {
    expect(changeSummary(membership(true, false))).toBe("그룹에 넣기: alice → app_read");
    expect(changeSummary(membership(false, false))).toBe("그룹에서 빼기: alice → app_read");
  });

  test("a membership change that is about the admin option says so", () => {
    expect(changeSummary(membership(true, true))).toBe("ADMIN OPTION 주기: alice → app_read");
    expect(changeSummary(membership(false, true))).toBe("ADMIN OPTION 빼기: alice → app_read");
  });

  test("attributes, a password and a drop name the role", () => {
    const set = { login: true, createDb: false, createRole: false, inherit: true, connectionLimit: -1, validUntil: null };
    expect(changeSummary({ kind: "attributes", role: "alice", set })).toBe("속성 바꾸기: alice");
    expect(changeSummary({ kind: "password", role: "alice" })).toBe("비밀번호 재설정: alice");
    expect(changeSummary({ kind: "dropRole", role: "alice" })).toBe("역할 삭제: alice");
  });

  test("a grant of one item names the object and its privileges", () => {
    expect(changeSummary(grantOn("app_read", true, [item({ kind: "allTables", schema: "app" }, "SELECT")]))).toBe("권한 주기: app_read · app 스키마의 모든 테이블 SELECT");
    expect(changeSummary(grantOn("PUBLIC", false, [item({ kind: "database", name: "orders" }, "CONNECT")]))).toBe("권한 빼기: 모든 역할(PUBLIC) · 데이터베이스 orders CONNECT");
  });

  test("the privileges of a grant are joined in the order of the list, once each", () => {
    expect(changeSummary(grantOn("app_read", true, [item(relation("app", "orders"), "INSERT", "SELECT", "INSERT")]))).toBe("권한 주기: app_read · app.orders SELECT, INSERT");
  });

  test("a grant of several items counts the objects", () => {
    const three = [item(relation("app", "orders"), "SELECT"), item({ kind: "schema", name: "app" }, "USAGE"), item({ kind: "database", name: "appdb" }, "CONNECT")];
    expect(changeSummary(grantOn("app_read", true, three))).toBe("권한 주기: app_read · 객체 3개");
    const two = [item(relation("app", "a"), "SELECT"), item(relation("app", "b"), "SELECT")];
    expect(changeSummary(grantOn("PUBLIC", false, two))).toBe("권한 빼기: 모든 역할(PUBLIC) · 객체 2개");
  });

  test("a default privilege reads creator arrow grantee", () => {
    expect(changeSummary(defaultPrivilege("app_read", true))).toBe("기본 권한 주기: app_owner → app_read");
    expect(changeSummary(defaultPrivilege("PUBLIC", false))).toBe("기본 권한 빼기: app_owner → 모든 역할(PUBLIC)");
  });

  test("ending a session names the role and the pid, whether or not the start time is known", () => {
    expect(changeSummary({ kind: "terminate", pid: 4242, role: "bob", backendStart: "2026-10-28T12:00:00Z" })).toBe("세션 끊기: bob (pid 4242)");
    expect(changeSummary({ kind: "terminate", pid: 7, role: "bob", backendStart: null })).toBe("세션 끊기: bob (pid 7)");
  });

  test("every kind of target has its label", () => {
    const all: [PgGrantTarget, string][] = [
      [{ kind: "database", name: "orders" }, "데이터베이스 orders"],
      [{ kind: "schema", name: "app" }, "스키마 app"],
      [relation("app", "orders"), "app.orders"],
      [{ kind: "sequence", schema: "app", name: "orders_id_seq" }, "app.orders_id_seq"],
      [{ kind: "function", schema: "app", name: "touch", signature: "order_id integer" }, "app.touch(order_id integer)"],
      [{ kind: "function", schema: "app", name: "cleanup", signature: "" }, "app.cleanup()"],
      [{ kind: "allTables", schema: "app" }, "app 스키마의 모든 테이블"],
      [{ kind: "allSequences", schema: "app" }, "app 스키마의 모든 시퀀스"],
    ];
    for (const [target, label] of all) expect(targetLabel(target), label).toBe(label);
  });

  test("PUBLIC reads as every role and other names stay, `public` in lower case too", () => {
    expect(granteeLabel("PUBLIC")).toBe("모든 역할(PUBLIC)");
    expect(granteeLabel("app_read")).toBe("app_read");
    // 글자 그대로 PUBLIC일 때만이다
    expect(granteeLabel("public")).toBe("public");
    expect(changeSummary(grantOn("public", true, [item(relation("app", "orders"), "SELECT")]))).toBe("권한 주기: public · app.orders SELECT");
  });
});
