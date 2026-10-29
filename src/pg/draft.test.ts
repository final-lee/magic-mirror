import {
  addBobToWriters,
  createAppAudit,
  createCarol,
  defaultAuditRead,
  dropAppAudit,
  grantAuditRead,
  resetAlicePassword,
  revokeAuditRead,
  removeBobFromWriters,
  sampleOverview,
} from "./fixtures";
import {
  FULL_NOTICE,
  MAX_DRAFT,
  OTHER_DATABASE_NOTICE,
  changeDatabase,
  defaultsAddedNotice,
  draftDatabase,
  draftItem,
  draftKey,
  putItems,
  removeApplied,
  toggleItem,
  type PgDraftItem,
} from "./draft";
import type { PgAttributesSet, PgChange } from "./types";

const roles = sampleOverview().roles;
type Grant = Extract<PgChange, { kind: "grant" }>;

const item = (change: PgChange): PgDraftItem => {
  const made = draftItem(change);
  if (!made) throw new Error(`not a tray change: ${change.kind}`);
  return made;
};
const keys = (items: PgDraftItem[]) => items.map((d) => d.key);

/** 사용자 bob의 지금 속성(픽스처): LOGIN, NOINHERIT, 8일 뒤 만료 */
const BOB: PgAttributesSet = { login: true, createDb: false, createRole: false, inherit: false, connectionLimit: -1, validUntil: "2026-11-05T12:00:00Z" };
const attributesOf = (role: string, set: Partial<PgAttributesSet>): PgChange => ({ kind: "attributes", role, set: { ...BOB, ...set } });

/** 데이터베이스 orders의 스키마 USAGE를 역할에게 준다 */
const usage = (grantee: string, schema = "app", database = "orders", add = true): Grant => ({
  kind: "grant",
  database,
  grantee,
  add,
  items: [{ target: { kind: "schema", name: schema }, privileges: ["USAGE"] }],
});

describe("the key of a change", () => {
  test("a grant: database, grantee, the object and its privileges", () => {
    expect(draftKey(grantAuditRead)).toBe("grant|orders|app_read|allTables:audit|SELECT");
    expect(draftKey(usage("alice"))).toBe("grant|orders|alice|schema:app|USAGE");
  });

  test("a grant and the revoke of it are the same cell: the key leaves out whether it adds", () => {
    expect(draftKey(revokeAuditRead)).toBe(draftKey(grantAuditRead));
  });

  test("the object is told apart by its kind and its names, and a function by its arguments", () => {
    const grantOn = (target: Grant["items"][number]["target"], privileges = ["SELECT"]): string =>
      draftKey({ kind: "grant", database: "orders", grantee: "alice", add: true, items: [{ target, privileges }] }) as string;
    expect(grantOn({ kind: "database", name: "orders" })).toBe("grant|orders|alice|database:orders|SELECT");
    expect(grantOn({ kind: "relation", schema: "app", name: "orders" })).toBe("grant|orders|alice|relation:app.orders|SELECT");
    expect(grantOn({ kind: "sequence", schema: "app", name: "orders_id_seq" })).toBe("grant|orders|alice|sequence:app.orders_id_seq|SELECT");
    expect(grantOn({ kind: "function", schema: "app", name: "touch_order", signature: "order_id integer" })).toBe(
      "grant|orders|alice|function:app.touch_order(order_id integer)|SELECT",
    );
    expect(grantOn({ kind: "allSequences", schema: "app" })).toBe("grant|orders|alice|allSequences:app|SELECT");
    expect(new Set([grantOn({ kind: "allTables", schema: "app" }), grantOn({ kind: "relation", schema: "app", name: "orders" }), grantOn({ kind: "schema", name: "app" })]).size).toBe(3);
  });

  test("the privileges are in the order PostgreSQL declares them, whatever order they were given", () => {
    const write = (privileges: string[]) => draftKey({ ...usage("alice"), items: [{ target: { kind: "allTables", schema: "app" }, privileges }] });
    expect(write(["INSERT", "UPDATE", "DELETE"])).toBe("grant|orders|alice|allTables:app|INSERT,UPDATE,DELETE");
    expect(write(["DELETE", "UPDATE", "INSERT"])).toBe(write(["INSERT", "UPDATE", "DELETE"]));
  });

  test("a grant with several objects has them all in its key, in the order they were given", () => {
    const two: Grant = {
      ...usage("alice"),
      items: [
        { target: { kind: "schema", name: "app" }, privileges: ["USAGE"] },
        { target: { kind: "schema", name: "audit" }, privileges: ["USAGE", "CREATE"] },
      ],
    };
    expect(draftKey(two)).toBe("grant|orders|alice|schema:app|USAGE;schema:audit|USAGE,CREATE");
  });

  test("a membership: the group, the member and whether it is the ADMIN OPTION", () => {
    expect(draftKey(addBobToWriters)).toBe("membership|app_write|bob|false");
    expect(draftKey(removeBobFromWriters)).toBe("membership|app_write|bob|false");
    expect(draftKey({ ...addBobToWriters, admin: true })).toBe("membership|app_write|bob|true");
  });

  test("the attributes of a role: one key per role", () => {
    expect(draftKey(attributesOf("bob", {}))).toBe("attributes|bob");
    expect(draftKey(attributesOf("bob", { createDb: true }))).toBe("attributes|bob");
  });

  test("a default privilege: who creates, where, what, for whom and which privileges. No schema is *", () => {
    expect(draftKey(defaultAuditRead)).toBe("default|orders|app_owner|audit|tables|app_read|SELECT");
    expect(draftKey({ ...defaultAuditRead, schema: null })).toBe("default|orders|app_owner|*|tables|app_read|SELECT");
    expect(draftKey({ ...defaultAuditRead, add: false })).toBe(draftKey(defaultAuditRead));
  });

  test("names that hold the separators of the key do not make two different cells one", () => {
    const schemaOf = (grantee: string, name: string) => draftKey({ ...usage(grantee), items: [{ target: { kind: "schema", name }, privileges: ["USAGE"] }] });
    const tableOf = (schema: string, name: string) => draftKey({ ...usage("alice"), items: [{ target: { kind: "relation", schema, name }, privileges: ["SELECT"] }] });
    // without the escapes both pairs would read grant|orders|a|schema:b|schema:c|USAGE and relation:a.b.c
    expect(schemaOf("a|schema:b", "c")).not.toBe(schemaOf("a", "b|schema:c"));
    expect(tableOf("a.b", "c")).not.toBe(tableOf("a", "b.c"));
    // the key of a name that holds none of them is the plain one
    expect(tableOf("app", "orders")).toBe("grant|orders|alice|relation:app.orders|SELECT");
    expect(draftKey({ ...defaultAuditRead, schema: "*" })).not.toBe(draftKey({ ...defaultAuditRead, schema: null }));
  });

  test("a change that does not go through the tray has no key", () => {
    for (const change of [createAppAudit, createCarol, resetAlicePassword, dropAppAudit, { kind: "terminate", pid: 1, role: "alice", backendStart: null } as PgChange]) {
      expect(draftKey(change)).toBeNull();
      expect(draftItem(change)).toBeNull();
    }
  });

  test("an item has the key, the change as it was given, and its summary as the label", () => {
    expect(draftItem(grantAuditRead)).toEqual({ key: draftKey(grantAuditRead), change: grantAuditRead, label: "권한 주기: app_read · audit 스키마의 모든 테이블 SELECT" });
    expect(draftItem(addBobToWriters)?.label).toBe("그룹에 넣기: bob → app_write");
  });
});

describe("the database of the tray", () => {
  test("a grant and a default privilege run in their database, and the cluster-wide changes in none", () => {
    expect(changeDatabase(grantAuditRead)).toBe("orders");
    expect(changeDatabase(defaultAuditRead)).toBe("orders");
    expect(changeDatabase(addBobToWriters)).toBeNull();
    expect(changeDatabase(attributesOf("bob", {}))).toBeNull();
  });

  test("is the database of the items that have one, and none while there are only cluster-wide items", () => {
    expect(draftDatabase([])).toBeNull();
    expect(draftDatabase([item(addBobToWriters), item(attributesOf("bob", { createDb: true }))])).toBeNull();
    expect(draftDatabase([item(addBobToWriters), item(grantAuditRead)])).toBe("orders");
    expect(draftDatabase([item(usage("alice", "app", "analytics")), item(addBobToWriters)])).toBe("analytics");
  });
});

describe("toggling an item", () => {
  test("puts it at the end of the tray, and the same key again takes it out", () => {
    const first = toggleItem([], item(grantAuditRead), roles);
    expect(keys(first.items)).toEqual([draftKey(grantAuditRead)]);
    const second = toggleItem(first.items, item(usage("alice")), roles);
    expect(keys(second.items)).toEqual([draftKey(grantAuditRead), draftKey(usage("alice"))]);
    const off = toggleItem(second.items, item(grantAuditRead), roles);
    expect(keys(off.items)).toEqual([draftKey(usage("alice"))]);
  });

  test("the opposite change of a pending cell is the same key, so it takes the pending one out instead of queueing a second", () => {
    const on = toggleItem([], item(grantAuditRead), roles).items;
    expect(toggleItem(on, item(revokeAuditRead), roles).items).toEqual([]);
  });

  test("says nothing was refused when it adds or removes", () => {
    expect(toggleItem([], item(grantAuditRead), roles)).toMatchObject({ full: false, elsewhere: false, added: 1 });
    expect(toggleItem([item(grantAuditRead)], item(grantAuditRead), roles)).toMatchObject({ full: false, elsewhere: false, added: 0 });
  });

  test("a membership toggles by its key", () => {
    const added = toggleItem([], item(addBobToWriters), roles).items;
    expect(keys(added)).toEqual(["membership|app_write|bob|false"]);
    expect(toggleItem(added, item(removeBobFromWriters), roles).items).toEqual([]);
  });
});

describe("one change for one pair or one role", () => {
  test("a membership with the other ADMIN OPTION value replaces the pending one for the same pair, where it stands", () => {
    const other = (group: string, member: string): PgChange => ({ kind: "membership", group, member, add: true, admin: false });
    const start = [item(other("app_read", "alice")), item(addBobToWriters), item(other("app_read", "bob"))];
    const result = toggleItem(start, item({ ...addBobToWriters, admin: true }), roles);
    expect(keys(result.items)).toEqual(["membership|app_read|alice|false", "membership|app_write|bob|true", "membership|app_read|bob|false"]);
    expect(result.added).toBe(0); // a replacement is not a new item
  });

  test("the replacement works the other way too, and a pair never holds two items", () => {
    const admin = item({ ...addBobToWriters, admin: true });
    const result = toggleItem([admin], item(addBobToWriters), roles);
    expect(keys(result.items)).toEqual(["membership|app_write|bob|false"]);
  });

  test("a membership of another pair is another item", () => {
    const result = toggleItem([item(addBobToWriters)], item({ ...addBobToWriters, group: "app_read" }), roles);
    expect(result.items).toHaveLength(2);
  });

  test("a replacement is allowed when the tray is full: it takes no room", () => {
    const full = fill(MAX_DRAFT - 1, [item(addBobToWriters)]);
    const result = toggleItem(full, item({ ...addBobToWriters, admin: true }), roles);
    expect(result.items).toHaveLength(MAX_DRAFT);
    expect(result.full).toBe(false);
  });

  test("a new attributes item for a role replaces the old one, where it stands", () => {
    const start = [item(addBobToWriters), item(attributesOf("bob", { createDb: true })), item(grantAuditRead)];
    const next = attributesOf("bob", { createDb: true, createRole: true });
    const result = toggleItem(start, item(next), roles);
    expect(keys(result.items)).toEqual(["membership|app_write|bob|false", "attributes|bob", "grant|orders|app_read|allTables:audit|SELECT"]);
    expect(result.items[1].change).toEqual(next);
    expect(result.added).toBe(0);
  });

  test("the same attributes again do not take the item out: an attributes item is set, not toggled", () => {
    const set = item(attributesOf("bob", { createDb: true }));
    const result = toggleItem([set], set, roles);
    expect(result.items).toEqual([set]);
  });

  test("an attributes item that equals the role's attributes as they are is dropped, and queues nothing", () => {
    expect(toggleItem([], item(attributesOf("bob", {})), roles).items).toEqual([]);
    const pending = [item(addBobToWriters), item(attributesOf("bob", { createDb: true }))];
    // the user changed it back: the pending item goes, the other items stay
    expect(keys(toggleItem(pending, item(attributesOf("bob", {})), roles).items)).toEqual(["membership|app_write|bob|false"]);
  });

  test("each of the attributes counts when it is compared with the role", () => {
    for (const set of [{ login: false }, { createDb: true }, { createRole: true }, { inherit: true }, { connectionLimit: 5 }, { validUntil: null }, { validUntil: "2026-12-01T12:00:00Z" }]) {
      expect(toggleItem([], item(attributesOf("bob", set)), roles).items, JSON.stringify(set)).toHaveLength(1);
    }
  });

  test("an expiry that is the same instant is the same expiry", () => {
    expect(toggleItem([], item(attributesOf("bob", { validUntil: "2026-11-05T12:00:00.000Z" })), roles).items).toEqual([]);
  });

  test("a role the overview does not know has nothing to be compared with, so the item stays", () => {
    expect(toggleItem([], item(attributesOf("nobody", {})), roles).items).toHaveLength(1);
  });
});

/** 서로 다른 칸 n개를 담은 장바구니(orders의 스키마 USAGE). extra를 앞에 둔다 */
function fill(n: number, extra: PgDraftItem[] = []): PgDraftItem[] {
  return [...extra, ...Array.from({ length: n }, (_, i) => item(usage(`role_${String(i).padStart(2, "0")}`)))];
}

describe("the limit of the tray", () => {
  test("holds MAX_DRAFT (50) items", () => {
    expect(MAX_DRAFT).toBe(50);
    expect(FULL_NOTICE).toBe("한 번에 50개까지 담을 수 있어요");
  });

  test("an item that does not fit is left out, and the result says the tray was full", () => {
    const full = fill(MAX_DRAFT);
    const result = toggleItem(full, item(usage("one_more")), roles);
    expect(result.items).toBe(full);
    expect(result).toMatchObject({ full: true, elsewhere: false, added: 0 });
  });

  test("an item that is already in the tray takes the room it had: removing from a full tray works", () => {
    const full = fill(MAX_DRAFT);
    const result = toggleItem(full, full[10], roles);
    expect(result.items).toHaveLength(MAX_DRAFT - 1);
    expect(result.full).toBe(false);
  });

  test("painting stops at the limit: what fits goes in, in order, and the rest is left out", () => {
    const incoming = Array.from({ length: MAX_DRAFT + 3 }, (_, i) => item(usage(`user_${String(i).padStart(2, "0")}`)));
    const result = putItems([], incoming, roles);
    expect(result.items).toHaveLength(MAX_DRAFT);
    expect(result.items[0]).toBe(incoming[0]);
    expect(result.items[MAX_DRAFT - 1]).toBe(incoming[MAX_DRAFT - 1]);
    expect(result).toMatchObject({ full: true, added: MAX_DRAFT });
  });
});

describe("one database for the grants and default privileges", () => {
  test("an item for another database than the tray's is refused, with the result saying so", () => {
    const start = [item(grantAuditRead)];
    const result = toggleItem(start, item(usage("alice", "app", "analytics")), roles);
    expect(result.items).toBe(start);
    expect(result).toMatchObject({ full: false, elsewhere: true, added: 0 });
    expect(OTHER_DATABASE_NOTICE).toBe("다른 데이터베이스의 변경이 담겨 있어요. 먼저 적용하거나 비워 주세요");
  });

  test("a default privilege follows the same rule, whichever kind came first", () => {
    const other = { ...defaultAuditRead, database: "analytics" };
    expect(toggleItem([item(grantAuditRead)], item(other), roles).elsewhere).toBe(true);
    expect(toggleItem([item(other)], item(grantAuditRead), roles).elsewhere).toBe(true);
    expect(toggleItem([item(defaultAuditRead)], item(grantAuditRead), roles).elsewhere).toBe(false);
  });

  test("the cluster-wide items are for any database: they neither fix it nor are refused by it", () => {
    const start = [item(addBobToWriters), item(attributesOf("bob", { createDb: true }))];
    const withGrant = toggleItem(start, item(grantAuditRead), roles);
    expect(withGrant.elsewhere).toBe(false);
    expect(withGrant.items).toHaveLength(3);
    const other = toggleItem(withGrant.items, item({ ...addBobToWriters, group: "app_read" }), roles);
    expect(other).toMatchObject({ elsewhere: false, added: 1 });
  });

  test("once the last item that has a database is out, another database is welcome", () => {
    const start = [item(addBobToWriters), item(grantAuditRead)];
    const without = toggleItem(start, item(grantAuditRead), roles).items;
    expect(toggleItem(without, item(usage("alice", "app", "analytics")), roles).elsewhere).toBe(false);
  });

  test("painting leaves out the items of another database and still takes the others", () => {
    const incoming = [item(usage("a")), item(usage("b", "app", "analytics")), item(usage("c"))];
    const result = putItems([], incoming, roles);
    expect(keys(result.items)).toEqual([draftKey(usage("a")), draftKey(usage("c"))]);
    expect(result).toMatchObject({ elsewhere: true, added: 2 });
  });

  test("the other-database rule goes before the limit", () => {
    const result = toggleItem(fill(MAX_DRAFT), item(usage("alice", "app", "analytics")), roles);
    expect(result).toMatchObject({ elsewhere: true, full: false });
  });
});

describe("putting many items in", () => {
  test("keeps the order, and skips the keys that are already there", () => {
    const start = [item(usage("a")), item(usage("b"))];
    const result = putItems(start, [item(usage("b")), item(usage("c")), item(usage("a")), item(usage("d"))], roles);
    expect(keys(result.items)).toEqual(["a", "b", "c", "d"].map((who) => draftKey(usage(who))));
    expect(result.items[0]).toBe(start[0]);
    expect(result.added).toBe(2);
  });

  test("returns the tray it was given when nothing is new", () => {
    const start = [item(usage("a"))];
    expect(putItems(start, [item(usage("a"))], roles).items).toBe(start);
    expect(putItems(start, [], roles).items).toBe(start);
  });

  test("a grant that is already pending in the other direction is not queued again: the cell has its one change", () => {
    const start = [item(grantAuditRead)];
    expect(putItems(start, [item(revokeAuditRead)], roles).items).toBe(start);
  });

  test("a default privilege is queued like any other change, and the notice counts them", () => {
    const result = putItems([item(grantAuditRead)], [item(defaultAuditRead)], roles);
    expect(keys(result.items)).toEqual([draftKey(grantAuditRead), draftKey(defaultAuditRead)]);
    expect(defaultsAddedNotice(result.added)).toBe("기본 권한 1개를 담았어요");
    expect(defaultsAddedNotice(3)).toBe("기본 권한 3개를 담았어요");
  });
});

describe("taking out what was applied", () => {
  test("drops exactly the items whose keys the applied changes have", () => {
    const start = [item(grantAuditRead), item(addBobToWriters), item(usage("alice")), item(defaultAuditRead)];
    const left = removeApplied(start, [revokeAuditRead, addBobToWriters]);
    expect(keys(left)).toEqual([draftKey(usage("alice")), draftKey(defaultAuditRead)]);
  });

  test("a membership of the other ADMIN OPTION value is not the same item", () => {
    const start = [item(addBobToWriters), item({ ...addBobToWriters, group: "app_read", admin: true })];
    expect(keys(removeApplied(start, [{ ...addBobToWriters, group: "app_read" }]))).toEqual(keys(start));
  });

  test("changes that have no key take nothing out, and an empty list returns the tray itself", () => {
    const start = [item(grantAuditRead)];
    expect(removeApplied(start, [createAppAudit, resetAlicePassword])).toBe(start);
    expect(removeApplied(start, [])).toBe(start);
    expect(removeApplied(start, [usage("nobody")])).toBe(start);
  });
});
