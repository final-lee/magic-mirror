# IAM Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single "🔐 IAM" workspace tab that shows effective permissions, answers "who can do X", runs security checks, suggests least privilege, and applies IAM changes safely (preview → confirm → apply → log → undo).

**Architecture:** Rust backend fetches the whole account's IAM once (`GetAccountAuthorizationDetails` + credential report), caches it per profile, and evaluates identity policies locally against a bundled AWS action catalog. All IAM mutations live in one Rust module and go through a pure preview/warning layer. The React frontend is a new `src/iam/` area wired into the existing tab system.

**Tech Stack:** Tauri 2, Rust (aws-sdk-iam, aws-sdk-sts, aws-sdk-accessanalyzer, serde), React 18 + TS + TanStack Query + Vitest.

**Spec (source of truth for behavior, rules and the JSON contract):** `docs/superpowers/specs/2026-10-26-iam-workspace-design.md`

## Global Constraints
- UI copy is Korean 해요체; code identifiers and commit messages are English.
- The contract section of the spec (command names, argument names, JSON shapes) is fixed. Additive optional fields only.
- Resource-browser adapters (`src-tauri/src/adapters/`) stay read-only. IAM mutating SDK calls (`attach_*`, `detach_*`, `put_*_policy`, `delete_*`, `add_user_to_group`, `remove_user_from_group`, `update_access_key`, `create_policy_version`) appear **only** in `src-tauri/src/iam/write.rs`.
- Every IAM change goes through `iam_preview` → user confirmation → `iam_apply`; the backend re-computes the preview on apply and refuses `block` warnings and mismatched `confirmText`.
- Never log or return secrets. No access-key creation.
- Rust: `cargo test` and `cargo clippy --all-targets -- -D warnings` clean. Frontend: `npm test`, `npx tsc --noEmit`, `npm run build` clean.
- Commits end with exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage files by explicit path (backend and frontend tasks run concurrently in one working tree). Backend tasks touch only `src-tauri/` and `scripts/update-iam-catalog.mjs`; frontend tasks touch only `src/` and `docs/manual-test-checklist.md`.
- Branch: `feat/iam-workspace`.

## Execution order
Two chains run in parallel: backend **I1 → I2 → I3 → I4**, frontend **J1 → J2 → J3** (frontend mocks the backend per the contract). Final: **K** (demo data, screenshot, README, whole-branch review).

---

### Task I1: Action catalog, policy parsing and matching, snapshot model

**Files:**
- Create: `scripts/update-iam-catalog.mjs`, `src-tauri/src/iam/mod.rs`, `src-tauri/src/iam/catalog.rs`, `src-tauri/src/iam/catalog.json` (generated), `src-tauri/src/iam/policy.rs`, `src-tauri/src/iam/model.rs`
- Modify: `src-tauri/src/lib.rs` (`mod iam;` only)

**Produces (later tasks rely on these exact names):**
```rust
// catalog.rs
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccessLevel { List, Read, Write, Permissions, Tagging }
pub const LEVELS: [AccessLevel; 5];
pub struct Catalog { /* private */ }
pub fn catalog() -> &'static Catalog;               // OnceLock, parses include_str!("catalog.json")
impl Catalog {
    pub fn services(&self) -> impl Iterator<Item = (&str /*prefix*/, &str /*name*/)>;
    pub fn service_name(&self, prefix: &str) -> Option<&str>;
    pub fn level(&self, prefix: &str, action: &str) -> Option<AccessLevel>;   // action match case-insensitive
    pub fn actions(&self, prefix: &str) -> &[(String, AccessLevel)];          // canonical case
    pub fn total(&self, prefix: &str, level: AccessLevel) -> usize;
    pub fn all_count(&self) -> usize;
    pub fn expand(&self, pattern: &str) -> Vec<(String /*prefix*/, String /*Action*/, AccessLevel)>; // glob, case-insensitive; "*" = everything
    pub fn all_action_names(&self) -> Vec<String>;   // "s3:GetObject", sorted
}
// policy.rs
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)] pub enum Effect { Allow, Deny }
#[derive(Clone, Debug, PartialEq)] pub enum Actions { Action(Vec<String>), NotAction(Vec<String>) }
#[derive(Clone, Debug, PartialEq)] pub enum Resources { Resource(Vec<String>), NotResource(Vec<String>), Unspecified }
#[derive(Clone, Debug, PartialEq)]
pub struct Statement { pub index: usize, pub sid: Option<String>, pub effect: Effect, pub actions: Actions,
    pub resources: Resources, pub principal: Option<serde_json::Value>, pub conditional: bool, pub conditions: Vec<String> }
#[derive(Clone, Debug, PartialEq)] pub struct PolicyDocument { pub statements: Vec<Statement> }
pub fn decode_document(raw: &str) -> String;                       // percent-decodes if it looks URL-encoded ("%7B" / "%22"), else returns as-is
pub fn parse_document(raw: &str) -> Result<PolicyDocument, String>; // decode + JSON; Statement object or array; string-or-array fields
pub fn pretty(raw: &str) -> String;                                 // decoded, pretty-printed JSON (fallback: decoded text)
pub fn glob(pattern: &str, text: &str, case_insensitive: bool) -> bool;   // '*' any run, '?' one char
pub fn action_matches(pattern: &str, action: &str) -> bool;              // "s3:Get*" vs "s3:GetObject", "*" matches all
pub enum ResMatch { Yes, No, Unknown }                                   // Unknown when the pattern contains "${"
pub fn resource_matches(pattern: &str, arn: &str) -> ResMatch;           // case-sensitive glob
pub fn statement_resource_matches(s: &Statement, arn: Option<&str>) -> ResMatch; // arn None => Yes
pub fn statement_action_matches(s: &Statement, action: &str) -> bool;    // Action any-match / NotAction none-match
// condition lines: "<key> · <operator> · <v1, v2>", sorted
// model.rs — filled by I3, read by I2/I4
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)] #[serde(rename_all = "lowercase")] pub enum Scope { Aws, Local }
pub struct InlinePolicy { pub name: String, pub raw: String, pub document: Option<PolicyDocument> }
pub struct UserRec { pub arn: String, pub name: String, pub path: String, pub created_at: Option<String>, pub inline: Vec<InlinePolicy>,
    pub attached: Vec<String>, pub groups: Vec<String>, pub boundary: Option<String>, pub tags: BTreeMap<String, String> }
pub struct GroupRec { pub arn: String, pub name: String, pub path: String, pub created_at: Option<String>, pub inline: Vec<InlinePolicy>, pub attached: Vec<String> }
pub struct RoleRec { pub arn: String, pub name: String, pub path: String, pub created_at: Option<String>, pub description: Option<String>,
    pub inline: Vec<InlinePolicy>, pub attached: Vec<String>, pub boundary: Option<String>, pub tags: BTreeMap<String, String>,
    pub trust_raw: Option<String>, pub trust: Option<PolicyDocument>, pub last_used: Option<String> }
pub struct VersionRec { pub id: String, pub is_default: bool, pub created_at: Option<String> }
pub struct ManagedPolicyRec { pub arn: String, pub name: String, pub scope: Scope, pub description: Option<String>,
    pub default_version_id: Option<String>, pub attachment_count: i32, pub updated_at: Option<String>,
    pub raw: Option<String>, pub document: Option<PolicyDocument>, pub versions: Vec<VersionRec> }
pub struct CredRow { pub user: String, pub arn: String, pub created_at: Option<String>, pub password_enabled: bool,
    pub password_last_used: Option<String>, pub mfa_active: bool,
    pub key1_active: bool, pub key1_rotated: Option<String>, pub key1_last_used: Option<String>,
    pub key2_active: bool, pub key2_rotated: Option<String>, pub key2_last_used: Option<String> }
pub struct Snapshot { pub account_id: String, pub caller_arn: String, pub caller_principal_arn: Option<String>, pub fetched_at: String,
    pub users: Vec<UserRec>, pub groups: Vec<GroupRec>, pub roles: Vec<RoleRec>, pub policies: BTreeMap<String, ManagedPolicyRec>,
    pub cred_report: Option<Vec<CredRow>>, pub cred_generated_at: Option<String>, pub warnings: Vec<String> }
impl Snapshot { pub fn user(&self, name_or_arn: &str) -> Option<&UserRec>; pub fn group(..) -> Option<&GroupRec>; pub fn role(..) -> Option<&RoleRec>;
    pub fn principal_kind(&self, arn: &str) -> Option<&'static str /*"user"|"group"|"role"*/>; }
```
All model structs derive `Clone, Debug` (and `Default` where it helps tests).

- [ ] **Step 1: catalog script.** `scripts/update-iam-catalog.mjs` (Node 20+, no deps): GET `https://servicereference.us-east-1.amazonaws.com/` (array of `{service,url}`), fetch each service JSON with concurrency 16 and retries, and write `src-tauri/src/iam/catalog.json` compact (no whitespace) as `{"generated":"<ISO date>","services":{"<prefix>":{"name":"<ServiceName or prefix>","actions":{"<Action>":"l|r|w|p|t"}}}}`. Level code from `Annotations.Properties`: IsPermissionManagement→p, IsTaggingOnly→t, IsWrite→w, IsList→l, else r. Inspect one service JSON first to confirm field names (`Name`, `ServiceName`, `Actions[].Name`, `Actions[].Annotations.Properties`). Run it and commit the output (expect a few hundred KB, ~450 services). Print totals.
- [ ] **Step 2: tests first** in `catalog.rs`/`policy.rs` `#[cfg(test)]`:
  - catalog: `level("s3","GetObject")==Some(Read)`, `level("s3","getobject")` same (case-insensitive), `level("iam","AttachUserPolicy")==Some(Permissions)`, `level("s3","ListBucket")==Some(List)`, `expand("s3:Get*")` non-empty and all prefix `s3` and every name starts with `Get`, `expand("*").len()==all_count()`, `expand("nosuch:*")` empty, `all_action_names()` contains `"s3:GetObject"` and is sorted.
  - glob: `glob("s3:Get*","s3:GetObject",true)`, `glob("s3:?etObject","s3:GetObject",true)`, `!glob("s3:Put*","s3:GetObject",true)`, `glob("*","anything",false)`, case: `glob("S3:GET*","s3:GetObject",true)` true but `glob("arn:aws:s3:::Bucket","arn:aws:s3:::bucket",false)` false.
  - resource: `resource_matches("arn:aws:s3:::prod-*/*","arn:aws:s3:::prod-assets/a.txt")==Yes`, `resource_matches("arn:aws:s3:::${aws:username}/*", …)==Unknown`, `resource_matches("*", …)==Yes`.
  - parse: URL-encoded document decodes (`%7B%22Version%22%3A%222012-10-17%22%2C%22Statement%22%3A%7B%22Effect%22%3A%22Allow%22%2C%22Action%22%3A%22s3%3AGetObject%22%2C%22Resource%22%3A%22*%22%7D%7D` → 1 statement, Action(["s3:GetObject"])); single Statement object; Action string vs array; NotAction; NotResource; missing Resource → Unspecified (trust policies); Condition present → `conditional=true` and a readable line `"aws:SourceIp · IpAddress · 10.0.0.0/8"`; invalid JSON → Err with a message; statement `index` order preserved.
  - statement matching helpers incl. NotAction semantics and `arn=None`.
- [ ] **Step 3: implement** to pass. `catalog()` must parse once (OnceLock). Keep `expand` allocation-light (it is called a lot by I2).
- [ ] **Step 4:** `cargo test iam::` + `cargo clippy --all-targets -- -D warnings`.
- [ ] **Step 5: commit** `feat(iam): action catalog, policy parsing and snapshot model`.

---

### Task I2: Evaluation engine (effective permissions, who-can, danger, trust, badges)

**Files:** Create `src-tauri/src/iam/eval.rs`, `src-tauri/src/iam/view.rs` (serde view structs from the spec contract: `Badge`, `BadgeKind`, `Level`, `PrincipalSummary`, `PolicySummary`, `PrincipalView`, `AttachedPolicy`, `ServicePermissions`, `LevelCell`, `ActionGrant`, `GrantSource`, `TrustEntry`, `PolicyView`, `StatementView`, `WhoCanResult`, `WhoCanHit` — exact camelCase JSON), register in `iam/mod.rs`.

**Consumes:** I1 (catalog, policy, model).
**Produces:**
```rust
pub enum Status { Allowed, Conditional, Denied, Boundary }       // serde lowercase
pub struct ActionEval { pub status: Status, pub resources: Vec<String>, pub sources: Vec<GrantSource> }
pub struct PrincipalEval { pub actions: BTreeMap<(String, String), (AccessLevel, ActionEval)>, pub unknown: Vec<String>, pub admin_like: bool }
pub fn policy_sources(s: &Snapshot, arn: &str) -> (Vec<Source>, Option<Source>);   // (identity sources, boundary)
pub fn evaluate(s: &Snapshot, arn: &str) -> Option<PrincipalEval>;                 // full expansion (use for one principal at a time)
pub fn evaluate_action(s: &Snapshot, arn: &str, action: &str, resource: Option<&str>) -> Option<ActionEval>; // cheap single-action path, None = no matching allow
pub fn principal_view(s: &Snapshot, arn: &str) -> Option<PrincipalView>;
pub fn principal_actions(s: &Snapshot, arn: &str, prefix: &str, level: AccessLevel) -> Vec<ActionGrant>;
pub fn who_can(s: &Snapshot, action: &str, resource: Option<&str>) -> WhoCanResult;   // users and roles, sorted: allowed, conditional, boundary, denied, then name
pub fn admin_like_statementwise(s: &Snapshot, arn: &str) -> bool;  // cheap check for overview badges (no expansion)
pub fn privesc_reasons(s: &Snapshot, arn: &str) -> Vec<String>;    // cheap: evaluate_action for each PRIVESC_ACTIONS on "*"
pub const PRIVESC_ACTIONS: &[&str];                                // spec list
pub fn parse_trust(doc: &PolicyDocument, own_account: &str) -> Vec<TrustEntry>;
pub fn policy_badges(s: &Snapshot, arn: &str) -> Vec<Badge>;       // admin, privesc, boundary, cfn (tag aws:cloudformation:stack-name), sso, serviceLinked, externalTrust
pub fn managed_policy_badges(p: &ManagedPolicyRec) -> Vec<Badge>;  // admin/privesc by its own statements, unattached (local & 0), awsManaged
pub fn summaries(s: &Snapshot) -> (Vec<PrincipalSummary>, Vec<PrincipalSummary>, Vec<PrincipalSummary>, Vec<PolicySummary>); // users, groups, roles, policies; lastUsed: role last_used; user lastUsed filled later by I3 from cred report
pub fn policy_view(s: &Snapshot, policy_id: &str) -> Option<PolicyView>;   // "arn:…" or "inline:<ownerArn>:<name>"
pub fn is_service_linked(path: &str) -> bool; pub fn is_sso_role(name: &str, path: &str) -> bool;
```
Rules: exactly the spec "권한 계산 규칙" (status priority, boundary, conditions, policy variables → conditional, NotAction via catalog complement, unknown actions, adminLike, privesc, trust interpretation). `danger` on `ActionGrant`: Korean reason if action ∈ PRIVESC_ACTIONS or level=permissions on `*` resource or `*` wildcard admin. `ServicePermissions.danger` = any allowed danger action. Groups' members: `UserRec.groups` names.

- [ ] **Step 1: fixtures.** `#[cfg(test)] mod fixtures` building a `Snapshot` in code: user `alice` (group `admins` with AWS managed `AdministratorAccess` = Allow `*` on `*`), user `bob` (inline: Allow `s3:Get*`,`s3:List*` on `arn:aws:s3:::prod-assets*`; Deny `s3:GetObject` on `arn:aws:s3:::prod-assets/secret/*`), user `carol` (managed `AmazonS3FullAccess`-like `s3:*` on `*` + boundary Allow only `s3:Get*`), role `deploy` (inline Allow `iam:PassRole` `*` + `lambda:*` with Condition), role `ci` trusting `{"Federated":"arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com"}` with conditions, role `vendor` trusting `{"AWS":"arn:aws:iam::999999999999:root"}` without ExternalId, role `open` trusting `{"AWS":"*"}`, role `AWSServiceRoleForX` path `/aws-service-role/`, role `AWSReservedSSO_Admin_abc` path `/aws-reserved/sso.amazonaws.com/`. Own account `111111111111`.
- [ ] **Step 2: tests first:**
  - alice: `admin_like`, every catalog action allowed, badge admin; `principal_view` has `adminLike=true`.
  - bob: `s3:GetObject` allowed with resources `[arn:aws:s3:::prod-assets*]`; `evaluate_action(bob,"s3:GetObject",Some("arn:aws:s3:::prod-assets/secret/x"))` → Denied; `…/public/x` → Allowed; `s3:PutObject` → None; `principal_view` S3 read cell `allowed>0`, write cell all zero; sources show inline policy name and sid.
  - carol: `s3:GetObject` Allowed, `s3:PutObject` Boundary (cell counts in `denied`).
  - deploy: `iam:PassRole` Allowed + privesc reason; `lambda:InvokeFunction` Conditional.
  - Deny-with-condition over an unconditional Allow → Conditional.
  - Policy variable resource → Conditional in `evaluate_action` with that resource.
  - NotAction: Allow NotAction `iam:*` on `*` → `s3:GetObject` Allowed, `iam:GetUser` absent.
  - unknown action `foo:Bar` reported in `unknown`.
  - who_can(`s3:GetObject`, `arn:aws:s3:::prod-assets/a`) → alice Allowed, bob Allowed, carol Allowed, ordered; who_can(`s3:PutObject`, None) → alice Allowed, carol Boundary.
  - parse_trust: ci → federated `token.actions.githubusercontent.com`, conditional; vendor → account external with warning (no ExternalId); open → anyone + warning; own-account root → not external.
  - badges: service-linked, sso, cfn tag, externalTrust; managed policy unattached.
  - JSON shape snapshot of one `PrincipalView` (keys camelCase, enums lowercase).
- [ ] **Step 3: implement.** Performance: `evaluate` expands each statement's patterns once; `who_can`/badges use the single-action path only.
- [ ] **Step 4:** `cargo test iam::` + clippy.
- [ ] **Step 5: commit** `feat(iam): permission evaluation, who-can, danger and trust analysis`.

---

### Task I3: AWS reads, findings, least-privilege, read commands

**Files:** Create `src-tauri/src/iam/fetch.rs`, `src-tauri/src/iam/findings.rs`, `src-tauri/src/iam/lastused.rs`, `src-tauri/src/iam_commands.rs`; Modify `src-tauri/src/lib.rs` (register `IamState` + read commands), `src-tauri/Cargo.toml` (`aws-sdk-accessanalyzer = "1"` via `cargo add`).

**Consumes:** I1, I2. AWS config via `state.ctx.config(profile, "us-east-1")` (IAM is global; mirror how `AwsContext::account_id` uses `GLOBAL_REGION`).
**Produces (Tauri commands, contract in spec):** `iam_overview`, `iam_principal`, `iam_principal_actions`, `iam_policy`, `iam_actions`, `iam_who_can`, `iam_simulate`, `iam_findings`, `iam_access_keys`, `iam_last_accessed`, `iam_list_policies`, `iam_validate_policy`. Plus:
```rust
#[derive(Default)] pub struct IamState { snapshots: tokio::sync::Mutex<HashMap<String, Arc<Snapshot>>>, policy_lists: tokio::sync::Mutex<HashMap<String, Arc<Vec<PolicyRef>>>> }
pub async fn snapshot(state: &AppState, iam: &IamState, profile: &str, force: bool) -> Result<Arc<Snapshot>, AppError>; // cache; force refetches
pub fn invalidate(iam: &IamState, profile: &str);   // used by I4 after writes (make it async if the mutex requires)
pub fn credential_badges(s: &Snapshot, user_arn: &str, now: i64 /*unix secs*/) -> Vec<Badge>;   // noMfa, oldKey, unusedKey, inactive
pub fn findings(s: &Snapshot, now: i64 /*unix secs*/) -> Findings;   // pure
pub fn parse_credential_report(csv: &str) -> Vec<CredRow>;                         // pure
pub fn least_privilege(eval: &PrincipalEval, la: &LastAccessedRaw, s: &Snapshot, arn: &str) -> (Vec<UnusedPolicy>, Option<String>, Vec<String>); // pure
```
Rules: spec "보안 점검 규칙" and "권한 줄이기". `STALE_DAYS = 90`. Use the project's existing time handling (check `adapters/util.rs`/`explorer/local.rs` for ISO formatting; add `time` crate only if nothing exists — prefer passing `now` as Unix seconds into pure functions for testability).
- Fetch: `get_account_authorization_details` with filters User, Role, Group, LocalManagedPolicy, AWSManagedPolicy, paginate `marker`/`is_truncated`; decode docs; for attached ARNs missing in `Policies`, `get_policy` + `get_policy_version` (concurrently, cap 20 at a time). Credential report: generate → poll every 1s up to 20s → get → `content` bytes (UTF-8 CSV) → parse; failure → `warnings` ("자격 증명 보고서를 불러오지 못했어요: …"), continue. Caller: `sts:GetCallerIdentity` → `caller_arn`; map `assumed-role/<RoleName>/<session>` → that role's ARN in the snapshot, `user/<name>` → user ARN, root → None.
- `iam_overview`: summaries from I2 + `credential_badges` merged into users + user `lastUsed` = max(password_last_used, key last used) + `findingCount` = total items over all groups + snapshot warnings.
- `iam_access_keys`: `list_access_keys` + `get_access_key_last_used` per key.
- `iam_last_accessed`: generate (ACTION_LEVEL) → poll every 1s up to 30s → get (paginate) → map to spec `LastAccessed` + `least_privilege`.
- `iam_list_policies(query)`: cache per profile `list_policies` (Scope=All, OnlyAttached=false, paginate) once; filter name contains query (case-insensitive), local first, max 100; badges via catalog-free name heuristics only (`AdministratorAccess`, `IAMFullAccess`, `PowerUserAccess` → admin/privesc) since documents are not fetched here.
- `iam_simulate`: `simulate_principal_policy` per principal (action, optional resource) → decision mapping.
- `iam_validate_policy`: JSON syntax check locally; then `accessanalyzer validate_policy` (PolicyType IDENTITY_POLICY); on AccessDenied/other errors set `analyzerAvailable=false` and keep syntax result.
- [ ] **Step 1: tests first (pure):** credential report CSV fixture (root row + 3 users covering: no MFA console user, key rotated 200 days ago, key never used created 120 days ago, inactive user, `N/A`/`no_information`/`not_supported` values) → parsed rows and `findings(now)` groups/items/details/cli/fix (`setAccessKeyStatus` fix carries the key id **only if known**; credential report has no key ids → `fix=None` and `cli` uses `<ACCESS_KEY_ID>` placeholder plus a hint "액세스 키 탭에서 바로 비활성화할 수 있어요"); inactiveRole excludes service-linked/SSO and young roles; externalTrust levels; unattachedPolicy; group order = spec table order with empty groups present. `least_privilege`: principal with S3+EC2 allowed via two policies, last-accessed shows only S3 used → EC2-only policy listed as unused, draft contains only `s3:*` (or used S3 actions when action-level data present), notes mention conditions dropped.
- [ ] **Step 2: implement** fetch + commands. Map SDK errors with existing `from_sdk(e, "iam:…")`.
- [ ] **Step 3:** register `IamState` (`app.manage`) and commands in `lib.rs`.
- [ ] **Step 4:** `cargo test` + clippy.
- [ ] **Step 5: commit** `feat(iam): IAM fetch, findings, least-privilege and read commands`.

---

### Task I4: Changes — preview, warnings, write, log, undo

**Files:** Create `src-tauri/src/iam/change.rs` (pure), `src-tauri/src/iam/write.rs` (the only IAM mutating calls), `src-tauri/src/iam/log.rs`; Modify `src-tauri/src/iam_commands.rs`, `src-tauri/src/lib.rs`.

**Consumes:** I1–I3 (`snapshot`, `invalidate`, `evaluate`, `policy_badges`).
**Produces:** commands `iam_preview`, `iam_apply`, `iam_change_log`, `iam_undo_change`, and:
```rust
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)] #[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum IamChange { AttachPolicy { target: String, policy_arn: String }, DetachPolicy { target: String, policy_arn: String },
    AddToGroup { user_name: String, group_name: String }, RemoveFromGroup { user_name: String, group_name: String },
    SetAccessKeyStatus { user_name: String, access_key_id: String, status: String /*"Active"|"Inactive"*/ },
    DeleteAccessKey { user_name: String, access_key_id: String },
    PutInlinePolicy { target: String, name: String, document: String }, DeleteInlinePolicy { target: String, name: String },
    UpdateManagedPolicy { policy_arn: String, document: String } }
pub fn apply_to_snapshot(s: &Snapshot, c: &IamChange) -> Result<Snapshot, String>;  // hypothetical state for impacts
pub fn preview(s: &Snapshot, c: &IamChange, key_status: Option<&str>) -> ChangePreview;   // pure
pub fn inverse(s: &Snapshot, c: &IamChange, key_status: Option<&str>) -> Option<IamChange>;  // pure
pub fn calls(s: &Snapshot, c: &IamChange) -> Vec<ApiCall>;   // exact API + params (UpdateManagedPolicy may include DeletePolicyVersion first)
pub async fn apply(client: &aws_sdk_iam::Client, s: &Snapshot, c: &IamChange) -> Result<Vec<String>, AppError>; // write.rs
pub fn append(path: &Path, e: &ChangeLogEntry) -> io::Result<()>; pub fn read_all(path: &Path) -> Vec<ChangeLogEntry>; pub fn mark_undone(path: &Path, id: &str) -> io::Result<()>; // log.rs
```
Rules: spec "직접 변경" (warning levels, confirmText = target's short name, e.g. user/role/group/policy name or key id for key deletion; policy size limits; caller self-impact uses `caller_principal_arn` and groups the caller user belongs to). Impacts: diff `evaluate` before/after for each affected principal (target; group → members; managed policy → every attached principal incl. via groups) aggregated to `(prefix, level)` counts of actions that became allowed/conditional (`gained`) or stopped (`lost`), `sample` ≤ 5 action names. `summary` Korean one-liners (e.g. "alice에서 AdministratorAccess 떼기"). Log file: `<app data dir>/iam-changes.jsonl` (resolve like `settings_path`'s dir). `iam_apply(profile, change, confirmText, undoOf)`: snapshot (refetch if older than 60s) → current key status via `list_access_keys` for key ops → `preview` again → refuse block / confirm mismatch (`AppError::other` Korean) → `inverse` → `write::apply` → append log (also on failure, `ok=false`) → if `undoOf` mark that entry undone → `invalidate` → return `{logId, summary}`. `iam_undo_change(entryId)`: read log → entry.inverse or error "되돌릴 수 없는 변경이에요".
- [ ] **Step 1: tests first (pure):** each op's `calls`; `apply_to_snapshot` effects; warnings: service-linked/SSO targets → block; AWS managed edit → block; invalid JSON → block; inline size limits per kind; caller losing permissions → confirm with confirmText; making someone admin → confirm; delete key/inline → confirm; cfn tag → warn; 5 versions → warn + DeletePolicyVersion of oldest non-default in calls; impacts: detaching `AdministratorAccess` from group `admins` lists alice with lost counts; inverse for every op (key status uses `key_status`; put inline over existing → put old doc; new inline → delete; delete inline → put old; managed update → old default doc; delete key → None); log append/read/mark_undone roundtrip in a tempdir; `IamChange` JSON shape matches the spec (`{"op":"attachPolicy","target":…,"policyArn":…}`).
- [ ] **Step 2: implement** `write.rs` (target ARN → user/group/role by `principal_kind`; `UpdateManagedPolicy`: if 5 versions delete oldest non-default, then `create_policy_version(set_as_default=true)`), log, commands; register.
- [ ] **Step 3:** grep guard — mutating IAM calls only in `iam/write.rs`: `grep -rnE "attach_(user|group|role)_policy|detach_|put_(user|group|role)_policy|delete_(user|group|role)_policy|add_user_to_group|remove_user_from_group|update_access_key|delete_access_key|create_policy_version|delete_policy_version" src-tauri/src | grep -v "src/iam/write.rs"` → empty (test names excepted if needed — prefer not to mention them elsewhere).
- [ ] **Step 4:** `cargo test` + clippy.
- [ ] **Step 5: commit** `feat(iam): change preview, guarded writes, change log and undo`.

---

### Task J1: IAM tab shell, navigation, principal and policy views

**Files:** Create `src/iam/types.ts` (spec contract verbatim as TS), `src/iam/api.ts` (`iamApi.*` wrappers over `invoke` with the exact command/arg names), `src/iam/queries.ts`, `src/iam/IamTab.tsx`, `src/iam/IamNav.tsx`, `src/iam/PrincipalList.tsx`, `src/iam/PrincipalDetail.tsx`, `src/iam/PermissionMatrix.tsx`, `src/iam/ActionDrilldown.tsx`, `src/iam/PolicyDetail.tsx`, `src/iam/Badges.tsx`, `src/iam/useIamHistory.ts`, tests `src/iam/*.test.tsx`, `src/iam/fixtures.ts`; Modify `src/App.tsx`, `src/components/Sidebar.tsx`, `src/components/ResourceArea.tsx`, `src/components/MainArea.tsx`, `src/styles.css`, `docs/manual-test-checklist.md`.

**Behavior:** spec "화면" (tab, entry points, layout, history, principal sub-tabs **read-only content** for 권한/정책/그룹/액세스 키/신뢰 — buttons for changes are added in J3; leave clear extension points such as an `actions` render prop or a `ChangeContext`), policy detail, top note. Details:
- Query keys: `["iam", profile, "overview"]`, `["iam", profile, "principal", arn]`, `["iam", profile, "actions", arn, prefix, level]`, `["iam", profile, "policy", id]`, `["iam", profile, "keys", user]`, `["iam", "catalog"]` (iam_actions, staleTime Infinity). ⌘R `refresh` in App invalidates `["iam", profile]` and calls overview with `force=true` (expose `iamApi.overview(profile, true)` refetch via a `forceRef` or a query-fn param; simplest: the overview query fn reads a module-level `forceNext` flag set by refresh).
- App: state `iamTab: { focus: string | null; nonce: number } | null`; `openIam(focus?)` creates/activates tab id `iam`; title `🔐 IAM · <accountId>` (from overview when loaded, else `🔐 IAM`); closable; closed on profile change; placed after resource tab and before bucket tabs; `hidden`/`active` pattern. Sidebar: when the IAM service group is expanded, show a first row "🔐 IAM 관리" that calls `onOpenIam()` (new optional prop). ResourceArea: IAM `users`/`roles`/`policies` double-click/Enter → `onOpenIam(resource.arn)`.
- IamTab: nav (counts from overview) → main view by route `{ view: "findings"|"users"|"groups"|"roles"|"policies"|"whoCan"|"log", id?: string }`; history (back/forward) via `useIamHistory`; mouse back/forward via `onMouseNav` from `src/explorer/api.ts` and ⌘[ / ⌘] only when `active` and no dialog open; `focus` prop navigates to the principal/policy (detect kind from overview lists). Placeholders for findings/whoCan/log views ("곧 추가돼요") — J2/J3 replace them.
- Lists: filterable tables (reuse `ResourceTable` or a small table) with name, badges, last used, policy count / member count / attachment count. Double-click/Enter opens detail.
- PrincipalDetail: header (name, ARN with copy, badges), sub-tabs; 권한 = PermissionMatrix (rows = services, 5 level columns showing `allowed`/`total`, conditional/denied as small markers, danger row marker, filter box, admin banner "모든 서비스의 모든 작업이 허용돼요" when `adminLike`), clicking a cell opens ActionDrilldown in the right panel (calls `iam_principal_actions`): action list with status chips, resources, sources (policy name → click navigates to policy detail; via group). 정책 tab: list from `policies` with kind/via/badges (click → policy detail). 그룹 tab: names (click → group detail). 액세스 키 tab: `iam_access_keys` table. 신뢰 tab: TrustEntry list with warnings. `unknownActions` and `notes` shown.
- PolicyDetail: statements table (effect, services with levels and counts, resources, conditions), JSON (pre, copy), versions, attachedTo (click → principal).
- Styles consistent with existing dark theme.
- [ ] **Step 1: fixtures + tests first:** App opens IAM tab from sidebar entry and from IAM Users double-click (focus), reuses tab, closes on profile change; nav switches lists; history back/forward (⌘[ and mouse-nav mock) and inactive tab ignores them; PrincipalDetail renders badges and matrix; clicking a cell loads drilldown (mocked) and source click navigates to policy; admin banner; policy detail renders statements/JSON/attachments.
- [ ] **Step 2: implement.**
- [ ] **Step 3:** `npm test`, `npx tsc --noEmit`, `npm run build`.
- [ ] **Step 4:** checklist items for IAM tab basics.
- [ ] **Step 5: commit** `feat(iam): IAM workspace tab with permission and policy views`.

---

### Task J2: Who-can, security checks, unused permissions

**Files:** Create `src/iam/WhoCan.tsx`, `src/iam/Findings.tsx`, `src/iam/UnusedPermissions.tsx` + tests; Modify `src/iam/IamTab.tsx`, `src/iam/PrincipalDetail.tsx` (add 안 쓰는 권한 sub-tab), `src/styles.css`, `docs/manual-test-checklist.md`.

**Behavior:** spec "누가 할 수 있나", "보안 점검", "권한 줄이기".
- WhoCan: action input with autocomplete from `iam_actions` (prefix/substring match, keyboard ↑/↓/Enter, max 50 suggestions), optional resource ARN input, [찾기] → `iam_who_can`; results table: principal (click → detail), status chip (허용/조건부/경계로 차단/거부), sources (policy/via/sid). [AWS로 확인] runs `iam_simulate` for the listed principals and shows the decision next to each row. Notes line.
- Findings: cards in spec order with count and level color; empty groups shown as "문제 없음" (dim). Selecting a card lists items: target (click → detail), detail text, [CLI 복사] (`desktop.copy`), and a quick-fix button when `fix` exists (emit `onFix(change)`; J3 wires it to the preview dialog — for now a prop no-op). `generatedAt` and warnings shown.
- UnusedPermissions (principal sub-tab "안 쓰는 권한"): button [불러오기] (job can take ~10–30s; show progress text) → `iam_last_accessed`; services table sorted by last used (never used first) with "사용 안 함 (400일)" labels; unused policies list with [떼기] (emit `onFix(detachPolicy)`, disabled with hint when `via` is set); draft JSON in a pre with [복사] and [인라인 정책으로 저장] (emit `onFix(putInlinePolicy{ name: "least-privilege-<yyyymmdd>", document })`); `draftNotes`.
- [ ] Tests first (mocked api): autocomplete selection, results render and navigation, simulate merge; findings cards counts, empty group text, CLI copy, fix callback; unused permissions load, unused policy list, draft copy and fix callback.
- [ ] Implement, verify (`npm test`, `npx tsc --noEmit`, `npm run build`), checklist items, commit `feat(iam): who-can search, security findings and unused permissions`.

---

### Task J3: Change flow UI — actions, editors, preview, log, undo

**Files:** Create `src/iam/ChangePreviewDialog.tsx`, `src/iam/PolicyPicker.tsx`, `src/iam/GroupPicker.tsx`, `src/iam/PolicyEditor.tsx`, `src/iam/ChangeLog.tsx`, `src/iam/useIamChange.ts` + tests; Modify `src/iam/IamTab.tsx`, `src/iam/PrincipalDetail.tsx`, `src/iam/PolicyDetail.tsx`, `src/iam/Findings.tsx`, `src/iam/UnusedPermissions.tsx`, `src/styles.css`, `docs/manual-test-checklist.md`.

**Behavior:** spec "직접 변경".
- `useIamChange(profile)`: `start(change)` → `iam_preview` → opens ChangePreviewDialog; `apply()` → `iam_apply(change, confirmText, undoOf)` → success notice (summary + "반영까지 몇 초 걸릴 수 있어요") → invalidate `["iam", profile]` now and again after 3s with overview `force=true`; error → shown in dialog, dialog stays open.
- ChangePreviewDialog (wide sheet, focus-safe like ConfirmDialog: Escape cancels, initial focus on 취소): summary, warnings grouped (block red → 적용 disabled; confirm orange → text input "확인하려면 <confirmText>를 입력하세요" must match; warn yellow), API calls (mono list), impacts per principal (gained green / lost red per service·level with counts and samples), reversible note; buttons [취소] [적용] (danger style when any confirm/warn).
- Principal 정책 tab: [정책 붙이기] → PolicyPicker (search `iam_list_policies`, badges, description) → `attachPolicy`; each detachable policy row [떼기] → `detachPolicy` (group-inherited rows: hint "그룹 <name>에서 떼야 해요" + link to group); inline rows [편집] [삭제]; [인라인 정책 추가] → PolicyEditor (name + JSON textarea (monospace, Tab inserts 2 spaces), live JSON parse error, [검사] → `iam_validate_policy` findings list, [미리보기] → `putInlinePolicy`).
- Group detail: members with [빼기] (`removeFromGroup`), [사용자 추가] (pick from overview users) ; user 그룹 tab: [그룹에 추가] (GroupPicker from overview groups) / [빼기].
- 액세스 키 tab: [비활성화]/[활성화] (`setAccessKeyStatus`), [삭제] (`deleteAccessKey`).
- PolicyDetail: when `editable` and scope local → [편집] → PolicyEditor prefilled with `document` → `updateManagedPolicy`; inline → `putInlinePolicy`.
- Findings `fix` and UnusedPermissions `onFix` → `start(change)`.
- ChangeLog view (nav 🕘 변경 기록): `iam_change_log` list (time, profile/account, summary, ok/error, undone), [되돌리기] when `inverse && !undone && ok` → `iam_undo_change(id)` → `start(inverse, { undoOf: id })`.
- Service-linked/SSO principals: action buttons disabled with the reason (backend blocks anyway).
- [ ] Tests first (mocked api): attach via picker → preview → apply args; confirm text gating (apply disabled until exact match); block disables apply; error stays in dialog; detach/inherited hint; inline editor syntax error + validate findings + preview; key deactivate/delete; group add/remove; managed policy edit; findings fix opens preview; change log undo flow passes `undoOf`; invalidation after apply.
- [ ] Implement, verify, checklist (writes only in a test account), commit `feat(iam): guarded IAM changes with preview, change log and undo`.

---

### Task K: Demo, screenshot, README, final review (controller)
- Add IAM fixtures to `scripts/screenshots/demo.tsx` (mock all `iam_*` commands with a realistic small account), capture `docs/screenshots/iam.png` (principal permissions view with drilldown) via `scripts/screenshots/shoot.mjs`.
- README (English): "IAM workspace" feature section + permissions list; no instructions about screenshots.
- Whole-branch review (most capable model), single fix wave, merge to `main`, push.
