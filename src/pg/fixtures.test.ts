import { changeSummary } from "./changeText";
import {
  BADGES,
  FETCHED_AT,
  LOGIN_USER,
  ROLES,
  ROLE_NAMES,
  addBobToWriters,
  createAppAudit,
  createCarol,
  defaultAuditRead,
  dropAppAudit,
  grantAuditRead,
  pgTarget,
  removeBobFromWriters,
  resetAlicePassword,
  revokeAuditRead,
  sampleBatchPreview,
  sampleCellDetail,
  sampleChangeLog,
  sampleDatabaseView,
  sampleDropPlan,
  sampleFindings,
  sampleLogEntry,
  sampleOverview,
  samplePresetSuggestion,
  samplePreview,
  sampleRoleView,
  sampleSessions,
  sampleTargetInfo,
  sampleWhoCan,
} from "./fixtures";
import type { PgCoverage, PgSchemaCell } from "./types";

// 이후 화면 테스트가 기대는 값이 서로 어긋나지 않는지 확인한다.
const roleOf = (name: string) => ROLES.find((r) => r.name === name)!;
const DAY = 86_400_000;

describe("roles", () => {
  test("are unique, in name order, and include the system roles the screens hide", () => {
    expect(ROLE_NAMES).toEqual([...ROLE_NAMES].sort());
    expect(new Set(ROLE_NAMES).size).toBe(ROLE_NAMES.length);
    expect(ROLES.filter((r) => r.system).map((r) => r.name)).toEqual(["pg_read_all_data", "rds_iam", "rds_superuser"]);
    expect(sampleOverview().roles.map((r) => r.name)).toEqual(ROLE_NAMES);
  });

  test("the sample has the roles the task lists", () => {
    for (const name of ["postgres", "iam_admin", "app_owner", "app_read", "app_write", "alice", "bob"]) expect(ROLE_NAMES).toContain(name);
    expect(roleOf("app_read").kind).toBe("group");
    expect(roleOf("app_write").kind).toBe("group");
    expect(roleOf("alice").kind).toBe("user");
  });

  test("kind follows LOGIN", () => {
    for (const r of ROLES) expect(r.kind).toBe(r.attributes.login ? "user" : "group");
  });

  test("memberOf points at roles that exist, and memberCount counts the direct members", () => {
    for (const r of ROLES) {
      for (const m of r.memberOf) expect(ROLE_NAMES).toContain(m.group);
      const members = ROLES.filter((x) => x.memberOf.some((m) => m.group === r.name));
      expect(r.memberCount, r.name).toBe(members.length);
    }
  });

  test("badges follow memberships, attributes, expiry and the login user", () => {
    for (const r of ROLES) {
      const groups = r.memberOf.map((m) => m.group);
      const kinds = r.badges.map((b) => b.kind);
      expect(kinds.includes("admin"), `${r.name} admin`).toBe(groups.includes("rds_superuser"));
      expect(kinds.includes("iamAuth"), `${r.name} iamAuth`).toBe(groups.includes("rds_iam"));
      expect(kinds.includes("createRole"), `${r.name} createRole`).toBe(r.attributes.createRole);
      expect(kinds.includes("createDb"), `${r.name} createDb`).toBe(r.attributes.createDb);
      expect(kinds.includes("loginRole"), `${r.name} loginRole`).toBe(r.name === LOGIN_USER);
      const soon = r.attributes.validUntil !== null && Date.parse(r.attributes.validUntil) - Date.parse(FETCHED_AT) < 30 * DAY;
      expect(kinds.includes("expiringSoon"), `${r.name} expiringSoon`).toBe(soon);
    }
    expect(roleOf("iam_admin").badges).toEqual([BADGES.admin, BADGES.iamAuth, BADGES.loginRole]);
    expect(roleOf("bob").badges).toEqual([BADGES.expiringSoon]);
    expect(roleOf("bob").attributes.inherit).toBe(false);
    expect(roleOf("bob").memberOf[0].inherit).toBe(false);
  });

  test("session counts match the sample sessions", () => {
    const sessions = sampleSessions();
    for (const r of ROLES) expect(r.sessionCount, r.name).toBe(sessions.filter((s) => s.role === r.name).length);
  });
});

describe("overview", () => {
  test("is a connected cluster the app manages", () => {
    const overview = sampleOverview();
    expect(overview.target).toEqual(sampleTargetInfo());
    expect(overview.loginUser).toBe(LOGIN_USER);
    expect(overview.canManage).toBe(true);
    expect(overview.manageReason).toBeNull();
    expect(overview.target.identifier).toBe(pgTarget.id);
    expect(overview.target.kind).toBe(pgTarget.kind);
  });

  test("the default database exists and can be connected to, and one database cannot", () => {
    const { target, databases } = sampleOverview();
    expect(databases.find((d) => d.name === target.defaultDatabase)?.allowConn).toBe(true);
    expect(databases.some((d) => !d.allowConn)).toBe(true);
  });

  test("overrides replace single fields", () => {
    expect(sampleOverview({ canManage: false, manageReason: "이유" })).toMatchObject({ canManage: false, manageReason: "이유", loginUser: LOGIN_USER });
    expect(sampleTargetInfo({ iamAuth: false }).iamAuth).toBe(false);
  });
});

describe("database view", () => {
  const view = sampleDatabaseView();

  /** 칸에 잃을 것이 있는가: 보이는 권한이 하나라도 있다 */
  const somethingToLose = (c: PgSchemaCell) => c.usage || c.create || c.read !== "none" || c.write !== "none";
  /**
   * 계약이 정하는 칸의 unusable: 잃을 것이 없으면 null, 있으면 CONNECT가 먼저고 그다음이 스키마 USAGE다.
   * 보이는 것이 만들기(CREATE)뿐인 칸은 USAGE 없이도 쓸 수 있어서 USAGE 없음을 달지 않는다(CONNECT는 그대로 본다).
   * 이 픽스처에는 CONNECT는 있는데 USAGE가 없고 잃을 것이 있는 칸이 없다. 그런 칸이 생기면 이 규칙이 맞는 값을 요구한다.
   */
  const unusableOf = (c: PgSchemaCell, canConnect: boolean): string | null => {
    if (!somethingToLose(c)) return null;
    if (!canConnect) return "CONNECT 없음";
    const createOnly = c.create && !c.usage && c.read === "none" && c.write === "none";
    return !c.usage && !createOnly ? "USAGE 없음" : null;
  };

  test("is for a database the overview lists", () => {
    expect(sampleOverview().databases.map((d) => d.name)).toContain(view.database);
    expect(view.database).toBe(sampleOverview().target.defaultDatabase);
  });

  test("has the schemas app and audit", () => {
    expect(view.schemas.map((s) => s.name)).toEqual(["app", "audit"]);
  });

  test("has a cell for every role in every schema, roles in order and schemas by name", () => {
    expect(view.cells.map((c) => `${c.role}/${c.schema}`)).toEqual(ROLE_NAMES.flatMap((r) => ["app", "audit"].map((s) => `${r}/${s}`)));
  });

  test("has exactly one cell the role cannot actually use, and it has privileges to lose", () => {
    const unusable = view.cells.filter((c) => c.unusable !== null);
    expect(unusable).toHaveLength(1);
    expect(unusable[0]).toMatchObject({ role: "bob", schema: "app", unusable: "CONNECT 없음" });
    expect(unusable[0].read).not.toBe("none");
  });

  test("every unusable cell has something to lose", () => {
    for (const c of view.cells.filter((c) => c.unusable !== null)) expect(somethingToLose(c), `${c.role}/${c.schema}`).toBe(true);
  });

  test("an unusable cell follows the contract: CONNECT when it is missing, and a cell with nothing to lose is never flagged", () => {
    const connect = new Map(view.dbPrivileges.map((p) => [p.role, p.connect]));
    for (const c of view.cells) expect(c.unusable, `${c.role}/${c.schema}`).toBe(unusableOf(c, connect.get(c.role) ?? false));
    // 사용자 bob은 CONNECT가 없고 audit에는 USAGE도 없지만, 거기에는 잃을 것이 없다
    expect(view.cells.find((c) => c.role === "bob" && c.schema === "audit")?.unusable).toBeNull();
    expect(view.cells.find((c) => c.role === "alice" && c.schema === "audit")?.unusable).toBeNull();
  });

  test("has database privileges for every role, in the same order", () => {
    expect(view.dbPrivileges.map((p) => p.role)).toEqual(ROLE_NAMES);
    // unusable cells and CONNECT agree
    const cannotConnect = view.dbPrivileges.filter((p) => !p.connect).map((p) => p.role);
    expect(cannotConnect).toContain("bob");
  });

  test("inherited-only cells are exactly the ones whose privileges all come from groups or predefined roles", () => {
    expect(view.cells.filter((c) => c.inheritedOnly).map((c) => `${c.role}/${c.schema}`)).toEqual([
      "alice/app",
      "iam_admin/app",
      "iam_admin/audit",
      "pg_read_all_data/app",
      "pg_read_all_data/audit",
    ]);
    // an empty cell never claims a source
    for (const c of view.cells.filter((c) => !c.usage && !c.create && c.read === "none" && c.write === "none")) expect(c.inheritedOnly).toBe(false);
  });

  test("the default privileges name roles that exist and cover every object type, PUBLIC, all schemas and a grant option", () => {
    const rows = view.defaultPrivileges;
    for (const row of rows) {
      expect(ROLE_NAMES).toContain(row.creator);
      for (const g of row.grants) if (g.grantee !== "PUBLIC") expect(ROLE_NAMES).toContain(g.grantee);
    }
    expect(new Set(rows.map((r) => r.objectType))).toEqual(new Set(["tables", "sequences", "functions", "types", "schemas"]));
    expect(rows.some((r) => r.schema === null)).toBe(true);
    expect(rows.some((r) => r.grants.some((g) => g.grantee === "PUBLIC"))).toBe(true);
    expect(rows.some((r) => r.grants.some((g) => g.grantable))).toBe(true);
  });

  test("is not truncated by default and can be overridden", () => {
    expect(view.truncated).toBe(false);
    expect(sampleDatabaseView({ truncated: true }).truncated).toBe(true);
  });
});

describe("direct and owned", () => {
  const view = sampleDatabaseView();
  const rank: Record<PgCoverage, number> = { none: 0, some: 1, all: 2 };
  const none = { usage: false, create: false, read: "none", write: "none" };

  test("every cell and database row carries both", () => {
    for (const c of view.cells) {
      expect(Object.keys(c.direct).sort(), `${c.role}/${c.schema}`).toEqual(["create", "read", "usage", "write"]);
      expect(Object.keys(c.owned).sort()).toEqual(["create", "read", "usage", "write"]);
    }
    for (const p of view.dbPrivileges) {
      expect(Object.keys(p.direct).sort(), p.role).toEqual(["connect", "create", "temp"]);
      expect(Object.keys(p.owned).sort()).toEqual(["connect", "create", "temp"]);
    }
  });

  test("a source can only give what the cell shows: nothing direct or owned exceeds the effective value", () => {
    for (const c of view.cells) {
      for (const part of [c.direct, c.owned]) {
        const label = `${c.role}/${c.schema}`;
        if (part.usage) expect(c.usage, label).toBe(true);
        if (part.create) expect(c.create, label).toBe(true);
        expect(rank[part.read], label).toBeLessThanOrEqual(rank[c.read]);
        expect(rank[part.write], label).toBeLessThanOrEqual(rank[c.write]);
      }
    }
    for (const p of view.dbPrivileges) {
      for (const part of [p.direct, p.owned]) {
        if (part.connect) expect(p.connect, p.role).toBe(true);
        if (part.create) expect(p.create, p.role).toBe(true);
        if (part.temp) expect(p.temp, p.role).toBe(true);
      }
    }
  });

  test("the grid toggles direct: the roles that hold schema privileges directly are app_read, app_write and bob", () => {
    const direct = view.cells.filter((c) => JSON.stringify(c.direct) !== JSON.stringify(none));
    expect(direct.map((c) => `${c.role}/${c.schema}`)).toEqual(["app_read/app", "app_write/app", "bob/app"]);
    const at = (role: string) => view.cells.find((c) => c.role === role && c.schema === "app")!;
    expect(at("app_read").direct).toEqual({ usage: true, create: false, read: "all", write: "none" });
    expect(at("app_write").direct).toEqual({ usage: false, create: false, read: "none", write: "some" });
    expect(at("bob").direct).toEqual({ usage: false, create: false, read: "some", write: "none" });
  });

  test("only the owner owns, and it owns what it shows in both schemas, so it is never toggled", () => {
    const owned = view.cells.filter((c) => JSON.stringify(c.owned) !== JSON.stringify(none));
    expect(owned.map((c) => `${c.role}/${c.schema}`)).toEqual(["app_owner/app", "app_owner/audit"]);
    for (const c of owned) {
      expect(c.owned).toEqual({ usage: c.usage, create: c.create, read: c.read, write: c.write });
      expect(c.direct).toEqual(none);
    }
  });

  test("a cell whose visible privileges all come from groups, PUBLIC or predefined roles has nothing direct or owned", () => {
    for (const c of view.cells.filter((c) => c.inheritedOnly)) {
      expect(c.direct, `${c.role}/${c.schema}`).toEqual(none);
      expect(c.owned, `${c.role}/${c.schema}`).toEqual(none);
    }
  });

  test("the database row: CONNECT is direct for app_read, pg_read_all_data and rds_superuser, the owner owns all three, and TEMP comes from PUBLIC", () => {
    const direct = view.dbPrivileges.filter((p) => p.direct.connect).map((p) => p.role);
    expect(direct).toEqual(["app_read", "pg_read_all_data", "rds_superuser"]);
    const owner = view.dbPrivileges.find((p) => p.role === "app_owner")!;
    expect(owner.owned).toEqual({ connect: true, create: true, temp: true });
    expect(owner.direct).toEqual({ connect: false, create: false, temp: false });
    expect(view.dbPrivileges.filter((p) => p.owned.connect || p.owned.create || p.owned.temp).map((p) => p.role)).toEqual(["app_owner"]);
    expect(view.dbPrivileges.some((p) => p.direct.temp)).toBe(false);
    expect(view.dbPrivileges.every((p) => p.temp)).toBe(true);
  });

  test("a role view carries them in the cells it lists", () => {
    const orders = sampleRoleView("app_read").databases.find((d) => d.loaded)!;
    expect(orders.cells[0].direct).toEqual({ usage: true, create: false, read: "all", write: "none" });
    expect(orders.cells[0].owned).toEqual(none);
  });
});

describe("cell detail", () => {
  const detail = sampleCellDetail();

  test("is for a cell that has privileges in the database view", () => {
    const cell = sampleDatabaseView().cells.find((c) => c.role === detail.role && c.schema === detail.schema)!;
    expect(cell.read).not.toBe("none");
    expect(cell.inheritedOnly).toBe(true);
  });

  test("lists objects in name order, with only the privileges the role has", () => {
    const names = detail.objects.map((o) => o.object.name);
    expect(names).toEqual([...names].sort());
    for (const o of detail.objects) {
      expect(o.privileges.length).toBeGreaterThan(0);
      for (const p of o.privileges) expect(p.sources.length).toBeGreaterThan(0);
    }
  });

  test("shows group paths, a direct grant, PUBLIC and a table with row level security", () => {
    const kinds = new Set(detail.objects.flatMap((o) => o.privileges.flatMap((p) => p.sources.map((s) => s.kind))));
    expect(kinds).toEqual(new Set(["group", "direct", "public"]));
    expect(detail.objects.some((o) => o.rls)).toBe(true);
    const viaRead = detail.objects[0].privileges[0].sources[0];
    expect(viaRead.via).toEqual(["app_write", "app_read"]);
  });
});

describe("who-can", () => {
  const whoCan = sampleWhoCan();

  test("lists existing roles in name order, with their kind and system flag", () => {
    const names = whoCan.allowed.map((r) => r.role);
    expect(names).toEqual([...names].sort());
    for (const row of whoCan.allowed) {
      const r = roleOf(row.role);
      expect(row.kind).toBe(r.kind);
      expect(row.system).toBe(r.system);
    }
  });

  test("shows every kind of source a table gets, the longest group path, and a row that cannot be used", () => {
    const kinds = new Set(whoCan.allowed.flatMap((r) => r.sources.map((s) => s.kind)));
    expect(kinds).toEqual(new Set(["owner", "direct", "group", "predefined"]));
    expect(whoCan.allowed.some((r) => r.unusable === "CONNECT 없음")).toBe(true);
    // paths run from the role to the role that holds the grant, without the role itself
    expect(whoCan.allowed.find((r) => r.role === "alice")!.sources[0].via).toEqual(["app_write", "app_read"]);
  });

  test("bob has the privilege only through his own grant, because his membership in app_read does not inherit", () => {
    const row = whoCan.allowed.find((r) => r.role === "bob")!;
    expect(roleOf("bob").memberOf).toEqual([{ group: "app_read", inherit: false, set: true, admin: false }]);
    expect(row.sources.map((s) => s.kind)).toEqual(["direct"]);
    expect(row.sources.some((s) => s.via.includes("app_read"))).toBe(false);
  });

  test("agrees with the database view on who cannot use the grant", () => {
    const unusableInView = sampleDatabaseView().cells.filter((c) => c.unusable !== null && c.schema === whoCan.object.schema);
    for (const row of whoCan.allowed.filter((r) => r.unusable !== null)) expect(unusableInView.map((c) => c.role)).toContain(row.role);
  });
});

describe("sessions", () => {
  const sessions = sampleSessions();

  test("belong to roles and databases that exist", () => {
    const databases = sampleOverview().databases.map((d) => d.name);
    for (const s of sessions) {
      expect(ROLE_NAMES).toContain(s.role);
      expect(databases).toContain(s.database);
    }
  });

  test("mark the app's own connections, which are the login user's", () => {
    const own = sessions.filter((s) => s.own);
    expect(own.length).toBeGreaterThan(0);
    for (const s of own) {
      expect(s.role).toBe(LOGIN_USER);
      expect(s.applicationName).toBe("magic-mirror");
    }
    expect(sessions.some((s) => !s.own)).toBe(true);
  });

  test("have unique pids and a null in the optional columns", () => {
    expect(new Set(sessions.map((s) => s.pid)).size).toBe(sessions.length);
    expect(sessions.some((s) => s.waitEvent === null)).toBe(true);
  });
});

describe("findings", () => {
  const findings = sampleFindings();

  test("keep the highest level first and carry no empty group", () => {
    const rank = { high: 0, medium: 1, low: 2 } as const;
    const levels = findings.groups.map((g) => rank[g.level]);
    expect(levels).toEqual([...levels].sort());
    for (const g of findings.groups) expect(g.items.length).toBeGreaterThan(0);
  });

  test("point at roles and databases that exist", () => {
    const databases = sampleOverview().databases.map((d) => d.name);
    for (const item of findings.groups.flatMap((g) => g.items)) {
      if (item.role !== null) expect(ROLE_NAMES).toContain(item.role);
      if (item.database !== null) expect(databases).toContain(item.database);
    }
    for (const s of findings.skipped) expect(databases).toContain(s.database);
  });

  test("were all read whole, and the skipped database is not one that was cut", () => {
    expect(findings.truncated).toEqual([]);
  });

  test("include a skipped database and an item that names an object", () => {
    expect(findings.skipped.length).toBeGreaterThan(0);
    expect(findings.groups.flatMap((g) => g.items).some((i) => i.object !== null)).toBe(true);
  });
});

describe("role view", () => {
  const databaseView = sampleDatabaseView();

  test("is the detail of a role the overview lists, with the summary the list shows", () => {
    for (const name of ROLE_NAMES) expect(sampleRoleView(name).summary, name).toEqual(roleOf(name));
    expect(sampleRoleView().summary.name).toBe("alice");
  });

  test("a role the sample does not have is a mistake in the test, not an empty view", () => {
    expect(() => sampleRoleView("nobody")).toThrow("nobody");
  });

  test("members are the direct members, as many as memberCount says, with the flags of their membership", () => {
    for (const name of ROLE_NAMES) {
      const view = sampleRoleView(name);
      expect(view.members.length, name).toBe(roleOf(name).memberCount);
      for (const m of view.members) {
        const link = roleOf(m.role).memberOf.find((x) => x.group === name)!;
        expect(m, name).toEqual({ role: m.role, inherit: link.inherit, set: link.set, admin: link.admin });
      }
    }
    expect(sampleRoleView("rds_superuser").members).toEqual([
      { role: "iam_admin", inherit: true, set: true, admin: false },
      { role: "postgres", inherit: true, set: true, admin: true },
    ]);
    expect(sampleRoleView("app_read").members.find((m) => m.role === "bob")).toEqual({ role: "bob", inherit: false, set: true, admin: false });
  });

  test("setRoleOnly is what a role reaches only through memberships that do not inherit", () => {
    const reach = (name: string, viaInheritOnly: boolean): Set<string> => {
      const seen = new Set<string>();
      const walk = (r: string, throughSetRole: boolean) => {
        for (const m of roleOf(r).memberOf) {
          const direct = !throughSetRole && m.inherit;
          if (viaInheritOnly && !direct) continue;
          if (!seen.has(m.group)) {
            seen.add(m.group);
            walk(m.group, throughSetRole || !m.inherit);
          }
        }
      };
      walk(name, false);
      return seen;
    };
    for (const name of ROLE_NAMES) {
      const inherited = reach(name, true);
      const all = reach(name, false);
      expect(sampleRoleView(name).setRoleOnly, name).toEqual([...all].filter((g) => !inherited.has(g)).sort());
    }
    expect(sampleRoleView("bob").setRoleOnly).toEqual(["app_read"]);
    expect(sampleRoleView("alice").setRoleOnly).toEqual([]);
  });

  test("has one entry per database that can be connected to, and only the default database is read", () => {
    const view = sampleRoleView("app_owner");
    const connectable = sampleOverview().databases.filter((d) => d.allowConn).map((d) => d.name);
    expect(view.databases.map((d) => d.database)).toEqual(connectable);
    expect(view.databases.filter((d) => d.loaded).map((d) => d.database)).toEqual([sampleOverview().target.defaultDatabase]);
    for (const d of view.databases.filter((d) => !d.loaded)) expect(d).toEqual({ database: d.database, loaded: false, truncated: false, cells: [], owned: [], ownedOmitted: 0 });
    // 읽은 데이터베이스도 온전히 읽은 것이다
    expect(view.databases.filter((d) => d.loaded).every((d) => !d.truncated)).toBe(true);
  });

  test("the cells of the read database are the role's cells that have something in them", () => {
    for (const name of ROLE_NAMES) {
      const orders = sampleRoleView(name).databases.find((d) => d.database === databaseView.database)!;
      const expected = databaseView.cells.filter((c) => c.role === name && (c.usage || c.create || c.read !== "none" || c.write !== "none"));
      expect(orders.cells, name).toEqual(expected);
    }
    // bob의 칸 하나는 권한은 있지만 못 쓴다
    expect(sampleRoleView("bob").databases.find((d) => d.loaded)!.cells.map((c) => c.unusable)).toEqual(["CONNECT 없음"]);
  });

  test("the owner of the schemas owns them with their tables, sequences and functions; nobody else owns anything", () => {
    const owned = sampleRoleView("app_owner").databases.find((d) => d.loaded)!;
    expect(owned.ownedOmitted).toBe(0);
    expect(owned.owned.filter((o) => o.kind === "schema").map((o) => o.name)).toEqual(databaseView.schemas.map((s) => s.name));
    for (const schema of databaseView.schemas) {
      expect(owned.owned.filter((o) => o.kind === "table" && o.schema === schema.name), schema.name).toHaveLength(schema.tableCount);
    }
    expect(owned.owned.map((o) => o.kind)).toEqual(expect.arrayContaining(["schema", "table", "sequence", "function"]));
    for (const name of ROLE_NAMES.filter((n) => n !== "app_owner")) {
      for (const d of sampleRoleView(name).databases) expect(d.owned, name).toEqual([]);
    }
  });

  test("the sessions are the sample sessions of the role, and the login user's are the app's own", () => {
    for (const name of ROLE_NAMES) expect(sampleRoleView(name).sessions, name).toEqual(sampleSessions().filter((s) => s.role === name));
    expect(sampleRoleView("iam_admin").sessions.every((s) => s.own)).toBe(true);
    expect(sampleRoleView("iam_admin").sessions).toHaveLength(2);
  });

  test("has settings for the role that owns the schemas, for all databases and for one", () => {
    expect(sampleRoleView("app_owner").settings).toEqual([
      { database: null, setting: "search_path=app, public", allRoles: false },
      { database: "orders", setting: "work_mem=64MB", allRoles: false },
    ]);
    expect(sampleRoleView("alice").settings).toEqual([]);
  });

  test("overrides replace single fields", () => {
    expect(sampleRoleView("alice", { settings: [{ database: null, setting: "x=1", allRoles: true }] }).settings).toEqual([{ database: null, setting: "x=1", allRoles: true }]);
    expect(sampleRoleView("alice", { sessions: [] }).summary.name).toBe("alice");
  });
});

describe("changes", () => {
  const roleNames = new Set(ROLE_NAMES);
  const databases = sampleOverview().databases;

  test("the change fixtures are the ones the previews and the log talk about", () => {
    expect(revokeAuditRead).toEqual({ ...grantAuditRead, add: false });
    expect(removeBobFromWriters).toEqual({ ...addBobToWriters, add: false });
    expect(createCarol).toMatchObject({ kind: "createRole", login: true });
    expect(createAppAudit).toMatchObject({ kind: "createRole", login: false });
    expect(dropAppAudit).toEqual({ kind: "dropRole", role: "app_audit" });
    expect(resetAlicePassword).toEqual({ kind: "password", role: "alice" });
    for (const c of [grantAuditRead, defaultAuditRead]) expect(databases.map((d) => d.name)).toContain(c.database);
    for (const name of [grantAuditRead.grantee, defaultAuditRead.creator, addBobToWriters.member, addBobToWriters.group]) expect(roleNames).toContain(name);
  });

  test("a preview is for a change of the scenario, in a database it lists, run as the login user, with the summary the backend would write", () => {
    const preview = samplePreview();
    expect(preview.change).toBe(grantAuditRead);
    expect(preview.summary).toBe(changeSummary(preview.change));
    expect(databases.find((d) => d.name === preview.database)?.allowConn).toBe(true);
    expect(preview.loginUser).toBe(LOGIN_USER);
    expect(preview.sql).toEqual(['GRANT SELECT ON ALL TABLES IN SCHEMA "audit" TO "app_read"']);
  });

  test("its impact is who reads audit.events after the grant: the group chain of app_read, and not bob, who does not inherit", () => {
    const preview = samplePreview();
    expect(preview.impacts.map((i) => i.role)).toEqual(["alice", "app_read", "app_write"]);
    for (const impact of preview.impacts) {
      expect(roleNames).toContain(impact.role);
      expect(impact.lost).toEqual([]);
      expect(impact.gained).toEqual([{ database: "orders", schema: "audit", objectKind: "table", privilege: "SELECT", count: 1, sample: ["audit.events"] }]);
    }
    expect(preview.impacts.map((i) => i.role)).not.toContain("bob");
    expect(preview.impactsOmitted).toBe(0);
  });

  test("its warning is the one the app offers a button for, and that button adds the default privilege of the same schema and group", () => {
    const [warning] = samplePreview().warnings;
    expect(warning).toEqual({ level: "warn", message: "새로 만드는 테이블에는 적용되지 않아요", add: [defaultAuditRead] });
    expect(defaultAuditRead).toMatchObject({ schema: "audit", objectType: "tables", grantee: "app_read", creator: "app_owner" });
    // audit에는 기본 권한이 아직 없다
    expect(sampleDatabaseView().defaultPrivileges.some((r) => r.schema === "audit")).toBe(false);
  });

  test("a batch preview is its changes run one after the other in one database", () => {
    const batch = sampleBatchPreview();
    expect(batch.items.map((i) => i.change)).toEqual([grantAuditRead, addBobToWriters]);
    expect(batch.items.map((i) => i.summary)).toEqual(batch.items.map((i) => changeSummary(i.change)));
    expect(batch.sql).toEqual(batch.items.flatMap((i) => i.sql));
    expect(batch.database).toBe("orders");
    expect(batch.loginUser).toBe(LOGIN_USER);
    expect(batch.roles).toEqual([{ role: "bob", created: false, dropped: false, attributes: [], groupsAdded: ["app_write"], groupsRemoved: [] }]);
    expect(batch.impacts.map((i) => i.role)).not.toContain("bob");
  });

  test("a log entry is one the app wrote for this target, and undoing it is the revoke", () => {
    const entry = sampleLogEntry();
    expect(entry.targetArn).toBe(sampleTargetInfo().arn);
    expect(entry.profile).toBe(pgTarget.profile);
    expect(entry.loginUser).toBe(LOGIN_USER);
    expect(entry.summary).toBe(changeSummary(entry.change));
    expect(entry.inverse).toEqual([{ ...grantAuditRead, add: false }]);
    expect(entry.ok).toBe(true);
    expect(entry.error).toBeNull();
    expect("batchId" in entry).toBe(false); // 없을 때는 빠진다
  });

  test("the sample log is newest first, all of this target, and every summary matches its change", () => {
    const log = sampleChangeLog();
    const times = log.map((e) => e.at);
    expect(times).toEqual([...times].sort().reverse());
    expect(new Set(log.map((e) => e.targetArn))).toEqual(new Set([sampleTargetInfo().arn]));
    expect(new Set(log.map((e) => e.id)).size).toBe(log.length);
    for (const e of log) expect(e.summary, e.id).toBe(changeSummary(e.change));
  });

  test("the sample log has what the screen shows: a batch of two, one not undoable, one undone, one failed, a created role", () => {
    const log = sampleChangeLog();
    expect(log.filter((e) => e.batchId === "b-1").map((e) => e.id)).toEqual(["b-1-2", "b-1-1"]);
    expect(log.filter((e) => !e.batchId)).toHaveLength(4);
    expect(log.find((e) => e.change.kind === "password")?.inverse).toBeNull();
    expect(log.filter((e) => e.undone)).toHaveLength(1);
    const failed = log.filter((e) => !e.ok);
    expect(failed).toHaveLength(1);
    expect(failed[0].inverse).toBeNull();
    expect(failed[0].error).toMatch(/^적용하지 못했어요: /);
    expect(log.find((e) => e.change.kind === "createRole")?.inverse).toEqual([dropAppAudit]);
  });

  test("no log line carries a password: the password reset shows the mask", () => {
    const reset = sampleChangeLog().find((e) => e.change.kind === "password")!;
    expect(reset.sql).toEqual([`ALTER ROLE "alice" PASSWORD '••••••••'`]);
  });

  test("a preset suggestion names roles that exist: groups that match, creators, and one creator the login cannot set defaults for", () => {
    const suggestion = samplePresetSuggestion();
    for (const name of suggestion.matching) expect(ROLES.find((r) => r.name === name)?.kind).toBe("group");
    for (const name of [...suggestion.creators, ...suggestion.blockedCreators.map((b) => b.role)]) expect(roleNames).toContain(name);
    expect(suggestion.blockedCreators[0].reason).toMatch(/^postgres 역할의 기본 권한을 바꿀 수 없어요\. /);
    expect(suggestion.proposedName).not.toBe("");
    expect(roleNames).not.toContain(suggestion.proposedName);
  });

  test("a drop plan reassigns to an existing role, goes through the databases one by one and ends with DROP ROLE in the default database", () => {
    const plan = sampleDropPlan();
    expect(roleNames).toContain(plan.role);
    expect(roleNames).toContain(plan.reassignTo);
    expect(plan.confirmText).toBe(plan.role);
    const last = plan.steps[plan.steps.length - 1];
    expect(last).toMatchObject({ database: null, sql: ['DROP ROLE "alice"'] });
    const named = plan.steps.slice(0, -1).map((s) => s.database).filter((d): d is string => d !== null);
    for (const d of named) expect(databases.find((x) => x.name === d)?.allowConn, d).toBe(true);
    expect(plan.sessions).toBe(sampleSessions().filter((s) => s.role === plan.role).length);
    expect(plan.grantedMemberships).toEqual([]);
  });

  test("overrides replace single fields", () => {
    expect(samplePreview({ confirmText: "app_read" }).confirmText).toBe("app_read");
    expect(sampleBatchPreview({ reversible: false }).reversible).toBe(false);
    expect(sampleLogEntry({ id: "x" }).id).toBe("x");
    expect(samplePresetSuggestion({ matching: [] }).matching).toEqual([]);
    expect(sampleDropPlan({ sessions: 0 }).sessions).toBe(0);
  });
});

test("every sample is plain JSON, as the backend sends it", () => {
  const all = [
    sampleTargetInfo(),
    sampleOverview(),
    sampleDatabaseView(),
    sampleCellDetail(),
    sampleWhoCan(),
    sampleSessions(),
    sampleFindings(),
    sampleRoleView("app_owner"),
    samplePreview(),
    sampleBatchPreview(),
    sampleChangeLog(),
    samplePresetSuggestion(),
    sampleDropPlan(),
  ];
  for (const sample of all) expect(JSON.parse(JSON.stringify(sample))).toStrictEqual(sample);
});

test("each call returns new top-level objects, so a test can change one without touching the next", () => {
  expect(sampleOverview()).not.toBe(sampleOverview());
  expect(sampleDatabaseView().cells).not.toBe(sampleDatabaseView().cells);
  expect(sampleSessions()).not.toBe(sampleSessions());
  expect(sampleFindings().groups).not.toBe(sampleFindings().groups);
  expect(sampleRoleView().databases).not.toBe(sampleRoleView().databases);
  expect(sampleRoleView().summary).not.toBe(sampleRoleView().summary);
  expect(samplePreview().impacts).not.toBe(samplePreview().impacts);
  expect(sampleBatchPreview().items).not.toBe(sampleBatchPreview().items);
  expect(sampleChangeLog()).not.toBe(sampleChangeLog());
  expect(sampleDropPlan().steps).not.toBe(sampleDropPlan().steps);
});
