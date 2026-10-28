# RDS PostgreSQL 사용자 관리 1단계(읽기) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Double-clicking an RDS PostgreSQL cluster or instance opens a "🐘 <식별자>" tab. It connects over VPN with IAM database authentication and TLS, then shows roles, effective privileges per database, default privileges, who-can, sessions and security checks. Nothing is written to the database.

**Architecture:**
- **Backend:** a new `src-tauri/src/pg/` module with:
  - target resolution through the RDS API;
  - an IAM token plus a TLS connection (`tokio-postgres` + rustls + a bundled RDS CA);
  - a connection pool per tab and database;
  - read-only catalog queries that build a snapshot;
  - pure functions for effective privileges, who-can and checks;
  - view builders and Tauri commands.
- **Frontend:** a new `src/pg/` tab that reuses the IAM workspace's layout, list and grid pieces.

**Tech Stack:** Tauri 2, Rust (tokio, tokio-postgres, rustls, aws-sdk-rds), React 18 + TS, TanStack Query, Vitest; Docker postgres 14 and 16 for the live tests.

## Global Constraints
- Spec: `docs/superpowers/specs/2026-10-28-rds-postgres-users-design.md`. Branch: `feat/pg-users`.
- **No writes:** phase 1 writes nothing to any database. Every query runs inside a read-only transaction (`build_transaction().read_only(true)`). The only code allowed to open transactions or run queries under `src-tauri/src/pg/` is `pg/catalog.rs`. A hygiene test enforces this (Task PB4).
- **Secrets:** IAM tokens are never logged, never stored, and never put in errors or command results.
- **TLS:** it is always on. It is verified against the bundled RDS global CA, with the hostname checked. There is no insecure verifier, no `NoTls` outside `#[cfg(test)]`, and no "accept invalid certs".
- **UI copy:** Korean 해요체. Code identifiers and commit messages are in English.
- **Exact strings:**
  - Not a PostgreSQL target: "PostgreSQL 엔진만 열 수 있어요"
  - IAM auth off: "이 클러스터는 IAM 데이터베이스 인증이 꺼져 있어요. RDS 콘솔에서 수정해 켠 뒤 다시 열어 주세요" (for an instance target: "이 인스턴스는 IAM 데이터베이스 인증이 꺼져 있어요. RDS 콘솔에서 수정해 켠 뒤 다시 열어 주세요")
  - Network: `엔드포인트에 연결하지 못했어요(${host}:${port}). VPN이 켜져 있는지 확인하세요`
  - IAM auth failed: `IAM 인증에 실패했어요. 프로필에 rds-db:connect 권한이 있는지, DB 사용자 ${user}에게 rds_iam이 있는지 확인하세요`
  - Role missing: `DB 사용자 ${user}가 없어요`
  - TLS: "서버 인증서를 확인하지 못했어요"
  - Database connect: `${database}에 연결하지 못했어요: ${reason}`
  - Not opened yet: "먼저 연결해 주세요"
  - Read timeout (SQLSTATE 57014): "질의가 30초 안에 끝나지 않았어요. 잠시 뒤 다시 읽어 주세요"
  - Connection closed during a read (network kind): "데이터베이스 연결이 끊겼어요. 다시 읽으면 새로 연결해요"
  - Sessions footnote, shown when another user's session has its details hidden: "빈 칸은 이 DB 사용자에게 보이지 않는 정보예요. 다른 사용자의 세션을 자세히 보려면 pg_read_all_stats 권한이 필요해요"
  - Truncated: "객체가 많아 일부만 읽었어요"
  - Unusable cell: "권한은 있지만 실제로는 못 써요", with reasons "CONNECT 없음" and "USAGE 없음"
  - RLS: "행 수준 보안 켜짐"
  - SET ROLE only: "SET ROLE로만 쓸 수 있음"
  - Findings footnote: "역할별 비밀번호 해시 방식과 마지막 로그인은 RDS에서 볼 수 없어 점검하지 않아요"
  - Manage reason: "이 사용자는 rds_superuser 멤버가 아니고 CREATEROLE도 없어서 바꿀 수 없어요"
  - Login prompt: title "DB 사용자", intro "IAM 인증으로 접속할 DB 사용자 이름을 입력하세요(예: iam_admin). 이 대상에 대해 기억해 둘게요", button "연결"
  - Nav: "점검", "역할", "권한", "기본 권한", "누가 할 수 있나", "세션"
  - Role chips: "사용자", "그룹", and the toggle "시스템 역할 보기"
  - Badges: "관리자급", "IAM 인증", "CREATEROLE", "CREATEDB", "BYPASSRLS", "REPLICATION", "만료됨", "곧 만료", "앱이 로그인한 역할"
  - Default-privilege sentence: `${creator} 역할이 ${schemaLabel}에 새 ${objectLabel}을(를) 만들면 ${grantee} 역할이 ${privileges} 권한을 받아요`. `schemaLabel` is the schema name or "모든 스키마". `objectLabel` is "테이블", "시퀀스", "함수", "타입" or "스키마". Render the 을/를 particle with the same Hangul final-consonant rule as `objectParticle` in `src/iam/previewParts.tsx`. `PUBLIC` reads as "모든 역할(PUBLIC)", and for it the sentence ends `모든 역할(PUBLIC)이 ${privileges} 권한을 받아요` (no second "역할").
  - Default-privilege row with no grants: `${creator} 역할이 ${schemaLabel}에 새 ${objectLabel}을(를) 만들어도 아무 역할도 권한을 받지 않아요`
  - Built-in defaults note: "PostgreSQL 기본값: 함수는 모든 역할(PUBLIC)이 EXECUTE, 타입은 USAGE를 받아요. 기본 권한을 바꾸지 않았다면 그대로예요"
- **Limits:**
  - Connect timeout: 10 s.
  - Reads: `SET LOCAL statement_timeout = '30s'`.
  - Idle connections close after 10 minutes, swept every 60 s.
  - At most 20 000 objects per database, counting relations and functions together.
  - At most 100 search results, and at most 2 000 objects in one cell detail.
- **Snapshot exclusions:** system schemas (`pg_catalog`, `information_schema`, `pg_toast`, `pg_temp_%`, `pg_toast_temp_%`), template databases, `rdsadmin`, and partition children (`relispartition`).
- **System roles:** names starting with `pg_` or `rds_`, plus `rdsadmin`, `rdstopmgr` and `rdsrepladmin`.
- **Verification:**
  - Rust: `cargo test` plus the literal `cargo clippy --all-targets -- -D warnings`, clean, with no `allow` added.
  - Frontend: `npx vitest run`, `npx tsc --noEmit` and `npm run build`.
  - Live tests: `scripts/pg-live-test.sh` (Docker).
- **Commits:** each one ends with exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage by explicit path.
  - Backend tasks touch `src-tauri/` and `scripts/pg-live-test.sh`.
  - Frontend tasks touch `src/`, plus `docs/manual-test-checklist.md` and `README.md` in PF4.

## Contract (shared by both tracks)
Rust structs serialize with `#[serde(rename_all = "camelCase")]`. Tauri maps camelCase JS argument names to snake_case Rust parameters. Every command takes `target` as one object.

```ts
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
  unusable: string | null;         // "CONNECT 없음" | "USAGE 없음" | null. 이 칸에 잃을 것(usage·create·read·write 가운데 하나)이 있을 때만 채운다. 만들기(create)만 보이는 칸에는 "USAGE 없음"을 쓰지 않는다(CREATE는 USAGE 없이도 된다)
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
```

Commands:
| command | args | returns |
|---|---|---|
| `pg_target` | `target` | `PgTargetInfo`. RDS API only, no DB connection. |
| `pg_open` | `target, loginUser` | `PgOverview`. Remembers `loginUser` for the target, connects to `defaultDatabase`, and reads the cluster snapshot fresh. |
| `pg_database` | `target, database, force` | `PgDatabaseView`. The snapshot is cached per (target, database) and reread when `force`. |
| `pg_cell` | `target, database, role, schema` | `PgCellDetail` |
| `pg_objects` | `target, database, query` | `PgObjectRef[]`: case-insensitive substring match on `schema.name`, at most 100. |
| `pg_role` | `target, role` | `PgRoleView`. It reads no new databases. |
| `pg_who_can` | `target, database, object, privilege` | `PgWhoCan` |
| `pg_sessions` | `target` | `PgSession[]`, read fresh. |
| `pg_findings` | `target, force` | `PgFindings`. Reads every connectable database, using the cache unless `force`. |
| `pg_close` | `target` | `null`. Closes the target's connections and drops its caches and remembered login. |

Every command except `pg_target` and `pg_open` fails with "먼저 연결해 주세요" when `pg_open` hasn't succeeded for that target.

Settings: `Settings.pgLogins: Record<string, string>` maps a target ARN to its DB login user name. Rust `pg_logins: BTreeMap<String, String>` with `#[serde(default)]`.

## Execution order
- The backend track (PB1 → PB2 → PB3 → PB4) and the frontend track (PF1 → PF2 → PF3 → PF4) run in parallel. The frontend mocks the contract.
- After both tracks finish, K1 is a phase-1 checkpoint review. Phase 2 then gets its own plan.

---

### Task PB1: Connection layer

**Files:**
- Modify: `src-tauri/Cargo.toml` (add deps), `src-tauri/src/lib.rs` (`mod pg;`), `src-tauri/src/adapters/rds.rs` (add the `cluster` value to instance rows).
- Create:
  - `src-tauri/certs/rds-global-bundle.pem`, downloaded from `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem` and committed. It contains only public certificates.
  - `src-tauri/src/pg.rs`, the module root with docs listing the submodules.
  - `src-tauri/src/pg/target.rs`, `src-tauri/src/pg/connect.rs`, `src-tauri/src/pg/pool.rs`, each with its tests in the file or in `pg/<name>/tests.rs`, following the repo's existing style.

**Interfaces:**
- Produces:
  - `pg::target::{PgTarget, TargetKind, PgTargetInfo, info_of_cluster(&DbCluster) -> Result<PgTargetInfo, AppError>, info_of_instance(&DbInstance) -> Result<PgTargetInfo, AppError>, resolve(cfg: &SdkConfig, target: &PgTarget) -> Result<PgTargetInfo, AppError>}`
  - `pg::connect::{ConnFailure, describe_failure(&ConnFailure, &ConnCtx) -> AppError, ConnCtx { host, port, user, database, kind }, rds_roots() -> rustls::RootCertStore, auth_token(cfg: &SdkConfig, host, port, user) -> Result<String, AppError>, connect(cfg: &SdkConfig, info: &PgTargetInfo, user: &str, database: &str) -> Result<Connected, AppError>}`
  - `Connected { client: tokio_postgres::Client, backend_pid: i32 }`. The connection future is spawned inside `connect`.
  - `pg::pool::{Pool, ConnKey { target: PgTarget, user: String, database: String }}`, with:
    - `Pool::get_or_connect(&self, key, f) -> Result<Arc<tokio::sync::Mutex<Connected>>, AppError>`
    - `Pool::close_target(&self, &PgTarget)`
    - `Pool::sweep(&self, now: Instant)`
    - `Pool::backend_pids(&self, &PgTarget) -> Vec<i32>`
    - `IDLE: Duration = 600 s`

- [ ] **Step 1: Dependencies and the CA bundle.**
  - Add to `src-tauri/Cargo.toml`: `tokio-postgres = "0.7"`, `tokio-postgres-rustls` (the version compatible with tokio-postgres 0.7 and rustls 0.23), `rustls = { version = "0.23", default-features = false, features = ["std", "tls12", "ring"] }` (use `aws_lc_rs` instead if the tree already builds it; avoid two providers), and `rustls-pemfile = "2"`.
  - Run `cargo tree -d | grep rustls` and keep a single rustls 0.23 in the tree.
  - Download the bundle: `curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o src-tauri/certs/rds-global-bundle.pem`.
- [ ] **Step 2: Failing tests.**
  1. `info_of_cluster_reads_the_writer_endpoint`: a `DbCluster` built with `aurora-postgresql`, endpoint, port 5432, `database_name("app")` and `iam_database_authentication_enabled(true)` gives `PgTargetInfo { kind: Cluster, defaultDatabase: "app", iamAuth: true, readReplica: false }`. With no database name the default is `"postgres"`. A `replication_source_identifier` makes `readReplica: true`.
  2. `info_of_instance_reads_its_endpoint`: the same for `DbInstance` (`engine("postgres")`, `endpoint(Endpoint{address, port})`, `db_name`, `read_replica_source_db_instance_identifier`).
  3. `non_postgres_targets_are_refused`: `aurora-mysql` and `mysql` give `Err` with "PostgreSQL 엔진만 열 수 있어요".
  4. `the_rds_bundle_loads`: `rds_roots().len() > 10`.
  5. `failures_read_as_the_spec_says`: one assertion per `ConnFailure` variant, with exact strings:
     - `Timeout` and `Io(..)` → `AppError::Network { message }` whose message is the network text with `host:port`.
     - `Auth` → the IAM failure text with the user.
     - `NoRole` → `DB 사용자 ${user}가 없어요`.
     - `Tls(..)` → "서버 인증서를 확인하지 못했어요".
     - `Db { message }` → `${database}에 연결하지 못했어요: ${message}`.
  6. `iam_off_is_reported_without_connecting`: `connect_check(&info)` (a pure precheck) returns the cluster text for a cluster and the instance text for an instance when `iamAuth` is false.
  7. `auth_token_is_a_signed_connect_url`: with a static-credentials `SdkConfig` (`aws_credential_types::Credentials::new("AKID", "SECRET", None, None, "test")`, region `ap-northeast-2`), `auth_token(cfg, "db.example", 5432, "iam_admin")` returns a string that starts with `db.example:5432/?` and contains `Action=connect`, `DBUser=iam_admin` and `X-Amz-Signature=`. Signing is local; no network call is made.
  8. Pool tests with fake connections (`get_or_connect` takes the connect future as a closure):
     - a second `get_or_connect` for the same key reuses the entry and does not call the closure;
     - different databases make separate entries;
     - `sweep(now + IDLE + 1s)` drops idle entries but not ones used within `IDLE`;
     - `close_target` drops every entry of that target;
     - `backend_pids` lists the pids of that target.
- [ ] **Step 3: Implement.**
  - `target.rs`:
    - Engine check: `aurora-postgresql` or `postgres`.
    - `resolve` calls `describe_db_clusters().db_cluster_identifier(id)` or `describe_db_instances().db_instance_identifier(id)`, mapping SDK errors with `from_sdk(e, "rds:DescribeDBClusters")` or `from_sdk(e, "rds:DescribeDBInstances")`, then the `info_of_*` mapper.
    - A missing endpoint is `AppError::other("엔드포인트가 아직 없어요")`.
  - `connect.rs`:

```rust
pub enum ConnFailure { Timeout, Io(String), Tls(String), Auth, NoRole, Db { code: String, message: String } }

pub struct ConnCtx<'a> { pub host: &'a str, pub port: u16, pub user: &'a str, pub database: &'a str }

pub fn describe_failure(f: &ConnFailure, c: &ConnCtx) -> AppError {
    match f {
        ConnFailure::Timeout | ConnFailure::Io(_) => AppError::Network { message: format!("엔드포인트에 연결하지 못했어요({}:{}). VPN이 켜져 있는지 확인하세요", c.host, c.port) },
        ConnFailure::Tls(_) => AppError::other("서버 인증서를 확인하지 못했어요"),
        ConnFailure::Auth => AppError::other(format!("IAM 인증에 실패했어요. 프로필에 rds-db:connect 권한이 있는지, DB 사용자 {}에게 rds_iam이 있는지 확인하세요", c.user)),
        ConnFailure::NoRole => AppError::other(format!("DB 사용자 {}가 없어요", c.user)),
        ConnFailure::Db { message, .. } => AppError::other(format!("{}에 연결하지 못했어요: {}", c.database, message)),
    }
}
```

  - `failure_of(e: &tokio_postgres::Error) -> ConnFailure`, in this order:
    - SQLSTATE `28000` or `28P01` → `NoRole` when the message contains "does not exist", otherwise `Auth`;
    - any other DB error → `Db`;
    - a `rustls::Error` in the source chain → `Tls`;
    - a `std::io::Error` in the chain → `Io`;
    - otherwise `Io(e.to_string())`.
  - `connect`:
    - Run `connect_check`, generate the token, and build a `tokio_postgres::Config`: host, port, user, password = token, dbname, `ssl_mode(SslMode::Require)`, `connect_timeout(10 s)`, `application_name("magic-mirror")`, keepalives.
    - Use `tokio_postgres_rustls::MakeRustlsConnect` with `rustls::ClientConfig::builder().with_root_certificates(rds_roots()).with_no_client_auth()`. rustls verifies the hostname.
    - Wrap the whole connect in `tokio::time::timeout(10 s)`; elapsed → `Timeout`.
    - Spawn the connection future. Then `SELECT pg_backend_pid()` through `catalog::read` once PB2 exists. Until then use a temporary `client.query_one` inside `connect.rs`, and move it into `catalog.rs` in PB2 so the hygiene rule holds.
    - Never format the token into anything.
  - `auth_token`: `aws_sdk_rds::auth_token::{AuthTokenGenerator, Config}`. Check its builder methods on docs.rs for the crate version in Cargo.lock.
    - When credentials cannot be resolved, map the error with the same credential classifier `AwsContext` already uses in `src-tauri/src/aws/context.rs`. An expired SSO session must become `AppError::SsoExpired`, so the app's automatic login flow takes over. Add a test for this.
  - `pool.rs`:
    - `Mutex<HashMap<ConnKey, Entry { conn: Arc<tokio::sync::Mutex<Connected>>, last_used: Instant, pid: i32 }>>`.
    - `get_or_connect` drops closed clients (`client.is_closed()`) and reconnects.
    - A sweeper task is spawned once by the owner (PB4) and calls `sweep(Instant::now())` every 60 s.
  - In `adapters/rds.rs` `db_instance`, add `.value("cluster", s(d.db_cluster_identifier()))` and assert it in `db_instance_resource`.
- [ ] **Step 4: Verify.** Run `cd src-tauri && cargo test pg::`, `cargo test adapters::rds`, the full `cargo test`, and the literal clippy command. Dead-code warnings for items that PB4 consumes must not fail clippy. If they do, gate the unused re-exports with `#[cfg(test)]` the way B1 of the IAM matrix did, and note it in the report.
- [ ] **Step 5: Commit** with `feat(pg): resolve RDS PostgreSQL targets and connect with IAM auth over verified TLS`.

---

### Task PB2: Catalog snapshot (read-only queries) and the live-test harness

**Files:**
- Create: `src-tauri/src/pg/model.rs`, `src-tauri/src/pg/catalog.rs`, `src-tauri/src/pg/catalog/tests.rs`, `src-tauri/src/pg/live_tests.rs` (`#[cfg(test)]`, every test `#[ignore]`), `scripts/pg-live-test.sh`.
- Modify: `src-tauri/src/pg.rs`, `src-tauri/src/pg/connect.rs` (move the pid query into `catalog::read`).

**Interfaces:**
- Consumes `Connected` from PB1.
- Produces:
  - `pg::model` types, all `Clone, Debug, PartialEq`:

```rust
pub enum Privilege { Select, Insert, Update, Delete, Truncate, References, Trigger, Maintain, Execute, Usage, Create, Connect, Temporary }
// from_pg("SELECT") etc. and as_str() -> "SELECT"
pub struct AclEntry { pub grantor: String, pub grantee: Option<String>, pub privilege: Privilege, pub grantable: bool } // grantee None = PUBLIC
pub struct RoleRec { pub name: String, pub login: bool, pub inherit: bool, pub create_role: bool, pub create_db: bool, pub replication: bool, pub bypass_rls: bool, pub superuser: bool, pub conn_limit: i32, pub valid_until: Option<String>, pub comment: Option<String> }
pub struct MemberRec { pub member: String, pub group: String, pub admin: bool, pub inherit: Option<bool>, pub set: Option<bool> } // inherit/set: PG16+ per-grant options (OR across grantors), None before
pub struct DatabaseRec { pub name: String, pub owner: String, pub allow_conn: bool, pub acl: Vec<AclEntry> }
pub struct RoleSettingRec { pub role: Option<String>, pub database: Option<String>, pub setting: String }
pub struct SessionRec { pub pid: i32, pub role: Option<String>, pub database: Option<String>, pub client_addr: Option<String>, pub application_name: String, pub state: Option<String>, pub backend_start: Option<String>, pub query_start: Option<String>, pub wait_event: Option<String> }
pub struct ClusterSnapshot { pub version_num: i32, pub version: String, pub password_encryption: String, pub login_user: String, pub roles: Vec<RoleRec>, pub members: Vec<MemberRec>, pub databases: Vec<DatabaseRec>, pub settings: Vec<RoleSettingRec>, pub sessions: Vec<SessionRec>, pub fetched_at: String }
pub enum RelKind { Table, View, MatView, Partitioned, Foreign, Sequence } // relkind r v m p f S
pub struct SchemaRec { pub name: String, pub owner: String, pub acl: Vec<AclEntry> }
pub struct RelationRec { pub schema: String, pub name: String, pub kind: RelKind, pub owner: String, pub rls: bool, pub acl: Vec<AclEntry> }
pub struct FunctionRec { pub schema: String, pub name: String, pub signature: String, pub owner: String, pub security_definer: bool, pub search_path_set: bool, pub acl: Vec<AclEntry> }
pub enum DefaultObjType { Tables, Sequences, Functions, Types, Schemas } // defaclobjtype r S f T n
pub struct DefaultAclRec { pub creator: String, pub schema: Option<String>, pub obj_type: DefaultObjType, pub acl: Vec<AclEntry> }
pub struct DbSnapshot { pub database: String, pub owner: String, pub schemas: Vec<SchemaRec>, pub relations: Vec<RelationRec>, pub functions: Vec<FunctionRec>, pub default_acls: Vec<DefaultAclRec>, pub truncated: bool, pub fetched_at: String }
```

  - `pg::catalog`:
    - `read<T, F>(conn: &mut Connected, f: F) -> Result<T, AppError>` opens `build_transaction().read_only(true).start()`, runs `SET LOCAL statement_timeout = '30s'`, runs `f(&tx)` and commits.
    - `backend_pid(conn)`, `cluster_snapshot(conn, login_user) -> ClusterSnapshot`, `db_snapshot(conn, database) -> DbSnapshot`, `sessions(conn) -> Vec<SessionRec>`.
    - Pure grouping helper `group_acl(rows: Vec<AclRow<K>>) -> Vec<(K, Vec<AclEntry>)>`, with `AclRow<K> { key: K, grantor: Option<String>, grantee: Option<String>, privilege: Option<String>, grantable: Option<bool> }`. It keeps key order. A row with `privilege: None` yields the key with an empty ACL; that comes from `LEFT JOIN LATERAL` over an empty ACL.

- [ ] **Step 1: Unit tests (pure) in `catalog/tests.rs`.**
  - `group_acl` keeps object order, merges rows per object, maps `grantee: None` to PUBLIC, and keeps objects with no ACL rows.
  - Every privilege string round-trips through `Privilege::from_pg` and `as_str`, and an unknown string is `None`.
  - `RelKind` and `DefaultObjType` parse from their one-letter codes.
- [ ] **Step 2: The SQL** (constants in `catalog.rs`; `{SYS}` is the schema filter `n.nspname NOT IN ('pg_catalog','information_schema','pg_toast') AND n.nspname NOT LIKE 'pg\_temp\_%' AND n.nspname NOT LIKE 'pg\_toast\_temp\_%'`):

```sql
-- server
SELECT current_setting('server_version_num')::int, current_setting('server_version'), current_setting('password_encryption');
-- roles
SELECT r.rolname, r.rolcanlogin, r.rolinherit, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls, r.rolsuper, r.rolconnlimit,
       CASE WHEN r.rolvaliduntil IS NULL OR r.rolvaliduntil = 'infinity' THEN NULL
            ELSE to_char(r.rolvaliduntil AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
       shobj_description(r.oid, 'pg_authid')
FROM pg_roles r ORDER BY r.rolname;
-- members, PG16+ (server_version_num >= 160000)
SELECT m.rolname, g.rolname, am.admin_option, am.inherit_option
FROM pg_auth_members am JOIN pg_roles m ON m.oid = am.member JOIN pg_roles g ON g.oid = am.roleid ORDER BY 1, 2;
-- members, before 16
SELECT m.rolname, g.rolname, am.admin_option, NULL::bool
FROM pg_auth_members am JOIN pg_roles m ON m.oid = am.member JOIN pg_roles g ON g.oid = am.roleid ORDER BY 1, 2;
-- databases
SELECT d.datname, pg_get_userbyid(d.datdba), d.datallowconn,
       pg_get_userbyid(a.grantor), CASE WHEN a.grantee = 0 THEN NULL ELSE pg_get_userbyid(a.grantee) END, a.privilege_type, a.is_grantable
FROM pg_database d LEFT JOIN LATERAL aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a ON true
WHERE NOT d.datistemplate AND d.datname <> 'rdsadmin' ORDER BY d.datname;
-- role settings
SELECT CASE WHEN s.setrole = 0 THEN NULL ELSE pg_get_userbyid(s.setrole) END, d.datname, c.setting
FROM pg_db_role_setting s LEFT JOIN pg_database d ON d.oid = s.setdatabase, LATERAL unnest(s.setconfig) AS c(setting);
-- sessions
SELECT pid, usename, datname, host(client_addr), coalesce(application_name, ''), state,
       to_char(backend_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), to_char(query_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), wait_event
FROM pg_stat_activity WHERE backend_type = 'client backend' ORDER BY backend_start;
-- schemas (per database)
SELECT n.nspname, pg_get_userbyid(n.nspowner),
       pg_get_userbyid(a.grantor), CASE WHEN a.grantee = 0 THEN NULL ELSE pg_get_userbyid(a.grantee) END, a.privilege_type, a.is_grantable
FROM pg_namespace n LEFT JOIN LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a ON true
WHERE {SYS} ORDER BY n.nspname;
-- relations: at most $1 objects (the limit is 20001 so that truncation can be detected)
WITH o AS (
  SELECT c.oid, n.nspname, c.relname, c.relkind, c.relowner, c.relrowsecurity, c.relacl
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r','v','m','p','f','S') AND NOT c.relispartition AND {SYS}
  ORDER BY n.nspname, c.relname LIMIT $1)
SELECT o.nspname, o.relname, o.relkind::text, pg_get_userbyid(o.relowner), o.relrowsecurity,
       pg_get_userbyid(a.grantor), CASE WHEN a.grantee = 0 THEN NULL ELSE pg_get_userbyid(a.grantee) END, a.privilege_type, a.is_grantable
FROM o LEFT JOIN LATERAL aclexplode(coalesce(o.relacl, acldefault(CASE WHEN o.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, o.relowner))) a ON true
ORDER BY o.nspname, o.relname;
-- functions: at most $1 objects
WITH o AS (
  SELECT p.oid, n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args, p.proowner, p.prosecdef, p.proconfig, p.proacl
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.prokind IN ('f','p') AND {SYS}
  ORDER BY n.nspname, p.proname, args LIMIT $1)
SELECT o.nspname, o.proname, o.args, pg_get_userbyid(o.proowner), o.prosecdef,
       coalesce(EXISTS (SELECT 1 FROM unnest(o.proconfig) c WHERE c LIKE 'search\_path=%'), false),
       pg_get_userbyid(a.grantor), CASE WHEN a.grantee = 0 THEN NULL ELSE pg_get_userbyid(a.grantee) END, a.privilege_type, a.is_grantable
FROM o LEFT JOIN LATERAL aclexplode(coalesce(o.proacl, acldefault('f', o.proowner))) a ON true
ORDER BY o.nspname, o.proname, o.args;
-- default privileges
SELECT pg_get_userbyid(d.defaclrole), n.nspname, d.defaclobjtype::text,
       pg_get_userbyid(a.grantor), CASE WHEN a.grantee = 0 THEN NULL ELSE pg_get_userbyid(a.grantee) END, a.privilege_type, a.is_grantable
FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
LEFT JOIN LATERAL aclexplode(d.defaclacl) a ON true ORDER BY 1, 2, 3;
```

  - Relations are read first with limit 20 001; if more than 20 000 come back, keep 20 000, set `truncated`, and read no functions. Otherwise functions get `20 001 - relations`, and `truncated` is set when the cap is hit. (Changed in review: tables matter more than functions.)
  - `DbSnapshot.owner` and `DbSnapshot.database` come from `SELECT current_database(), pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()`. If the server's database differs from the requested one, the read fails with "연결한 데이터베이스가 요청과 달라요: <요청> / <실제>". Reads run `READ ONLY` at `REPEATABLE READ`, so one `read` sees one snapshot.
  - `fetched_at` is ISO 8601 UTC from the app clock (`crate::iam::clock::iso(now_secs())` or the equivalent).
- [ ] **Step 3: The live harness.**
  - `scripts/pg-live-test.sh` (bash, `set -euo pipefail`):
    1. Start `postgres:14` and `postgres:16` with `-e POSTGRES_PASSWORD=live -p 55414:5432` and `-p 55416:5432`, wait until `pg_isready` passes in each.
    2. Run `cd src-tauri && MM_PG_LIVE_14=postgres://postgres:live@127.0.0.1:55414/postgres MM_PG_LIVE_16=postgres://postgres:live@127.0.0.1:55416/postgres cargo test pg::live_tests -- --ignored --test-threads=1`.
    3. Remove the containers on exit, including on failure (`trap`).
  - `live_tests.rs` connects with `tokio_postgres::connect(url, NoTls)`; this is test-only. It creates a fresh database `mm_live_<n>` with a seeded scenario: roles `app_owner` (LOGIN), `app_read` (NOLOGIN), `app_write` (NOLOGIN, member of `app_read`), `alice` (LOGIN, member of `app_write`), `bob` (LOGIN NOINHERIT, member of `app_read`) and `carol` (LOGIN, member of `pg_read_all_data`). It also creates schemas `app` and `audit`, tables, a view, a sequence, a SECURITY DEFINER function without `search_path`, `GRANT`s, `ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA app GRANT SELECT ON TABLES TO app_read`, and `REVOKE CONNECT ON DATABASE … FROM PUBLIC` plus `GRANT CONNECT … TO app_read`.
  - Live tests for this task:
    - `cluster_snapshot` reads the seeded roles and memberships on both versions. On 16, `inherit` is `Some(false)` for bob's membership; on 14 it is `None`.
    - `db_snapshot` reads the schemas, relations (no partition children), functions with `security_definer` and `search_path_set`, and default ACLs.
    - `read` refuses `CREATE TABLE x()` with SQLSTATE `25006` (read-only transaction). This proves reads cannot write.
- [ ] **Step 4: Verify.** Run `cargo test pg::`, clippy, and `scripts/pg-live-test.sh`, then paste the outputs into the report. If Docker isn't running, report BLOCKED for the live part only and keep the unit tests green.
- [ ] **Step 5: Commit** with `feat(pg): read-only catalog snapshot and the Docker live-test harness`.

---

### Task PB3: Effective privileges and who-can (pure)

**Files:**
- Create: `src-tauri/src/pg/eval.rs`, `src-tauri/src/pg/eval/tests.rs`, `src-tauri/src/pg/fixtures.rs` (`#[cfg(test)]` builders).
- Modify: `src-tauri/src/pg.rs`, `src-tauri/src/pg/live_tests.rs` (comparison tests), `src-tauri/src/pg/model.rs` and `src-tauri/src/pg/catalog.rs` (one shared `MEMBERSHIP_OPTIONS_SINCE` gate).

**Interfaces:**
- Consumes the `pg::model` types.
- Produces (in `pg::eval`):

```rust
pub enum SourceKind { Owner, Direct, Group, Public, Predefined, Superuser }   // serde camelCase
pub struct Source { pub kind: SourceKind, pub via: Vec<String>, pub grantor: Option<String> }
pub struct Inherited { pub role: String, pub path: Vec<String> }            // path: role → … → this role, excluding the starting role
pub struct Ctx<'a> { pub cluster: &'a ClusterSnapshot, pub db: &'a DbSnapshot }
pub enum Obj<'a> { Database(&'a DatabaseRec), Schema(&'a SchemaRec), Relation(&'a RelationRec), Function(&'a FunctionRec) }
impl Ctx<'_> {
    pub fn inherited(&self, role: &str) -> Vec<Inherited>;         // the role itself first (empty path), then BFS order
    pub fn set_role_only(&self, role: &str) -> Vec<String>;         // reachable only through non-inheriting memberships that allow SET ROLE (skip edges with set == Some(false), PG16+)
    pub fn sources(&self, role: &str, obj: Obj, p: Privilege) -> Vec<Source>;
    pub fn unusable(&self, role: &str, schema: &str) -> Option<&'static str>;  // "CONNECT 없음" first, then "USAGE 없음"
}
// Also a handle built once per command that owns the role graph: `Eval::new(&ctx)`, then `eval.role(name)` with the same four
// questions on the per-role view. The `Ctx` methods are one-line wrappers over it.
pub enum Coverage { All, Some, None }
pub struct SchemaCell { pub role: String, pub schema: String, pub usage: bool, pub create: bool, pub read: Coverage, pub write: Coverage, pub inherited_only: bool, pub unusable: Option<&'static str> }
pub fn schema_cells(ctx: &Ctx, roles: &[&str]) -> Vec<SchemaCell>;   // roles × schemas, in schema-name order inside role order
pub struct WhoCanRow { pub role: String, pub sources: Vec<Source>, pub unusable: Option<&'static str> }
pub fn who_can(ctx: &Ctx, obj: Obj, p: Privilege) -> Vec<WhoCanRow>; // roles with at least one source, in role-name order
```

- [ ] **Step 1: Failing tests** on fixture snapshots (builders in `pg/fixtures.rs`).
  1. **Inheritance before PG16:** alice → app_write → app_read inherits both, with paths `["app_write"]` and `["app_write","app_read"]`. NOINHERIT bob gets nothing through app_read, and `set_role_only("bob") == ["app_read"]`.
  2. **Inheritance on PG16:** a membership with `inherit: Some(false)` blocks that edge even when the member has `rolinherit = true`. `inherit: Some(true)` passes even when the member is NOINHERIT.
  3. **Owner:** the ACL entry whose grantee is the object owner gives `Owner`. A role that inherits the owner gets `Owner` with `via = path`. An owner who revoked their own SELECT (no ACL entry) does not have it.
  4. **Direct, group and PUBLIC:** direct entries are `Direct`, entries for an inherited group are `Group`, and PUBLIC entries are `Public` for every role.
  5. **Predefined roles:** for `version_num >= 140000`, a role inheriting `pg_read_all_data` gets `Predefined` SELECT on every relation, sequences included, and USAGE on every schema. `pg_write_all_data` gives INSERT, UPDATE and DELETE on tables, partitioned tables, views, matviews and foreign tables, UPDATE on sequences, and USAGE on every schema. Neither gives CREATE, TRUNCATE, REFERENCES, TRIGGER, sequence USAGE, EXECUTE or a database privilege. The predefined role itself holds what it grants. Both are ignored below 140000. From 170000, `pg_maintain` gives MAINTAIN on every relation except sequences. MAINTAIN exists only from 170000, so no object (not even for a superuser) offers it before.
  6. **pg_database_owner:** on PG14 and later the database owner (`db.owner`) implicitly has the privileges granted to `pg_database_owner`. A role that inherits the owner gets them too, with `via` ending in `"pg_database_owner"`. Before PG16 this is gated by the owner's `rolinherit`: a NOINHERIT owner does not get them, and neither does any role that inherits that owner.
  7. **Superuser:** a role whose own `superuser` is true gets `Superuser` for every privilege its object type has. Superuser is never inherited: a member of a superuser role, inheriting or not, gets only the ACL entries granted to that role, as `Group`.
  8. **Unusable:**
     - Without CONNECT (direct, group or PUBLIC) on the database, `unusable` is "CONNECT 없음".
     - With CONNECT but without schema USAGE, it is "USAGE 없음".
     - With both, it is `None`.
     - CREATE on a schema works without USAGE. So a cell whose only shown value is `create` gets "CONNECT 없음" or `None`, never "USAGE 없음". A who-can row for CREATE on a schema gets only "CONNECT 없음".
     - For a database object, CONNECT is checked on that database, not on the snapshot's database.
  9. **Schema cells:**
     - `read` is `All` when the role has SELECT on every relation of kind table, view, matview, partitioned or foreign in the schema, `Some` when on some of them, and `None` when on none. An empty schema reads `None`.
     - `write` uses INSERT, UPDATE or DELETE on table, partitioned or foreign relations.
     - `usage` and `create` come from the schema ACL.
     - `inherited_only` is true when the cell shows at least one value and every source behind the shown `true` or `All`/`Some` values is Group, Public or Predefined. A cell that shows nothing is false.
     - `unusable` holds `ctx.unusable(role, schema)` only when the cell has something to lose: `usage || create || read != None || write != None`. Otherwise it is `None`. Test both sides: a cell with privileges but no CONNECT, and an empty cell without CONNECT.
  10. **Who-can:** for `app.orders` SELECT, the rows are app_owner (Owner), app_read (Direct), app_write (Group via app_read), alice (Group via app_write → app_read) and carol (Predefined). Bob is absent because of NOINHERIT. Rows are in name order, and `unusable` is filled for roles that lack CONNECT.
- [ ] **Step 2: Implement.**
  - Precompute each role's inherited set once (BFS over `members`, with the PG16 rule when `version_num >= 160000` and the `rolinherit` rule before).
  - Treat `pg_database_owner` as a virtual membership `db.owner → pg_database_owner`, added after the owner's real memberships, for `version_num >= 140000`. It always allows SET ROLE. From PG16 it is always inherited. Before PG16 it is inherited only when the owner has `rolinherit`, the same gate as the owner's other memberships.
  - `sources` walks the object's ACL entries and classifies each match:
    - grantee is `None` → `Public`;
    - grantee is the object owner and is the role itself or an inherited role → `Owner`;
    - grantee is the role itself → `Direct`;
    - grantee is an inherited role → `Group`;
    - the predefined rules from test 5 → `Predefined`;
    - the role's own `superuser` is true → `Superuser` (never through membership).
  - `schema_cells` must stay fast. Precompute per role a `HashSet<&str>` of the role and every inherited role (`effective set`), so each check is a set lookup. Budget: 200 roles × 20 000 relations in under 2 s in release mode. Add a `#[test] #[ignore]` benchmark-style test that builds that size and asserts it.
- [ ] **Step 3: Live comparison tests** in `live_tests.rs`, on both versions:
  - For every non-system role × every relation in the seeded database × each of SELECT, INSERT, UPDATE, DELETE, the result of `!sources(..).is_empty()` equals `has_table_privilege(role, oid, priv)`.
  - The same for schemas (USAGE, CREATE via `has_schema_privilege`), the database (CONNECT, CREATE, TEMP via `has_database_privilege`), functions (EXECUTE via `has_function_privilege`) and sequences (USAGE, SELECT, UPDATE via `has_sequence_privilege`).
  - On any mismatch, print the role, object and privilege.
- [ ] **Step 4: Verify** with `cargo test pg::`, clippy and the live script. Mutation checks:
  - Ignore `inherit_option` on 16: test 2 and the live comparison must fail.
  - Drop the `pg_database_owner` virtual membership: tests 6 and the live public-schema comparison on 16 must fail.
  - Restore both.
- [ ] **Step 5: Commit** with `feat(pg): effective privileges with sources, matched against PostgreSQL`.

---

### Task PB4: Checks, views, commands and the hygiene guard

**Files:**
- Create:
  - `src-tauri/src/pg/view.rs`: the contract structs (`PgTargetInfo` lives in target.rs).
  - `src-tauri/src/pg/summary.rs`: view builders.
  - `src-tauri/src/pg/checks.rs`.
  - Tests in each file or in `pg/<name>/tests.rs`.
  - `src-tauri/src/pg_commands.rs`.
- Modify: `src-tauri/src/lib.rs` (manage `PgState`, register commands, spawn the pool sweeper in `setup`), `src-tauri/src/settings.rs` (`pg_logins`), `src-tauri/src/pg.rs`.

**Interfaces:**
- Consumes PB1 to PB3.
- Produces the commands and contract in the Contract section.

- [ ] **Step 1: Failing tests.**
  - **Role summaries:**
    - `kind` is "user" when `login` is true, otherwise "group".
    - `system` follows the Global Constraints list.
    - Badges, in this order: admin (member of `rds_superuser`, inherited or not, level "high"), iamAuth (`rds_iam`, "info"), createRole ("medium"), createDb ("info"), bypassRls ("medium"), replication ("info"), expired (`valid_until` in the past, "medium"), expiringSoon (within 30 days, "info"), loginRole (`name == login_user`, "info").
    - `memberCount` counts direct members. `sessionCount` counts sessions whose role is this one.
  - **Overview:** `canManage` is true when the login user inherits `rds_superuser`, or has CREATEROLE, or is a superuser. Otherwise `canManage` is false and `manageReason` is the exact manage text.
  - **Database view:**
    - `cells` covers all roles × all schemas.
    - `dbPrivileges` has CONNECT, CREATE and TEMP for every role.
    - `schemas[].tableCount` counts relations of kind table or partitioned.
    - `defaultPrivileges` maps `DefaultAclRec` with `grantee: None` → "PUBLIC" and privileges as strings.
  - **Cell detail:** only privileges the role has, sources included, objects in name order, at most 2 000 objects with `truncated`. Functions are included (EXECUTE) and sequences too (USAGE, SELECT, UPDATE).
  - **Object search:** case-insensitive substring on `schema.name` (for databases and schemas, the name), at most 100 results, sorted with databases, then schemas, then relations, then functions.
  - **Role view:** settings for that role, plus settings for all roles (`role: None`), filtered to this role. Members, `setRoleOnly`, owned objects per loaded database (at most 200, plus `ownedOmitted`), and cells limited to the non-empty ones. Unloaded databases have `loaded: false`.
  - **Checks:** one test per finding kind, on fixtures. Each test also checks a fixture that must not trigger the kind.
    - `publicSchemaCreate`: PUBLIC has CREATE on a schema, including the PG14 public default. Level "high".
    - `publicObjectGrant`: PUBLIC has any privilege on a relation (tables and sequences). "medium".
    - `rdsSuperuser`: direct and inherited members of `rds_superuser`, excluding system roles. "high".
    - `createRole`: non-system roles with CREATEROLE. "medium". The detail adds "PG15 이하에서는 거의 관리자급이에요" when `version_num < 160000`.
    - `bypassRls`: non-system roles with BYPASSRLS. "medium".
    - `expiringLogin`: login roles whose `valid_until` is in the past or within 30 days. "low".
    - `emptyLogin`: a non-system login role that is a member of no role except `rds_iam`, has no ACL entry naming it in any loaded database, and owns nothing. "low".
    - `defaultPrivilegeGap`: role R has SELECT on every table in schema S through Direct or Group sources. There is a creator C (the owner of at least one table in S) such that R is not C and does not inherit C. No default ACL of C (schema S or global) grants SELECT on tables to R, to a role R inherits, or to PUBLIC. Detail: `${R} 역할은 ${S}의 지금 테이블은 읽지만 ${C} 역할이 새로 만드는 테이블은 못 읽어요`. "medium".
    - `securityDefinerPath`: functions with `security_definer && !search_path_set`. "high".
    - `md5Encryption`: `password_encryption == "md5"`. "medium".
    - Group titles: "PUBLIC이 스키마에 객체를 만들 수 있어요", "PUBLIC에 테이블·시퀀스 권한이 있어요", "rds_superuser 멤버", "CREATEROLE을 가진 역할", "BYPASSRLS를 가진 역할", "만료됐거나 곧 만료되는 사용자", "그룹도 권한도 없는 사용자", "새 테이블에는 권한이 없는 역할", "search_path를 고정하지 않은 SECURITY DEFINER 함수", "password_encryption이 md5예요".
    - Only groups with items are returned, highest level first.
  - **Settings:** `pg_logins` round-trips, and an old settings file without it still loads.
  - **Hygiene:** `pg_only_the_catalog_runs_queries`:
    - Read every `.rs` file under `src-tauri/src/pg` and `src-tauri/src/pg_commands.rs`, skipping `#[cfg(test)]` files such as `live_tests.rs` and `tests.rs`.
    - Assert that `.query(`, `.query_one(`, `.query_opt(`, `.execute(`, `batch_execute(`, `simple_query(`, `build_transaction(` and `.transaction(` appear only in `pg/catalog.rs`.
    - Assert that `build_transaction()` appears exactly once and is followed by `.read_only(true)`.
- [ ] **Step 2: Implement.**
  - **`PgState`:**
    - `pool: Pool`
    - `logins: Mutex<HashMap<PgTarget, String>>`
    - `infos: Mutex<HashMap<PgTarget, PgTargetInfo>>`
    - `clusters: Mutex<HashMap<PgTarget, Arc<ClusterSnapshot>>>`
    - `dbs: Mutex<HashMap<(PgTarget, String), Arc<DbSnapshot>>>`
  - **Commands:**
    - Every command resolves the SDK config with `state.ctx.config(&target.profile, &target.region)`.
    - `pg_open` runs `resolve`, then `connect_check`, stores the login, and then `cluster_snapshot` through the pool. It clears that target's `dbs` cache.
    - The other commands take the stored login or fail with "먼저 연결해 주세요".
    - `pg_findings` loads each connectable database (`allow_conn`). A connect or read failure for one database goes into `skipped` with the error text and does not fail the call.
    - Session `own` is true when the pid is in `pool.backend_pids(target)`.
    - Heavy builders run in `spawn_blocking`.
  - **Registration:** add every command to `lib.rs`. Spawn the sweeper once in `setup`: a tokio interval of 60 s calling `pool.sweep(Instant::now())`.
- [ ] **Step 3: Verify.**
  - Run `cargo test`, clippy and the live script.
  - Add one live test that runs the builders (`database_view`, `who_can`, `findings`) on the seeded database and checks the expected findings: `securityDefinerPath` for the seeded function, and `defaultPrivilegeGap` none for `app_read` (seeded default privileges) but present for a role granted only `SELECT ON ALL TABLES`.
  - Mutation: remove the `inherited_only` computation; the database-view test must fail. Restore it.
- [ ] **Step 4: Commit** with `feat(pg): checks, views and read-only commands for the PostgreSQL tab`.

---

### Task PF1: Frontend contract, API, queries, fixtures and tab opening

**Files:**
- Create: `src/pg/types.ts`, `src/pg/api.ts`, `src/pg/queries.ts`, `src/pg/fixtures.ts`, `src/pg/targets.ts`, `src/pg/targets.test.ts`.
- Modify:
  - `src/api/types.ts`: `Settings.pgLogins?: Record<string, string>`.
  - `src/components/ResourceArea.tsx`: RDS double-click routing.
  - `src/components/MainArea.tsx`: prop pass-through.
  - `src/App.tsx`: pg tabs, close on profile change, `pg_close` on tab close.
  - The tests of those components.

**Interfaces:**
- Produces:
  - Types: the Contract section verbatim.
  - `pgApi.target/open/database/cell/objects/role/whoCan/sessions/findings/close`, one-to-one with the commands. Argument names are camelCase (`{ target, loginUser }`, `{ target, database, force }`, …).
  - `pgKeys.*` query keys, each starting with `["pg", targetKey(target)]`.
  - Hooks: `usePgTarget(target)`, `usePgOverview(target, loginUser | null)`, `usePgDatabase(target, database | null)`, `usePgCell(target, database, role, schema)`, `usePgObjects(target, database, query)`, `usePgRole(target, role)`, `usePgWhoCan(target, database, object, privilege)`, `usePgSessions(target)`, `usePgFindings(target, enabled)`, and `refreshPg(qc, target)`.
  - `refreshPg` invalidates every query of the target and refetches the overview, database and findings queries with `force: true`.
  - `targetKey(t) = \`${t.profile}|${t.region}|${t.kind}|${t.id}\``.
  - `pgTargetOf(row: Resource, typeId: "db-clusters" | "db-instances"): { kind, id } | null`.
  - App's `openPg(target, title)`, with tab id `pg:${region}:${kind}:${id}` and title `🐘 ${identifier}`.

- [ ] **Step 1: Failing tests.**
  - `pgTargetOf`, cluster rows: engine `aurora-postgresql` or `postgres` → `{ kind: "cluster", id }`; `aurora-mysql` → null.
  - `pgTargetOf`, instance rows:
    - a row with `values.cluster` and engine `aurora-postgresql` or `postgres` → `{ kind: "cluster", id: values.cluster }`;
    - a `postgres` row without a cluster → `{ kind: "instance", id }`;
    - a `mysql` row → null.
  - In ResourceArea, double-clicking a PostgreSQL row calls `onOpenPg` with the resolved target. Double-clicking a MySQL row shows "PostgreSQL 엔진만 열 수 있어요" in a `role="status"` line that disappears after 5 s (fake timers) and does not call `onOpenPg`.
  - App:
    - opening the same target twice keeps one tab and activates it;
    - closing the tab calls `pgApi.close` with that target;
    - a profile change closes all pg tabs and calls `close` for each.
  - `refreshPg` invalidates and passes `force: true`; check this with a mocked `pgApi`.
- [ ] **Step 2: Implement** with the existing patterns: `useResources`-style hooks in `src/api/queries.ts`, the IAM `queries.ts` for keys and `force`, and App's `openVpc` and `closeTab` for tabs. Fixtures: `sampleTargetInfo()`, `sampleOverview()` (roles: `postgres` admin, `iam_admin` login role with admin and iamAuth, `app_owner`, `app_read` group, `app_write` group, `alice`, `bob` expiring, and `rds_superuser`/`rds_iam`/`pg_read_all_data` as system roles), `sampleDatabaseView()` (schemas `app` and `audit`, cells for every role, one unusable cell, default privileges), `sampleCellDetail()`, `sampleWhoCan()`, `sampleSessions()`, `sampleFindings()`.
- [ ] **Step 3: Verify** with `npx vitest run`, `npx tsc --noEmit` and `npm run build`. A placeholder `PgTab` that renders the title is fine until PF2.
- [ ] **Step 4: Commit** with `feat(pg): open PostgreSQL tabs from the RDS list`.

---

### Task PF2: Tab shell, login prompt, nav, roles list and role detail

**Files:**
- Create: `src/pg/PgTab.tsx`, `src/pg/PgNav.tsx`, `src/pg/route.ts`, `src/pg/LoginPrompt.tsx`, `src/pg/RoleList.tsx`, `src/pg/RoleDetail.tsx`, `src/pg/Badges.tsx`, and their tests.
- Modify: `src/App.tsx` (render `PgTab`), `src/styles.css` (rules under `.pg-`).

**Interfaces:**
- Consumes PF1.
- Produces:
  - `PgTab({ target, title, active, filter })`.
  - Route `{ view: "findings" | "roles" | "privileges" | "defaults" | "whoCan" | "sessions"; id?: string; tab?: string; database?: string }`. History and back/forward work like `useIamHistory`; reuse it if it is generic, otherwise copy its shape into `src/pg/route.ts`.

- [ ] **Step 1: Failing tests.**
  - **First open:** `usePgTarget` loads the target info.
    - With `iamAuth` false, the screen shows the IAM-off text for that kind and offers no login prompt.
    - Otherwise, when `settings.pgLogins[arn]` is missing, the login prompt shows the exact title, intro and button.
    - Submitting saves `pgLogins[arn]` through `useSettings().update` and calls `open`.
    - A remembered login opens without the prompt.
  - **Errors:** errors from `open` render through `ErrorState`, so the network text shows with [다시 시도]. The top bar's [바꾸기] reopens the prompt with the current name, and saving reconnects.
  - **Top bar:** identifier, engine version, login user, "읽은 시각", and [다시 읽기], which calls `refreshPg`. When `canManage` is false, the `manageReason` text shows as a hint.
  - **Nav:** the six items with the exact labels. 점검 shows the finding count once findings are loaded.
  - **Role list:**
    - Chips 사용자 and 그룹, both on by default.
    - System roles stay hidden until "시스템 역할 보기" is on.
    - The toolbar filter matches names.
    - Columns: name with badges, 종류, 소속 그룹, 구성원, 세션, 만료일.
    - Double-click or Enter opens the detail.
  - **Role detail:**
    - [개요] shows attributes with labels, the connection limit as "제한 없음" for -1, the expiry, settings and the comment.
    - [구성원] lists memberOf (상속 or "SET ROLE로만 쓸 수 있음", ADMIN OPTION) and members.
    - [권한] has one section per database. Unloaded ones have [불러오기], which calls `usePgDatabase` for that database and then refetches the role.
    - [소유 객체] lists owned objects with `ownedOmitted` as "외 N개".
    - [세션] lists the role's sessions.
- [ ] **Step 2: Implement.**
  - Mirror IamTab's structure (top bar, nav, body by route, ⌘[ ⌘] when active).
  - Reuse `ListTable` (`src/iam/ListTable.tsx`), `ErrorState` and the IAM badge CSS classes.
  - Do not touch `src/iam/` behavior. If a component must become generic, move it without behavior changes and keep its tests green untouched.
- [ ] **Step 3: Verify** (vitest, tsc, build) and commit with `feat(pg): PostgreSQL tab shell, login prompt, roles and role detail`.

---

### Task PF3: Privileges table, cell detail and default privileges

**Files:**
- Create: `src/pg/PrivilegeGrid.tsx`, `src/pg/CellPanel.tsx`, `src/pg/DefaultPrivileges.tsx`, `src/pg/DatabasePicker.tsx`, `src/pg/sentences.ts`, and tests.
- Modify: `src/pg/PgTab.tsx` (routes), `src/styles.css`.

**Interfaces:**
- Consumes `usePgDatabase`, `usePgCell` and the overview.
- Produces `DatabasePicker({ databases, value, onChange })`, which PF4 reuses. It lists only `allowConn` databases and defaults to `target.defaultDatabase`. The choice is remembered in the route.

- [ ] **Step 1: Failing tests.**
  - **Grid layout:** rows are roles grouped 사용자 then 그룹, with the same chips, system toggle and filter as the role list. The first column is 데이터베이스 (CONNECT/CREATE/TEMP), then one column per schema in name order.
  - **Cell content:**
    - Cells show four indicators with accessible names `${role} · ${schema}: 사용 ${o|x}, 만들기 ${o|x}, 읽기 ${모든 테이블|일부 테이블|없음}, 쓰기 …`.
    - Inherited-only cells carry a dimmed class.
    - Unusable cells show ⚠ and "권한은 있지만 실제로는 못 써요 (CONNECT 없음)".
  - **Cell panel:** clicking a cell opens the panel. It loads `pg_cell`, lists objects with privilege chips, and each chip's title explains its sources:
    - "직접 받음", "소유자", `${via.join(" ← ")} 그룹에서 받음`, "모든 역할(PUBLIC)", "pg_read_all_data", "superuser"
    - RLS objects show "행 수준 보안 켜짐". When the role has BYPASSRLS, the chip reads "행 수준 보안 켜짐 · BYPASSRLS라 적용되지 않아요".
    - `truncated` shows "객체가 많아 일부만 읽었어요".
  - **Rendering:** the grid renders only visible rows with 300 roles, using `visibleRange` from `src/iam/AssignmentGrid.tsx`. Keyboard: arrows move, and Enter opens the panel.
  - **Truncated view:** a truncated database view shows the truncated text above the grid.
  - **Default privileges:**
    - Rows are (creator, schema or "모든 스키마"). Columns are 테이블, 시퀀스, 함수, 타입, 스키마. Cells list grantees and privileges.
    - Each row has the exact sentence form from the constraints, one per grantee and object type.
    - The built-in defaults note shows above the table.
  - **`sentences.ts` unit tests:** the particle rule (테이블을, 시퀀스를, 함수를, 타입을, 스키마를) and `PUBLIC` → "모든 역할(PUBLIC)".
- [ ] **Step 2: Implement.** Grid cells are read-only buttons in this phase, because phase 2 adds toggling.
- [ ] **Step 3: Verify and commit** with `feat(pg): privileges table, cell detail and default privileges`.

---

### Task PF4: Who-can, sessions, findings, checklist and README

**Files:**
- Create: `src/pg/WhoCan.tsx`, `src/pg/Sessions.tsx`, `src/pg/Findings.tsx`, and tests.
- Modify: `src/pg/PgTab.tsx`, `src/styles.css`, `docs/manual-test-checklist.md`, `README.md`.

- [ ] **Step 1: Failing tests.**
  - **Who-can:**
    - Pick a database, then search an object (`pg_objects`, 250 ms debounce, reusing `PickerSheet`).
    - The privilege list depends on the kind:
      - database: CONNECT, CREATE, TEMPORARY
      - schema: USAGE, CREATE
      - table, view, matview, partitioned, foreign: SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
      - sequence: USAGE, SELECT, UPDATE
      - function: EXECUTE
    - Results list users first, then groups, each with reason paths, e.g. "readonly ← app_read ← 직접 받음".
    - Roles that are unusable are grouped under "권한은 있지만 실제로는 못 써요".
    - System roles are hidden unless "시스템 역할 보기" is on.
  - **Sessions:**
    - Columns: 역할, 데이터베이스, 클라이언트, application_name, 상태, 시작, 대기.
    - A role filter.
    - The app's own sessions carry "이 앱".
    - [다시 읽기] refetches.
  - **Findings:**
    - Groups ordered by level with counts. Items link to the role detail or to the privileges table with database and schema preselected.
    - Skipped databases are listed with reasons.
    - The footnote uses the exact text.
    - The nav count is the total number of items.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Checklist and README.**
  - Add "RDS PostgreSQL 사용자 관리 1단계 (IAM 인증을 켠 테스트 클러스터에서 확인한다)" to `docs/manual-test-checklist.md` with these items:
    1. Double-click a cluster, an Aurora instance (opens its cluster) and a MySQL row (notice).
    2. Login prompt and remembered login.
    3. VPN off shows the network text.
    4. IAM off shows its text.
    5. A wrong DB user shows the IAM failure text.
    6. Roles and badges.
    7. Role detail tabs.
    8. Privileges grid with an unusable cell, plus the cell panel.
    9. Default privileges sentences.
    10. Who-can with reason paths.
    11. Sessions, including the app's own.
    12. Findings, including the footnote.
    13. Closing the tab closes connections: `SELECT count(*) FROM pg_stat_activity WHERE application_name='magic-mirror'` drops to 0 within a few seconds.
  - Add to README (English):
    - Feature: a "PostgreSQL users (RDS)" subsection under the features, covering what it shows and that phase 1 is read-only.
    - Requirements: VPN reachability, IAM database authentication on the cluster, `rds-db:connect`, and a DB user with `rds_iam` (and `rds_superuser` to manage).
    - Permissions list: add `rds:DescribeDBClusters`, `rds:DescribeDBInstances` and `rds-db:connect`.
- [ ] **Step 4: Verify and commit** with `feat(pg): who-can, sessions and security checks`.

---

### Task K1: Phase-1 checkpoint (controller)
- Run everything on HEAD:
  - `cargo test`
  - clippy
  - the hygiene test
  - `scripts/pg-live-test.sh`
  - vitest, tsc and build
- Run a whole-phase review with the most capable model over the branch range, plus one fix wave.
- Then write the phase-2 plan from the spec's 변경 section.
- Phase 1 is not merged or released on its own.
