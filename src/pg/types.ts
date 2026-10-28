// RDS PostgreSQL 사용자 관리 계약(docs/superpowers/specs/2026-10-28-rds-postgres-users-design.md "계약")과 1:1로 맞춘 타입.
// Tauri 명령/JSON 모양은 백엔드와 같이 고정이다. 필드를 바꾸지 말고, 추가는 선택 필드로만 한다.

export type PgTargetKind = "cluster" | "instance";
export interface PgTarget { profile: string; region: string; kind: PgTargetKind; id: string }

export interface PgTargetInfo {
  arn: string; identifier: string; kind: PgTargetKind;
  engine: string; engineVersion: string;
  endpoint: string; port: number; defaultDatabase: string;
  iamAuth: boolean; readReplica: boolean;
}

export type PgRoleKind = "user" | "group";
export type PgBadgeKind = "admin" | "iamAuth" | "createRole" | "createDb" | "bypassRls" | "replication" | "expired" | "expiringSoon" | "loginRole";
export interface PgBadge { kind: PgBadgeKind; label: string; level: "high" | "medium" | "info" }
export interface PgAttributes {
  login: boolean; createDb: boolean; createRole: boolean; inherit: boolean;
  replication: boolean; bypassRls: boolean;
  connectionLimit: number;       // -1 = 제한 없음
  validUntil: string | null;     // ISO 8601 UTC, null = 없음
}
export interface PgMembership { group: string; inherit: boolean; admin: boolean }
export interface PgRoleSummary {
  name: string; kind: PgRoleKind; system: boolean; attributes: PgAttributes;
  memberOf: PgMembership[]; memberCount: number; sessionCount: number;
  badges: PgBadge[]; comment: string | null;
}
export interface PgDatabaseInfo { name: string; owner: string; allowConn: boolean }
export interface PgOverview {
  target: PgTargetInfo; loginUser: string;
  serverVersion: string; serverVersionNum: number; passwordEncryption: string;
  fetchedAt: string; roles: PgRoleSummary[]; databases: PgDatabaseInfo[];
  canManage: boolean; manageReason: string | null;
}

export type PgCoverage = "all" | "some" | "none";
export type PgSourceKind = "owner" | "direct" | "group" | "public" | "predefined" | "superuser";
export interface PgSource { kind: PgSourceKind; via: string[]; grantor: string | null }  // via: 역할에서 권한을 받은 역할까지의 경로(자기 자신 제외)
export interface PgSchemaCell {
  role: string; schema: string;
  usage: boolean; create: boolean; read: PgCoverage; write: PgCoverage;
  inheritedOnly: boolean;          // 보이는 권한의 출처가 group/public/predefined뿐
  unusable: string | null;         // "CONNECT 없음" | "USAGE 없음" | null. 이 칸에 잃을 것(usage·create·read·write 가운데 하나)이 있을 때만 채운다
}
export interface PgDbPrivilegeRow { role: string; connect: boolean; create: boolean; temp: boolean }
export interface PgSchemaInfo { name: string; owner: string; tableCount: number }
export type PgDefaultObjectType = "tables" | "sequences" | "functions" | "types" | "schemas";
export interface PgDefaultAclRow {
  creator: string; schema: string | null; objectType: PgDefaultObjectType;
  grants: { grantee: string; privileges: string[]; grantable: boolean }[];   // grantee "PUBLIC" = 모든 역할
}
export interface PgDatabaseView {
  database: string; fetchedAt: string; truncated: boolean;
  dbPrivileges: PgDbPrivilegeRow[]; schemas: PgSchemaInfo[];
  cells: PgSchemaCell[];           // 시스템 역할을 포함한 모든 역할 × 모든 스키마
  defaultPrivileges: PgDefaultAclRow[];
}
export type PgObjectKind = "database" | "schema" | "table" | "view" | "matview" | "partitioned" | "foreign" | "sequence" | "function";
export interface PgObjectRef { kind: PgObjectKind; schema: string | null; name: string; signature: string | null }
export interface PgPrivilegeGrant { privilege: string; sources: PgSource[] }
export interface PgCellObject { object: PgObjectRef; owner: string; rls: boolean; privileges: PgPrivilegeGrant[] }  // 가진 권한만
export interface PgCellDetail { role: string; schema: string; objects: PgCellObject[]; truncated: boolean }
export interface PgWhoCanRow { role: string; kind: PgRoleKind; system: boolean; sources: PgSource[]; unusable: string | null }
export interface PgWhoCan { object: PgObjectRef; privilege: string; allowed: PgWhoCanRow[] }
export interface PgSession {
  pid: number; role: string | null; database: string | null; clientAddr: string | null;
  applicationName: string; state: string | null; backendStart: string | null; queryStart: string | null;
  waitEvent: string | null; own: boolean;
}
export interface PgRoleDatabase { database: string; loaded: boolean; cells: PgSchemaCell[]; owned: PgObjectRef[]; ownedOmitted: number }
export interface PgRoleView {
  summary: PgRoleSummary;
  settings: { database: string | null; setting: string }[];
  members: { role: string; inherit: boolean; admin: boolean }[];
  databases: PgRoleDatabase[];     // 모든 연결 가능한 데이터베이스. 아직 안 읽은 곳은 loaded=false, 나머지 비움
  sessions: PgSession[];
  setRoleOnly: string[];           // 상속하지 않는 구성원 관계로만 닿는 역할
}
export type PgFindingKind = "publicSchemaCreate" | "publicObjectGrant" | "rdsSuperuser" | "createRole" | "bypassRls" | "expiringLogin" | "emptyLogin" | "defaultPrivilegeGap" | "securityDefinerPath" | "md5Encryption";
export interface PgFinding { database: string | null; role: string | null; object: PgObjectRef | null; detail: string }
export interface PgFindingGroup { kind: PgFindingKind; title: string; level: "high" | "medium" | "low"; items: PgFinding[] }
export interface PgFindings { groups: PgFindingGroup[]; skipped: { database: string; reason: string }[]; fetchedAt: string }
