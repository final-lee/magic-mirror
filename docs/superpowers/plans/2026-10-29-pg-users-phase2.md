# RDS PostgreSQL 사용자 관리 2단계(변경) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the "🐘 <식별자>" tab, change roles, memberships, attributes, passwords, object privileges and default privileges. Every change goes through preview, confirm and apply, and one change or one batch is one transaction. The tab also adds a safe role drop, ending sessions, and a change log with undo.

**Architecture:**
- **Backend** (`src-tauri/src/pg/`):
  - `change/`: pure functions over the phase-1 snapshots. They cover:
    - the change model and its SQL;
    - what the login user may do, including which role PostgreSQL will record as the grantor;
    - the snapshot after a change;
    - the impact, the warnings, the inverse, and the previews.
  - `exec.rs`: the only code that runs SQL that changes the database. It runs one transaction with lock and statement timeouts. A server warning that means nothing was granted or revoked fails it.
  - `commit.rs`: re-reads the snapshots, recomputes the preview and compares it with the one the user saw. It then checks the gate, makes the password, calls exec and writes the log.
  - `log.rs`: `db-changes.jsonl`.
  - `preset.rs` and `drop.rs`.
  - Tauri commands in `pg_commands.rs`.
- **Frontend** (`src/pg/`):
  - change and batch hooks and dialogs modeled on the IAM ones;
  - a tray and a 바꾸기 mode on the privileges table;
  - role editing, create-role with presets, safe drop and ending sessions;
  - a change log screen.

**Tech Stack:** as phase 1, plus two crates already in the lock file:
- `postgres-protocol` 0.6 (through tokio-postgres) for escaping and SCRAM-SHA-256;
- `rand` 0.10 for passwords.

## Global Constraints
- **Sources:**
  - Spec: `docs/superpowers/specs/2026-10-28-rds-postgres-users-design.md`, section "변경 (2단계)" and the phase-2 contract.
  - Phase-1 plan: `docs/superpowers/plans/2026-10-28-pg-users-phase1.md`. Its constraints still bind, except "No writes", which the next rule replaces.
  - Branch: `feat/pg-users`.
- **Where changes run:**
  - SQL that changes a database runs only in `pg/exec.rs`.
  - exec opens one transaction per change or batch with `build_transaction()`, not read-only. It runs `SET LOCAL lock_timeout = '5s'` and `SET LOCAL statement_timeout = '60s'` (the spec's write timeouts), then the statements, then COMMIT. On any error or fatal notice it rolls back.
  - exec is called only from the closures that `pg_commands.rs` hands to `commit::commit` and `drop::apply`, as IAM's `write_calls` does.
  - Every other query stays in `pg/catalog.rs`, in read-only transactions.
  - The hygiene test enforces all of this (QB4).
- **SQL text:**
  - Identifiers go only through `pg::sql::ident` and values only through `pg::sql::literal`. Both wrap `postgres_protocol::escape`. Keywords and privilege names come only from enums.
  - One exception: a function's argument list is the text the server printed (`pg_get_function_identity_arguments`). It is used only after the target matched a function in the snapshot exactly.
  - No other code formats names into SQL.
- **Secrets:**
  - IAM tokens follow the phase-1 rule.
  - A new password is generated in `pg/password.rs`: 24 characters from `ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789`, using OS randomness. It is hashed with `postgres_protocol::password::scram_sha_256` and sent as `PASSWORD 'SCRAM-SHA-256$…'`.
  - The plaintext appears exactly once: in the `password` field of the `pg_apply` result that created or reset it.
  - It never appears in a preview, the change log, an error, a log line, the PlanStore or `Debug` output. The same holds for its SCRAM hash.
  - Previews and the log show `PASSWORD '••••••••'`.
  - Every type that carries the plaintext or the verifier gets a masking `Debug` and never derives it: `NewPassword`, `ScramHash`, exec's `Step` and `PgApplyResult`. The hygiene test checks this.
  - tokio-postgres logs full SQL at debug level. No logger is installed today. Any future logger must cap `tokio_postgres` at Info.
- **Plans:**
  - Every preview is remembered in IAM's `PlanStore`, keyed by the target key plus the change, or plus the database and the changes.
  - Apply re-reads the cluster and the execution database, recomputes the preview, and compares the whole preview with the remembered one: SQL, warnings, impacts, role and default deltas. Any difference rejects with the stale text.
  - A plan is used at most once.
- **Execution database:**
  - A `grant` or `defaultPrivilege` change runs in its `database`, and so does a `createRole` whose preset names one.
  - Every other change runs in the target's default database.
  - A batch runs in its one database.
- **System roles:** as in phase 1. The system groups that may gain or lose members are `rds_superuser`, `rds_iam`, `rds_password`, `rds_replication`, `pg_read_all_data`, `pg_write_all_data`, `pg_monitor`, `pg_read_all_settings`, `pg_read_all_stats`, `pg_stat_scan_tables` and `pg_signal_backend`.
- **UI copy:** Korean 해요체, as in phase 1. A role or object name never takes a particle directly. Put "역할" after it, or put the name after a colon.
- **Exact strings.** These are new; the phase-1 strings stay. `${…}` are values.
  - **Gate:** the same as IAM.
    - `막혀 있어서 적용할 수 없어요: ${messages joined with " / "}`
    - `확인 문구가 달라요. 입력해야 할 이름: ${confirmText}`
    - "확인할 이름을 알 수 없어서 적용할 수 없어요"
  - **Apply:**
    - Stale: "미리보기 뒤에 바뀌었어요. 미리보기를 다시 받아 주세요"
    - Failed: `적용하지 못했어요: ${reason}`. `reason` is the server's message or the fatal notice's message.
    - Lock: "다른 작업이 객체를 잠그고 있어 적용하지 못했어요. 잠시 뒤 다시 시도하세요"
    - Session already gone: "세션이 이미 끝났어요"
    - Connection lost before COMMIT was sent: "적용하지 못했어요: 데이터베이스 연결이 끊겼어요"
    - Connection lost while waiting for COMMIT's reply: "데이터베이스 연결이 끊겨 적용됐는지 알 수 없어요. 다시 읽어서 확인해 주세요"
    - Note when a re-read after that shows the change applied: "연결이 끊겼지만 적용된 것을 확인했어요"
    - Added to the unknown text for a `password` change: " 비밀번호를 다시 재설정해 주세요"
  - **Change controls:**
    - Read replica: "읽기 전용 복제본이라 바꿀 수 없어요"
    - The login can't manage roles: phase 1's manage reason.
  - **Tray:**
    - Another database: "다른 데이터베이스의 변경이 담겨 있어요. 먼저 적용하거나 비워 주세요"
    - Full: "한 번에 50개까지 담을 수 있어요"
    - Batch empty: "담긴 변경이 없어요"
    - Batch over the limit: "한 번에 50개까지 적용할 수 있어요"
    - Not a tray change: "장바구니에 담을 수 없는 변경이에요"
    - The same target twice: "같은 대상의 변경이 두 번 담겨 있어요"
  - **Blocked** (level block):
    - System role: `시스템 역할이라 바꿀 수 없어요: ${role}`
    - System group: `이 시스템 역할에는 구성원을 넣거나 뺄 수 없어요: ${group}`
    - Own session: "이 앱의 세션은 끊을 수 없어요"
    - Superuser session: `superuser 세션은 끊을 수 없어요: ${role}`
    - Terminate rights: "이 세션을 끊을 권한이 없어요. pg_signal_backend 권한이 있어야 해요"
    - Superuser or replication target: `superuser나 REPLICATION 역할은 바꿀 수 없어요: ${role}`
    - Alter rights, before 160000: `${role} 역할을 바꿀 권한이 없어요. CREATEROLE이 있어야 해요` (the login's own attribute; attributes aren't inherited)
    - Alter rights, from 160000: `${role} 역할을 바꿀 권한이 없어요. CREATEROLE과 이 역할에 대한 ADMIN OPTION이 있어야 해요`
    - Create rights: "역할을 만들 권한이 없어요. CREATEROLE이 있어야 해요"
    - CREATEDB, from 160000: "CREATEDB를 주거나 빼려면 로그인한 역할에도 CREATEDB가 있어야 해요"
    - Membership rights, before 160000: `${group} 역할의 구성원을 바꿀 권한이 없어요. CREATEROLE이나 ${group} 역할에 대한 ADMIN OPTION이 있어야 해요`
    - Membership rights, from 160000: `${group} 역할의 구성원을 바꿀 권한이 없어요. ${group} 역할에 대한 ADMIN OPTION이 있어야 해요`
    - Membership from another grantor, from 160000: `${member} 역할을 ${group} 역할에서 뺄 수 없어요. 이 구성원 관계는 ${grantor} 역할이 줬어요`
    - ADMIN only through non-inheriting memberships, from 160000: `${group} 역할의 구성원을 바꿀 수 없어요. ADMIN OPTION을 가진 역할의 권한을 물려받아야 해요`
    - Dependent membership, from 160000: `${member} 역할이 ${group} 역할을 다른 역할에 줬어요. 그 구성원 관계부터 빼야 해요`
    - Grant rights, one object: `${object}에 ${privileges} 권한을 줄 수 없어요. 소유자 ${owner} 역할의 권한을 물려받거나 GRANT OPTION이 있어야 해요`
    - Grant rights, several objects: `객체 ${count}개에 ${privileges} 권한을 줄 수 없어요(예: ${sample}). 소유자(${owners}) 역할의 권한을 물려받거나 GRANT OPTION이 있어야 해요`. `sample` is the first 3 object names and `owners` the distinct owners of all of them, both in name order and joined with ", ".
    - Revoke rights: the same two sentences with "에서 … 권한을 뺄 수 없어요" in place of "에 … 권한을 줄 수 없어요".
    - Dependent grants: `${grantee} 역할이 ${object}의 ${privilege} 권한을 다른 역할에 다시 줬어요. 그 권한부터 빼야 해요`
    - Default privileges, before 160000: `${creator} 역할의 기본 권한을 바꿀 수 없어요. 로그인한 역할이 ${creator} 역할의 구성원이어야 해요`
    - Default privileges, from 160000: `${creator} 역할의 기본 권한을 바꿀 수 없어요. 로그인한 역할이 ${creator} 역할의 권한을 물려받아야 해요`
    - Bad role name: "역할 이름이 올바르지 않아요. 1~63바이트이고 pg_로 시작하지 않아야 해요"
    - Reserved name: "이 이름은 PostgreSQL이 예약해 둬서 쓸 수 없어요"
    - Name taken: `이미 있는 역할이에요: ${name}`
    - Unknown role: `역할을 찾을 수 없어요: ${role}`
    - Empty privilege list: "권한을 하나 이상 골라야 해요"
    - A grant change with no items: "바꿀 객체가 없어요"
    - A role named PUBLIC: "PUBLIC이라는 이름의 역할은 이 앱에서 바꿀 수 없어요"
    - Password commands restricted: "비밀번호나 만료일을 바꾸려면 로그인한 역할이 rds_password 구성원이어야 해요(rds.restrict_password_commands가 켜져 있어요)"
    - Execution database: `이 데이터베이스에서는 바꿀 수 없어요: ${database}`
    - Unknown object: `객체를 찾을 수 없어요: ${object}`
    - Wrong privilege: `${object}에는 ${privilege} 권한이 없어요`
    - Schemas object type with a schema: "스키마의 기본 권한은 모든 스키마에만 줄 수 있어요"
    - Undoing a create after more was added: "만든 뒤에 객체나 권한이 생겨서 되돌릴 수 없어요"
    - Drop the login: "앱이 로그인한 역할은 삭제할 수 없어요"
    - Bad reassign target: `넘겨받을 역할로 쓸 수 없어요: ${role}`
    - Reassign rights: `${role} 역할의 권한을 물려받아야 그 역할에게 넘길 수 있어요`
    - Drop rights: `${role} 역할을 삭제할 권한이 없어요. ${requirement}`. The requirement is the second sentence of the matching alter-rights text, or "로그인한 역할에 INHERIT가 있어야 해요" for a NOINHERIT login before 160000.
    - Drop, privileges that would stay: `${role} 역할이 받은 권한 중 로그인한 역할이 뺄 수 없는 것이 있어요(${count}개, 예: ${sample}). 준 역할: ${grantors}`
    - Drop, reassign checks: `${reassignTo} 역할에게 넘길 수 없어요: ${object}. ${reason}`, where `reason` is `데이터베이스 ${db}에 CREATE 권한이 있어야 해요`, `스키마 ${schema}에 CREATE 권한이 있어야 해요` or `로그인한 역할이 ${reassignTo} 역할로 SET ROLE 할 수 있어야 해요`
    - Drop, truncated databases: `객체가 많아 일부만 읽은 데이터베이스가 있어 삭제 계획을 만들 수 없어요: ${names joined with ", "}`
    - Unreachable databases: `연결하지 못한 데이터베이스가 있어 삭제 계획을 만들 수 없어요: ${names joined with ", "}`
  - **Confirm** (level confirm):
    - rds_superuser: "rds_superuser를 주면 대부분의 관리 작업을 할 수 있게 돼요"
    - CREATEROLE: "CREATEROLE을 주면 역할을 만들고 바꿀 수 있게 돼요"
    - PUBLIC grant: "모든 역할(PUBLIC)에 권한을 줘요"
    - Drop: "역할을 삭제해요. 되돌릴 수 없어요"
    - Terminate: "세션을 끊어요. 되돌릴 수 없어요"
    - Big group: `구성원이 ${n}명인 그룹의 권한을 바꿔요`
    - Login loses access: "적용하면 이 앱이 다시 접속하지 못할 수 있어요"
    - Truncated snapshot: "객체가 많아 일부만 읽었어요. 영향에 없는 객체에도 적용돼요"
    - Drop deletes granted memberships, from 160000: `이 역할이 준 구성원 관계 ${n}개가 함께 지워져요. ${k}개는 다른 부여가 없어 구성원이 그룹에서 빠져요(예: ${sample})`, where `sample` is the first 3 `${member} → ${group}` that leave, in name order
  - **Warn** (level warn):
    - All tables without defaults: "새로 만드는 테이블에는 적용되지 않아요", with the button "기본 권한도 담기"
    - All sequences without defaults: "새로 만드는 시퀀스에는 적용되지 않아요", with the same button
    - No-op: "이미 그 상태라 달라지는 게 없어요"
    - Grants that stay: `다른 역할이 준 권한은 남아요(${count}개, 예: ${sample})`
    - Memberships that stay: `다른 역할이 준 구성원 관계는 남아요: ${grantors joined with ", "}`
    - rds_iam user: "이 사용자는 rds_iam 구성원이라 비밀번호로는 로그인하지 못해요"
    - Sessions stay: `이 역할로 접속한 세션 ${n}개는 끊기지 않아요`
    - Global default: "스키마별 기본 권한에서는 모든 스키마에 준 권한을 뺄 수 없어요. 모든 스키마의 기본 권한에서 빼 주세요"
    - LOGIN off: "LOGIN을 끄면 이 역할은 역할 목록의 그룹 쪽에 보여요"
    - Impact limited to one database: `영향은 ${database} 데이터베이스만 계산했어요`
  - **Undo:**
    - Not found: "변경 기록을 찾을 수 없어요"
    - Not undoable: "되돌릴 수 없는 변경이에요"
    - Already undone: "이미 되돌린 변경이에요"
    - Another target: `다른 대상의 변경이에요: ${arn}`
  - **Drop result:** `${total}개 데이터베이스 중 ${done}개를 정리하고 멈췄어요: ${reason}`
  - **Summaries:**
    - `역할 만들기: ${name}`
    - `그룹에 넣기: ${member} → ${group}` and `그룹에서 빼기: ${member} → ${group}`
    - `ADMIN OPTION 주기: ${member} → ${group}` and `ADMIN OPTION 빼기: ${member} → ${group}`
    - `속성 바꾸기: ${role}`
    - `비밀번호 재설정: ${role}`
    - `권한 주기: ${grantee} · ${what}` and `권한 빼기: ${grantee} · ${what}`
    - `기본 권한 주기: ${creator} → ${grantee}` and `기본 권한 빼기: ${creator} → ${grantee}`
    - `역할 삭제: ${role}`
    - `세션 끊기: ${role} (pid ${pid})`
    - A batch: `변경 ${n}개`
  - **What** (inside a grant summary):
    - One item: `${target label} ${privileges joined with ", "}`
    - Several items: `객체 ${n}개`
    - Target labels:
      - database: `데이터베이스 ${name}`
      - schema: `스키마 ${name}`
      - relation or sequence: `${schema}.${name}`
      - function: `${schema}.${name}(${signature})`
      - all tables: `${schema} 스키마의 모든 테이블`
      - all sequences: `${schema} 스키마의 모든 시퀀스`
    - `PUBLIC` reads as "모든 역할(PUBLIC)" in summaries.
  - **Owner-held aspect** (not toggleable in 바꾸기 mode): title "소유자라서 가진 권한이에요"
  - **Preview header:** `적용할 DB 사용자: ${loginUser}`
  - **Confirm field label:** `확인하려면 입력하세요: ${confirmText}`
  - **Refresh after apply failed:** "적용은 됐지만 목록을 다시 읽지 못했어요. [다시 읽기]를 눌러 주세요"
  - **Password result:**
    - Title "새 비밀번호"
    - Note "이 창을 닫으면 다시 볼 수 없어요"
    - Buttons "복사" and "닫기"
    - After copying: "복사했어요"
- **Limits:**
  - A batch holds at most 50 changes.
  - Impacts list at most 30 roles; the rest go into `impactsOmitted`.
  - Each delta keeps at most 5 sample names.
  - Writes: `lock_timeout` 5 s and `statement_timeout` 60 s. Reads keep phase 1's 30 s.
  - A big group has 10 or more direct members.
- **Verification:** as in phase 1. The live tests add the change scenarios.
- **Commits:**
  - Each commit ends with the `Co-Authored-By:` trailer your own session's attribution gives you. Stage by explicit path.
  - Backend tasks (QB1 to QB5) own `src-tauri/` and `scripts/pg-live-test.sh`.
  - Frontend tasks (QF1, QF2a, QF2b, QF3) own `src/`. QF3 also owns `docs/manual-test-checklist.md` and `README.md`.

## Contract (phase-2 additions)
Rust structs serialize with `#[serde(rename_all = "camelCase")]`. Enums are tagged with `#[serde(tag = "kind", rename_all = "camelCase")]`.

```ts
export type PgGrantTarget =
  | { kind: "database"; name: string }
  | { kind: "schema"; name: string }
  | { kind: "relation"; schema: string; name: string }          // table, view, matview, partitioned, foreign
  | { kind: "sequence"; schema: string; name: string }
  | { kind: "function"; schema: string; name: string; signature: string }
  | { kind: "allTables"; schema: string }
  | { kind: "allSequences"; schema: string };
export interface PgGrantItem { target: PgGrantTarget; privileges: string[] }   // aclexplode names, e.g. "SELECT", "TEMPORARY"
export type PgPresetKind = "readOnly" | "readWrite" | "owner" | "admin";
export interface PgPresetChoice {
  preset: PgPresetKind;
  database: string | null;     // null only for admin
  schemas: string[];           // empty only for admin
  creators: string[];          // readOnly/readWrite: roles whose new tables and sequences get default privileges
  group: string | null;        // the group that takes the privileges; null = the new role itself, or admin
  createGroup: boolean;        // true: `group` is created in the same transaction
}
export interface PgAttributesSet {
  login: boolean; createDb: boolean; createRole: boolean; inherit: boolean;
  connectionLimit: number;     // -1 = 제한 없음
  validUntil: string | null;   // ISO 8601 UTC, null = 없음
}
export type PgChange =
  | { kind: "createRole"; name: string; login: boolean; groups: string[]; connectionLimit: number; validUntil: string | null; preset: PgPresetChoice | null }
  | { kind: "membership"; group: string; member: string; add: boolean; admin: boolean }
  | { kind: "attributes"; role: string; set: PgAttributesSet }     // the whole wanted set
  | { kind: "password"; role: string }
  | { kind: "grant"; database: string; grantee: string; add: boolean; items: PgGrantItem[] }   // grantee "PUBLIC" = 모든 역할
  | { kind: "defaultPrivilege"; database: string; creator: string; schema: string | null; objectType: PgDefaultObjectType; grantee: string; privileges: string[]; add: boolean }
  | { kind: "dropRole"; role: string }                               // only as the undo of createRole
  | { kind: "terminate"; pid: number; role: string; backendStart: string | null };   // guard: pid + role, plus the start second when known

export type PgWarnLevel = "block" | "confirm" | "warn";
export interface PgWarning { level: PgWarnLevel; message: string; add: PgChange[] }   // add: what "기본 권한도 담기" puts in the tray; usually empty
export interface PgPrivDelta { database: string; schema: string | null; objectKind: PgObjectKind; privilege: string; count: number; sample: string[] }
export interface PgImpact { role: string; gained: PgPrivDelta[]; lost: PgPrivDelta[] }
export interface PgDefaultDelta { before: PgDefaultAclRow | null; after: PgDefaultAclRow | null }   // one default-privilege record, before and after
export interface PgRoleDelta {
  role: string; created: boolean; dropped: boolean;
  attributes: { name: string; before: string; after: string }[];
  groupsAdded: string[]; groupsRemoved: string[];
}
export interface PgPreview {
  change: PgChange; database: string; summary: string; loginUser: string;   // the DB user the change runs as
  sql: string[];               // run order; passwords masked
  impacts: PgImpact[]; impactsOmitted: number; roles: PgRoleDelta[]; defaults: PgDefaultDelta[];
  warnings: PgWarning[];       // block, then confirm, then warn
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
  undoOf: string | null; undone: boolean; batchId?: string;   // batchId is left out when null, as in IAM
}
export interface PgUndo { database: string; changes: PgChange[]; undoOf: string[] }
export interface PgPresetSuggestion { matching: string[]; proposedName: string; creators: string[]; blockedCreators: { role: string; reason: string }[] }   // blockedCreators: creators the login can't set defaults for, with the block text
export interface PgDropStep { database: string | null; sql: string[]; owned: number; privileges: number; defaults: number }  // database null = the default database
export interface PgDropPlan {
  role: string; reassignTo: string; steps: PgDropStep[]; warnings: PgWarning[]; confirmText: string; sessions: number;
  grantedMemberships: { member: string; group: string; lost: boolean }[];   // from 160000: rows this role granted, which DROP OWNED deletes; lost = no other grantor's row
}
export interface PgDropResult { logId: string; total: number; done: number; stopped: string | null }   // stopped = the drop-result text
```

Additions to phase-1 types (fields only):
- `PgSchemaCell.direct: { usage: boolean; create: boolean; read: PgCoverage; write: PgCoverage }`. These are the same four values computed from Direct sources only. The editable grid toggles them. Owner sources are left out, so an owner's own entries are never toggled.
- `PgSchemaCell.owned: { usage: boolean; create: boolean; read: PgCoverage; write: PgCoverage }`, computed from Owner sources only.
- `PgDbPrivilegeRow.direct` and `PgDbPrivilegeRow.owned`: `{ connect: boolean; create: boolean; temp: boolean }`, with the same rules.

Commands (all take `target` first and need `pg_open`, except `pg_change_log`, `pg_undo` and `pg_undo_batch`):

| command | args | returns |
|---|---|---|
| `pg_preview` | `target, change` | `PgPreview` |
| `pg_apply` | `target, change, confirmText, undoOf` | `PgApplyResult` |
| `pg_preview_batch` | `target, database, changes` | `PgBatchPreview` |
| `pg_apply_batch` | `target, database, changes, confirmText, undoOf` | `PgBatchResult`; `undoOf: string[] \| null` |
| `pg_preset` | `target, database, preset, schemas` | `PgPresetSuggestion` |
| `pg_drop_plan` | `target, role, reassignTo` | `PgDropPlan` |
| `pg_apply_drop` | `target, role, reassignTo, confirmText` | `PgDropResult` |
| `pg_change_log` | (none) | `PgChangeLogEntry[]`, newest first |
| `pg_undo` | `logId` | `PgUndo` for that entry |
| `pg_undo_batch` | `batchId` | `PgUndo` for the batch's undoable entries, last applied first (failed, undone and not-undoable entries are skipped, as in IAM) |

The spec lists `pg_undo` as returning `PgChange`. The undo of a created role needs several changes in one transaction, so it returns `PgUndo` instead, and `pg_undo_batch` is added as IAM has it. The spec's line is updated in the same commit as this plan.

## Execution order
- The backend track (QB1 → QB2 → QB3 → QB4 → QB5) and the frontend track (QF1 → QF2a → QF2b → QF3) run in parallel. The frontend mocks the contract.
- K2 is the whole-branch review after both tracks finish. Then the branch merges to `main` and is pushed. There is no release.

---

### Task QB1: Change model, SQL builders, passwords and membership grantors

**Files:**
- Create:
  - `src-tauri/src/pg/sql.rs`: quoting.
  - `src-tauri/src/pg/password.rs`.
  - `src-tauri/src/pg/change.rs`: the module root, declaring `model`, `sql_text` and `text`.
  - `src-tauri/src/pg/change/model.rs`: the Contract's change types.
  - `src-tauri/src/pg/change/sql_text.rs`: statement builders.
  - `src-tauri/src/pg/change/text.rs`: summaries and labels.
  - Tests in `#[cfg(test)]` modules next to them, or in `<file>/tests.rs` when a file passes about 400 lines.
- Modify:
  - `src-tauri/Cargo.toml`: `postgres-protocol = "0.6"` and `rand = "0.10"`. Both are already in Cargo.lock, so nothing new is downloaded. Check that `cargo tree -d` shows no second copy of either.
  - `src-tauri/src/pg.rs`: modules.
  - `src-tauri/src/pg/model.rs`: `MemberRec.grants`, `RoleRec.oid`, and three `ClusterSnapshot` fields.
  - `src-tauri/src/pg/catalog.rs`: the members query keeps one grant per grantor, the roles query reads `oid`, and the cluster read gets the three settings.
  - `src-tauri/src/pg/fixtures.rs`.
  - `src-tauri/src/pg/live_tests.rs`.

**Interfaces:**
- Consumes `pg::model` (`Privilege`, `DefaultObjType`, `MemberRec`, `MEMBERSHIP_OPTIONS_SINCE`).
- Produces:

```rust
// pg::sql
pub fn ident(name: &str) -> String;      // postgres_protocol::escape::escape_identifier
pub fn literal(value: &str) -> String;   // escape_literal with its leading space trimmed: 'x' or E'x\\y'
pub fn grantee(name: &str) -> String;    // "PUBLIC" -> PUBLIC (keyword), anything else -> ident(name)

// pg::password
pub struct NewPassword(String);          // no Clone, Display or Serialize. Debug prints NewPassword(••••••••)
impl NewPassword {
    pub fn generate() -> NewPassword;    // 24 chars from the Global Constraints alphabet: rand 0.10's `rand::rng()` (ThreadRng, a CSPRNG reseeded from the OS) with `RngExt::random_range` per character
    pub fn scram(&self) -> ScramHash;    // postgres_protocol::password::scram_sha_256(self.0.as_bytes())
    pub fn expose(self) -> String;       // only the pg_apply result calls this (QB4)
}
pub struct ScramHash(String);            // Debug prints ScramHash(••••••••)
impl ScramHash { pub fn sql_literal(&self) -> String; }   // literal(&self.0)

// pg::change::model: the Contract's types in Rust
pub enum GrantTarget { Database { name: String }, Schema { name: String }, Relation { schema: String, name: String }, Sequence { schema: String, name: String }, Function { schema: String, name: String, signature: String }, AllTables { schema: String }, AllSequences { schema: String } }
pub struct GrantItem { pub target: GrantTarget, pub privileges: Vec<Privilege> }   // serde: aclexplode names; unknown names fail to deserialize
pub enum PresetKind { ReadOnly, ReadWrite, Owner, Admin }
pub struct PresetChoice { pub preset: PresetKind, pub database: Option<String>, pub schemas: Vec<String>, pub creators: Vec<String>, pub group: Option<String>, pub create_group: bool }
pub struct AttributesSet { pub login: bool, pub create_db: bool, pub create_role: bool, pub inherit: bool, pub connection_limit: i32, pub valid_until: Option<String> }
pub enum PgChange { CreateRole { name, login, groups, connection_limit, valid_until, preset: Option<PresetChoice> }, Membership { group, member, add, admin }, Attributes { role, set: AttributesSet }, Password { role }, Grant { database, grantee, add, items: Vec<GrantItem> }, DefaultPrivilege { database, creator, schema: Option<String>, object_type: DefaultObjType, grantee, privileges: Vec<Privilege>, add }, DropRole { role }, Terminate { pid: i32, role: String, backend_start: Option<String> } }
impl PgChange { pub fn execution_database<'a>(&'a self, default_db: &'a str) -> &'a str; }   // Global Constraints rule

// pg::change::sql_text
pub enum Part { Text(String), Password }
pub struct Statement { pub parts: Vec<Part>, pub expect: Option<&'static str> }   // expect: the error text when the first column of the first row isn't true
impl Statement {
    pub fn shown(&self) -> String;                  // Password -> PASSWORD '••••••••'
    pub fn run(&self, hash: Option<&ScramHash>) -> String;   // Password -> PASSWORD <hash literal>. Panics if a Password part has no hash (a bug, not user input)
}
pub enum AttrClause { Login(bool), CreateDb(bool), CreateRole(bool), Inherit(bool), ConnectionLimit(i32), ValidUntil(Option<String>) }
pub enum OnClause<'a> { Database(&'a str), Schema(&'a str), Table(&'a str, &'a str), Sequence(&'a str, &'a str), Routine(&'a str, &'a str, &'a str), AllTables(&'a str), AllSequences(&'a str) }
pub fn create_role(name: &str, login: bool, with_password: bool, connection_limit: i32, valid_until: Option<&str>) -> Statement;
pub fn alter_role(role: &str, clauses: &[AttrClause]) -> Statement;
pub fn alter_role_password(role: &str) -> Statement;
pub fn drop_role(role: &str) -> Statement;
pub fn grant_role(group: &str, member: &str, admin: bool, inherit_true: bool) -> Statement;   // inherit_true: append WITH INHERIT TRUE (PG16 drop plan only)
pub fn revoke_role(group: &str, member: &str, admin_only: bool, granted_by: Option<&str>) -> Statement;
pub fn grant_privileges(privileges: &[Privilege], on: &OnClause, grantee: &str) -> Statement;
pub fn revoke_privileges(privileges: &[Privilege], on: &OnClause, grantee: &str) -> Statement;
pub fn alter_default_privileges(creator: &str, schema: Option<&str>, add: bool, privileges: &[Privilege], object_type: DefaultObjType, grantee: &str) -> Statement;
pub fn terminate(pid: i32, role: &str, backend_start: Option<&str>) -> Statement;   // expect: "세션이 이미 끝났어요"
pub fn reassign_owned(role: &str, to: &str) -> Statement;
pub fn drop_owned(role: &str) -> Statement;

// pg::change::text
pub fn summary(change: &PgChange) -> String;          // Global Constraints "Summaries"
pub fn target_label(target: &GrantTarget) -> String;  // Global Constraints "Target labels"
pub fn grantee_label(name: &str) -> String;           // "PUBLIC" -> "모든 역할(PUBLIC)"

// pg::model (fields added)
pub struct MemberGrant { pub grantor: String, pub admin: bool, pub inherit: Option<bool>, pub set: Option<bool> }
// MemberRec gains `pub grants: Vec<MemberGrant>`, in grantor-name order. The merged fields stay as they are.
// RoleRec gains `pub oid: u32`: PostgreSQL breaks ties between roles at one BFS depth in OID order.
// ClusterSnapshot gains:
//   `pub bootstrap_superuser: String`     -- SELECT rolname FROM pg_roles WHERE oid = 10 (rdsadmin on RDS)
//   `pub createrole_self_grant: String`   -- current_setting('createrole_self_grant') from 160000, "" before
//   `pub restrict_password_commands: bool` -- current_setting('rds.restrict_password_commands', true) = 'on'
```

- [ ] **Step 1: Failing tests.**
  - **Quoting:**
    - `ident("alice") == "\"alice\""` and `ident("a\"b") == "\"a\"\"b\""`.
    - `ident("x\"); DROP TABLE t;--")` gives one quoted identifier with the inner quote doubled.
    - `ident("앱_읽기") == "\"앱_읽기\""`.
    - `literal("O'Brien") == "'O''Brien'"`, `literal("a\\b") == "E'a\\\\b'"` and `literal("2027-01-01T00:00:00Z") == "'2027-01-01T00:00:00Z'"`.
    - `grantee("PUBLIC") == "PUBLIC"`.
  - **Builders.** Each `shown()` text is exact:
    - `CREATE ROLE "alice" LOGIN PASSWORD '••••••••' CONNECTION LIMIT 5 VALID UNTIL '2027-01-01T00:00:00Z'`. A group is `CREATE ROLE "app_read" NOLOGIN`. A limit of -1 and a `None` expiry add nothing.
    - `ALTER ROLE "alice" NOLOGIN CREATEDB NOCREATEROLE INHERIT CONNECTION LIMIT -1 VALID UNTIL 'infinity'`. Clauses come in that order and only the given ones appear. `ValidUntil(None)` is `'infinity'`.
    - `ALTER ROLE "alice" PASSWORD '••••••••'`
    - `DROP ROLE "alice"`
    - Role membership:
      - `GRANT "app_read" TO "alice"`
      - `… WITH ADMIN OPTION`
      - `GRANT "alice" TO "iam_admin" WITH INHERIT TRUE`
      - `REVOKE "app_read" FROM "alice"`
      - `REVOKE ADMIN OPTION FOR "app_read" FROM "alice"`
      - `REVOKE "app_read" FROM "alice" GRANTED BY "ops_admin"`
    - Object privileges:
      - `GRANT SELECT, INSERT ON TABLE "app"."orders" TO "app_read"`
      - `GRANT SELECT, USAGE ON SEQUENCE "app"."orders_id_seq" TO "app_read"`
      - `GRANT EXECUTE ON ROUTINE "app"."touch_order"(integer) TO "app_read"`
      - `GRANT USAGE ON SCHEMA "app" TO "app_read"`
      - `GRANT CONNECT, TEMPORARY ON DATABASE "orders" TO "app_read"`
      - `GRANT SELECT ON ALL TABLES IN SCHEMA "app" TO "app_read"`
      - `REVOKE SELECT ON ALL SEQUENCES IN SCHEMA "app" FROM PUBLIC`
    - Default privileges:
      - `ALTER DEFAULT PRIVILEGES FOR ROLE "app_owner" IN SCHEMA "app" GRANT SELECT ON TABLES TO "app_read"`
      - `ALTER DEFAULT PRIVILEGES FOR ROLE "app_owner" REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`
      - `ON SEQUENCES`, `ON TYPES` and `ON SCHEMAS` for the other object types.
    - Ending a session:
      - `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = 12345 AND usename = 'bob' AND date_trunc('second', backend_start) = '2026-10-28T12:00:00Z'::timestamptz`
      - Without a start time, the last condition is left out.
      - `expect == Some("세션이 이미 끝났어요")`
    - Ownership: `REASSIGN OWNED BY "alice" TO "iam_admin"` and `DROP OWNED BY "alice"`.
    - Privilege lists are in the `Privilege` enum's order (SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN, EXECUTE, USAGE, CREATE, CONNECT, TEMPORARY) whatever order the caller passes.
    - `run(Some(&hash))` replaces only the Password part. A role named `x PASSWORD '••••••••'` keeps its name intact in both `shown()` and `run()`.
  - **Passwords:**
    - `generate()` gives 24 characters from the alphabet, and 1 000 calls are all distinct.
    - `format!("{:?}", p)` and `format!("{:?}", p.scram())` contain neither the password nor the hash.
    - `scram()` matches `^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$`. Two hashes of one password differ, because the salt is random.
  - **Serde:** every `PgChange` variant round-trips through the Contract's JSON shape. Check one exact JSON string per variant (`"kind":"createRole"`, `"objectType":"tables"`, `"privileges":["SELECT"]`). An unknown privilege name fails to deserialize.
  - **Text:**
    - One exact summary per kind. Examples:
      - `권한 주기: app_read · app 스키마의 모든 테이블 SELECT`
      - `권한 빼기: 모든 역할(PUBLIC) · 데이터베이스 orders CONNECT`
      - `권한 주기: app_read · 객체 3개`
      - `그룹에서 빼기: alice → app_read`
      - `세션 끊기: bob (pid 4242)`
    - A `membership` change with `admin: true` uses the ADMIN OPTION summaries.
  - **`execution_database`:**
    - A `grant` change and a `createRole` with a preset database give their database.
    - A `membership`, `attributes`, `password`, `dropRole` or `terminate` change gives the default database.
  - **New snapshot fields:** the catalog readers fill `oid`, `bootstrap_superuser`, `createrole_self_grant` (empty before 160000) and `restrict_password_commands` (false when the setting doesn't exist). The fixtures give every role a distinct `oid` in name order.
  - **Grants per grantor:**
    - With two rows for (alice, app_read), one from `postgres` and one from `ops_admin`, the members reader gives one `MemberRec` with `grants` in grantor order.
    - The merged `admin`, `inherit` and `set` fields are unchanged from today (the OR across grantors).
- [ ] **Step 2: Implement.**
  - Build the builders from `ident`, `literal`, `grantee` and fixed keywords only.
  - `Routine` takes the signature text as it is. Doc-comment the Global Constraints exception at that one place.
  - The members query also selects `pg_get_userbyid(am.grantor)`. `merge_members` collects the grants.
- [ ] **Step 3: Live check.** Add to `live_tests.rs`, on both versions:
  - The seeded `alice → app_write` membership has exactly one grant, from `postgres`.
  - `bootstrap_superuser` is `postgres` and `restrict_password_commands` is false on both versions. `createrole_self_grant` is "" on PG16.
  - On PG16, create `mm_admin` and run `GRANT app_write TO mm_admin WITH ADMIN OPTION`. Then, as `postgres`, run `GRANT app_write TO alice GRANTED BY mm_admin`. The membership now has two grants, from `mm_admin` and `postgres`.
  - Drop what the test created at its end, as the other live tests do.
- [ ] **Step 4: Verify** with `cargo test`, clippy and the live script. Mutation checks:
  - Make `Statement::run` replace the first occurrence of the mask in the joined text. The name test must fail.
  - Drop the `E` branch of `literal`. The backslash test must fail.
  - Restore both.
- [ ] **Step 4a: Carried from K1 (N1).** Two overlapping `pg_open` calls with different logins must not leave the older one remembered.
  - Give `PgState` a per-target open counter. Each `pg_open` takes the next number when it starts. `finish_open` refuses, and drops its snapshot and connections, when a later open was already accepted.
  - Test with two opens finishing out of order: the later-started login stays remembered and its connections stay open.
  - This touches `src-tauri/src/pg_commands.rs`; add it to the Modify list.
- [ ] **Step 5: Commit** with `feat(pg): change model, SQL builders, SCRAM passwords and membership grantors`.

### Task QB2: What the login may do, the operations a change becomes, and the snapshot after it

**Files:**
- Create:
  - `src-tauri/src/pg/change/rights.rs`
  - `src-tauri/src/pg/change/resolve.rs`: a change becomes operations, statements and block warnings.
  - `src-tauri/src/pg/change/after.rs`: applies operations to cloned snapshots.
  - Tests for each.
- Modify:
  - `src-tauri/src/pg/change.rs`
  - `src-tauri/src/pg/eval.rs`: direct and owned values in `SchemaCell`, plus the walks `Rights` needs that are private today: closures over any membership edge with each grant row's ADMIN flag, and the inheriting BFS with its depth, ties broken by role OID.
  - `src-tauri/src/pg/summary.rs`: `PgSchemaCell.direct` and `.owned`, `PgDbPrivilegeRow.direct` and `.owned`.
  - `src-tauri/src/pg/fixtures.rs`
  - `src-tauri/src/pg/live_tests.rs`

**Interfaces:**
- Consumes:
  - QB1's model and builders;
  - `pg::eval::{Ctx, Eval, RoleView, Obj, Source, SourceKind}`;
  - `pg::model` snapshots.
- Produces:

```rust
// pg::change::rights. The login user's standing, per PostgreSQL's own checks.
pub struct Rights<'a> { /* login, version, Eval over (cluster, db) */ }
impl<'a> Rights<'a> {
    pub fn new(cluster: &'a ClusterSnapshot, db: &'a DbSnapshot) -> Rights<'a>;   // login = cluster.login_user
    pub fn superuser(&self) -> bool;                      // the login's own flag
    pub fn has_privs_of(&self, role: &str) -> bool;       // the login itself, a superuser, or a role it inherits
    pub fn member_of(&self, role: &str) -> bool;          // any membership chain, inheriting or not
    pub fn can_manage(&self) -> bool;                     // phase 1's canManage rule
    pub fn create_role(&self) -> Result<(), String>;      // Err = the block text
    pub fn alter(&self, role: &RoleRec, clauses: &[AttrClause]) -> Result<(), String>;
    pub fn drop(&self, role: &RoleRec) -> Result<(), String>;
    pub fn membership_grantor(&self, group: &str) -> Result<String, String>;   // the grantor PostgreSQL records
    pub fn membership_revocations(&self, group: &str, member: &str) -> Revocations;
    pub fn defaults_for(&self, creator: &str) -> Result<(), String>;
    pub fn object_grantor(&self, obj: Obj, privileges: &[Privilege]) -> Option<String>;   // None = can't grant or revoke them all
    pub fn terminate(&self, session: &SessionRec, own_pids: &[i32]) -> Result<(), String>;
}
pub struct Revocations { pub rows: Vec<String>, pub remaining: Vec<String> }   // rows: grantors to name with GRANTED BY (from 160000; before that one empty-string row means a plain REVOKE); remaining: grantors whose rows stay

// pg::change::resolve
pub enum Op {
    CreateRole { name: String, login: bool, connection_limit: i32, valid_until: Option<String>, password: bool },
    AlterRole { role: String, clauses: Vec<AttrClause> },
    SetPassword { role: String },
    DropRole { role: String },
    GrantRole { group: String, member: String, admin: bool, grantor: String },
    RevokeRole { group: String, member: String, admin_only: bool, granted_by: Option<String>, row_grantor: String },
    Privileges { add: bool, on: OnTarget, privileges: Vec<Privilege>, grantee: String, effects: Vec<AclEffect> },
    DefaultAcl { creator: String, schema: Option<String>, object_type: DefaultObjType, privileges: Vec<Privilege>, grantee: String, add: bool },
    Terminate { pid: i32, role: String, backend_start: Option<String> },
}
pub enum OnTarget { Database(String), Schema(String), Relation(String, String), Sequence(String, String), Function(String, String, String), AllTables(String), AllSequences(String) }
pub struct AclEffect { pub object: ObjKey, pub privilege: Privilege, pub grantor: String }   // one ACL entry added or removed; AllTables/AllSequences expand here
pub enum ObjKey { Database(String), Schema(String), Relation(String, String), Function(String, String, String) }   // sequences are relations
pub struct Resolved { pub ops: Vec<Op>, pub statements: Vec<Statement>, pub blocks: Vec<String>, pub confirms: Vec<String>, pub stays: Vec<String>, pub memberships_stay: Vec<String> }
pub struct ResolveCtx<'a> { pub cluster: &'a ClusterSnapshot, pub db: &'a DbSnapshot, pub own_pids: &'a [i32], pub read_replica: bool }
pub fn resolve(ctx: &ResolveCtx, change: &PgChange) -> Resolved;

// pg::change::after
pub fn apply(cluster: &mut ClusterSnapshot, db: &mut DbSnapshot, ops: &[Op]);

// pg::eval (field added)
pub struct DirectCell { pub usage: bool, pub create: bool, pub read: Coverage, pub write: Coverage }
// SchemaCell gains `pub direct: DirectCell` (Direct sources only) and `pub owned: DirectCell` (Owner sources only), with the same rules as the shown values.
```

- [ ] **Step 1: Failing tests** on fixtures. Version-dependent rules are tested at 150000 and 160000.
  1. **Object grantor.** This is PostgreSQL's `select_best_grantor`.
     - The login is the owner, or a superuser: the owner is the grantor.
     - Otherwise, walk the login and then the roles it inherits, in BFS order, with ties at one depth in role OID order. The first role that holds a grant option for every asked privilege, directly in the ACL, is the grantor. A role that is the owner holds every grant option.
     - When no role holds them all, the result is None.
     - Tests:
       - the login inherits the owner;
       - the login holds `SELECT` WITH GRANT OPTION itself;
       - an inherited group holds it;
       - only half the privileges are grantable, which gives None;
       - a NOINHERIT path doesn't count.
  2. **Membership rights.**
     - **From 160000:**
       - Granting or revoking needs a superuser login, or ADMIN OPTION on the group held by the login or by a role in its membership closure (any chain). The group never counts as its own admin, and `pg_database_owner` can't get members.
       - The grantor (`check_role_grantor` with `select_best_admin`):
         - a superuser login: the bootstrap superuser;
         - otherwise the login, when its own row on the group has ADMIN;
         - otherwise the first role with ADMIN on the group in a BFS over inheriting edges, ties in OID order.
       - When ADMIN is reachable only through non-inheriting edges, the check passes but the server finds no grantor. Block with the ADMIN-through-non-inheriting text.
     - **Before 160000:** the login's own CREATEROLE, or ADMIN OPTION through any chain. The grantor is the login. Adding ADMIN OPTION to an existing pair also sets its grantor to the login.
     - **Both:** a superuser group needs a superuser login.
     - The block texts are the exact Global Constraints strings.
  3. **Membership revocations.**
     - **Before 160000:** one plain REVOKE.
     - **From 160000:** every REVOKE names its row with `GRANTED BY <row grantor>`, the login's own rows included.
       - A row can be revoked when the login `has_privs_of` its grantor.
       - Any other row stays and is listed in `remaining`.
     - When no row can be revoked, `resolve` blocks with the membership-from-another-grantor text.
     - **Dependent membership, from 160000:** removing a membership, or only its ADMIN, is blocked with the dependent-membership text when all of these hold:
       - the removed row carries ADMIN;
       - its member is the grantor of another row of the same group;
       - the member keeps no other ADMIN row on the group.
  4. **Default privileges.**
     - Before 160000, a `member_of(creator)` login passes, NOINHERIT included.
     - From 160000 the login needs `has_privs_of(creator)`.
     - A superuser login always passes, and so does the creator itself.
  5. **Alter and drop.**
     - A superuser login passes.
     - **Before 160000:** the login's own CREATEROLE. Attributes aren't inherited, so `can_manage` isn't enough.
     - **From 160000:** the login's own CREATEROLE plus ADMIN OPTION on the role (any chain, as in 2).
     - **Superuser or replication targets** are blocked for a non-superuser login on every version.
       - Before 160000 the server needs a superuser for both.
       - From 160000 the code checks only superuser targets, but the documented rule is non-replication roles only, so stay on that side.
     - **CREATEDB:** from 160000, a `CreateDb` clause needs CREATEDB on the login.
     - **Create:** the login's own CREATEROLE, or superuser, on every version.
     - **Password commands:** when `restrict_password_commands` is on, a password, a `createRole` with a password, or a `ValidUntil` clause needs the login in `rds_password` (any chain). Otherwise it is blocked with the restricted text.
  6. **Terminate.**
     - The login's own pids give the own-session block.
     - A superuser's session gives the superuser-session block for a non-superuser login.
     - Otherwise it passes when any of these holds:
       - the login is a superuser;
       - the login `has_privs_of` the session's role;
       - the login `has_privs_of("pg_signal_backend")`.
     - Failing all of those gives the terminate-rights text.
  7. **Resolve, statements and order.** One exact statement list per change kind on `fixtures::app_scene` (database `appdb`, schema `app`, owner `app_owner`, sequence `ticket_seq`, function `app.touch(order_id integer)`):
     - **createRole with a readOnly preset** (`createGroup: true`, group `app_read`, schemas `[app]`, creators `[app_owner]`) runs, in order:
       1. `CREATE ROLE "app_read" NOLOGIN`
       2. `CREATE ROLE "alice2" LOGIN PASSWORD '••••••••'`
       3. `GRANT CONNECT ON DATABASE "appdb" TO "app_read"`
       4. `GRANT USAGE ON SCHEMA "app" TO "app_read"`
       5. `GRANT SELECT ON ALL TABLES IN SCHEMA "app" TO "app_read"`
       6. `GRANT SELECT ON ALL SEQUENCES IN SCHEMA "app" TO "app_read"`
       7. `ALTER DEFAULT PRIVILEGES FOR ROLE "app_owner" IN SCHEMA "app" GRANT SELECT ON TABLES TO "app_read"`
       8. `ALTER DEFAULT PRIVILEGES FOR ROLE "app_owner" IN SCHEMA "app" GRANT SELECT ON SEQUENCES TO "app_read"`
       9. `GRANT "app_read" TO "alice2"`
       10. each extra group, `GRANT "<group>" TO "alice2"`, in the given order.
     - **readWrite** grants `SELECT, INSERT, UPDATE, DELETE` on all tables and `SELECT, USAGE` on all sequences. Its default privileges are `SELECT, INSERT, UPDATE, DELETE` on tables and `SELECT, USAGE` on sequences. (Statement texts always list privileges in `Privilege` enum order.)
     - **owner** grants CONNECT and `USAGE, CREATE` on each schema, with no default privileges.
     - **admin** gives `GRANT "rds_superuser" TO "<name>"` and nothing else from the preset.
     - **A group with a preset** (`login: false`, `group: null`) gets the grants itself.
     - **An existing group** (`createGroup: false`) gets nothing but the membership: steps 1 and 3 to 8 are left out, because a suggested group already holds the preset's privileges.
     - **attributes** emits only the clauses that differ from the snapshot. With no differences, there is no statement.
     - **membership:**
       - `add: true` → GRANT, and `admin: true` adds WITH ADMIN OPTION.
       - `add: false, admin: true` → REVOKE ADMIN OPTION FOR.
       - `add: false, admin: false` → REVOKE.
       - The revocation rows from 3 apply in both REVOKE forms.
     - **grant:** one statement per item, using the item's target. `effects` lists every (object, privilege, grantor) entry touched. `AllTables` expands to every relation of kind table, view, matview, partitioned or foreign in the schema. `AllSequences` expands to every sequence.
  8. **Blocks** collected by `resolve`. Each test checks the exact text.
     - read replica (every change);
     - system role target;
     - system group outside the Global Constraints list;
     - rights 1 to 6;
     - unknown role or object;
     - a privilege that the object kind doesn't have (relation: SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER; sequence: USAGE, SELECT, UPDATE; function: EXECUTE; schema: USAGE, CREATE; database: CONNECT, CREATE, TEMPORARY);
     - `schemas` with a schema;
     - role names: bad (empty, over 63 bytes, a `pg_` prefix, a control character), reserved (`public`, `none`, `current_role`, `current_user`, `session_user`, compared case-insensitively) and taken (the group to create too);
     - dependent grants (`aclupdate` and `recursive_revoke`): all of these hold —
       - the removed entry carries the grant option;
       - the grantee isn't the owner;
       - the grantee is the grantor of an entry for the same privilege on the same object;
       - the grantee keeps no grant option for that privilege through another entry or an inherited role;
     - when the cluster has a role named exactly `PUBLIC`: a change whose member, group, role or creator is `PUBLIC` (the PUBLIC-role text). A grantee `PUBLIC` always means the PUBLIC pseudo-role. The grid and the pickers don't offer a role named exactly `PUBLIC`;
     - the execution database: not in the cluster snapshot, not connectable, or a template or `rdsadmin` (a backstop; the commands check it before connecting, QB4 test 7);
     - `dropRole`, judged on the snapshot after the batch's earlier items, with the undo-after-create text when the role:
       - owns an object in the execution database;
       - appears in an ACL or default-ACL entry there;
       - or is the grantor of a membership row;
     - grant rights, one object and several objects. The several-objects text has its exact `sample` and `owners`.
  8a. **Truncated snapshot:** when the execution database's snapshot is truncated, an `allTables` or `allSequences` item, or a preset with schemas, adds the truncated-snapshot confirm warning. `resolve` returns it in a `confirms` list next to `blocks`.
  9. **Grants that stay.** A revoke whose grantee also holds the same entries from other grantors lists them in `stays`, as `${grantor} → ${object} ${privilege}`, in name order.
  10. **After.**
      - **Privileges:**
        - A grant adds `(grantor, grantee, privilege, grantable: false)` unless that entry exists.
        - A revoke removes the entries with the predicted grantor only.
      - **Memberships:**
        - GrantRole adds or updates the grant row from its grantor. From 160000 a new row has `inherit: Some(member.inherit)` and `set: Some(true)`; before 160000 both are None.
        - RevokeRole removes that row, or clears its admin flag. The merged fields are then recomputed, and a pair with no rows left disappears.
      - **Roles:**
        - CreateRole adds a `RoleRec` with INHERIT and every other flag off, and the next free `oid`.
        - From 160000, for a non-superuser login, CreateRole also adds a grant row with group = the new role, member = the login, grantor = the bootstrap superuser, admin true, inherit false and set false.
        - When `createrole_self_grant` isn't empty, it also adds a row from the login with admin false and the listed INHERIT and SET options.
        - Test: the readOnly preset with `createGroup: true` at 160000 isn't blocked by the membership rights, and its snapshot after has both rows.
        - AlterRole sets fields.
        - DropRole removes the role and every membership naming it.
      - **Sessions:** Terminate removes the session.
      - **Default privileges:**
        - Global record:
          - When absent, it starts from the built-in default. The creator holds every privilege of the type as grantor and grantee; from 170000 that includes MAINTAIN for tables. Functions add PUBLIC EXECUTE and types add PUBLIC USAGE.
          - The change is applied with the creator as grantor.
          - A record equal to the built-in default is removed.
        - Per-schema record: starts empty, and is removed when empty.
        - A per-schema revoke of an entry that only the global record or the built-in default holds changes nothing.
  11. **Direct and owned values:**
      - A role whose SELECT on every `app` table comes only through `app_read` has `read: All` and `direct.read: None`.
      - `app_owner`'s cell has `owned.read: All` and `direct.read: None`.
      - The database view's `direct` and `owned` follow the same rules.
- [ ] **Step 2: Implement.**
  - Build `Rights` on one `Eval` handle for the login, as PB3's fix round made it.
  - `resolve` never fails. Problems go into `blocks`, so the preview can still show the SQL.
- [ ] **Step 3: Live comparison** in `live_tests.rs`, on both versions. Use a scratch set of roles and objects created by the test and dropped at its end.
  - Create `mm_admin` (CREATEROLE, no superuser) with the memberships each case needs, and connect as it with a password. For each case below:
    1. Resolve the change as `mm_admin` on a fresh snapshot.
    2. Run the statements' `run(…)` text in one transaction as `mm_admin`, and commit. Statements with a Password part get a generated password's hash.
    3. Re-read the snapshot.
    4. Assert that the re-read ACLs, memberships (grant rows included), roles and default-privilege records equal `after::apply`'s prediction.
  - Cases:
    - a grant on a table `mm_admin` owns;
    - a grant through an inherited owner role;
    - a revoke that leaves another grantor's entry;
    - an `AllTables` grant on a schema with a view and a matview;
    - a global and a per-schema default grant, then their revokes;
    - membership add and remove, plus on PG16 a `GRANTED BY` revoke;
    - an attribute change;
    - a readOnly preset createRole with `createGroup: true` (on PG16 this checks the implicit ADMIN row).
  - For the blocked rights cases, run the statements anyway and assert that the server either raises an error or sends a class-01 warning. That is why exec must fail on class 01.
- [ ] **Step 4: Verify** with `cargo test`, clippy and the live script. Mutation checks:
  - The object grantor ignores grant options: test 1 and the live revoke case must fail.
  - The per-schema default revoke removes global entries: test 10 and the live default case must fail.
  - Restore both.
- [ ] **Step 5: Commit** with `feat(pg): rights, change operations and the snapshot after a change`.

### Task QB3: Impact, warnings, inverse and previews

**Files:**
- Create:
  - `src-tauri/src/pg/change/impact.rs`
  - `src-tauri/src/pg/change/warnings.rs`
  - `src-tauri/src/pg/change/inverse.rs`
  - `src-tauri/src/pg/change/preview.rs`: single and batch.
  - Tests for each.
- Modify: `src-tauri/src/pg/change.rs`, `src-tauri/src/pg/view.rs` (the Contract's preview types).

**Interfaces:**
- Consumes QB1 and QB2.
- Produces:

```rust
pub struct PreviewCtx<'a> { pub cluster: &'a ClusterSnapshot, pub db: &'a DbSnapshot, pub own_pids: &'a [i32], pub read_replica: bool, pub default_db: &'a str, pub now: i64 }   // now: Unix seconds, so the preview stays pure
pub fn preview(ctx: &PreviewCtx, change: &PgChange) -> PgPreview;                    // pure; db = the change's execution database
pub fn preview_batch(ctx: &PreviewCtx, database: &str, changes: &[PgChange]) -> PgBatchPreview;
pub fn inverse(ctx: &PreviewCtx, change: &PgChange) -> Option<Vec<PgChange>>;      // None = 되돌릴 수 없어요; Some(empty) = it changes nothing
pub fn confirm_target(change: &PgChange) -> &str;   // createRole: name; membership: member; attributes, password, dropRole, terminate: role; grant, defaultPrivilege: grantee
```

- [ ] **Step 1: Failing tests.**
  1. **Impact.**
     - Affected roles:
       - For a privilege operation, the grantee. PUBLIC means every role.
       - For a membership operation, the member.
       - For an inherit change, a create or a drop, that role.
       - In each case, plus every role that inherits from it, before or after.
     - For each affected role, compare its effective privileges before and after (any source), with one `Eval` per side. Group the differences by (database, schema, object kind, privilege). Each group has `count` and the first 5 names in name order as `sample`.
     - Only candidate objects are evaluated:
       - the objects in the operations' `effects`;
       - for membership, inherit, create and drop operations, every object whose ACL names a role in the changed role's closure, or that such a role owns;
       - every object when the upward closure over inheriting edges, before or after, contains `pg_read_all_data`, `pg_write_all_data`, `pg_maintain` (from 170000) or `pg_database_owner`. The closure starts from the changed group, or from the changed role for inherit, create and drop operations.
     - When `createrole_self_grant` includes `inherit`, the login is an affected role of a createRole.
     - Roles are listed in name order, at most 30. The rest are counted in `impactsOmitted`.
     - Tests:
       - a grant to `app_read` shows gains for app_read, app_write and alice;
       - removing alice from app_write shows her losses;
       - a PUBLIC grant affects every role;
       - the 30-role cap;
       - a membership into a group that is itself a member of `pg_read_all_data` shows gains on every fixture table.
     - Ignored release benchmark, under 2 s each, on 200 roles × 20 000 relations:
       - a membership change into a group with privileges on every relation, where the member has no inheritors;
       - a PUBLIC SELECT grant on one schema of 5 000 tables.
  2. **Role and default deltas.**
     - `roles` lists:
       - created and dropped roles;
       - attribute changes as (name, before, after), with names "LOGIN", "CREATEDB", "CREATEROLE", "INHERIT", "연결 수 제한" and "만료일", and the values "예"/"아니요", the number or "제한 없음", the date or "없음";
       - groups added and removed.
     - `defaults` lists each touched default-privilege record before and after, as `PgDefaultAclRow`, or null.
  3. **Confirm warnings.** One test for each, and one test for each that must not fire:
     - rds_superuser: a membership into `rds_superuser`, an admin preset, or `rds_superuser` in `groups`.
     - CREATEROLE: attributes turning `createRole` on.
     - PUBLIC grant: a privilege or default grant to PUBLIC with `add: true`.
     - Drop: `dropRole`.
     - Terminate: `terminate`.
     - Big group: a privilege or default change whose grantee is a group with ≥ 10 direct members, or a membership change whose member is such a group.
     - Login loses access: in the after snapshot, the login is no longer a member of `rds_iam` (any chain), `login` is off, `validUntil` is before `now`, or `can_manage` turns false.
     - Truncated snapshot: QB2's `confirms`.
  4. **Warns.**
     - All tables without defaults: an `allTables` grant (or `allSequences` grant) to G in schema S where some current owner C of tables (or sequences) in S has no default ACL that grants those privileges to G, a role G inherits, or PUBLIC. The ACL may be for S or global. Judge it on the snapshot after the whole change or batch, so a batch that already holds the defaults doesn't warn, and skip owners that are G or that G inherits. `add` holds one `defaultPrivilege` change per such C: (database, C, S, tables or sequences, G, the granted privileges, `add: true`).
     - Impact limited to one database: a membership, INHERIT, createRole or dropRole operation adds `영향은 ${database} 데이터베이스만 계산했어요`, since those change access in every database.
     - No-op: the after snapshot equals the before snapshot for this change.
     - Grants stay: from QB2's `stays`, with count and first 3.
     - Memberships stay: from QB2's `memberships_stay`.
     - rds_iam user: a password change for a role in `rds_iam`, or a createRole with `login: true` and `rds_iam` in `groups`.
     - Global default: a per-schema default revoke that changes nothing because the global record or the built-in default holds it.
     - LOGIN off: an `attributes` change that turns `login` off for a role that has it.
  5. **Ordering and confirm text.**
     - Warnings go block, then confirm, then warn. When anything blocks, confirm warnings are dropped and warns stay.
     - `confirmText` is null when no confirm warning remains. Otherwise:
       - for a single change, `confirm_target`;
       - for a batch, the common `confirm_target` when every change has the same one, otherwise `변경 ${n}개 적용`.
  6. **Inverse.**
     - createRole:
       - `[grant remove of the preset's grant items, defaultPrivilege remove per (creator, schema, type), dropRole name, dropRole group]`, for a group created in the same change.
       - These revokes keep the preset's `allTables` and `allSequences` items. The new group had nothing before, so revoking everything there is exact, and it also covers tables that got privileges through the default privileges since.
       - `[dropRole name]` with an existing group or no preset.
       - A group with a preset: its revokes then `dropRole`.
     - membership:
       - add without ADMIN: a remove of the row it created. When the row from that grantor already existed, `Some(vec![])`. From 160000, when only other grantors' rows existed, None: the GRANT adds a new row with default options, and a remove can't name only that row.
       - add with `admin: true`: a full remove when the pair had no row before, and an ADMIN-only remove when it had one.
       - remove, from 160000: `Some([add])`, with `admin: true` when the removed row had ADMIN, only when every removed row had inherit equal to the member's `rolinherit`, set true, and the grantor a re-grant would get. Otherwise None, because a re-grant can't restore those options or grantors.
       - remove, before 160000: the opposite add, with ADMIN when the removed row had it.
       - Test each case.
     - attributes: the before set.
     - grant add: a grant remove of exactly the (object, privilege) entries it added, one item per object, never `allTables` (the createRole case above is the only exception). Grant remove: a grant add of exactly the removed entries.
     - defaultPrivilege: the opposite, for the privileges that changed.
     - password, dropRole and terminate: None.
     - A change that changes nothing: `Some(vec![])`, so `reversible` is false.
     - Batch: the items' inverses in reverse order.
  7. **Reversible:** not blocked, every inverse is Some, and at least one is non-empty.
  8. **Batch blocks:**
     - empty;
     - more than 50;
     - a `createRole`, `password` or `terminate` (the "not a tray change" text);
     - a `grant` or `defaultPrivilege` whose database isn't the batch's (the another-database text);
     - two changes with the same target (the same-target text). The same target means:
       - the same (grantee, object, privilege) after expansion;
       - the same membership pair;
       - two `attributes` for one role;
       - the same default-privilege key and privilege.
     - The batch's statements are the items' statements in this order:
       1. memberships added;
       2. attributes;
       3. privilege grants;
       4. default grants;
       5. default revokes;
       6. privilege revokes;
       7. memberships removed;
       8. dropRole.
       Within each kind, the given order. `items` keeps that same order.
  9. **The preview is pure:** the same input gives an equal `PgPreview` twice.
- [ ] **Step 2: Implement.** Each item of a batch is resolved and applied in turn on one pair of cloned snapshots. The impact compares the first and last snapshot.
- [ ] **Step 3: Verify** with `cargo test` and clippy. Mutation checks:
  - Treat Group sources as Direct when finding the affected roles: test 1 must fail.
  - Compute the inverse of an `allTables` grant as `allTables`: test 6 must fail.
  - Restore both.
- [ ] **Step 4: Commit** with `feat(pg): previews with impact, warnings and inverse for every change`.

### Task QB4: Exec, commit, change log and the change commands

**Files:**
- Create:
  - `src-tauri/src/pg/exec.rs`
  - `src-tauri/src/pg/commit.rs`
  - `src-tauri/src/pg/log.rs`
  - `src-tauri/src/jsonl.rs`: generic JSONL helpers.
  - Tests for each.
- Modify:
  - `src-tauri/src/pg/connect.rs`: a notice channel.
  - `src-tauri/src/iam/log.rs`: uses `jsonl`, with behavior unchanged.
  - `src-tauri/src/pg_commands.rs`
  - `src-tauri/src/lib.rs`: the log path and the commands.
  - The hygiene test (PB4's, in `pg_commands.rs` or wherever PB4 put it).
  - `src-tauri/src/pg/live_tests.rs`

**Interfaces:**
- Consumes:
  - QB1 to QB3;
  - PB4's `PgState`;
  - IAM's `PlanStore<P>` and `new_log_id` from `crate::iam::commit`.
- Produces:

```rust
// pg::connect
pub struct Notice { pub code: String, pub severity: String, pub message: String }   // severity from DbError::parsed_severity() (the non-localized V field), not severity()
pub fn spawn_connection<S, T>(connection: tokio_postgres::Connection<S, T>) -> UnboundedReceiver<Notice>;
// The one place that spawns a connection task. It polls `Connection::poll_message` and forwards every
// `AsyncMessage::Notice` synchronously before polling again. `connect`, the live helper and the fake-server tests use it.
// Connected gains `pub notices: UnboundedReceiver<Notice>`. Catalog reads drain it before they start, so it can't grow.

// pg::exec: the only code that runs SQL that changes a database
pub struct Step { pub run: String, pub expect: Option<&'static str> }   // Debug masks `run`; never derive Debug
pub enum ExecError { Failed(AppError), CommitUnknown }   // CommitUnknown: the connection closed during the COMMIT call itself
pub async fn run(conn: &mut Connected, steps: &[Step]) -> Result<(), ExecError>;

// pg::log
pub struct PgLogEntry { /* the Contract's PgChangeLogEntry */ }
pub fn append(path: &Path, e: &PgLogEntry) -> io::Result<()>;
pub fn read_all(path: &Path) -> Vec<PgLogEntry>;           // oldest first; skips broken lines
pub fn mark_undone(path: &Path, id: &str) -> io::Result<()>;

// pg::commit
pub enum PgPlan { One(PgPreview), Batch(PgBatchPreview) }   // the whole preview, compared with ==; previews are pure and capped
pub enum PgChanges { One(PgChange), Batch { database: String, changes: Vec<PgChange> } }
pub struct PgRequest {
    pub profile: String, pub target_arn: String, pub login_user: String,
    pub cluster: Arc<ClusterSnapshot>, pub db: Arc<DbSnapshot>,   // already re-read with force by the command
    pub own_pids: Vec<i32>, pub read_replica: bool, pub default_db: String, pub now: i64,
    pub changes: PgChanges, pub confirm_text: Option<String>, pub undo_of: Vec<String>, pub seen: Option<PgPlan>,
    pub log_path: PathBuf, pub log_id: String,
}
pub struct PgCommitted { pub result: Result<PgCommitResult, AppError>, pub ran: bool }   // ran: exec was called, so caches must be refreshed
pub enum PgCommitResult { One(PgApplyResult), Batch(PgBatchResult) }
pub async fn commit<X, XF, R, RF>(req: PgRequest, exec: X, reread: R) -> PgCommitted
where X: FnOnce(Vec<Step>) -> XF, XF: Future<Output = Result<(), ExecError>>,
      R: FnOnce() -> RF, RF: Future<Output = Result<(Arc<ClusterSnapshot>, Arc<DbSnapshot>), AppError>>;   // reread: only for CommitUnknown
```
- `pg_commands` does the forced re-reads and builds the request, as IAM's `gather` does. The live tests build it from `catalog` reads over a password connection.

- [ ] **Step 1: Failing tests.**
  1. **Notices:**
     - With the fake server from PB1, extended to send a NoticeResponse before CommandComplete, the notice arrives on `notices` by the time the statement's future returns.
     - Notices left over from earlier statements are drained before a new `run` starts. Catalog reads drain them too.
  2. **exec, against the fake server:**
     - The order is `BEGIN`, `SET LOCAL lock_timeout = '5s'`, `SET LOCAL statement_timeout = '60s'`, the steps, then `COMMIT`.
     - A failing step sends `ROLLBACK` and maps its error:
       - SQLSTATE 55P03 gives the lock text;
       - any other server error gives `적용하지 못했어요: ${message}`.
     - For a step with `expect`, check `expect` first: the first column of the first row must be true. Otherwise the run fails with that text and rolls back. (A vanished pid also sends a warning; the `expect` text wins.)
     - Then a notice whose SQLSTATE starts with `01`, or whose severity is WARNING, fails the run with `적용하지 못했어요: ${notice message}` and rolls back. Other notices are ignored.
     - A closed connection:
       - seen before the COMMIT call gives `Failed` with the before-COMMIT text, since the server aborts an open transaction when its client leaves;
       - from the COMMIT call itself gives `CommitUnknown`.
     - Each run has the read deadline from K1 (90 s for the whole run). When it elapses, the connection is marked `broken`. Before COMMIT that is `Failed` with the before-COMMIT text, and during COMMIT it is `CommitUnknown`.
  3. **commit, single change.** The flow, in order:
     1. The `dropRole` guard, whether or not `undoOf` is set:
        - A change list with `dropRole` is rejected with "되돌릴 수 없는 변경이에요" unless `undoOf` is set and every undone entry's change is a `createRole` whose name or created group is that role.
        - A `dropRole` whose role has members or groups that the undone entry's change didn't create is rejected with the undo-after-create text.
     1a. When `undoOf` is set, check the log entries:
        - each exists, is `ok` and not `undone`, and has the same `targetArn`;
        - their `inverse` lists, concatenated in `undoOf` order, equal the changes as passed (before any batch reordering).
        Each failure has its exact text.
     2. (In `pg_commands`, before calling commit.) Re-read the cluster and the execution database with `force`.
     3. Recompute the preview, take the remembered plan, and compare the whole previews. A miss or a difference gives the stale text. Previews carry `loginUser`, so a login switch between preview and apply is stale too.
     4. Gate with IAM's texts: blocked, wrong confirm text, or a confirm warning without text.
     5. If the change needs a password (a `createRole` with `login: true`, or `password`), generate it, hash it, and fill the Password part.
     6. `exec::run` in the execution database's pooled connection.
     6a. On `CommitUnknown`:
        - A `password` change skips the comparison, because passwords aren't in the snapshot: log `ok: false` with the unknown text plus " 비밀번호를 다시 재설정해 주세요".
        - Otherwise call `reread` and compare it with the preview's snapshot after this change:
          - equal: treat the change as applied. Log it as `ok` with its inverse, and return the result, password included, with the note "연결이 끊겼지만 적용된 것을 확인했어요";
          - equal to the snapshot before: log the failure and return the before-COMMIT text;
          - otherwise, or when `reread` fails: log `ok: false` with the unknown text.
     7. Append the log entry (with `ok` false and `error` on failure), and `mark_undone` the `undoOf` entries on success.
     8. On success, re-read the cluster snapshot and the execution database snapshot and store them: the cluster through a new `PgState::keep_cluster(target, epoch, cluster)`, which checks the epoch as `keep_db` does and leaves the other databases' snapshots alone. Failures are ignored, because the frontend reads again anyway.
     9. Return `PgApplyResult`, with `password` only when step 5 ran.
     - Tests use fake exec and reread closures, as IAM's commit tests do. Check:
       - the order;
       - nothing runs when the gate or the stale check fails;
       - a member added to the grantee group between preview and apply gives the stale text, though the SQL is equal;
       - each `CommitUnknown` branch;
       - the `dropRole` guard, for `pg_apply` and `pg_apply_batch`;
       - the password appears in the result and nowhere in the log file (grep the file);
       - the log's `sql` is the masked `shown()` text.
  4. **commit, batch:** the same flow with `PgPlan::Batch`.
     - One transaction for the whole batch.
     - One log entry per change, with `batchId` and ids `${batchId}-${k}` from 1.
     - `undoOf` is a list, and every entry is checked as in 3.1.
     - All entries are ok or all failed.
  5. **Log:**
     - The file is `db-changes.jsonl` in the app data folder.
     - Fields follow the Contract, camelCase. `batchId` is left out when null.
     - Writes are serialized.
     - `read_all` skips a broken line.
     - IAM's log tests still pass unchanged after the move to `jsonl`.
  6. **Undo:**
     - `pg_undo(logId)` gives `PgUndo { database, changes: entry.inverse, undoOf: [logId] }`.
     - `pg_undo_batch(batchId)` gives the batch's undoable entries, last first: the changes are their inverses concatenated, and `undoOf` is their ids. Like IAM's `undo_batch_of`, it skips entries that failed, are already undone, or have a null or empty inverse. It fails with not-undoable only when no entry is left.
     - Errors: not found, not undoable (`inverse` null or empty, or not `ok`), already undone.
  7. **Commands:**
     - `pg_preview` and `pg_preview_batch` remember the plan under `(targetKey, change)` or `(targetKey, (database, changes))`.
     - `pg_apply` and `pg_apply_batch` take it once.
     - The heavy work runs in `spawn_blocking`.
     - Every command except `pg_change_log`, `pg_undo` and `pg_undo_batch` needs `pg_open`.
     - A new read command `pg_overview(target) -> PgOverview` reads the cluster snapshot fresh through the pool, stores it with `keep_cluster`, and returns the overview. It makes no RDS call and keeps the database snapshots. The post-apply refresh uses it, so a failed re-read in commit step 8 can't leave the screen on the old state unnoticed.
     - `pg_preview`, `pg_preview_batch`, `pg_apply` and `pg_apply_batch` check the execution database against the cluster snapshot before connecting. A database that isn't in it, isn't connectable, or is a template or `rdsadmin` gives the execution-database text as the error.
  8. **Hygiene** (extend PB4's test):
     - `.query(`, `.query_one(`, `.query_opt(`, `.execute(`, `batch_execute(`, `simple_query(`, `build_transaction(` and `.transaction(` appear only in `pg/catalog.rs` and `pg/exec.rs`.
     - Every `build_transaction()` in catalog.rs is followed by `.read_only(true)`.
     - exec.rs has exactly one `build_transaction()`, with no `read_only`.
     - `exec::run(` appears only in `pg_commands.rs`, exactly once per closure handed to `commit::commit` or `drop::apply`. Pin the count as IAM's `WRITE_CALLS_SITES` does.
     - `PASSWORD '` appears only in `pg/change/sql_text.rs`, and `.expose()` only in `pg/commit.rs`. Both checks skip test files and `#[cfg(test)] mod` blocks.
     - `NewPassword`, `ScramHash`, `Step` and `PgApplyResult` don't derive `Debug`, and each has a masking `impl Debug`.
- [ ] **Step 2: Implement.**
  - Mirror IAM's commit for the gate and the plan flow. The PG stale text is its own constant; don't change IAM's.
  - The log path is `dir.join("db-changes.jsonl")`, next to IAM's.
- [ ] **Step 3: Live tests** in `live_tests.rs`, on both versions. They run as a non-superuser `mm_admin` with CREATEROLE, through `exec::run` on a password connection.
  1. A grant on a table `mm_admin` owns commits, and `has_table_privilege` agrees.
  2. An `exec::run` with two steps, where the second fails (a grant to a missing role), leaves the first step's role uncreated.
  3. Lock. Another connection runs `BEGIN; GRANT SELECT ON mm_t TO PUBLIC;` and keeps the transaction open. The app's `GRANT SELECT ON mm_t TO app_read` then fails with the lock text in 5 to 8 s. Roll the other transaction back afterwards.
  4. A role with SELECT on `mm_t` but no grant option runs `GRANT SELECT ON mm_t TO app_read` through exec. It fails with the class-01 notice's text, and `app_read` still lacks the privilege.
  5. createRole with `login: true` through the commit flow. A password connection with the returned password succeeds, and `rolpassword LIKE 'SCRAM-SHA-256$%'` is true. Query `pg_authid` as the superuser test client.
  6. PG16: a membership revoke with `GRANTED BY` removes only that grantor's row.
- [ ] **Step 4: Verify** with `cargo test`, clippy and the live script. Mutation checks:
  - Ignore class-01 notices: unit test 2 and live test 4 must fail.
  - Skip the plan comparison: test 3 must fail.
  - Write the unmasked SQL to the log: test 3's grep must fail.
  - Restore all three.
- [ ] **Step 5: Commit** with `feat(pg): transactional apply with plan recheck, change log and undo`.

### Task QB5: Presets, safe drop and ending sessions

**Files:**
- Create:
  - `src-tauri/src/pg/preset.rs`
  - `src-tauri/src/pg/drop.rs`
  - Tests for each.
- Modify: `src-tauri/src/pg.rs`, `src-tauri/src/pg_commands.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/pg/live_tests.rs`.

**Interfaces:**
- Consumes QB1 to QB4.
- Produces:

```rust
pub fn suggest(cluster: &ClusterSnapshot, db: &DbSnapshot, preset: PresetKind, schemas: &[String]) -> PgPresetSuggestion;   // pure
pub fn drop_plan(cluster: &ClusterSnapshot, dbs: &[Arc<DbSnapshot>], unreachable: &[String], role: &str, reassign_to: &str, default_db: &str) -> PgDropPlan;   // pure
pub async fn apply<X, XF>(plan: &PgDropPlan, default_db: &str /* the database of the last step (DROP ROLE, database null) */, exec: X) -> (usize /* database steps done */, Option<String> /* stop text */)
where X: FnMut(&str /* database */, Vec<Step>) -> XF, XF: Future<Output = Result<(), ExecError>>;
// pg_preset, pg_drop_plan and pg_apply_drop as in the Contract
```

- [ ] **Step 1: Failing tests.**
  1. **Suggest, `matching`.** These are the non-system group roles (`login` false) whose effective privileges in the database match the preset exactly, in name order.
     - **readOnly**, for every chosen schema S:
       - CONNECT on the database;
       - `usage`, `read: All`, `write: None` and no `create` in S's cell;
       - SELECT on every sequence of S;
       - for each current table owner C of S other than the group, a default ACL (for S or global) that grants SELECT on tables to the group or to a role it inherits;
       - for each current sequence owner C of S other than the group, a default ACL (for S or global) that grants SELECT on sequences to the group or to a role it inherits.
     - **readWrite:**
       - as readOnly, with every table of S also giving INSERT, UPDATE and DELETE;
       - USAGE as well as SELECT on every sequence;
       - the table default ACL covering SELECT, INSERT, UPDATE and DELETE, and the sequence default ACL covering USAGE and SELECT.
     - **owner:** CONNECT, plus `usage` and `create` in every chosen S.
     - **admin:** always empty.
  2. **Suggest, `proposedName`:**
     - `${schema}_read`, `${schema}_write` or `${schema}_owner` for one schema, and `${database}_…` for several.
     - The name is lowercased, every character outside `[a-z0-9_]` becomes `_`, and it is cut to 63 bytes.
     - If the name is taken, `_2`, `_3` … is appended.
     - `admin` gives "".
  3. **Suggest, `creators`:** the distinct owners of tables and sequences in the chosen schemas, excluding system roles, in name order. `blockedCreators` lists those the login can't set default privileges for (QB2's `Rights::defaults_for`), each with its block text.
  4. **Drop plan steps:**
     1. One step per connectable database, in name order, each its own transaction:
        - when the login lacks `has_privs_of(role)`: `GRANT "<role>" TO "<login>"` first, with `WITH INHERIT TRUE` from 160000;
        - `REASSIGN OWNED BY "<role>" TO "<reassignTo>"`, then `DROP OWNED BY "<role>"`;
        - then, when the membership was added: `REVOKE "<role>" FROM "<login>"`, with `GRANTED BY` its grantor from 160000. So a stop leaves no membership behind.
     2. A last step in the default database: `DROP ROLE "<role>"`.
     - `total` counts the database steps and `done` the database steps finished. The DROP ROLE step counts in neither.
     - `owned`, `privileges` and `defaults` count, per database, what the role owns, the ACL entries naming it, and the default-ACL records it creates or appears in.
     - `confirmText` is the role. `sessions` counts its sessions.
     - **Predicted effect per database.**
       - REASSIGN OWNED gives the role's objects to `reassignTo` and rewrites their ACL grantors.
       - DROP OWNED then runs `REVOKE ALL … FROM <role>` as the login on every object whose ACL names the role as grantee. This includes database ACLs, which the first database step handles.
       - For each such object take `g = select_best_grantor(login, every privilege of the object's kind)`, with the role counted in the login's inheriting closure during the step. An entry is removed only when its grantor is `g` and `g` is the owner or holds that privilege's grant option. Every other entry stays.
     - **grantedMemberships, from 160000:** every membership row whose grantor is the role. DROP OWNED deletes them cluster-wide. `lost` is true when no other grantor's row exists for the pair. Empty before 160000.
  5. **Drop plan warnings:**
     - Blocks:
       - a system role;
       - the login itself;
       - an unknown role;
       - drop rights (QB2's `Rights::drop`, with the drop-rights text);
       - a bad reassign target: unknown, system, or the role itself;
       - reassign rights, when `reassignTo` isn't the login and the login lacks `has_privs_of(reassignTo)`;
       - unreachable databases;
       - truncated databases;
       - a NOINHERIT login before 160000 (the drop-rights text with the INHERIT requirement), because the added membership would give it nothing;
       - from 160000, when the membership step is needed and `membership_grantor(role)` fails: the ADMIN-through-non-inheriting text;
       - privileges that would stay: entries the predicted effect leaves, with count, the first 3 as `${object} ${privilege}`, and the grantors;
       - reassign checks:
         - for each schema the role owns, the login, with the role counted in its inheriting closure during the step, has CREATE on that database, and, when `reassignTo` isn't the login, can SET ROLE to it (from 160000 through a chain where every grant has SET, before that through any membership);
         - for each function the role owns, `reassignTo` has CREATE on the function's schema (a schema the role owns counts as `reassignTo`'s).
     - Objects the snapshot doesn't read (collations, operators, text-search objects, extended statistics) can still stop a step. The drop-result text covers them.
     - Confirm: the drop text, and the granted-memberships text when `grantedMemberships` isn't empty.
     - Warn: the sessions-stay text when `sessions > 0`.
  6. **Apply drop:**
     - Re-read the cluster and every connectable database with `force`, recompute, and compare with the remembered plan, ignoring only `sessions` and the sessions-stay warning (stale text on a difference). Gate on the confirm text.
     - Run the steps in order, each through `exec::run` in its database's pooled connection.
     - On the first failure, stop. `stopped` is the drop-result text, where `done` counts the database steps finished and `total` counts all database steps. Don't run any later step.
     - A `CommitUnknown` also stops the drop. `stopped` uses the unknown text as the reason, and `done` doesn't count that database.
     - Log one entry with every step's SQL and `inverse: null`.
     - Re-read the snapshots afterwards.
     - Tests use a fake exec, as QB4's do. Include a failure in the second database.
     - One unit test per new block, and `grantedMemberships` at 150000 (empty) and 160000.
  7. **Terminate end to end** through `pg_preview` and `pg_apply` with a fake exec:
     - the own-session block;
     - the confirm text is the session's role;
     - an `expect` failure gives "세션이 이미 끝났어요".
- [ ] **Step 2: Implement.**
  - `pg_drop_plan` reads every connectable database fresh, as `pg_findings` does. One that fails goes into `unreachable` and blocks the plan.
  - Plans are remembered under `(targetKey, role, reassignTo)`.
- [ ] **Step 3: Live tests,** on both versions:
  - **Drop.**
    - Setup:
      - `mm_drop` owns a table in database `orders`;
      - in database `mm_other`, `mm_admin` grants `mm_drop` SELECT on a table `mm_admin` owns;
      - it has a default-ACL record;
      - on PG16, `mm_admin` holds ADMIN OPTION on `mm_drop`;
      - on PG16, `mm_drop` holds ADMIN on `app_read` and grants it to `carol`.
    - The plan as `mm_admin` applies.
    - Afterwards `mm_drop` is gone, the table is owned by `mm_admin`, and no ACL in either database names `mm_drop`.
    - On PG16 the plan listed `carol → app_read` with `lost: true`, and afterwards `carol` isn't in `app_read`.
  - **Drop blocked by a privilege that would stay.** `mm_drop` gets SELECT on an `app_owner` table, granted by `app_owner`, and `mm_admin` doesn't inherit `app_owner`. The plan blocks with the privileges-stay text.
  - **Drop stopped by a lock.** Another connection holds `ACCESS SHARE` on `mm_drop`'s table in an open transaction.
    - The apply stops at the `orders` step with the lock text inside the drop-result text.
    - `mm_drop` still exists.
    - Roll the other transaction back afterwards.
  - **Terminate.** A second connection logs in as `bob`. Terminate it through the commit flow. Its pid then disappears from `pg_stat_activity` within 2 s.
- [ ] **Step 4: Verify** with `cargo test`, clippy and the live script. Mutation checks:
  - Skip the membership step: the live drop test must fail on PG16.
  - Continue after a failed step: test 6 must fail.
  - Drop the stays prediction: the live stays case must stop on the 01006 text instead of blocking.
  - Restore both.
- [ ] **Step 5: Commit** with `feat(pg): presets, safe role drop and ending sessions`.

### Task QF1: Contract, change and batch flows, preview dialogs and the change log

**Files:**
- Create:
  - `src/pg/changeText.ts`: mirrors `pg::change::text`.
  - `src/pg/canChange.ts`
  - `src/pg/usePgChange.ts` and `src/pg/usePgBatch.ts`
  - `src/pg/PgChangeDialog.tsx` and `src/pg/PgBatchDialog.tsx`
  - `src/pg/PreviewBody.tsx`: SQL, impact, role and default deltas.
  - `src/pg/PasswordResult.tsx`
  - `src/pg/ChangeLog.tsx`
  - Tests for each.
- Modify:
  - `src/pg/types.ts`: the Contract additions, including `direct` and `owned` on cells and database rows.
  - `src/pg/api.ts` and `src/pg/queries.ts`: commands, `pgKeys.changeLog`, `usePgChangeLog`.
  - `src/pg/fixtures.ts`: `samplePreview`, `sampleBatchPreview`, `sampleChangeLog`, `samplePresetSuggestion` and `sampleDropPlan`. Every existing cell and database row gains `direct` and `owned`.
  - `src/pg/route.ts`: view `"changes"`, label "변경 기록".
  - `src/pg/PgNav.tsx` and `src/pg/PgTab.tsx`
  - `src/styles.css`

**Interfaces:**
- Reuse, without changing IAM behavior:
  - `usePendingFlow` and `useApplyNotices` from `src/iam/useApplyFlow.ts`;
  - `useSheetFocus`, `WarningList`, `ReversibleNote`, `ConfirmField`, `PreviewAlerts` and `GATE_HINT` from `src/iam/previewParts.tsx`;
  - `applyGate` from `src/iam/useIamChange.ts`.
  - They take plain shapes, and `PgWarning` fits `PreviewWarning`.
  - Pass `targetKey(target)` where IAM passes the profile.
- Produces:

```ts
export function changeSummary(c: PgChange): string;      // same strings as pg::change::text::summary
export function changeBlockReason(info: PgTargetInfo, ov: PgOverview): string | null;   // read replica text, else manageReason when !canManage, else null
export function usePgChange(target: PgTarget): {
  pending: PendingPgChange | null; notices: ApplyNotice[];
  start(change: PgChange, opts?: { undoOf?: string; onApplied?: () => void }): void;
  apply(typed: string): void; retryPreview(): void; cancel(): void; dismissNotice(id: string): void;
};
export function usePgBatch(target: PgTarget): {
  pending: PendingPgBatch | null; notices: ApplyNotice[];
  start(database: string, changes: PgChange[], opts?: { undoOf?: string[]; onApplied?: (applied: PgChange[]) => void }): void;
  apply(typed: string): void; retryPreview(): void; cancel(): void; dismissNotice(id: string): void;
};
```

- [ ] **Step 1: Failing tests.**
  1. **`changeSummary`:** the same examples as QB1's text tests, string for string.
  2. **`changeBlockReason`:** read replica first, then the manage reason, then null.
  3. **usePgChange**, modeled on `useIamChange`'s tests:
     - `start` calls `pg_preview` and opens the dialog.
     - `apply` is refused by `applyGate`, as in IAM.
     - On success:
       - the post-apply refresh runs at once, with no IAM-style delay: `pg_overview` replaces the overview query's data, and the execution database's view and the affected role views are refetched. `refreshPg`, which re-opens the target, stays for 다시 읽기;
       - the change log query is invalidated;
       - a notice shows the summary and any notes.
     - On failure the dialog stays open with `PreviewAlerts`. `stale` turns on, and "미리보기 다시 받기" fetches the preview again.
     - A result with `password` switches the dialog to the password phase instead of closing it. The notice never contains the password.
  4. **usePgBatch:**
     - The same flow over `pg_preview_batch` and `pg_apply_batch`.
     - `onApplied(changes)` runs after a success.
     - `undoOf` is passed through.
  5. **PgChangeDialog and PgBatchDialog**, showing in order:
     1. the title: the summary; for undo, "되돌리기 미리보기";
     2. `WarningList`;
     3. "실행할 SQL" with the statements numbered, in monospace;
     4. "영향";
     5. `ReversibleNote`;
     6. `ConfirmField` when `confirmText`;
     7. the buttons "취소" and "적용" ("적용 중…" while applying).
     - A warning with `add` shows "기본 권한도 담기" only when the dialog got an `onAddDefaults` prop.
     - Esc and focus handling come from `useSheetFocus`, as in IAM.
     - Under the title, `적용할 DB 사용자: ${loginUser}` from the preview.
  6. **Impact rendering:**
     - Per role, "얻는 권한" and "잃는 권한" lines read `${schema ?? database} · ${OBJECT_KIND_LABEL[objectKind]} ${count}개 ${privilege}`, with the sample names after.
     - When `impactsOmitted > 0`, the list ends with `그 밖에 ${n}개 역할`.
     - Role deltas:
       - "새로 만들어요" and "삭제돼요";
       - `${name}: ${before} → ${after}`;
       - `들어가는 그룹: ${names}` and `빠지는 그룹: ${names}`.
     - Default deltas reuse `sentences.ts` under "바뀌기 전" and "바뀐 뒤".
     - With no impact, no role delta and no default delta, it says "권한 변화 없음".
  7. **PasswordResult:**
     - It shows the title, the password in a read-only field, the note, and the buttons "복사" and "닫기".
     - "복사" copies through `desktop.copy` (src/api/desktop.ts, the clipboard plugin the app already uses) and then shows "복사했어요".
     - After "닫기" the password is gone from the DOM, from the hook state, and from the query cache.
  8. **ChangeLog** (nav "변경 기록"). Mirror `src/iam/ChangeLog.tsx`'s layout and wording:
     - "변경 기록을 불러오는 중…", "변경 기록이 없어요" and "되돌리기";
     - batches grouped as `묶음 · 변경 ${n}개 · ${time}`, with "묶음 되돌리기";
     - "되돌릴 수 없어요" for a null or empty `inverse`, and "되돌렸어요" for `undone`.
     - Only this target's entries are shown, by `targetArn`.
     - "되돌리기" calls `pg_undo`. One change opens the single flow with `undoOf`. More than one opens the batch flow in `PgUndo.database` with `undoOf`.
     - "묶음 되돌리기" calls `pg_undo_batch`.
     - Errors from the call show with `PgError`.
  9. Every existing pg test still passes with the `direct` and `owned` fields added to fixtures.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify** with `npx vitest run`, `npx tsc --noEmit` and `npm run build`. Mutation checks:
  - Keep the password in the notice: test 3 must fail.
  - Skip `refreshPg` after apply: test 3 must fail.
  - Restore both.
- [ ] **Step 4: Commit** with `feat(pg): change and batch previews, apply flow and change log`.

### Task QF2a: Draft, tray, 바꾸기 mode and the grid

**Files:**
- Create:
  - `src/pg/draft.ts`: pure keys, toggles and the database rule.
  - `src/pg/usePgDraft.ts`
  - `src/pg/TrayBar.tsx`
  - `src/lib/usePaintDrag.ts`: the generic drag state machine, extracted.
  - Tests for each.
- Modify:
  - `src/iam/usePaintDrag.ts`: becomes a thin IAM wrapper over the generic hook. Every IAM test passes unchanged.
  - `src/pg/PrivilegeGrid.tsx`, `src/pg/PgTab.tsx`
  - `src/styles.css`

**Interfaces:**
- Consumes QF1's hooks and dialogs, and the `direct` and `owned` fields of `PgSchemaCell` and `PgDbPrivilegeRow`.
- Produces:

```ts
export interface PgDraftItem { key: string; change: PgChange; label: string }   // label = changeSummary(change)
export function usePgDraft(target: PgTarget, ov: PgOverview | undefined): {
  items: PgDraftItem[]; notices: string[]; database: string | null;   // the database of the db-scoped items, if any
  toggle(item: PgDraftItem): void;     // add, or remove when the same key is pending
  paint(items: PgDraftItem[]): void;   // add many; stops at 50 with the full notice
  add(changes: PgChange[]): void;      // "기본 권한도 담기"
  remove(key: string): void; clear(): void; removeApplied(applied: PgChange[]): void; dismissNotice(i: number): void;
};
```

- [ ] **Step 1: Failing tests.**
  1. **Draft rules (`draft.ts`):**
     - The key of each kind:
       - grant: `grant|${database}|${grantee}|${target key}|${privileges}`;
       - membership: `membership|${group}|${member}|${admin}`. Toggling uses the key, but a new membership item replaces any pending item for the same pair with the other `admin` value, as attributes items do, so the batch never holds two changes for one pair;
       - attributes: `attributes|${role}`;
       - default privilege: `default|${database}|${creator}|${schema ?? "*"}|${objectType}|${grantee}|${privileges}`.
     - Toggling a pending key removes it.
     - A new attributes item for a role replaces the old one. It is dropped when it equals the snapshot.
     - At most 50 items, with the full notice.
     - A grant or default item for another database than the draft's is refused with the another-database notice. Cluster-wide items don't count toward the rule.
     - `add` keeps the order, skips keys already present, and appends `기본 권한 ${n}개를 담았어요` to the notices.
     - `removeApplied` drops exactly the applied keys.
     - The draft is kept per `targetKey` and cleared when the tab closes.
  2. **The 바꾸기 toggle** lives in the tab toolbar (`aria-pressed`). It is disabled with `changeBlockReason` as its title and description.
     - While it is on, the 권한 screen shows the brush group "칠할 권한":
       - "사용", "만들기", "읽기" and "쓰기" for the schema columns;
       - "CONNECT", "CREATE" and "TEMP" for the 데이터베이스 column.
     - Exactly one brush is active, and "읽기" is the default.
  3. **Grid cells in 바꾸기 mode** show the brush's aspect only.
     - States:
       - on (●), when `direct` has it (for 읽기 and 쓰기, `direct.read` or `direct.write` is "all");
       - pending add (+) and pending remove (−);
       - owner-held (not toggleable, title "소유자라서 가진 권한이에요"), when `owned` has it and `direct` doesn't;
       - inherited only (dim, title "그룹·PUBLIC으로만 받음", not toggleable), when the shown value has it but neither `direct` nor `owned` does;
       - a system role's row is not toggleable, with the system-role block text as its title.
     - Click and Space toggle.
     - A drag paints toward the first cell's target state, using the generic hook. Shift with the arrows extends a range, which Space then toggles, as in IAM.
     - Enter opens the cell panel.
     - Brush → change:
       - 사용: schema `USAGE`;
       - 만들기: schema `CREATE`;
       - 읽기: `allTables` `SELECT`;
       - 쓰기: `allTables` `INSERT, UPDATE, DELETE`;
       - CONNECT, CREATE, TEMP: database `CONNECT`, `CREATE` or `TEMPORARY`.
       - `add` is the opposite of "on".
  4. **TrayBar:**
     - It reuses the `asg-tray` markup and classes.
     - The summary is `변경 1개 · ${label}`, or `변경 ${n}개 · ${first} 외 ${n-1}개`.
     - The buttons are "모두 취소" and "미리보기". "미리보기" starts `usePgBatch` with the draft's database (or the tab's database when the draft has none) and the items' changes.
     - On success, `removeApplied`.
     - The batch dialog gets `onAddDefaults = draft.add`.
  5. The generic paint hook: IAM's AssignmentGrid tests all pass unchanged, and the pg grid uses the same hook.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify** with vitest, tsc and the build. Mutation checks:
  - Allow toggling inherited-only cells: test 3 must fail.
  - Drop the database rule: test 1 must fail.
  - Restore both.
- [ ] **Step 4: Commit** with `feat(pg): draft, tray and 바꾸기 mode on the privileges table`.

### Task QF2b: Editing in the cell panel, default privileges and the role detail

**Files:**
- Create: `src/pg/GrantSheet.tsx`, `src/pg/DefaultPrivilegeForm.tsx`, and tests.
- Modify: `src/pg/CellPanel.tsx`, `src/pg/DefaultPrivileges.tsx`, `src/pg/RoleDetail.tsx`, `src/styles.css`.

**Interfaces:**
- Consumes:
  - QF2a's `usePgDraft`, the tab's 바꾸기 state, and `changeBlockReason`;
  - QF1's `changeSummary`.

- [ ] **Step 1: Failing tests.**
  1. **CellPanel in 바꾸기 mode:**
     - The panel's header shows the schema's 사용 and 만들기 with their sources, as chips.
     - Each held privilege is a chip:
       - a direct one carries "빼기", which adds a one-object revoke from the role;
       - a PUBLIC one carries "PUBLIC에서 빼기", which adds the same revoke from PUBLIC;
       - any other inherited one is disabled.
     - "객체에 권한 주기" opens `GrantSheet`:
       - the object search, limited to the schema (`pg_objects` with the query `${schema}.`);
       - "받는 역할": the cell's role by default, or "모든 역할(PUBLIC)";
       - checkboxes for the object kind's privileges;
       - "담기".
  2. **DefaultPrivileges in 바꾸기 mode:**
     - Each grant line has "빼기".
     - "기본 권한 추가" opens `DefaultPrivilegeForm` with:
       - creator;
       - schema ("모든 스키마" or one schema);
       - object type;
       - grantee (roles plus "모든 역할(PUBLIC)");
       - the type's privileges:
         - tables: the seven table privileges;
         - sequences: USAGE, SELECT, UPDATE;
         - functions: EXECUTE;
         - types: USAGE;
         - schemas: USAGE, CREATE.
       - The button "담기".
     - Choosing the object type "스키마" fixes the schema to "모든 스키마".
  3. **RoleDetail in 바꾸기 mode:**
     - **구성원 tab:** a checkbox per non-system group and per allowed system group, with the pending markers, giving membership changes. The phase-1 chips stay, now with the `set` field from K1. Existing memberships also get an "ADMIN OPTION" checkbox, giving a membership change with `admin: true`.
     - **개요 tab:** a form with LOGIN, CREATEDB, CREATEROLE and INHERIT, "연결 수 제한" (a number, or "제한 없음") and "만료일" (a date, or "없음"). The button "담기" adds or replaces the attributes item. REPLICATION and BYPASSRLS stay read-only.
  4. Every new item goes through the draft, so the 50-item limit and the database rule apply as in QF2a.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify** with vitest, tsc and the build. Mutation check: let the cell panel's "빼기" revoke from the cell's role when the source is PUBLIC. Test 1 must fail. Restore it.
- [ ] **Step 4: Commit** with `feat(pg): grant and revoke from the cell panel, default privileges, groups and attributes`.

### Task QF3: Create role, password reset, safe drop, ending sessions, checklist and README

**Files:**
- Create: `src/pg/CreateRoleDialog.tsx`, `src/pg/DropRoleDialog.tsx`, and tests.
- Modify:
  - `src/pg/RoleList.tsx`: "역할 만들기".
  - `src/pg/RoleDetail.tsx`: "비밀번호 재설정" and "삭제".
  - `src/pg/Sessions.tsx`: "끊기".
  - `src/pg/api.ts` and `src/pg/queries.ts`: `pg_preset`, `pg_drop_plan` and `pg_apply_drop`.
  - `src/styles.css`, `docs/manual-test-checklist.md`, `README.md`.
- Every new button is disabled with `changeBlockReason` when it isn't null.

- [ ] **Step 1: Failing tests.**
  1. **CreateRoleDialog** (title "역할 만들기"):
     - **Fields:**
       - "이름". Validate it with the backend's name rules and texts.
       - "종류": "사용자" or "그룹".
       - "속할 그룹": a multi-select of groups and the allowed system groups.
       - "연결 수 제한": "제한 없음" or a number.
       - "만료일": "없음" or a date.
       - "프리셋", with each option's description:
         - "없음";
         - "읽기 전용": "고른 스키마의 테이블과 시퀀스를 읽어요";
         - "읽기·쓰기": "읽기에 더해 테이블에 쓰고 시퀀스를 써요";
         - "소유자(마이그레이션)": "고른 스키마에 객체를 만들 수 있어요";
         - "관리자": "rds_superuser 구성원이 돼요".
     - **Preset choices.** With any preset other than 관리자, the dialog shows:
       - "데이터베이스", the tab's choice by default;
       - "스키마": checkboxes from `usePgDatabase(target, db).schemas`.
       - The dialog then calls `pg_preset` once, 300 ms after the last change to them.
     - **The suggestion, for a 사용자:**
       - With `matching`, a radio: "같은 권한을 가진 그룹에 넣어요" with a select of `matching` (the first chosen), or "새 그룹을 만들어요" with a name field.
       - Without `matching`, only the new-group option, with the name field filled with `proposedName`.
     - **The suggestion, for a 그룹:** `같은 권한을 가진 그룹이 이미 있어요: ${names}` as information. The new group takes the privileges itself.
     - **Creators.** When "같은 권한을 가진 그룹에 넣어요" is chosen, the creators are hidden and `creators: []` is sent, since only the membership is added. Otherwise readOnly and readWrite show "기본 권한을 줄 역할": checkboxes of `creators`, with the note "앞으로 이 역할들이 만드는 테이블과 시퀀스에도 같은 권한을 줘요". Creators in `blockedCreators` start unchecked and disabled, with their reason shown next to them. The others start checked.
     - **Preview.** "미리보기" builds the `createRole` change exactly. Test each preset and each group choice. It then starts `usePgChange`. A 사용자 ends in the password phase.
  2. **Password reset:** "비밀번호 재설정" shows only for login roles. It starts `{ kind: "password", role }` and ends in the password phase.
  3. **DropRoleDialog** (title "역할 삭제"):
     - **Plan:** "넘겨받을 역할" (default: the login user) loads `pg_drop_plan` again on every choice.
     - **Steps:** for each step, the database (or the default database's name), `객체 ${owned}개 · 권한 ${privileges}개 · 기본 권한 ${defaults}개`, and its SQL.
     - `grantedMemberships`, when not empty, under the heading "함께 지워지는 구성원 관계": one line per row as `${member} → ${group}`, with "그룹에서 빠져요" when `lost`.
     - Then `WarningList` and `ConfirmField` with `confirmText`.
     - **Apply:** "삭제" calls `pg_apply_drop`.
       - A full success closes the dialog with the notice `역할 삭제: ${role}`, and refreshes and clears the role route.
       - `stopped` keeps the dialog open with that text. Finished steps carry ✓ and the rest "실행하지 않음".
       - It refreshes in both cases.
  4. **Sessions:**
     - Each row has "끊기", which starts `{ kind: "terminate", pid, role, backendStart }`.
     - Own sessions get a disabled button titled "이 앱의 세션은 끊을 수 없어요".
     - Rows without a role get no button.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Checklist and README.**
  - Add "RDS PostgreSQL 사용자 관리 2단계 (IAM 인증을 켠 테스트 클러스터에서 확인한다)" to `docs/manual-test-checklist.md`:
    1. Create a user with the 읽기 전용 preset on one schema, copy the password, and log in with `psql` as that user. It can read a table and can't write.
    2. The same preset again offers the group just created.
    3. Brush grant and revoke on the grid, then the tray preview and apply.
    4. A per-object grant from the cell panel.
    5. An `allTables` grant shows "새로 만드는 테이블에는 적용되지 않아요". "기본 권한도 담기" adds the default privilege.
    6. Change attributes. Add and remove a group, with ADMIN OPTION.
    7. Password reset, then log in with the new password.
    8. In another session run `BEGIN; GRANT SELECT ON <table> TO PUBLIC;` and leave it open. A grant on that table from the app stops with the lock text within about 5 s. Then roll the other session back.
    9. Safe drop of a role that owns a table in one database and has privileges in another.
    10. End another session. Your own session can't be ended.
    11. Undo a grant, a batch and a created role from 변경 기록.
    12. A read replica and a login without manage rights show disabled controls with their reasons.
    13. Log in as an `rds_superuser` member that lacks CREATEROLE. 역할 만들기 shows the create-rights block. Check that the server agrees. If RDS allows it, relax the rule to `canManage` and record that.
  - **README:**
    - Extend the PostgreSQL section: changes, the preview of the exact SQL, one transaction per change or batch, the change log and undo, and passwords shown once.
    - Requirements:
      - the DB user needs CREATEROLE or `rds_superuser` to manage roles;
      - on PostgreSQL 16 and later it also needs ADMIN OPTION on the roles it changes;
      - granting on objects needs the owner's privileges or GRANT OPTION.
- [ ] **Step 4: Verify** with vitest, tsc and the build. Mutation check: build the createRole change without `createGroup`. Test 1 must fail. Restore it.
- [ ] **Step 5: Commit** with `feat(pg): create roles with presets, reset passwords, drop roles safely and end sessions`.

### Task K2: Whole-branch review and finish (controller)
- [ ] Run both suites, clippy and the live script on the branch head.
- [ ] Dispatch the whole-branch review on the most capable model. Give it:
  - the package from `git merge-base main HEAD` to HEAD;
  - both plans and the spec;
  - the ledger's carried Minor findings, for triage.
- [ ] Send all findings in one fix wave, then a re-review.
- [ ] Merge to `main` locally, run the suites on the merge, and push. No release.
