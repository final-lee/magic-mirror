// RDS PostgreSQL 사용자 관리 계약(docs/superpowers/specs/2026-10-28-rds-postgres-users-design.md "계약")과 1:1로 맞춘 타입.
// Tauri 명령/JSON 모양은 백엔드(src-tauri/src/pg/view.rs)와 같이 고정이다. 필드를 바꾸지 말고, 더할 때는 백엔드와 같은 변경에서 함께 더한다(view.rs의 시험이 JSON 모양을 지킨다).

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
export interface PgMembership { group: string; inherit: boolean; set: boolean; admin: boolean }  // set: 이 관계로 SET ROLE을 할 수 있다(PG16 전에는 늘 true)
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
/** 칸의 사용·만들기·읽기·쓰기를 출처 한 가지로만 계산한 값(PgSchemaCell.direct, owned) */
export interface PgSchemaAspects { usage: boolean; create: boolean; read: PgCoverage; write: PgCoverage }
export interface PgSchemaCell {
  role: string; schema: string;
  usage: boolean; create: boolean; read: PgCoverage; write: PgCoverage;
  inheritedOnly: boolean;          // 보이는 권한의 출처가 group/public/predefined뿐
  unusable: string | null;         // "CONNECT 없음" | "USAGE 없음" | null. 이 칸에 잃을 것(usage·create·read·write 가운데 하나)이 있을 때만 채운다
  direct: PgSchemaAspects;         // 위 네 값을 Direct 출처만으로 계산한 것. 편집 표가 켜고 끄는 값이다. 소유자 출처는 빠져서 소유자 자신의 칸은 켜고 끌 수 없다
  owned: PgSchemaAspects;          // 위 네 값을 Owner 출처만으로 계산한 것
}
/** 데이터베이스 권한 행의 CONNECT·CREATE·TEMP를 출처 한 가지로만 계산한 값(PgDbPrivilegeRow.direct, owned) */
export interface PgDbAspects { connect: boolean; create: boolean; temp: boolean }
export interface PgDbPrivilegeRow {
  role: string; connect: boolean; create: boolean; temp: boolean;
  direct: PgDbAspects;             // Direct 출처만으로 계산한 값(PgSchemaCell.direct와 같은 규칙)
  owned: PgDbAspects;              // Owner 출처만으로 계산한 값
}
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
export interface PgRoleDatabase { database: string; loaded: boolean; truncated: boolean; cells: PgSchemaCell[]; owned: PgObjectRef[]; ownedOmitted: number }  // truncated: 읽은 스냅숏이 객체가 많아 일부만 읽은 것
export interface PgRoleView {
  summary: PgRoleSummary;
  settings: { database: string | null; setting: string; allRoles: boolean }[];   // allRoles: 이 역할만이 아니라 모든 역할에 걸린 설정
  members: { role: string; inherit: boolean; set: boolean; admin: boolean }[];
  databases: PgRoleDatabase[];     // 모든 연결 가능한 데이터베이스. 아직 안 읽은 곳은 loaded=false, 나머지 비움
  sessions: PgSession[];
  setRoleOnly: string[];           // 상속하지 않는 구성원 관계로만 닿는 역할
}
export type PgFindingKind = "publicSchemaCreate" | "publicObjectGrant" | "rdsSuperuser" | "createRole" | "bypassRls" | "expiringLogin" | "emptyLogin" | "defaultPrivilegeGap" | "securityDefinerPath" | "md5Encryption";
export interface PgFinding { database: string | null; role: string | null; object: PgObjectRef | null; detail: string }
export interface PgFindingGroup { kind: PgFindingKind; title: string; level: "high" | "medium" | "low"; items: PgFinding[] }
export interface PgFindings { groups: PgFindingGroup[]; skipped: { database: string; reason: string }[]; truncated: string[]; fetchedAt: string }  // truncated: 객체가 많아 일부만 읽고 점검한 데이터베이스(이름순)

// ───────────────────────── 2단계: 변경 ─────────────────────────
// 계약(.superpowers/sdd/p8/global-constraints.md "Contract (phase-2 additions)")과 1:1이다. 백엔드(src-tauri/src/pg/change/)와 같이 고정이다.

export type PgGrantTarget =
  | { kind: "database"; name: string }
  | { kind: "schema"; name: string }
  | { kind: "relation"; schema: string; name: string }          // 테이블, 뷰, 구체화 뷰, 파티션 테이블, 외부 테이블
  | { kind: "sequence"; schema: string; name: string }
  | { kind: "function"; schema: string; name: string; signature: string }
  | { kind: "allTables"; schema: string }
  | { kind: "allSequences"; schema: string };
export interface PgGrantItem { target: PgGrantTarget; privileges: string[] }   // aclexplode 이름, 예: "SELECT", "TEMPORARY"
export type PgPresetKind = "readOnly" | "readWrite" | "owner" | "admin";
export interface PgPresetChoice {
  preset: PgPresetKind;
  database: string | null;     // 관리자만 null
  schemas: string[];           // 관리자만 비어 있다
  creators: string[];          // 읽기 전용·읽기·쓰기: 새로 만드는 테이블과 시퀀스에 기본 권한을 줄 역할
  group: string | null;        // 권한을 받는 그룹. null이면 새 역할 자신이거나 관리자
  createGroup: boolean;        // true면 같은 트랜잭션에서 group을 만든다
}
export interface PgAttributesSet {
  login: boolean; createDb: boolean; createRole: boolean; inherit: boolean;
  connectionLimit: number;     // -1 = 제한 없음
  validUntil: string | null;   // ISO 8601 UTC, null = 없음
}
export type PgChange =
  | { kind: "createRole"; name: string; login: boolean; groups: string[]; connectionLimit: number; validUntil: string | null; preset: PgPresetChoice | null }
  | { kind: "membership"; group: string; member: string; add: boolean; admin: boolean }
  | { kind: "attributes"; role: string; set: PgAttributesSet }     // 바라는 값 전체
  | { kind: "password"; role: string }
  | { kind: "grant"; database: string; grantee: string; add: boolean; items: PgGrantItem[] }   // grantee "PUBLIC" = 모든 역할
  | { kind: "defaultPrivilege"; database: string; creator: string; schema: string | null; objectType: PgDefaultObjectType; grantee: string; privileges: string[]; add: boolean }
  | { kind: "dropRole"; role: string }                               // 역할 만들기를 되돌릴 때만
  | { kind: "terminate"; pid: number; role: string; backendStart: string | null };   // 확인용: pid와 역할, 알면 시작 시각(초)까지

export type PgWarnLevel = "block" | "confirm" | "warn";
export interface PgWarning { level: PgWarnLevel; message: string; add: PgChange[] }   // add: [기본 권한도 담기]가 장바구니에 담는 변경. 대개 비어 있다
export interface PgPrivDelta { database: string; schema: string | null; objectKind: PgObjectKind; privilege: string; count: number; sample: string[] }
export interface PgImpact { role: string; gained: PgPrivDelta[]; lost: PgPrivDelta[] }
export interface PgDefaultDelta { before: PgDefaultAclRow | null; after: PgDefaultAclRow | null }   // 기본 권한 기록 하나의 전과 후
export interface PgRoleDelta {
  role: string; created: boolean; dropped: boolean;
  attributes: { name: string; before: string; after: string }[];
  groupsAdded: string[]; groupsRemoved: string[];
}
export interface PgPreview {
  change: PgChange; database: string; summary: string; loginUser: string;   // loginUser: 이 변경을 실행할 DB 사용자
  sql: string[];               // 실행 순서. 비밀번호는 가려져 있다
  impacts: PgImpact[]; impactsOmitted: number; roles: PgRoleDelta[]; defaults: PgDefaultDelta[];
  warnings: PgWarning[];       // 막힘, 확인, 주의 순서
  confirmText: string | null; reversible: boolean;
}
export interface PgBatchItem { change: PgChange; summary: string; sql: string[]; warnings: PgWarning[] }
export interface PgBatchPreview {
  database: string; loginUser: string; items: PgBatchItem[]; sql: string[];
  impacts: PgImpact[]; impactsOmitted: number; roles: PgRoleDelta[]; defaults: PgDefaultDelta[];
  warnings: PgWarning[]; confirmText: string | null; reversible: boolean;
}
export interface PgApplyResult { logId: string; summary: string; password?: string; notes?: string[] }
export interface PgBatchResult { batchId: string; logIds: string[]; summary: string; notes?: string[] }
export interface PgChangeLogEntry {
  id: string; at: string; profile: string; targetArn: string; database: string; loginUser: string;
  change: PgChange; summary: string; sql: string[]; ok: boolean; error: string | null;
  inverse: PgChange[] | null;  // null = 되돌릴 수 없어요
  undoOf: string | null; undone: boolean; batchId?: string;   // batchId는 없을 때 빠진다(IAM과 같다)
}
export interface PgUndo { database: string; changes: PgChange[]; undoOf: string[] }
export interface PgPresetSuggestion { matching: string[]; proposedName: string; creators: string[]; blockedCreators: { role: string; reason: string }[] }   // blockedCreators: 로그인한 역할이 기본 권한을 바꿀 수 없는 만드는 역할과 그 막힘 문구
export interface PgDropStep { database: string | null; sql: string[]; owned: number; privileges: number; defaults: number }  // database null = 기본 데이터베이스
export interface PgDropPlan {
  role: string; reassignTo: string; steps: PgDropStep[]; warnings: PgWarning[]; confirmText: string; sessions: number;
  grantedMemberships: { member: string; group: string; lost: boolean }[];   // 160000부터: 이 역할이 준 구성원 관계(DROP OWNED가 지운다). lost = 다른 부여가 없다
}
export interface PgDropResult { logId: string; total: number; done: number; stopped: string | null; notes?: string[] }   // stopped = 삭제 결과 문구
