import {
  BRUSHES,
  DEFAULT_BRUSH,
  baseState,
  brushChange,
  brushItem,
  brushKey,
  brushOf,
  brushView,
  databaseLevels,
  schemaLevels,
  type Brush,
  type BrushId,
  type Levels,
} from "./brush";
import { OWNER_HELD_TEXT, systemRoleText } from "./canChange";
import { draftItem, draftKey, type PgDraftItem } from "./draft";
import { dbAspects, grantAuditRead, schemaAspects } from "./fixtures";
import { INHERITED_ONLY_TEXT } from "./labels";
import type { PgChange, PgDbPrivilegeRow, PgSchemaCell } from "./types";

const brush = (id: BrushId): Brush => brushOf(id);

describe("the brushes", () => {
  test("are the four of the schema columns and the three of the database column, in the order the legends show them", () => {
    expect(BRUSHES.map((b) => [b.label, b.scope])).toEqual([
      ["사용", "schema"],
      ["만들기", "schema"],
      ["읽기", "schema"],
      ["쓰기", "schema"],
      ["CONNECT", "database"],
      ["CREATE", "database"],
      ["TEMP", "database"],
    ]);
  });

  test("have different ids, and 읽기 is the one that is active at first", () => {
    expect(new Set(BRUSHES.map((b) => b.id)).size).toBe(BRUSHES.length);
    expect(brushOf(DEFAULT_BRUSH).label).toBe("읽기");
  });
});

describe("what a brush changes", () => {
  const grant = (role: string, add: boolean, ...items: Extract<PgChange, { kind: "grant" }>["items"]): PgChange => ({ kind: "grant", database: "orders", grantee: role, add, items });

  test("사용 and 만들기 are USAGE and CREATE on the schema", () => {
    expect(brushChange(brush("usage"), "orders", "alice", "app", true)).toEqual(grant("alice", true, { target: { kind: "schema", name: "app" }, privileges: ["USAGE"] }));
    expect(brushChange(brush("create"), "orders", "alice", "app", false)).toEqual(grant("alice", false, { target: { kind: "schema", name: "app" }, privileges: ["CREATE"] }));
  });

  test("읽기 is SELECT on all the tables of the schema, and 쓰기 is INSERT, UPDATE and DELETE on them", () => {
    expect(brushChange(brush("read"), "orders", "app_read", "audit", true)).toEqual(grantAuditRead);
    expect(brushChange(brush("write"), "orders", "alice", "app", true)).toEqual(
      grant("alice", true, { target: { kind: "allTables", schema: "app" }, privileges: ["INSERT", "UPDATE", "DELETE"] }),
    );
  });

  test("CONNECT, CREATE and TEMP are CONNECT, CREATE and TEMPORARY on the database, whatever the schema is", () => {
    for (const [id, privilege] of [["connect", "CONNECT"], ["dbCreate", "CREATE"], ["temp", "TEMPORARY"]] as const) {
      expect(brushChange(brush(id), "orders", "alice", null, true), id).toEqual(grant("alice", true, { target: { kind: "database", name: "orders" }, privileges: [privilege] }));
      expect(brushChange(brush(id), "orders", "alice", "app", true), id).toEqual(brushChange(brush(id), "orders", "alice", null, true));
    }
  });

  test("whether it adds is the add that was asked for, and the database is the one of the screen", () => {
    const revoke = brushChange(brush("usage"), "analytics", "bob", "reports", false);
    expect(revoke).toMatchObject({ kind: "grant", database: "analytics", grantee: "bob", add: false });
  });

  test("a schema brush needs the schema it paints", () => {
    expect(() => brushChange(brush("usage"), "orders", "alice", null, true)).toThrow();
  });

  test("the key of the change is the key of the cell: it does not depend on whether it adds", () => {
    expect(draftKey(brushChange(brush("read"), "orders", "alice", "app", true))).toBe(draftKey(brushChange(brush("read"), "orders", "alice", "app", false)));
    expect(draftKey(brushChange(brush("read"), "orders", "alice", "app", true))).not.toBe(draftKey(brushChange(brush("write"), "orders", "alice", "app", true)));
  });
});

describe("the item of a cell", () => {
  test("is the change, its key and its summary as the tray holds them", () => {
    const item = brushItem(brush("read"), "orders", "app_read", "audit", true);
    expect(item).toEqual({ key: "grant|orders|app_read|allTables:audit|SELECT", change: grantAuditRead, label: "권한 주기: app_read · audit 스키마의 모든 테이블 SELECT" });
    expect(brushItem(brush("read"), "orders", "app_read", "audit", false).change).toMatchObject({ add: false });
  });

  test("the key of a cell is the key of its item, whether the item gives or takes away", () => {
    expect(brushKey(brush("read"), "orders", "app_read", "audit")).toBe(brushItem(brush("read"), "orders", "app_read", "audit", true).key);
    expect(brushKey(brush("read"), "orders", "app_read", "audit")).toBe(brushItem(brush("read"), "orders", "app_read", "audit", false).key);
    expect(brushKey(brush("connect"), "orders", "bob", null)).toBe("grant|orders|bob|database:orders|CONNECT");
  });
});

describe("how much of a privilege a cell has", () => {
  const cell: PgSchemaCell = {
    role: "alice",
    schema: "app",
    usage: true,
    create: false,
    read: "all",
    write: "some",
    inheritedOnly: false,
    unusable: null,
    direct: schemaAspects({ usage: false, create: true, read: "some", write: "all" }),
    owned: schemaAspects({ usage: true, read: "all" }),
  };

  test("a schema cell: what is shown, what is direct and what the owner holds, for each brush", () => {
    expect(schemaLevels(brush("usage"), cell)).toEqual({ shown: "all", direct: "none", owned: "all" });
    expect(schemaLevels(brush("create"), cell)).toEqual({ shown: "none", direct: "all", owned: "none" });
    expect(schemaLevels(brush("read"), cell)).toEqual({ shown: "all", direct: "some", owned: "all" });
    expect(schemaLevels(brush("write"), cell)).toEqual({ shown: "some", direct: "all", owned: "none" });
  });

  const row: PgDbPrivilegeRow = {
    role: "alice",
    connect: true,
    create: false,
    temp: true,
    direct: dbAspects({ connect: true }),
    owned: dbAspects({ create: true }),
  };

  test("a database row: CONNECT, CREATE and TEMP", () => {
    expect(databaseLevels(brush("connect"), row)).toEqual({ shown: "all", direct: "all", owned: "none" });
    expect(databaseLevels(brush("dbCreate"), row)).toEqual({ shown: "none", direct: "none", owned: "all" });
    expect(databaseLevels(brush("temp"), row)).toEqual({ shown: "all", direct: "none", owned: "none" });
  });

  test("a brush of the other kind is not read from this kind of cell", () => {
    expect(() => schemaLevels(brush("connect"), cell)).toThrow();
    expect(() => databaseLevels(brush("read"), row)).toThrow();
  });
});

describe("the state of a cell", () => {
  const levels = (shown: Levels["shown"], direct: Levels["direct"] = "none", owned: Levels["owned"] = "none"): Levels => ({ shown, direct, owned });

  test("on when the role itself was given all of it, even if a group or the owner would give it too", () => {
    expect(baseState(levels("all", "all"))).toBe("on");
    expect(baseState(levels("all", "all", "all"))).toBe("on");
  });

  test("held as the owner when the ownership has all of it and nothing is given directly", () => {
    expect(baseState(levels("all", "none", "all"))).toBe("owner");
    expect(baseState(levels("all", "some", "all"))).toBe("owner");
  });

  test("partial when only some of the tables are covered by a direct grant or by ownership: it can still be filled in", () => {
    expect(baseState(levels("some", "some"))).toBe("some");
    expect(baseState(levels("all", "some"))).toBe("some"); // a group gives the rest
    expect(baseState(levels("some", "none", "some"))).toBe("some");
  });

  test("inherited only when it is shown and neither a direct grant nor the owner has any of it", () => {
    expect(baseState(levels("all"))).toBe("inherited");
    expect(baseState(levels("some"))).toBe("inherited");
  });

  test("off when nobody gives it", () => {
    expect(baseState(levels("none"))).toBe("off");
  });
});

describe("how a cell looks and what it does", () => {
  const read = brush("read");
  const bob = { name: "bob", system: false };
  const pendingOf = (add: boolean): PgDraftItem => {
    const item = draftItem(brushChange(read, "orders", "bob", "app", add));
    if (!item) throw new Error("no item");
    return item;
  };
  const view = (levels: Levels, pending?: PgDraftItem, who = bob) => brushView(read, levels, who, pending);

  test("on: ● that can be taken away", () => {
    expect(view({ shown: "all", direct: "all", owned: "none" })).toMatchObject({
      base: "on",
      on: true,
      shown: true,
      toggleable: true,
      glyph: "●",
      tone: "all",
      dim: false,
      title: undefined,
      name: "읽기 직접 받음",
    });
  });

  test("off: ○ that can be given", () => {
    expect(view({ shown: "none", direct: "none", owned: "none" })).toMatchObject({ base: "off", on: false, shown: false, toggleable: true, glyph: "○", tone: "none", dim: false, title: undefined, name: "읽기 없음" });
  });

  test("partial: ◐ that can be filled in, and is not on", () => {
    expect(view({ shown: "some", direct: "some", owned: "none" })).toMatchObject({ base: "some", on: false, shown: false, toggleable: true, glyph: "◐", tone: "some", name: "읽기 일부 테이블" });
  });

  test("held as the owner: dim, with its title, and not toggleable", () => {
    const v = view({ shown: "all", direct: "none", owned: "all" });
    expect(v).toMatchObject({ base: "owner", on: false, toggleable: false, dim: true, glyph: "●", tone: "all", title: OWNER_HELD_TEXT, name: "읽기 소유자" });
    expect(OWNER_HELD_TEXT).toBe("소유자라서 가진 권한이에요");
  });

  test("inherited only: dim, with its title, and not toggleable. A partial one is drawn ◐", () => {
    expect(view({ shown: "all", direct: "none", owned: "none" })).toMatchObject({
      base: "inherited",
      toggleable: false,
      dim: true,
      glyph: "●",
      tone: "all",
      title: INHERITED_ONLY_TEXT,
      name: `읽기 ${INHERITED_ONLY_TEXT}`,
    });
    expect(INHERITED_ONLY_TEXT).toBe("그룹·PUBLIC으로만 받음");
    expect(view({ shown: "some", direct: "none", owned: "none" })).toMatchObject({ glyph: "◐", tone: "some", dim: true });
  });

  test("a system role's cell is not toggleable, with the system-role text as its title, and shows what it holds", () => {
    const rdsSuperuser = { name: "rds_superuser", system: true };
    const v = view({ shown: "all", direct: "all", owned: "none" }, undefined, rdsSuperuser);
    expect(v).toMatchObject({ base: "on", toggleable: false, dim: true, glyph: "●", title: "시스템 역할이라 바꿀 수 없어요: rds_superuser" });
    expect(systemRoleText("rds_superuser")).toBe("시스템 역할이라 바꿀 수 없어요: rds_superuser");
    // the system-role text goes before the ones about where the privilege comes from
    expect(view({ shown: "all", direct: "none", owned: "all" }, undefined, rdsSuperuser).title).toBe(systemRoleText("rds_superuser"));
    expect(view({ shown: "all", direct: "none", owned: "none" }, undefined, rdsSuperuser).title).toBe(systemRoleText("rds_superuser"));
  });

  test("a change waiting to give it: ＋, and the cell shows as having it", () => {
    expect(view({ shown: "none", direct: "none", owned: "none" }, pendingOf(true))).toMatchObject({
      pending: pendingOf(true),
      shown: true,
      on: false,
      glyph: "＋",
      tone: "add",
      dim: false,
      name: "읽기 줄 예정",
    });
  });

  test("a change waiting to take it away: －, and the cell shows as not having it", () => {
    expect(view({ shown: "all", direct: "all", owned: "none" }, pendingOf(false))).toMatchObject({ shown: false, on: true, glyph: "－", tone: "del", name: "읽기 뺄 예정" });
  });

  test("the direction of the waiting change is what shows, even when the cell has changed under it", () => {
    // a give is waiting, but the cell has it by now
    expect(view({ shown: "all", direct: "all", owned: "none" }, pendingOf(true))).toMatchObject({ shown: true, on: true, glyph: "＋", tone: "add" });
    // a take-away is waiting, but the cell lost it by now
    expect(view({ shown: "none", direct: "none", owned: "none" }, pendingOf(false))).toMatchObject({ shown: false, on: false, glyph: "－", tone: "del" });
  });

  test("a waiting change on a cell that cannot be toggled is still shown, and the cell still cannot be toggled", () => {
    const v = view({ shown: "all", direct: "none", owned: "none" }, pendingOf(true));
    expect(v).toMatchObject({ glyph: "＋", toggleable: false, title: INHERITED_ONLY_TEXT });
  });

  test("the key of the change waiting is the key of the cell it is for", () => {
    expect(draftKey(pendingOf(true).change)).toBe("grant|orders|bob|allTables:app|SELECT");
  });

  test("each brush names its own aspect in the name of the cell", () => {
    const levels: Levels = { shown: "none", direct: "none", owned: "none" };
    expect(brushView(brush("usage"), levels, bob, undefined).name).toBe("사용 없음");
    expect(brushView(brush("dbCreate"), levels, bob, undefined).name).toBe("CREATE 없음");
    expect(brushView(brush("temp"), levels, bob, undefined).name).toBe("TEMP 없음");
  });
});
