// 테스트(와 이후 데모)용 Aurora PostgreSQL 클러스터 샘플. 시각은 TZ에 상관없이 같은 날짜가 되도록 정오(UTC)로 둔다.
//
// 한 시나리오에서 모든 값을 맞춰 두었다(fixtures.test.ts가 서로 어긋나지 않는지 확인한다).
// - 앱은 iam_admin(rds_superuser 멤버)으로 접속했고, 기본 데이터베이스는 orders다.
// - orders의 PUBLIC CONNECT는 회수했다. CONNECT는 app_owner(소유자), app_read, rds_superuser, pg_read_all_data만 가진다.
// - app 스키마: app_read가 USAGE와 모든 테이블 SELECT, app_write가 orders·order_items에 INSERT·UPDATE·DELETE.
//   alice ← app_write ← app_read는 그룹으로 받고, bob은 NOINHERIT라 app_read를 상속하지 않는다.
// - bob은 app.orders SELECT를 직접 받았지만 CONNECT가 없어서 못 쓴다(권한 표의 유일한 "못 쓰는 칸").
// - iam_admin은 pg_read_all_data 멤버라 모든 테이블을 읽는다(출처 predefined).
import type {
  PgAttributes,
  PgBadge,
  PgBadgeKind,
  PgCellDetail,
  PgCellObject,
  PgDatabaseView,
  PgDefaultAclRow,
  PgFinding,
  PgFindingGroup,
  PgFindings,
  PgMembership,
  PgObjectRef,
  PgOverview,
  PgPrivilegeGrant,
  PgRoleDatabase,
  PgRoleSummary,
  PgRoleView,
  PgSchemaCell,
  PgSession,
  PgSource,
  PgSourceKind,
  PgTarget,
  PgTargetInfo,
  PgWhoCan,
} from "./types";

const ACCOUNT_ID = "123456789012";
export const FETCHED_AT = "2026-10-28T12:00:00Z";
/** 앱이 로그인한 DB 사용자 */
export const LOGIN_USER = "iam_admin";

export const pgTarget: PgTarget = { profile: "prod", region: "ap-northeast-2", kind: "cluster", id: "orders-aurora" };

export function sampleTargetInfo(extra: Partial<PgTargetInfo> = {}): PgTargetInfo {
  return {
    arn: `arn:aws:rds:${pgTarget.region}:${ACCOUNT_ID}:cluster:${pgTarget.id}`,
    identifier: pgTarget.id,
    kind: "cluster",
    engine: "aurora-postgresql",
    engineVersion: "16.4",
    endpoint: "orders-aurora.cluster-c9akciq32.ap-northeast-2.rds.amazonaws.com",
    port: 5432,
    defaultDatabase: "orders",
    iamAuth: true,
    readReplica: false,
    ...extra,
  };
}

// ── 역할 ──
export const badge = (kind: PgBadgeKind, label: string, level: PgBadge["level"]): PgBadge => ({ kind, label, level });
// 백엔드와 같은 이름·수준. 한 역할에서는 아래 선언 순서대로 붙는다.
export const BADGES = {
  admin: badge("admin", "관리자급", "high"),
  iamAuth: badge("iamAuth", "IAM 인증", "info"),
  createRole: badge("createRole", "CREATEROLE", "medium"),
  createDb: badge("createDb", "CREATEDB", "info"),
  bypassRls: badge("bypassRls", "BYPASSRLS", "medium"),
  replication: badge("replication", "REPLICATION", "info"),
  expired: badge("expired", "만료됨", "medium"),
  expiringSoon: badge("expiringSoon", "곧 만료", "info"),
  loginRole: badge("loginRole", "앱이 로그인한 역할", "info"),
};

export const attributes = (extra: Partial<PgAttributes> = {}): PgAttributes => ({
  login: false,
  createDb: false,
  createRole: false,
  inherit: true,
  replication: false,
  bypassRls: false,
  connectionLimit: -1,
  validUntil: null,
  ...extra,
});
export const membership = (group: string, extra: Partial<PgMembership> = {}): PgMembership => ({ group, inherit: true, set: true, admin: false, ...extra });

const SYSTEM_NAMES = ["rdsadmin", "rdstopmgr", "rdsrepladmin"];
/** kind와 system은 속성과 이름에서 정한다(백엔드와 같은 규칙). */
export function role(name: string, extra: Partial<PgRoleSummary> = {}): PgRoleSummary {
  const attrs = extra.attributes ?? attributes();
  return {
    name,
    kind: attrs.login ? "user" : "group",
    system: name.startsWith("pg_") || name.startsWith("rds_") || SYSTEM_NAMES.includes(name),
    attributes: attrs,
    memberOf: [],
    memberCount: 0,
    sessionCount: 0,
    badges: [],
    comment: null,
    ...extra,
  };
}

export const postgres = role("postgres", {
  attributes: attributes({ login: true, createDb: true, createRole: true }),
  memberOf: [membership("rds_superuser", { admin: true })],
  badges: [BADGES.admin, BADGES.createRole, BADGES.createDb],
});
export const iamAdmin = role(LOGIN_USER, {
  attributes: attributes({ login: true }),
  memberOf: [membership("pg_read_all_data"), membership("rds_iam"), membership("rds_superuser")],
  sessionCount: 2,
  badges: [BADGES.admin, BADGES.iamAuth, BADGES.loginRole],
  comment: "IAM 인증으로 접속하는 관리자",
});
export const appOwner = role("app_owner", {
  attributes: attributes({ login: true, connectionLimit: 20 }),
  sessionCount: 1,
  comment: "orders 스키마를 만들고 소유하는 계정",
});
export const appRead = role("app_read", { memberCount: 2, comment: "app 스키마 읽기 전용 그룹" });
export const appWrite = role("app_write", { memberOf: [membership("app_read")], memberCount: 1 });
export const alice = role("alice", {
  attributes: attributes({ login: true }),
  memberOf: [membership("app_write"), membership("rds_iam")],
  sessionCount: 1,
  badges: [BADGES.iamAuth],
});
// NOINHERIT라서 app_read의 권한을 물려받지 않는다(SET ROLE로만 쓸 수 있다). 8일 뒤 만료.
export const bob = role("bob", {
  attributes: attributes({ login: true, inherit: false, validUntil: "2026-11-05T12:00:00Z" }),
  memberOf: [membership("app_read", { inherit: false })],
  sessionCount: 1,
  badges: [BADGES.expiringSoon],
});
export const rdsSuperuser = role("rds_superuser", {
  attributes: attributes({ createDb: true, createRole: true }),
  memberCount: 2,
  badges: [BADGES.createRole, BADGES.createDb],
});
export const rdsIam = role("rds_iam", { memberCount: 2 });
export const pgReadAllData = role("pg_read_all_data", { memberCount: 1 });

// 이름순(백엔드의 pg_roles ORDER BY rolname)
export const ROLES: PgRoleSummary[] = [alice, appOwner, appRead, appWrite, bob, iamAdmin, pgReadAllData, postgres, rdsIam, rdsSuperuser];
export const ROLE_NAMES = ROLES.map((r) => r.name);

export function sampleOverview(extra: Partial<PgOverview> = {}): PgOverview {
  return {
    target: sampleTargetInfo(),
    loginUser: LOGIN_USER,
    serverVersion: "16.4",
    serverVersionNum: 160004,
    passwordEncryption: "scram-sha-256",
    fetchedAt: FETCHED_AT,
    roles: [...ROLES],
    databases: [
      { name: "analytics", owner: "app_owner", allowConn: true },
      { name: "legacy_archive", owner: "app_owner", allowConn: false },
      { name: "orders", owner: "app_owner", allowConn: true },
      { name: "postgres", owner: "postgres", allowConn: true },
    ],
    canManage: true,
    manageReason: null,
    ...extra,
  };
}

// ── 객체 ──
export const object = (kind: PgObjectRef["kind"], schema: string | null, name: string, signature: string | null = null): PgObjectRef => ({
  kind,
  schema,
  name,
  signature,
});
export const ordersTable = object("table", "app", "orders");
export const orderItemsTable = object("table", "app", "order_items");
export const customersTable = object("table", "app", "customers");
export const eventsTable = object("table", "audit", "events");
export const ordersIdSeq = object("sequence", "app", "orders_id_seq");
export const touchOrderFn = object("function", "app", "touch_order", "order_id integer");

// ── 권한 표 ──
const SCHEMAS = ["app", "audit"];
const cell = (roleName: string, schema: string, extra: Partial<PgSchemaCell> = {}): PgSchemaCell => ({
  role: roleName,
  schema,
  usage: false,
  create: false,
  read: "none",
  write: "none",
  inheritedOnly: false,
  unusable: null,
  ...extra,
});
// 권한이 있는 칸만 적는다. 나머지는 모두 비어 있다. 못 쓰는 칸(unusable)은 권한이 있는 칸에만 붙는다.
const CELLS: Record<string, Partial<PgSchemaCell>> = {
  "alice/app": { usage: true, read: "all", write: "some", inheritedOnly: true }, // app_write ← app_read에서 받음
  "app_owner/app": { usage: true, create: true, read: "all", write: "all" },
  "app_owner/audit": { usage: true, create: true, read: "all", write: "all" },
  "app_read/app": { usage: true, read: "all" },
  "app_write/app": { usage: true, read: "all", write: "some" }, // 쓰기는 직접 받았으므로 흐리지 않는다
  "bob/app": { read: "some", unusable: "CONNECT 없음" }, // app.orders SELECT만 직접 받았고 CONNECT가 없다
  "iam_admin/app": { usage: true, read: "all", inheritedOnly: true }, // pg_read_all_data
  "iam_admin/audit": { usage: true, read: "all", inheritedOnly: true },
  "pg_read_all_data/app": { usage: true, read: "all", inheritedOnly: true },
  "pg_read_all_data/audit": { usage: true, read: "all", inheritedOnly: true },
};
const CONNECT = new Set(["alice", "app_owner", "app_read", "app_write", "iam_admin", "pg_read_all_data", "postgres", "rds_superuser"]);

export function sampleDatabaseView(extra: Partial<PgDatabaseView> = {}): PgDatabaseView {
  return {
    database: "orders",
    fetchedAt: FETCHED_AT,
    truncated: false,
    // PUBLIC은 TEMP만 남았다(CONNECT 회수). CREATE는 소유자뿐이다.
    dbPrivileges: ROLE_NAMES.map((name) => ({ role: name, connect: CONNECT.has(name), create: name === "app_owner", temp: true })),
    schemas: [
      { name: "app", owner: "app_owner", tableCount: 3 },
      { name: "audit", owner: "app_owner", tableCount: 1 },
    ],
    // 시스템 역할을 포함한 모든 역할 × 모든 스키마. 역할 순서 안에서 스키마 이름순.
    cells: ROLE_NAMES.flatMap((name) => SCHEMAS.map((schema) => cell(name, schema, CELLS[`${name}/${schema}`]))),
    defaultPrivileges: sampleDefaultPrivileges(),
    ...extra,
  };
}

function sampleDefaultPrivileges(): PgDefaultAclRow[] {
  const grant = (grantee: string, privileges: string[], grantable = false) => ({ grantee, privileges, grantable });
  return [
    {
      creator: "app_owner",
      schema: "app",
      objectType: "tables",
      grants: [grant("app_read", ["SELECT"]), grant("app_write", ["INSERT", "UPDATE", "DELETE"])],
    },
    { creator: "app_owner", schema: "app", objectType: "sequences", grants: [grant("app_write", ["USAGE", "SELECT"])] },
    { creator: "app_owner", schema: "app", objectType: "functions", grants: [grant("app_write", ["EXECUTE"])] },
    { creator: "app_owner", schema: null, objectType: "types", grants: [grant("PUBLIC", ["USAGE"])] },
    { creator: "app_owner", schema: null, objectType: "schemas", grants: [grant("app_read", ["USAGE"])] },
    { creator: "postgres", schema: null, objectType: "tables", grants: [grant("iam_admin", ["SELECT"], true)] },
  ];
}

// ── 칸 상세 ──
export const source = (kind: PgSourceKind, via: string[] = [], grantor: string | null = null): PgSource => ({ kind, via, grantor });
export const privilege = (name: string, ...sources: PgSource[]): PgPrivilegeGrant => ({ privilege: name, sources });

/** alice의 app 스키마 칸: 그룹(app_write ← app_read)에서 받은 권한, 직접 받은 시퀀스 USAGE, 기본값 PUBLIC EXECUTE. */
export function sampleCellDetail(extra: Partial<PgCellDetail> = {}): PgCellDetail {
  const fromRead = source("group", ["app_write", "app_read"], "app_owner");
  const fromWrite = source("group", ["app_write"], "app_owner");
  const tableObject = (ref: PgObjectRef, rls: boolean, writable: boolean): PgCellObject => ({
    object: ref,
    owner: "app_owner",
    rls,
    privileges: [
      privilege("SELECT", fromRead),
      ...(writable ? [privilege("INSERT", fromWrite), privilege("UPDATE", fromWrite), privilege("DELETE", fromWrite)] : []),
    ],
  });
  return {
    role: "alice",
    schema: "app",
    // 이름순
    objects: [
      tableObject(customersTable, true, false),
      tableObject(orderItemsTable, false, true),
      tableObject(ordersTable, false, true),
      {
        object: ordersIdSeq,
        owner: "app_owner",
        rls: false,
        privileges: [privilege("USAGE", source("direct", [], "app_owner")), privilege("SELECT", fromWrite)],
      },
      { object: touchOrderFn, owner: "app_owner", rls: false, privileges: [privilege("EXECUTE", source("public"))] },
    ],
    truncated: false,
    ...extra,
  };
}

// ── 누가 할 수 있나 ──
/** app.orders SELECT: 소유자, 직접, 그룹(1단계·2단계), 미리 정의된 역할, 못 쓰는 역할(bob)이 모두 나온다. 역할 이름순. */
export function sampleWhoCan(extra: Partial<PgWhoCan> = {}): PgWhoCan {
  return {
    object: ordersTable,
    privilege: "SELECT",
    allowed: [
      { role: "alice", kind: "user", system: false, sources: [source("group", ["app_write", "app_read"], "app_owner")], unusable: null },
      { role: "app_owner", kind: "user", system: false, sources: [source("owner", [], "app_owner")], unusable: null },
      { role: "app_read", kind: "group", system: false, sources: [source("direct", [], "app_owner")], unusable: null },
      { role: "app_write", kind: "group", system: false, sources: [source("group", ["app_read"], "app_owner")], unusable: null },
      { role: "bob", kind: "user", system: false, sources: [source("direct", [], "app_owner")], unusable: "CONNECT 없음" },
      { role: "iam_admin", kind: "user", system: false, sources: [source("predefined", ["pg_read_all_data"])], unusable: null },
      { role: "pg_read_all_data", kind: "group", system: true, sources: [source("predefined")], unusable: null },
    ],
    ...extra,
  };
}

// ── 세션 ──
export function sampleSessions(): PgSession[] {
  const base = { applicationName: "", state: "idle", backendStart: "2026-10-28T11:42:10Z", queryStart: "2026-10-28T11:59:40Z", waitEvent: "ClientRead", own: false };
  return [
    { ...base, pid: 2874, role: "app_owner", database: "orders", clientAddr: "10.0.2.31", applicationName: "flyway" },
    {
      ...base,
      pid: 2991,
      role: "alice",
      database: "orders",
      clientAddr: "172.16.4.33",
      applicationName: "DBeaver 24.1.0 - Main <orders>",
      state: "active",
      queryStart: "2026-10-28T11:59:58Z",
      waitEvent: null,
    },
    { ...base, pid: 3040, role: "bob", database: "postgres", clientAddr: "172.16.5.12", applicationName: "psql", state: "idle in transaction" },
    // 이 앱의 연결: 기본 데이터베이스 하나와, 다른 데이터베이스의 권한 표를 볼 때 연 연결 하나
    { ...base, pid: 3101, role: "iam_admin", database: "orders", clientAddr: "172.16.4.9", applicationName: "magic-mirror", own: true },
    { ...base, pid: 3102, role: "iam_admin", database: "analytics", clientAddr: "172.16.4.9", applicationName: "magic-mirror", own: true },
  ];
}

// ── 역할 상세 ──
/** 역할별 설정(pg_db_role_setting). app_owner만 있다. database가 null이면 모든 데이터베이스에 적용된다. */
const ROLE_SETTINGS: Record<string, PgRoleView["settings"]> = {
  app_owner: [
    { database: null, setting: "search_path=app, public" },
    { database: "orders", setting: "work_mem=64MB" },
  ],
};
/** 소유 객체. app_owner가 orders의 스키마와 그 안의 객체를 모두 소유한다(위 권한 표·칸 상세와 같다). 다른 역할은 아무것도 소유하지 않는다. */
const OWNED: Record<string, PgObjectRef[]> = {
  app_owner: [object("schema", null, "app"), object("schema", null, "audit"), customersTable, orderItemsTable, ordersTable, eventsTable, ordersIdSeq, touchOrderFn],
};
/** 상속하지 않는 구성원 관계로만 닿는 역할: bob이 app_read에 닿는 길뿐이다. */
const SET_ROLE_ONLY: Record<string, string[]> = { bob: ["app_read"] };

const hasSomething = (c: PgSchemaCell) => c.usage || c.create || c.read !== "none" || c.write !== "none";

/**
 * 역할 하나의 상세(pg_role). 데이터베이스는 연결할 수 있는 것마다 하나씩 있고, 권한 표 픽스처의 orders만 읽혀 있다.
 * 읽힌 데이터베이스의 칸은 이 역할에게 권한이 하나라도 있는 것만 담는다(백엔드와 같다).
 */
export function sampleRoleView(name = "alice", extra: Partial<PgRoleView> = {}): PgRoleView {
  const summary = ROLES.find((r) => r.name === name);
  if (!summary) throw new Error(`unknown role: ${name}`);
  const read = sampleDatabaseView();
  return {
    summary: { ...summary },
    settings: (ROLE_SETTINGS[name] ?? []).map((setting) => ({ ...setting })),
    members: ROLES.flatMap((r) => r.memberOf.filter((m) => m.group === name).map((m) => ({ role: r.name, inherit: m.inherit, set: m.set, admin: m.admin }))),
    databases: sampleOverview()
      .databases.filter((d) => d.allowConn)
      .map(
        (d): PgRoleDatabase =>
          d.name === read.database
            ? { database: d.name, loaded: true, cells: read.cells.filter((c) => c.role === name && hasSomething(c)), owned: [...(OWNED[name] ?? [])], ownedOmitted: 0 }
            : { database: d.name, loaded: false, cells: [], owned: [], ownedOmitted: 0 },
      ),
    sessions: sampleSessions().filter((s) => s.role === name),
    setRoleOnly: [...(SET_ROLE_ONLY[name] ?? [])],
    ...extra,
  };
}

// ── 점검 ──
const finding = (extra: Partial<PgFinding> & Pick<PgFinding, "detail">): PgFinding => ({ database: null, role: null, object: null, ...extra });

/** 심각도 높은 순. 항목이 있는 그룹만 들어 있다(백엔드와 같다). */
export function sampleFindings(extra: Partial<PgFindings> = {}): PgFindings {
  const groups: PgFindingGroup[] = [
    {
      kind: "rdsSuperuser",
      title: "rds_superuser 멤버",
      level: "high",
      items: [
        finding({ role: "iam_admin", detail: "iam_admin은 rds_superuser 멤버라 대부분의 관리 작업을 할 수 있어요" }),
        finding({ role: "postgres", detail: "postgres는 rds_superuser 멤버라 대부분의 관리 작업을 할 수 있어요" }),
      ],
    },
    {
      kind: "securityDefinerPath",
      title: "search_path를 고정하지 않은 SECURITY DEFINER 함수",
      level: "high",
      items: [
        finding({
          database: "orders",
          object: touchOrderFn,
          detail: "app.touch_order는 SECURITY DEFINER인데 search_path를 고정하지 않았어요",
        }),
      ],
    },
    {
      kind: "createRole",
      title: "CREATEROLE을 가진 역할",
      level: "medium",
      items: [finding({ role: "postgres", detail: "postgres는 CREATEROLE이 있어서 역할을 만들고 바꿀 수 있어요" })],
    },
    {
      kind: "expiringLogin",
      title: "만료됐거나 곧 만료되는 사용자",
      level: "low",
      items: [finding({ role: "bob", detail: "bob은 2026-11-05에 만료돼요" })],
    },
  ];
  return {
    groups,
    skipped: [{ database: "analytics", reason: 'analytics에 연결하지 못했어요: permission denied for database "analytics"' }],
    fetchedAt: "2026-10-28T12:01:00Z",
    ...extra,
  };
}
