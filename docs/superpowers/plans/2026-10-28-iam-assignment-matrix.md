# IAM 할당 매트릭스 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "🧩 할당" IAM view with two tables: principals × managed policies, and users × groups. Clicking or dragging over cells collects attach/detach/add/remove changes in a tray, and the tray is previewed, applied, logged and undone as one batch.

**Architecture:**
- Backend: a pure batch preview (`iam/change/batch.rs`) orders the changes, applies them one by one to a virtual snapshot, and compares the first and last state once. A batch commit (`iam/commit/batch.rs`) re-checks the stored plan, writes change by change through `iam/write.rs`, stops at the first failure, and logs every change with a shared `batchId`.
- Frontend: pure matrix logic (`src/iam/assignments.ts`) plus a tray hook. The grid has virtualised rows, paint-drag and keyboard support. A batch preview flow and dialog reuse the single-change dialog's parts.

**Tech Stack:** Tauri 2, Rust (tokio, serde), React 18 + TS, TanStack Query, Vitest + Testing Library.

## Global Constraints
- Spec: `docs/superpowers/specs/2026-10-28-iam-assignment-matrix-design.md`. Branch: `feat/iam-assignments`.
- UI copy is Korean 해요체. Code identifiers and commit messages are English.
- Contract changes are additive only, exactly as in the spec's 계약 section:
  - `PrincipalSummary.attached?/groups?/boundary?`
  - `iam_preview_batch(profile, changes)`
  - `iam_apply_batch(profile, changes, confirmText, undoOf)`
  - `iam_undo_batch(batchId) → { changes, undoOf }`
  - `BatchPreview { changes: BatchItem[]; impacts; impactsOmitted?; warnings; confirmText; reversible }`
  - `BatchItem { change; summary; calls; warnings }`
  - `BatchResult { batchId; logIds; failed: { index; summary; message } | null; notes? }`
  - `ChangeLogEntry.batchId?`
- Exact strings (Korean copy):
  - Batch blocks: "적용할 변경이 없어요", "한 번에 50개까지 적용할 수 있어요", "묶음에는 붙이기·떼기·넣기·빼기만 담을 수 있어요", "같은 대상을 바꾸는 변경이 겹쳐요".
  - Multi-target confirm text: `변경 ${N}개 적용`.
  - Drift: the existing `DRIFTED` ("미리보기 뒤에 IAM이 바뀌었어요. 미리보기를 다시 받아 주세요.").
  - Undo errors: "되돌릴 기록과 변경의 수가 맞지 않아요", "되돌릴 변경이 없어요", "변경 기록을 찾지 못했어요".
  - Tray full: "한 번에 50개까지 담을 수 있어요".
  - Tray bar: `변경 ${N}개 · ${first}` (N=1) / `변경 ${N}개 · ${first} 외 ${N-1}개`.
  - Draft labels: `${policy} 붙이기 · ${principal}`, `${policy} 떼기 · ${principal}`, `${group}에 넣기 · ${user}`, `${group}에서 빼기 · ${user}`.
  - Cleanup notices: `이미 붙어 있어서 뺐어요: ${label}`, `이미 떨어져 있어서 뺐어요: ${label}`, `이미 그룹에 있어서 뺐어요: ${label}`, `이미 그룹에 없어서 뺐어요: ${label}`, `찾을 수 없어서 뺐어요: ${label}`.
  - Inherited popover: `${group} 그룹에서 받아요` + [그룹 행으로 가기].
  - Batch dialog title: `변경 ${N}개 미리보기`.
  - Partial failure: `${N}개 중 ${k}개를 적용하고 ${k+1}번째에서 멈췄어요: ${summary}: ${message}` + [`적용된 ${k}개 되돌리기`].
  - Success notice: `변경 ${N}개를 적용했어요`.
  - Change-log group header: `묶음 · 변경 ${N}개 · ${time}` + [묶음 되돌리기].
  - Nav/tab labels: "할당", "정책", "그룹 구성원". Chips: "사용자", "그룹", "역할". Buttons: "열 추가", "모두 취소", "미리보기", "다른 주체와 같게". Row end: `인라인 ${N}`, "경계".
- A batch holds only attachPolicy/detachPolicy/addToGroup/removeFromGroup, at most 50 changes (`MAX_BATCH = 50`). The tray limit is also 50 (`MAX_DRAFT = 50`).
- IAM mutating SDK calls appear only in `src-tauri/src/iam/write.rs`. The grep guard must stay empty, so test names must avoid those words: `grep -rnE "attach_(user|group|role)_policy|detach_|put_(user|group|role)_policy|delete_(user|group|role)_policy|add_user_to_group|remove_user_from_group|update_access_key|delete_access_key|create_policy_version|delete_policy_version" src-tauri/src | grep -v "src/iam/write.rs"`.
- Rust: `cargo test` and the literal `cargo clippy --all-targets -- -D warnings` must be clean (no `allow` added). Frontend: `npx vitest run`, `npx tsc --noEmit` and `npm run build` must be clean.
- Every commit ends with exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage by explicit path. Backend tasks touch only `src-tauri/`. Frontend tasks touch only `src/` and `docs/manual-test-checklist.md`.

## Execution order
Backend **B1 → B2** and frontend **F1 → F2 → F3** run in parallel, with the frontend mocking the contract. Then **K**: README, final review, merge.

---

### Task B1: Pure batch preview

**Files:**
- Create: `src-tauri/src/iam/change/batch.rs`, `src-tauri/src/iam/change/batch/tests.rs`
- Modify: `src-tauri/src/iam/change.rs`. Add `mod batch;` and `pub use batch::{application_order, ordered, preview_batch, BatchItem, BatchPreview, MAX_BATCH};`, and add a line to the module doc.
- Modify: `src-tauri/src/iam/change/preview.rs`. `rank` becomes `pub(super)`.
- Modify: `src-tauri/src/iam/change/warnings.rs`. Split `from_analysis`, and make `undo_problem` take a slice.

**Interfaces:**
- Consumes these existing functions:
  - `warnings::{target_badges, blocks, notices}`
  - `text::{describe, confirm_name}`
  - `calls`, `inverse`, `apply_to_snapshot`
  - `impact::{affected, analyze, shown, is_zero}`
  - `Warning::new(level, msg)`, `Facts: Default`
- Produces, used by B2:
  - `pub const MAX_BATCH: usize = 50`
  - `pub fn application_order(changes: &[IamChange]) -> Vec<usize>`
  - `pub fn ordered(changes: &[IamChange]) -> Vec<IamChange>`
  - `pub fn preview_batch(s: &Snapshot, changes: &[IamChange], facts: &[Facts]) -> BatchPreview`
    - `facts` is aligned with `changes` in received order. A missing entry means `Facts::default()`.
  - `BatchItem { change, summary, calls, warnings, inverse }`. `inverse` is `#[serde(skip_serializing)]`.
  - `BatchPreview { changes, impacts, impacts_omitted, warnings, confirm_text, reversible }`, serialized in camelCase. `impacts_omitted` is skipped when 0.

- [ ] **Step 1: Refactor warnings for many inverses (no behavior change).** In `warnings.rs`:

```rust
pub(super) fn from_analysis(before: &Snapshot, after: &Snapshot, c: &IamChange, a: &Analysis, inverse: Option<&IamChange>) -> (Vec<Warning>, bool) {
    let inverses: Vec<IamChange> = inverse.cloned().into_iter().collect();
    let edits_document = matches!(c, IamChange::PutInlinePolicy { .. } | IamChange::UpdateManagedPolicy { .. });
    analysis_warnings(before, after, a, &inverses, edits_document)
}

/// 영향 비교에서 나오는 경고와 "되돌릴 권한을 잃는지". `inverses`는 되돌리는 순서대로, `edits_document`는 사용자가 쓴 정책 문서를 다루는 변경인지.
pub(super) fn analysis_warnings(before: &Snapshot, after: &Snapshot, a: &Analysis, inverses: &[IamChange], edits_document: bool) -> (Vec<Warning>, bool) {
    // = the old from_analysis body, with
    //   `undo_problem(before, after, caller, inverse)` → `undo_problem(before, after, caller, inverses)`
    //   `matches!(c, IamChange::PutInlinePolicy { .. } | IamChange::UpdateManagedPolicy { .. })` → `edits_document`
}
```

  `undo_problem(before, after, caller, inverses: &[IamChange])` returns `None` when `inverses` is empty. Otherwise it checks every API of `inverses.iter().flat_map(|inv| calls(after, inv))`. It removes duplicate API names in the `gone`/`conditional` lists and keeps their order. The messages stay the same.

  Run `cd src-tauri && cargo test iam::change`. Expected: all existing tests pass unchanged.

- [ ] **Step 2: Write the failing tests** in `src-tauri/src/iam/change/batch/tests.rs`. Build snapshots with the existing helpers in `iam::fixtures` and `iam/change/scenarios.rs` (reuse their builders, don't duplicate them). Each test name must avoid the grep-guard words.
  1. `grants_come_first_and_keep_their_order`
     - Input: `[detach(a), add(b), remove(c), attach(d)]`.
     - `application_order` must be `[1, 3, 0, 2]`, and `ordered(...)` must follow that order.
  2. `each_change_is_computed_on_the_state_before_it`
     - Input: `[add bob to dev-team, attach X to dev-team]`, where X allows `s3:GetObject`.
     - bob's impact contains gained `s3` read. The second item's summary and calls target dev-team.
  3. `swapping_a_policy_shows_only_the_real_difference`
     - Input: `[detach ReadOnlyAccess-like policy P1 from bob, attach P2 to bob]`, where P2 is a superset of P1.
     - The impacts must equal `analyze(s0, apply(apply(s0, attach), detach))`: only gains, no losses.
  4. `one_target_types_its_name`
     - Input: `[attach admin policy to bob]`, where bob becomes admin.
     - `confirm_text == Some("bob")`.
  5. `many_targets_type_the_count`
     - Input: `[attach admin to bob, attach admin to carol]`.
     - `confirm_text == Some("변경 2개 적용")`.
  6. `membership_and_attach_of_the_same_user_count_as_one_target`
     - Input: `[add bob to admins, attach P to bob]`, with a confirm present.
     - `confirm_text == Some("bob")`.
  7. `batch_rules_block` (one case each)
     - `[]` → "적용할 변경이 없어요".
     - 51 changes → "한 번에 50개까지 적용할 수 있어요".
     - A `SetAccessKeyStatus` in the list → "묶음에는 붙이기·떼기·넣기·빼기만 담을 수 있어요".
     - `[attach P to bob, detach P from bob]` → "같은 대상을 바꾸는 변경이 겹쳐요".
     - Every blocked batch has `reversible == false`, no confirm warnings anywhere, `confirm_text == None` and empty `impacts`.
  8. `a_locked_target_blocks_the_whole_batch`
     - Input: an attach on a service-linked role, plus one valid change.
     - That item carries the existing lock block, and the batch is not reversible.
  9. `losing_own_admin_needs_confirm_and_is_not_reversible`
     - Input: the caller (`caller_principal_arn`) gets admin only through group `admins`, and the batch is `[remove caller from admins, attach ReadOnly to caller]`.
     - The batch warnings contain the caller-reduction confirm with the undo-problem text, and `reversible == false`.
  10. `facts_follow_their_change_after_reordering`
      - Input: `changes = [detach P from bob, attach Q to carol]`, with `facts[1].policy_error = Some("권한 없음 (iam:GetPolicy)")`.
      - The attach item (now index 0) carries the warn built from that error. The detach item does not.
  11. `serializes_camel_case_without_inverse`
      - The JSON has `changes[0].summary` and `confirmText`.
      - It has no `inverse` key, and no `impactsOmitted` when 0.

  Run `cd src-tauri && cargo test iam::change::batch`. Expected: compile failure (module missing).

- [ ] **Step 3: Implement `batch.rs`:**

```rust
//! 묶음 미리보기: 할당 표에서 모은 붙이기·떼기·넣기·빼기를 적용 순서로 늘어놓고, 가상 스냅숏에 하나씩 반영하며 변경마다
//! 요약·호출·경고를 그 시점 상태로 계산한 뒤, 처음과 끝 상태를 한 번 비교해 권한 증감과 묶음 경고를 낸다. 순수 함수다.

use std::collections::BTreeSet;

use serde::Serialize;

use super::facts::Facts;
use super::impact::{affected, analyze, is_zero, shown};
use super::preview::rank;
use super::text::{confirm_name, describe};
use super::warnings;
use super::{apply_to_snapshot, calls, inverse, ApiCall, IamChange, Impact, WarnLevel, Warning};
use crate::iam::model::Snapshot;

pub const MAX_BATCH: usize = 50;
pub const EMPTY: &str = "적용할 변경이 없어요";
pub const TOO_MANY: &str = "한 번에 50개까지 적용할 수 있어요";
pub const ONLY_ASSIGNMENTS: &str = "묶음에는 붙이기·떼기·넣기·빼기만 담을 수 있어요";
pub const OVERLAP: &str = "같은 대상을 바꾸는 변경이 겹쳐요";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchItem {
    pub change: IamChange,
    pub summary: String,
    pub calls: Vec<ApiCall>,
    /// 이 변경에서 나온 막힘·확인·주의(막힘 → 확인 → 주의 순서)
    pub warnings: Vec<Warning>,
    /// 되돌리는 변경. 화면으로 보내지 않고 기록에 남길 때 쓴다
    #[serde(skip_serializing)]
    pub inverse: Option<IamChange>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchPreview {
    /// 적용 순서대로
    pub changes: Vec<BatchItem>,
    pub impacts: Vec<Impact>,
    #[serde(skip_serializing_if = "is_zero")]
    pub impacts_omitted: usize,
    /// 묶음 규칙과 처음·끝 상태 비교에서 나온 경고
    pub warnings: Vec<Warning>,
    pub confirm_text: Option<String>,
    pub reversible: bool,
}

fn is_grant(c: &IamChange) -> bool {
    matches!(c, IamChange::AttachPolicy { .. } | IamChange::AddToGroup { .. })
}

fn is_assignment(c: &IamChange) -> bool {
    matches!(c, IamChange::AttachPolicy { .. } | IamChange::DetachPolicy { .. } | IamChange::AddToGroup { .. } | IamChange::RemoveFromGroup { .. })
}

/// 적용 순서(받은 목록의 index): 붙이기·넣기 먼저, 떼기·빼기 나중, 각 무리 안에서는 받은 순서.
/// 앱이 자기 권한을 줄이는 묶음이라도 중간에 남은 변경을 적용할 권한을 잃지 않게 하려는 순서다.
pub fn application_order(changes: &[IamChange]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..changes.len()).filter(|&i| is_grant(&changes[i])).collect();
    order.extend((0..changes.len()).filter(|&i| !is_grant(&changes[i])));
    order
}

/// 적용 순서로 늘어놓은 변경. 계획 저장소의 키로도 쓴다.
pub fn ordered(changes: &[IamChange]) -> Vec<IamChange> {
    application_order(changes).into_iter().map(|i| changes[i].clone()).collect()
}

/// 같은 칸을 가리키는지 가르는 키: 붙이기·떼기는 (대상 ARN, 정책 ARN), 넣기·빼기는 (사용자, 그룹).
fn cell_key(c: &IamChange) -> Option<(u8, &str, &str)> {
    match c {
        IamChange::AttachPolicy { target, policy_arn } | IamChange::DetachPolicy { target, policy_arn } => Some((0, target, policy_arn)),
        IamChange::AddToGroup { user_name, group_name } | IamChange::RemoveFromGroup { user_name, group_name } => Some((1, user_name, group_name)),
        _ => None,
    }
}

fn batch_blocks(changes: &[IamChange]) -> Vec<Warning> {
    let mut out = Vec::new();
    if changes.is_empty() {
        out.push(Warning::new(WarnLevel::Block, EMPTY));
    }
    if changes.len() > MAX_BATCH {
        out.push(Warning::new(WarnLevel::Block, TOO_MANY));
    }
    if changes.iter().any(|c| !is_assignment(c)) {
        out.push(Warning::new(WarnLevel::Block, ONLY_ASSIGNMENTS));
    }
    let mut seen = BTreeSet::new();
    if changes.iter().filter_map(cell_key).any(|k| !seen.insert(k)) {
        out.push(Warning::new(WarnLevel::Block, OVERLAP));
    }
    out
}

/// 변경이 바꾸는 주체. 사용자를 그룹에 넣고 빼는 변경도 그 사용자의 ARN으로 센다(같은 사용자에게 정책을 붙이는 변경과 한 대상이다).
fn target_of(s: &Snapshot, c: &IamChange) -> String {
    match c {
        IamChange::AttachPolicy { target, .. } | IamChange::DetachPolicy { target, .. } => target.clone(),
        IamChange::AddToGroup { user_name, .. } | IamChange::RemoveFromGroup { user_name, .. } => {
            s.user(user_name).map_or_else(|| format!("user:{user_name}"), |u| u.arn.clone())
        }
        other => format!("{other:?}"),
    }
}

/// 확인 문구: 묶음의 모든 변경이 한 대상에 몰려 있으면 그 이름, 아니면 "변경 N개 적용".
fn batch_confirm_text(s: &Snapshot, changes: &[IamChange]) -> String {
    let targets: BTreeSet<String> = changes.iter().map(|c| target_of(s, c)).collect();
    match (targets.len(), changes.first()) {
        (1, Some(first)) => confirm_name(s, first),
        _ => format!("변경 {}개 적용", changes.len()),
    }
}

/// 묶음 미리보기. `facts`는 `changes`와 같은 순서(받은 순서)로 변경마다 하나다.
pub fn preview_batch(s: &Snapshot, changes: &[IamChange], facts: &[Facts]) -> BatchPreview {
    let mut batch_warnings = batch_blocks(changes);
    let mut state = s.clone();
    let mut items: Vec<BatchItem> = Vec::with_capacity(changes.len());
    let mut touched: Vec<String> = Vec::new();
    for i in application_order(changes) {
        let (c, f) = (&changes[i], facts.get(i).cloned().unwrap_or_default());
        let badges = warnings::target_badges(&state, c);
        let mut found = warnings::blocks(&state, c, &f, &badges);
        found.extend(warnings::notices(&state, c, &f, &badges));
        let item_inverse = inverse(&state, c, &f);
        let (summary, item_calls) = (describe(&state, c), calls(&state, c));
        if !found.iter().any(|w| w.level == WarnLevel::Block) {
            match apply_to_snapshot(&state, c) {
                Err(reason) => found.push(Warning::new(WarnLevel::Block, reason)),
                Ok(next) => {
                    for arn in affected(&state, c) {
                        if !touched.contains(&arn) {
                            touched.push(arn);
                        }
                    }
                    state = next;
                }
            }
        }
        found.sort_by_key(|w| rank(w.level));
        items.push(BatchItem { change: c.clone(), summary, calls: item_calls, warnings: found, inverse: item_inverse });
    }
    let blocked = batch_warnings.iter().chain(items.iter().flat_map(|i| &i.warnings)).any(|w| w.level == WarnLevel::Block);
    let caller = s.caller_principal_arn.as_deref();
    let mut impacts = Vec::new();
    let mut undo_lost = false;
    if blocked {
        // 막힌 묶음은 적용되지 않으니 확인을 받지 않는다(변경 하나짜리 미리보기와 같은 규칙)
        batch_warnings.retain(|w| w.level != WarnLevel::Confirm);
        for item in &mut items {
            item.warnings.retain(|w| w.level != WarnLevel::Confirm);
        }
    } else {
        let analysis = analyze(s, &state, touched, caller);
        // 되돌리기는 적용의 반대 순서로 한다
        let inverses: Vec<IamChange> = items.iter().rev().filter_map(|i| i.inverse.clone()).collect();
        let (found, lost) = warnings::analysis_warnings(s, &state, &analysis, &inverses, false);
        batch_warnings.extend(found);
        undo_lost = lost;
        impacts = analysis.impacts;
    }
    batch_warnings.sort_by_key(|w| rank(w.level));
    let needs_confirm = batch_warnings.iter().chain(items.iter().flat_map(|i| &i.warnings)).any(|w| w.level == WarnLevel::Confirm);
    let in_order: Vec<IamChange> = items.iter().map(|i| i.change.clone()).collect();
    let confirm_text = needs_confirm.then(|| batch_confirm_text(s, &in_order));
    let (impacts, impacts_omitted) = shown(impacts, caller);
    let reversible = !blocked && items.iter().all(|i| i.inverse.is_some()) && !undo_lost;
    BatchPreview { changes: items, impacts, impacts_omitted, warnings: batch_warnings, confirm_text, reversible }
}

#[cfg(test)]
mod tests;
```

  If a signature differs from what is assumed here (for example `analyze`'s argument types, `s.user`, or `Snapshot: Clone`), adapt the call. Keep the behavior and the tests.

- [ ] **Step 4: Run the tests.** Run `cd src-tauri && cargo test iam::change` and the literal `cargo clippy --all-targets -- -D warnings`. Expected: all pass, no warnings.

  Mutation-check:
  - Swap `application_order` to keep received order; test 1 must fail.
  - Compute every item on `s` instead of `state`; test 2 must fail.
  - Restore both.

- [ ] **Step 5: Commit** with message `feat(iam): pure batch preview for assignment changes`.

---

### Task B2: Batch commit, log, undo, commands, overview fields

**Files:**
- Modify: `src-tauri/src/iam/commit/plan.rs`. `PlanStore` becomes generic, and `BatchPlan` is added.
- Create: `src-tauri/src/iam/commit/batch.rs`, `src-tauri/src/iam/commit/batch/tests.rs`
- Modify: `src-tauri/src/iam/commit.rs`. Add `pub mod batch;`, and generalize `gate`.
- Modify: `src-tauri/src/iam/log.rs`. Add `batch_id`.
- Modify: every `ChangeLogEntry { … }` literal. Find them with `grep -rn "ChangeLogEntry {" src-tauri/src`.
- Modify: `src-tauri/src/iam/view.rs`, `src-tauri/src/iam/summary.rs`. Add the `PrincipalSummary` fields.
- Modify: `src-tauri/src/iam_commands.rs`. Add three commands and the glue.
- Modify: `src-tauri/src/lib.rs`. Register the commands.

**Interfaces:**
- Consumes from B1: `preview_batch`, `ordered`, `application_order`, `BatchPreview`, `BatchItem`, `MAX_BATCH`.
- Produces:
  - Commands `iam_preview_batch(profile, changes) -> BatchPreview`
  - `iam_apply_batch(profile, changes, confirm_text, undo_of) -> BatchResult`
  - `iam_undo_batch(batch_id) -> UndoBatch { changes, undo_of }`
  - Serialized in camelCase as in the spec.

- [ ] **Step 1: Make `PlanStore` generic and add `BatchPlan`.** In `plan.rs`:

```rust
fn key<K: Serialize + std::fmt::Debug + ?Sized>(profile: &str, k: &K) -> Key {
    let canonical = serde_json::to_string(k).unwrap_or_else(|_| format!("{k:?}"));
    (profile.to_string(), canonical)
}

struct Entry<P> {
    key: Key,
    plan: P,
    at: i64,
}

/// 프로필·변경(또는 변경 묶음)마다 마지막 미리보기의 계획. 꺼내 쓰면 지워져서 미리보기 하나로는 많아야 한 번 적용한다.
pub struct PlanStore<P = Plan> {
    entries: VecDeque<Entry<P>>,
}

impl<P> Default for PlanStore<P> {
    fn default() -> Self {
        PlanStore { entries: VecDeque::new() }
    }
}

impl<P> PlanStore<P> {
    // prune, remember<K: Serialize + Debug + ?Sized>(&mut self, profile: &str, k: &K, plan: P, now: i64),
    // take<K: …>(&mut self, profile: &str, k: &K, now: i64) -> Option<P>: same bodies as today
}

/// 묶음 미리보기에서 사용자가 확인한 것. 변경마다 (요약, 호출, 막힘·확인 경고)와 묶음 전체의 막힘·확인 경고, 확인 문구, 되돌릴 수 있는지.
#[derive(Clone, Debug, PartialEq)]
pub struct BatchPlan {
    pub account_id: String,
    pub items: Vec<(String, Vec<ApiCall>, Vec<Warning>)>,
    pub checks: Vec<Warning>,
    pub confirm_text: Option<String>,
    pub reversible: bool,
}

fn checks_of(warnings: &[Warning]) -> Vec<Warning> {
    warnings.iter().filter(|w| matches!(w.level, WarnLevel::Block | WarnLevel::Confirm)).cloned().collect()
}

impl BatchPlan {
    pub fn of(account_id: &str, p: &BatchPreview) -> BatchPlan {
        BatchPlan {
            account_id: account_id.to_string(),
            items: p.changes.iter().map(|i| (i.summary.clone(), i.calls.clone(), checks_of(&i.warnings))).collect(),
            checks: checks_of(&p.warnings),
            confirm_text: p.confirm_text.clone(),
            reversible: p.reversible,
        }
    }
}
```

  Make `check` generic: `pub fn check<P: PartialEq>(seen: Option<&P>, now: &P) -> Result<(), AppError>`. The body stays the same. `Plan::of` should use `checks_of` too.

  Add tests to the existing `commit/plan/tests.rs`:
  - `a_batch_plan_is_taken_once_by_its_ordered_changes`: remember a `BatchPlan` under `&Vec<IamChange>` and take it back once.
  - `a_batch_plan_differs_when_a_call_changes`: `check` rejects a plan whose call or confirm warning changed.

- [ ] **Step 2: Generalize `gate`.** In `commit.rs`, extract

  `fn gate_of(warnings: impl Iterator<Item = &Warning> + Clone, confirm_text: Option<&str>, typed: Option<&str>) -> Result<(), AppError>`

  from the existing `gate` body, keeping the same messages. Then:
  - `pub fn gate(preview: &ChangePreview, typed)` calls `gate_of(preview.warnings.iter(), …)`.
  - `pub fn gate_batch(p: &BatchPreview, typed: Option<&str>) -> Result<(), AppError>` calls `gate_of(p.warnings.iter().chain(p.changes.iter().flat_map(|i| i.warnings.iter())), p.confirm_text.as_deref(), typed)`.

  A `Vec<&Warning>` parameter is fine instead of the iterator if the iterator signature is awkward.

- [ ] **Step 3: Add `batch_id` to the log.** In `log.rs` `ChangeLogEntry`:

```rust
    /// 묶음으로 적용한 변경. 같은 묶음의 기록은 같은 값을 쓴다
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<String>,
```

  Add `batch_id: None` to every existing literal.

  Test: `an_entry_without_a_batch_reads_back_and_serializes_without_the_key`. A JSONL line without `batchId` parses, and an entry with `batch_id: None` serializes without the key.

- [ ] **Step 4: Write failing tests for `commit/batch.rs`** in `commit/batch/tests.rs`.
  - Use a temp log path, a fixed `now`, `batch_id = "b1"`, and a fake writer: `FnMut(Vec<ApiCall>) -> Ready<Applied>` that records the calls it got and fails on a chosen call number.
  - Build `seen` with `BatchPlan::of(account, &preview_batch(&s, &changes, &facts))`.

  Tests:
  1. `applies_every_change_in_order_and_logs_each`
     - Input: changes `[detach P from bob, attach Q to bob]`.
     - The writer gets the attach calls first.
     - The log has two entries, `b1-1` (attach) and `b1-2` (detach), both with `batch_id == Some("b1")`, `ok`, and a filled `inverse`.
     - The result is `log_ids == ["b1-1", "b1-2"]`, `failed == None`, `wrote == true`.
  2. `stops_at_the_first_failure`
     - Input: three grants, the second write fails with `AccessDenied`.
     - The writer is called exactly twice.
     - The log has `b1-1` ok and `b1-2` not ok with an error. There is no `b1-3`.
     - The result is `failed == Some(BatchFailure { index: 1, summary: <second item summary>, message: <error text> })` and `log_ids == ["b1-1"]`.
  3. `refuses_when_the_plan_changed`: `seen` built from a different snapshot → `Err(DRIFTED)`, the writer is never called, the log is empty, `wrote == false`.
  4. `refuses_without_a_preview`: `seen = None` → `Err(DRIFTED)`.
  5. `refuses_a_wrong_confirm_text`: an admin grant to two users plus typed `"bob"` → Err with the existing confirm-text message, and no writes.
  6. `undo_batches_mark_each_original_entry`
     - Write a log with two batch entries.
     - Commit their inverses with `undo_of = Some(vec![…])`, aligned with the received order.
     - Both originals become `undone`, and the new entries carry `undo_of` and a new `batch_id`.
  7. `undo_ids_must_match_the_changes`: `undo_of` length ≠ changes length → `Err("되돌릴 기록과 변경의 수가 맞지 않아요")`, no writes.

  `undo_batch_of` tests:
  8. `undo_batch_lists_inverses_newest_first`: the entries (newest first, as `change_log_of` returns them) are b1-3 failed, b1-2 ok, b1-1 ok. The result is the inverses of b1-2 and b1-1, in that order, with ids `["b1-2", "b1-1"]`.
  9. `undo_batch_skips_undone_entries_and_errors_when_nothing_is_left`: an unknown batch → "변경 기록을 찾지 못했어요". All entries undone → "되돌릴 변경이 없어요".

- [ ] **Step 5: Implement `commit/batch.rs`:**

```rust
//! 묶음 적용: 다시 계산한 묶음 미리보기를 사용자가 본 계획과 견주고 관문을 지난 뒤, 적용 순서대로 변경마다 쓰고 기록한다.
//! 실패하면 거기서 멈춘다: 이미 적용된 변경은 그대로 두고(자동 되돌리기 없음) 결과에 실패한 위치를 알린다.

use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;

use super::plan::{self, BatchPlan};
use super::{check_undo, gate_batch, iso, read_log, record};
use crate::error::AppError;
use crate::iam::change::{application_order, preview_batch, ApiCall, BatchPreview, Facts, IamChange};
use crate::iam::log::ChangeLogEntry;
use crate::iam::model::Snapshot;
use crate::iam::write::Applied;

pub struct BatchRequest {
    pub profile: String,
    pub snapshot: Arc<Snapshot>,
    /// `changes`와 같은 순서로 변경마다 하나
    pub facts: Vec<Facts>,
    /// 받은 순서(장바구니 순서)
    pub changes: Vec<IamChange>,
    pub confirm_text: Option<String>,
    /// 되돌리기 묶음이면 `changes`와 같은 길이, i번째 변경이 되돌리는 기록 id
    pub undo_of: Option<Vec<String>>,
    pub seen: Option<BatchPlan>,
    pub log_path: PathBuf,
    pub now: i64,
    /// 기록 id는 `{batch_id}-{적용 순서, 1부터}`
    pub batch_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchFailure {
    /// 적용 순서 기준, 0부터
    pub index: usize,
    pub summary: String,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
    pub batch_id: String,
    pub log_ids: Vec<String>,
    pub failed: Option<BatchFailure>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

pub struct BatchCommitted {
    pub result: Result<BatchResult, AppError>,
    /// 쓰기를 한 번이라도 불렀는지(부른 쪽이 스냅숏을 버려야 하는지)
    pub wrote: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoBatch {
    pub changes: Vec<IamChange>,
    pub undo_of: Vec<String>,
}

/// 묶음의 되돌리기: 그 묶음에서 성공했고 아직 되돌리지 않은 기록의 역변경을 적용의 반대 순서로. `entries`는 `change_log_of`처럼 새것이 먼저라서 그 순서가 곧 되돌릴 순서다.
pub fn undo_batch_of(entries: &[ChangeLogEntry], batch_id: &str) -> Result<UndoBatch, AppError> {
    let mine: Vec<&ChangeLogEntry> = entries.iter().filter(|e| e.batch_id.as_deref() == Some(batch_id)).collect();
    if mine.is_empty() {
        return Err(AppError::other("변경 기록을 찾지 못했어요"));
    }
    let (changes, undo_of): (Vec<IamChange>, Vec<String>) =
        mine.iter().filter(|e| e.ok && !e.undone).filter_map(|e| e.inverse.clone().map(|inv| (inv, e.id.clone()))).unzip();
    if changes.is_empty() {
        return Err(AppError::other("되돌릴 변경이 없어요"));
    }
    Ok(UndoBatch { changes, undo_of })
}

async fn prepare(req: &BatchRequest) -> Result<BatchPreview, AppError> {
    if let Some(ids) = &req.undo_of {
        if ids.len() != req.changes.len() {
            return Err(AppError::other("되돌릴 기록과 변경의 수가 맞지 않아요"));
        }
        let entries = read_log(&req.log_path).await?;
        for (id, change) in ids.iter().zip(&req.changes) {
            check_undo(&entries, id, change, &req.snapshot.account_id)?;
        }
    }
    let (s, changes, facts) = (req.snapshot.clone(), req.changes.clone(), req.facts.clone());
    let checked = tokio::task::spawn_blocking(move || preview_batch(&s, &changes, &facts))
        .await
        .map_err(|e| AppError::other(format!("미리보기를 계산하지 못했어요: {e}")))?;
    plan::check(req.seen.as_ref(), &BatchPlan::of(&req.snapshot.account_id, &checked))?;
    gate_batch(&checked, req.confirm_text.as_deref())?;
    Ok(checked)
}

pub async fn commit_batch<W, Fut>(req: BatchRequest, mut write: W) -> BatchCommitted
where
    W: FnMut(Vec<ApiCall>) -> Fut,
    Fut: Future<Output = Applied>,
{
    let checked = match prepare(&req).await {
        Err(refused) => return BatchCommitted { result: Err(refused), wrote: false },
        Ok(checked) => checked,
    };
    // 받은 순서의 되돌리기 짝을 적용 순서로 옮긴다
    let undo_of: Vec<Option<String>> = match &req.undo_of {
        Some(ids) => application_order(&req.changes).into_iter().map(|i| Some(ids[i].clone())).collect(),
        None => vec![None; checked.changes.len()],
    };
    let (mut log_ids, mut notes, mut failed) = (Vec::new(), Vec::new(), None);
    for (index, item) in checked.changes.iter().enumerate() {
        let Applied { done, result } = write(item.calls.clone()).await;
        let id = format!("{}-{}", req.batch_id, index + 1);
        let ok = result.is_ok();
        let entry = ChangeLogEntry {
            id: id.clone(),
            at: iso(req.now),
            profile: req.profile.clone(),
            account_id: req.snapshot.account_id.clone(),
            caller_arn: req.snapshot.caller_arn.clone(),
            change: item.change.clone(),
            summary: item.summary.clone(),
            calls: done.iter().map(|call| call.api.clone()).collect(),
            ok,
            error: result.as_ref().err().map(|e| e.to_string()),
            inverse: if ok { item.inverse.clone() } else { None },
            undo_of: undo_of[index].clone(),
            undone: false,
            batch_id: Some(req.batch_id.clone()),
        };
        notes.extend(record(req.log_path.clone(), entry, if ok { undo_of[index].clone() } else { None }).await);
        match result {
            Ok(()) => log_ids.push(id),
            Err(e) => {
                failed = Some(BatchFailure { index, summary: item.summary.clone(), message: e.to_string() });
                break;
            }
        }
    }
    BatchCommitted { result: Ok(BatchResult { batch_id: req.batch_id, log_ids, failed, notes }), wrote: true }
}

#[cfg(test)]
mod tests;
```

  `read_log`, `record`, `iso` and `check_undo` are items of the parent module `commit`. A child module can use the private items of its parent, so no visibility change is needed unless the compiler says otherwise.

- [ ] **Step 6: Add overview fields.** In `view.rs` `PrincipalSummary`:

```rust
    /// 직접 붙은 관리형 정책 ARN. 비면 보내지 않는다(계약에 더한 선택 필드)
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub attached: Vec<String>,
    /// 사용자만: 속한 그룹 이름
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<String>,
    /// 권한 경계 정책 ARN
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boundary: Option<String>,
```

  In `summary_of`, set the three fields:
  - `attached: principal.attached().to_vec()`
  - `groups`: for `Principal::User(u)`, `u.groups.clone()`; otherwise empty.
  - `boundary`: for a user or role, its `boundary.clone()`; for a group, `None`.

  Adjust any `PrincipalSummary { … }` literal that the compiler flags.

  Test in the existing summary/view tests: `principal_summaries_carry_assignments`. alice's summary JSON has `attached` and `groups`. A principal with nothing attached has no `attached` key. A user with a boundary has `boundary`.

- [ ] **Step 7: Add commands and glue.** In `iam_commands.rs`:

```rust
    /// 묶음 미리보기에서 사용자가 본 계획
    batch_plans: Mutex<PlanStore<BatchPlan>>,
```

  This field goes in `IamState`; `Default` still works.

```rust
/// 묶음의 재료. 붙일 정책이 스냅숏에 없으면 변경마다 읽어 둔다(앞 변경에서 읽은 정책은 다시 읽지 않는다). 50개를 넘는 묶음은 미리보기가 막으니 더 읽지 않는다.
async fn gather_batch(state: &AppState, iam: &IamState, profile: &str, changes: &[IamChange]) -> Result<(Arc<Snapshot>, Vec<Facts>, aws_sdk_iam::Client), AppError> {
    let mut s = fresh_snapshot(state, iam, profile).await?;
    let cfg = state.ctx.config(profile, GLOBAL_REGION).await?;
    let client = aws_sdk_iam::Client::new(&cfg);
    let mut facts = Vec::with_capacity(changes.len());
    for c in changes.iter().take(MAX_BATCH) {
        let (next, policy_error) = ensure_policy(&client, s, c).await?;
        s = next;
        facts.push(Facts { policy_error, ..Facts::default() });
    }
    facts.resize(changes.len(), Facts::default());
    Ok((s, facts, client))
}

async fn preview_batch_and_remember(iam: &IamState, profile: &str, s: Arc<Snapshot>, changes: Vec<IamChange>, facts: Vec<Facts>) -> Result<BatchPreview, AppError> {
    let account_id = s.account_id.clone();
    let key = ordered(&changes);
    let shown = tokio::task::spawn_blocking(move || preview_batch(&s, &changes, &facts))
        .await
        .map_err(|e| AppError::other(format!("미리보기를 계산하지 못했어요: {e}")))?;
    locked(&iam.batch_plans).remember(profile, &key, BatchPlan::of(&account_id, &shown), now_secs());
    Ok(shown)
}

struct BatchApplyRequest {
    profile: String,
    changes: Vec<IamChange>,
    confirm_text: Option<String>,
    undo_of: Option<Vec<String>>,
}

async fn apply_batch_with<W, Fut>(iam: &IamState, req: BatchApplyRequest, s: Arc<Snapshot>, facts: Vec<Facts>, write: W) -> Result<BatchResult, AppError>
where
    W: FnMut(Vec<ApiCall>) -> Fut,
    Fut: Future<Output = write::Applied>,
{
    let BatchApplyRequest { profile, changes, confirm_text, undo_of } = req;
    let now = now_secs();
    let seen = locked(&iam.batch_plans).take(&profile, &ordered(&changes), now);
    let request = BatchRequest {
        profile: profile.clone(), snapshot: s, facts, changes, confirm_text, undo_of, seen,
        log_path: iam.log_path.clone(), now, batch_id: new_log_id(now_millis()),
    };
    let committed = commit_batch(request, write).await;
    if committed.wrote {
        mark_written(iam, &profile, now_secs());
        invalidate(iam, &profile);
    }
    committed.result
}

#[tauri::command]
pub async fn iam_preview_batch(state: State<'_, AppState>, iam: State<'_, IamState>, profile: String, changes: Vec<IamChange>) -> Result<BatchPreview, AppError> {
    let (s, facts, _) = gather_batch(&state, &iam, &profile, &changes).await?;
    preview_batch_and_remember(&iam, &profile, s, changes, facts).await
}

#[tauri::command]
pub async fn iam_apply_batch(
    state: State<'_, AppState>,
    iam: State<'_, IamState>,
    profile: String,
    changes: Vec<IamChange>,
    confirm_text: Option<String>,
    undo_of: Option<Vec<String>>,
) -> Result<BatchResult, AppError> {
    let (s, facts, client) = gather_batch(&state, &iam, &profile, &changes).await?;
    let req = BatchApplyRequest { profile, changes, confirm_text, undo_of };
    apply_batch_with(&iam, req, s, facts, move |plan: Vec<ApiCall>| {
        let client = client.clone();
        async move { write::apply(&client, &plan).await }
    })
    .await
}

#[tauri::command]
pub async fn iam_undo_batch(iam: State<'_, IamState>, batch_id: String) -> Result<UndoBatch, AppError> {
    undo_batch_of(&change_log_of(&iam).await?, &batch_id)
}
```

  Register `iam_commands::iam_preview_batch`, `iam_commands::iam_apply_batch` and `iam_commands::iam_undo_batch` in `lib.rs`.

  Glue tests go next to the existing `apply_with` tests and use their fake-writer style:
  - `a_batch_apply_without_a_preview_is_refused_and_writes_nothing`
  - `one_batch_preview_allows_exactly_one_apply`
  - `a_batch_preview_in_another_tray_order_with_the_same_ordered_changes_still_matches`: preview `[a, b]` and apply `[b, a]`, where both orders sort to the same order.

- [ ] **Step 8: Verify.**
  - `cd src-tauri && cargo test`
  - The literal `cargo clippy --all-targets -- -D warnings`
  - The grep guard (empty)

  Mutation-check:
  - Remove the `break` on failure; test 2 must fail.
  - Skip `plan::check`; tests 3 and 4 must fail.
  - Restore both.

- [ ] **Step 9: Commit** with message `feat(iam): batch apply, log batches, undo batches and assignment fields`.

---

### Task F1: Frontend types, API, matrix logic and tray hook

**Files:**
- Modify: `src/iam/types.ts`, `src/iam/api.ts`, `src/iam/fixtures.ts`
- Create: `src/iam/assignments.ts`, `src/iam/assignments.test.ts`, `src/iam/useAssignmentDraft.ts`, `src/iam/useAssignmentDraft.test.tsx`

**Interfaces:**
- Consumes the contract (the backend is mocked in tests).
- Produces, used by F2 and F3:
  - Types: `PreviewWarning`, `BatchItem`, `BatchPreview`, `BatchResult`, `UndoBatch`, and `ChangeLogEntry.batchId?`.
  - `PrincipalSummary` gains `attached?`, `groups?` and `boundary?`.
  - `iamApi.previewBatch(profile, changes)`, `iamApi.applyBatch(profile, changes, confirmText, undoOf)`, `iamApi.undoBatch(batchId)`.
  - From `assignments.ts`:
    - `MAX_DRAFT`, `AssignmentTab`, `Column`, `DraftItem`, `PolicyCell`
    - `changeKey`, `rowKey`, `policyColumns`, `groupColumns`, `policyCell`, `isActual`, `isShown`, `isEditable`
    - `setCell`, `toggleCell`, `paintCells`, `matchPrincipal`, `matchChanges`, `normalizeDraft`, `removeApplied`, `draftLabel`
  - `useAssignmentDraft(profile, ov)` returns `{ items, notices, toggle, paint, match, remove, clear, removeApplied, dismissNotice }`.

- [ ] **Step 1: Types and API.** In `types.ts`:

```ts
export type PreviewWarning = { level: "block" | "confirm" | "warn"; message: string };
// ChangePreview.warnings: use PreviewWarning[] (same shape as today)
export interface PrincipalSummary {
  // …existing fields
  /** 직접 붙은 관리형 정책 ARN. 없으면 [] */
  attached?: string[];
  /** 사용자만: 속한 그룹 이름. 없으면 [] */
  groups?: string[];
  /** 권한 경계 정책 ARN */
  boundary?: string;
}
export interface BatchItem { change: IamChange; summary: string; calls: { api: string; params: Record<string, string> }[]; warnings: PreviewWarning[] }
export interface BatchPreview { changes: BatchItem[]; impacts: Impact[]; impactsOmitted?: number; warnings: PreviewWarning[]; confirmText: string | null; reversible: boolean }
export interface BatchResult { batchId: string; logIds: string[]; failed: { index: number; summary: string; message: string } | null; notes?: string[] }
export interface UndoBatch { changes: IamChange[]; undoOf: string[] }
// ChangeLogEntry: batchId?: string   /** 묶음으로 적용한 변경. 같은 묶음은 같은 값 */
```

  In `api.ts`, under 쓰기:

```ts
  previewBatch: (profile: string, changes: IamChange[]) => invoke<BatchPreview>("iam_preview_batch", { profile, changes }),
  applyBatch: (profile: string, changes: IamChange[], confirmText: string | null, undoOf: string[] | null) =>
    invoke<BatchResult>("iam_apply_batch", { profile, changes, confirmText, undoOf }),
  undoBatch: (batchId: string) => invoke<UndoBatch>("iam_undo_batch", { batchId }),
```

  In `fixtures.ts`, give the sample principals assignments that match the existing views:
  - `alice`: `attached: [readOnlyPolicy.arn]`, `groups: ["dev-team"]`, `boundary: policyArn("dev-boundary")`
  - `bob`: `groups: ["dev-team"]`
  - `ciBot`: `attached: [adminPolicy.arn]`
  - `devTeam`: `attached: [deployPolicy.arn]`
  - `admins`: `attached: [adminPolicy.arn]`
  - `appRole`: `attached: [readOnlyPolicy.arn]`

  Also export `previewBatchOf(changes, extra?)` and `batchResult(extra?)` builders.

  Run `npx vitest run src/iam` and `npx tsc --noEmit`. Expected: still green. Adjust any test that deep-compares these principals.

- [ ] **Step 2: Write failing tests** for `assignments.ts`. Use `sampleOverview()` with the fixtures above. Test cases:
  1. `policyColumns`
     - Lists policies attached somewhere, by direct-attach count and then name: AdministratorAccess (ci-bot, admins: 2), ReadOnlyAccess (alice, app-role: 2), app-deploy (dev-team: 1).
     - legacy-unused (attached nowhere) is not a column.
     - It appends `extra` ARNs that aren't used. A duplicate extra is ignored.
     - An unknown extra ARN gets its last path segment as its name and scope `"aws"` when it contains `":aws:policy/"`.
  2. `groupColumns` sorts groups by name.
  3. `policyCell`
     - alice / deploy → `{ direct: false, via: ["dev-team"] }`.
     - alice / readOnly → `{ direct: true, via: [] }`.
     - Groups and roles never have `via`.
  4. `isEditable`
     - A locked role (`supportRole`) is false.
     - An inherited-only cell (alice / deploy) is false.
     - A direct or empty cell is true.
     - Every members-tab cell is true.
  5. `toggleCell`
     - bob / readOnly adds `{ op: "attachPolicy", target: bob.arn, policyArn: readOnlyPolicy.arn }` with label `"ReadOnlyAccess 붙이기 · bob"`.
     - Toggling again removes it.
     - alice / readOnly adds a detach labelled `"ReadOnlyAccess 떼기 · alice"`.
     - Members tab: bob / admins → `"admins에 넣기 · bob"`; alice / dev-team → `"dev-team에서 빼기 · alice"`.
  6. `paintCells` with `want = true`
     - Over [bob/readOnly (none), alice/readOnly (direct, pending detach), supportRole/readOnly (locked)]:
     - bob gets an attach, alice's pending detach is removed, and the locked row is skipped.
  7. `setCell` refuses the 51st item: it returns `full: true` and the draft is unchanged.
  8. `matchPrincipal`
     - Source ciBot, target bob → `{ add: [admin], extra: [] }`.
     - Source bob, target alice (policies tab) → `{ add: [], extra: [readOnly] }`.
     - `matchChanges` with `remove = []` adds only the attaches.
  9. `normalizeDraft`
     - A pending attach whose target is now attached is dropped with `"이미 붙어 있어서 뺐어요: …"`.
     - A detach on a now-detached policy gets `"이미 떨어져 있어서 뺐어요: …"`.
     - An add on a now-member user gets `"이미 그룹에 있어서 뺐어요: …"`.
     - A remove on a now-non-member gets `"이미 그룹에 없어서 뺐어요: …"`.
     - A row that disappeared gets `"찾을 수 없어서 뺐어요: …"`.
     - An unchanged draft returns the same array reference and no notices.
  10. `removeApplied` drops items whose `changeKey` matches an applied change.

- [ ] **Step 3: Implement `assignments.ts`:**

```ts
// 할당 표의 순수 로직: 개요(주체 요약의 attached·groups)에서 칸 상태를 만들고, 칸 누르기·칠하기·"다른 주체와 같게"를 장바구니 변경으로 바꾼다.
import { changeBlockReason } from "./protect";
import type { Badge, IamChange, IamOverview, PrincipalSummary } from "./types";

export const MAX_DRAFT = 50;
export type AssignmentTab = "policies" | "members";

/** 표의 열. 정책 탭은 정책 ARN, 그룹 구성원 탭은 그룹 이름이 id다 */
export interface Column { id: string; name: string; scope: "aws" | "local" | null; badges: Badge[] }
/** 정책 탭의 칸. via: 그 정책을 준 그룹 이름(이름순) */
export interface PolicyCell { direct: boolean; via: string[] }
/** 장바구니 한 줄. key는 칸을 가리키고, 같은 칸의 변경은 하나만 있다 */
export interface DraftItem { key: string; change: IamChange; label: string }

export function changeKey(c: IamChange): string | null {
  switch (c.op) {
    case "attachPolicy":
    case "detachPolicy":
      return `policies|${c.target}|${c.policyArn}`;
    case "addToGroup":
    case "removeFromGroup":
      return `members|${c.userName}|${c.groupName}`;
    default:
      return null;
  }
}

/** 칸의 키. 정책 탭은 주체 ARN, 그룹 구성원 탭은 사용자 이름으로 가리킨다(변경이 쓰는 값과 같다) */
export function rowKey(tab: AssignmentTab, row: PrincipalSummary, column: string): string {
  return tab === "policies" ? `policies|${row.arn}|${column}` : `members|${row.name}|${column}`;
}

const lastSegment = (arn: string) => arn.slice(arn.lastIndexOf("/") + 1);

export function policyName(ov: IamOverview, arn: string): string {
  return ov.policies.find((p) => p.arn === arn)?.name ?? lastSegment(arn);
}

export function policyColumns(ov: IamOverview, extra: string[]): Column[] {
  const count = new Map<string, number>();
  for (const p of [...ov.users, ...ov.groups, ...ov.roles]) for (const arn of p.attached ?? []) count.set(arn, (count.get(arn) ?? 0) + 1);
  const byArn = new Map(ov.policies.map((p) => [p.arn, p]));
  const column = (arn: string): Column => {
    const p = byArn.get(arn);
    return p ? { id: arn, name: p.name, scope: p.scope, badges: p.badges } : { id: arn, name: lastSegment(arn), scope: arn.includes(":aws:policy/") ? "aws" : "local", badges: [] };
  };
  const used = [...count.keys()].sort((a, b) => count.get(b)! - count.get(a)! || column(a).name.localeCompare(column(b).name));
  const added = extra.filter((arn, i) => !count.has(arn) && extra.indexOf(arn) === i);
  return [...used, ...added].map(column);
}

export function groupColumns(ov: IamOverview): Column[] {
  return [...ov.groups].sort((a, b) => a.name.localeCompare(b.name)).map((g) => ({ id: g.name, name: g.name, scope: null, badges: g.badges }));
}

export function policyCell(ov: IamOverview, row: PrincipalSummary, policyArn: string): PolicyCell {
  const via = row.kind === "user" ? (row.groups ?? []).filter((g) => ov.groups.find((x) => x.name === g)?.attached?.includes(policyArn)).sort() : [];
  return { direct: (row.attached ?? []).includes(policyArn), via };
}

/** 칸이 실제로 붙어(속해) 있는지 */
export function isActual(ov: IamOverview, tab: AssignmentTab, row: PrincipalSummary, column: string): boolean {
  return tab === "policies" ? (row.attached ?? []).includes(column) : (row.groups ?? []).includes(column);
}

/** 보이는 상태 = 실제 상태에 대기 변경을 반영한 것 */
export function isShown(draft: DraftItem[], ov: IamOverview, tab: AssignmentTab, row: PrincipalSummary, column: string): boolean {
  const pending = draft.some((d) => d.key === rowKey(tab, row, column));
  return isActual(ov, tab, row, column) !== pending;
}

/** 바꿀 수 있는 칸인지: 잠긴 행과(정책 탭) 그룹으로만 받은 칸은 못 바꾼다 */
export function isEditable(ov: IamOverview, tab: AssignmentTab, row: PrincipalSummary, column: string): boolean {
  if (changeBlockReason(row)) return false;
  if (tab === "members") return true;
  const cell = policyCell(ov, row, column);
  return cell.direct || cell.via.length === 0;
}

export function draftLabel(ov: IamOverview, change: IamChange, principal: string): string {
  switch (change.op) {
    case "attachPolicy":
      return `${policyName(ov, change.policyArn)} 붙이기 · ${principal}`;
    case "detachPolicy":
      return `${policyName(ov, change.policyArn)} 떼기 · ${principal}`;
    case "addToGroup":
      return `${change.groupName}에 넣기 · ${principal}`;
    case "removeFromGroup":
      return `${change.groupName}에서 빼기 · ${principal}`;
    default:
      return change.op;
  }
}

function itemFor(ov: IamOverview, tab: AssignmentTab, row: PrincipalSummary, column: string, want: boolean): DraftItem {
  const change: IamChange =
    tab === "policies"
      ? { op: want ? "attachPolicy" : "detachPolicy", target: row.arn, policyArn: column }
      : { op: want ? "addToGroup" : "removeFromGroup", userName: row.name, groupName: column };
  return { key: rowKey(tab, row, column), change, label: draftLabel(ov, change, row.name) };
}

/** 칸을 목표 상태로: 실제 상태가 이미 want면 그 칸의 대기 변경을 지우고, 아니면 want로 가는 대기 변경을 둔다. 꽉 찼으면 full */
export function setCell(draft: DraftItem[], ov: IamOverview, tab: AssignmentTab, row: PrincipalSummary, column: string, want: boolean): { draft: DraftItem[]; full: boolean } {
  if (!isEditable(ov, tab, row, column)) return { draft, full: false };
  const key = rowKey(tab, row, column);
  const pending = draft.some((d) => d.key === key);
  if (isActual(ov, tab, row, column) === want) return { draft: pending ? draft.filter((d) => d.key !== key) : draft, full: false };
  if (pending) return { draft, full: false };
  if (draft.length >= MAX_DRAFT) return { draft, full: true };
  return { draft: [...draft, itemFor(ov, tab, row, column, want)], full: false };
}

export function toggleCell(draft: DraftItem[], ov: IamOverview, tab: AssignmentTab, row: PrincipalSummary, column: string) {
  return setCell(draft, ov, tab, row, column, !isShown(draft, ov, tab, row, column));
}

export function paintCells(draft: DraftItem[], ov: IamOverview, tab: AssignmentTab, cells: { row: PrincipalSummary; column: string }[], want: boolean) {
  let full = false;
  let next = draft;
  for (const { row, column } of cells) {
    const r = setCell(next, ov, tab, row, column, want);
    next = r.draft;
    full ||= r.full;
  }
  return { draft: next, full };
}

/** "다른 주체와 같게": 원본에만 있는 것(add)과 대상에만 있는 것(extra). 그룹으로 받은 것은 보지 않는다 */
export function matchPrincipal(tab: AssignmentTab, source: PrincipalSummary, target: PrincipalSummary): { add: string[]; extra: string[] } {
  const of = (p: PrincipalSummary) => (tab === "policies" ? p.attached ?? [] : p.groups ?? []);
  const [s, t] = [of(source), of(target)];
  return { add: s.filter((x) => !t.includes(x)), extra: t.filter((x) => !s.includes(x)) };
}

export function matchChanges(draft: DraftItem[], ov: IamOverview, tab: AssignmentTab, target: PrincipalSummary, add: string[], remove: string[]) {
  const on = paintCells(draft, ov, tab, add.map((column) => ({ row: target, column })), true);
  const off = paintCells(on.draft, ov, tab, remove.map((column) => ({ row: target, column })), false);
  return { draft: off.draft, full: on.full || off.full };
}

function rowOf(ov: IamOverview, c: IamChange): PrincipalSummary | undefined {
  if (c.op === "attachPolicy" || c.op === "detachPolicy") return [...ov.users, ...ov.groups, ...ov.roles].find((p) => p.arn === c.target);
  if (c.op === "addToGroup" || c.op === "removeFromGroup") return ov.groups.some((g) => g.name === c.groupName) ? ov.users.find((u) => u.name === c.userName) : undefined;
  return undefined;
}

const DONE: Record<string, string> = {
  attachPolicy: "이미 붙어 있어서 뺐어요",
  detachPolicy: "이미 떨어져 있어서 뺐어요",
  addToGroup: "이미 그룹에 있어서 뺐어요",
  removeFromGroup: "이미 그룹에 없어서 뺐어요",
};

/** 개요를 다시 불러온 뒤 장바구니 정리: 이미 그 상태가 된 변경과 대상이 없어진 변경을 빼고 알린다. 바뀐 것이 없으면 같은 배열을 돌려준다 */
export function normalizeDraft(ov: IamOverview, draft: DraftItem[]): { draft: DraftItem[]; notices: string[] } {
  const notices: string[] = [];
  const kept = draft.filter((d) => {
    const row = rowOf(ov, d.change);
    if (!row) {
      notices.push(`찾을 수 없어서 뺐어요: ${d.label}`);
      return false;
    }
    const tab: AssignmentTab = d.change.op === "attachPolicy" || d.change.op === "detachPolicy" ? "policies" : "members";
    const column = d.change.op === "attachPolicy" || d.change.op === "detachPolicy" ? d.change.policyArn : (d.change as { groupName: string }).groupName;
    const want = d.change.op === "attachPolicy" || d.change.op === "addToGroup";
    if (isActual(ov, tab, row, column) === want) {
      notices.push(`${DONE[d.change.op]}: ${d.label}`);
      return false;
    }
    return true;
  });
  return kept.length === draft.length ? { draft, notices } : { draft: kept, notices };
}

export function removeApplied(draft: DraftItem[], applied: IamChange[]): DraftItem[] {
  const keys = new Set(applied.map(changeKey).filter((k): k is string => k !== null));
  return draft.filter((d) => !keys.has(d.key));
}
```

  Run `npx vitest run src/iam/assignments.test.ts`. Expected: PASS.

- [ ] **Step 4: The tray hook.** In `useAssignmentDraft.ts`:
  - Keep state `items: DraftItem[]` with a ref mirror, so several calls in one render compose correctly. Also keep `notices: string[]`.
  - `toggle(tab, row, column)`, `paint(tab, cells, want)` and `match(tab, target, add, remove)` each apply the pure function to the ref value. When it reports `full`, push the notice "한 번에 50개까지 담을 수 있어요" (once per call).
  - `remove(key)`, `clear()`, `removeApplied(changes)` and `dismissNotice(index)`.
  - When `ov` changes, run `normalizeDraft` and append its notices.
  - `ov` may be undefined while loading. In that case, do nothing.
  - The tray belongs to one profile. IamTab is not remounted when the profile changes, so keep `{ profile, items, notices }` in one state value and treat a stored profile that differs from the current one as an empty tray (reset it during render, not in an effect). Then the old profile's items are never normalized against the new profile's overview, and no "찾을 수 없어서 뺐어요" notices appear for them.

  Tests in `useAssignmentDraft.test.tsx`:
  - Two toggles in one `act` compose.
  - The full notice appears once.
  - A rerender with a new overview where bob now has readOnly drops the pending attach and appends the notice.
  - `removeApplied` removes the matching keys.
  - Rerendering with another profile empties the tray and shows no notices.

- [ ] **Step 5: Verify and commit.** Run `npx vitest run`, `npx tsc --noEmit` and `npm run build`. Commit with message `feat(iam): assignment matrix logic and tray state`.

---

### Task F2: The 할당 screen and grid

**Files:**
- Modify: `src/iam/route.ts`. Add `IamView` `"assignments"` and `VIEW_LABEL.assignments = "할당"`.
- Modify: `src/iam/IamNav.tsx`. Add item `{ view: "assignments", icon: "🧩", label: "할당" }` right after 정책. Its count is the tray size, shown only when > 0.
- Modify: `src/iam/IamTab.tsx`
  - It owns `const draft = useAssignmentDraft(profile, ov)` and passes it down. `counts.assignments = draft.items.length || undefined`. Call the hook before the early return for a missing overview (rules of hooks).
  - It renders `<Assignments key={profile} …>` for `route.view === "assignments"`. The key drops the added columns when the profile changes.
  - `route.tab` is `"policies" | "members"` and defaults to `"policies"`. Remember it with `remember` like the other screens.
- Create: `src/iam/Assignments.tsx`, `src/iam/AssignmentGrid.tsx`, `src/iam/MatchSheet.tsx`, with tests `Assignments.test.tsx` and `AssignmentGrid.test.tsx`
- Modify: `src/styles.css`. Every new rule is scoped under `.iam-asg`.

**Interfaces:**
- Consumes F1's `assignments.ts`, `useAssignmentDraft`, `iamApi`, `usePolicyRefs` (for 열 추가), `PickerSheet`, and `changeBlockReason`.
- Produces `<Assignments profile overview draft tab onTab onOpen onPreview filter />`. `onPreview(changes: IamChange[])` is called by [미리보기]; F3 wires it to the batch flow. Until F3 lands, IamTab passes a no-op.

- [ ] **Step 1: Write failing tests** with Testing Library and the F1 fixtures, rendering `Assignments` with a real `useAssignmentDraft` through a small harness component. Assert on what the user sees. Each test name below goes in `Assignments.test.tsx` or `AssignmentGrid.test.tsx`.
  1. `shows_the_policy_table`
     - Rows are grouped under 사용자/그룹/역할 headers.
     - Columns are AdministratorAccess, ReadOnlyAccess, app-deploy in that order, each with its badges.
     - Cells have accessible names like `"bob · ReadOnlyAccess: 없음"`, `"alice · ReadOnlyAccess: 직접 붙음"`, `"alice · app-deploy: dev-team 그룹에서 받음"`.
  2. `clicking_a_cell_marks_it_and_fills_the_tray`
     - Click bob/ReadOnlyAccess: its name becomes `"bob · ReadOnlyAccess: 붙일 예정"` and the tray shows `"변경 1개 · ReadOnlyAccess 붙이기 · bob"`.
     - Click again: the tray disappears.
  3. `an_inherited_cell_explains_where_it_comes_from`: clicking alice/app-deploy shows `"dev-team 그룹에서 받아요"`, and [그룹 행으로 가기] focuses the dev-team row header.
  4. `locked_rows_are_disabled_with_a_reason`: the AWSServiceRoleForSupport row's cells are disabled, and the reason text from `changeBlockReason` is visible.
  5. `dragging_paints_cells_with_the_first_cells_result`: pointerdown on bob/ReadOnly, pointerenter on ciBot/ReadOnly, then pointerup → two pending attaches.
  6. `keyboard_moves_toggles_and_paints_a_range`
     - Focus a cell, ArrowDown moves focus, and Space toggles.
     - Shift+ArrowDown extends the range, and Space paints the range with the anchor's toggled state.
     - Esc clears the range.
  7. `kind_chips_and_the_toolbar_filter_narrow_rows`: unticking 역할 hides the role rows, and filter `"bo"` leaves only bob.
  8. `adding_a_column_puts_a_new_policy_in_the_table`
     - [열 추가] opens `PickerSheet`, fed by `iamApi.listPolicies` (mocked).
     - Picking a policy adds its column, with every cell 없음.
  9. `the_members_tab_toggles_membership`: in the 그룹 구성원 tab, clicking bob/admins → `"admins에 넣기 · bob"`.
  10. `match_another_principal_fills_the_tray`
      - Open alice's row menu, choose "다른 주체와 같게", then pick ci-bot.
      - The sheet lists AdministratorAccess under 붙일 것 and ReadOnlyAccess under 뗄 것, unchecked.
      - [담기] without ticking anything → the tray has only `"AdministratorAccess 붙이기 · alice"`.
      - Doing it again with ReadOnlyAccess ticked also adds `"ReadOnlyAccess 떼기 · alice"` (2 items in all).
  11. `row_end_shows_inline_count_and_boundary`
      - alice's row shows `"인라인 2"` (policyCount 3 − 1 attached) and `"경계"`.
      - ci-bot's row shows neither (policyCount 1 − 1 attached = 0, no boundary). "인라인 N" appears only when N > 0.
  12. `the_tray_lists_items_and_clears`
      - Expanding shows each item with ×, and × removes it.
      - [모두 취소] empties the tray.
      - [미리보기] calls `onPreview` with the changes in tray order.
  13. `nav_shows_the_tray_count`: through IamTab, after one toggle the 할당 menu item shows `1`.
  14. `tall_tables_render_only_visible_rows`
      - With 300 generated users, the DOM has far fewer row elements than 300 (for example < 60).
      - Scrolling moves the window. Mock `clientHeight`/`scrollTop` as the existing tests do, or test the windowing helper as a pure function.

- [ ] **Step 2: Implement.**
  - `AssignmentGrid` is a `role="grid"` table.
    - The header row and header column are sticky. Rows have a fixed height of 28px.
    - Windowing: render the visible slice plus 10 rows overscan, using a pure `visibleRange(scrollTop, viewport, rowHeight, count, overscan)` helper that can be unit-tested.
    - Each cell is a `<button>` with `aria-label` `${row} · ${column}: ${state}`. The state is one of: 직접 붙음 / 없음 / `${groups} 그룹에서 받음` / 직접 붙음, `${groups}` 그룹에서도 받음 / 붙일 예정 / 뗄 예정. In the members tab: 속함 / 안 속함 / 넣을 예정 / 뺄 예정.
    - Glyphs: ● ○ ◐ ＋ －.
  - Pointer painting
    - On pointerdown on an editable cell, compute `want = !isShown(...)` and start painting. Apply `setCell` to the first cell right away.
    - On pointerenter of other cells while the primary button is held, call `draft.paint(tab, [cell], want)`. Painting stops on pointerup, pointercancel or window blur.
    - A plain click (no movement) is just the first cell's toggle. Don't double-apply it on click.
  - Keyboard: roving tabindex over cells and headers, following the rules in test 6. Enter on a header calls `onOpen` with the principal or policy route.
  - Inherited popover: a small anchored panel with the text and [그룹 행으로 가기]. The button scrolls to the group row and focuses its header.
  - `MatchSheet`: reuse the modal pattern (`useModal`) and `PickerSheet` for choosing the source.
    - It shows two lists: 붙일(넣을) 것, always included, and 뗄(뺄) 것, as checkboxes that start unchecked.
    - [담기] calls `draft.match(...)`.
  - `Assignments`
    - Tabs: [정책] [그룹 구성원].
    - Chips (policies tab only).
    - [열 추가] (policies tab only). It keeps an `extra` column list in component state. IamTab mounts it with `key={profile}`, so the list starts empty for each profile.
    - The grid, the tray bar, the expandable list, and the notices with dismiss.
  - IamTab wiring and nav count as listed under Files.

- [ ] **Step 3: Verify and commit.**
  - Run `npx vitest run`, `npx tsc --noEmit` and `npm run build`.
  - Mutation-check:
    - Make `isEditable` always true; tests 3 and 4 must fail.
    - Drop the `want` capture so every painted cell toggles; test 5 must fail.
    - Restore both.
  - Commit with message `feat(iam): assignment matrix screen with paint, keyboard and tray`.

---

### Task F3: Batch preview, apply, undo and change-log batches

**Files:**
- Create: `src/iam/previewParts.tsx`. Move `ImpactList`, `ImpactItem`, `Deltas`, `ConfirmField` and the warning-list rendering out of `ChangePreviewDialog.tsx`, then export them and import them back. `ChangePreviewDialog` behavior must not change, and its tests must stay green untouched.
- Create: `src/iam/useIamBatch.ts`, `src/iam/useIamBatch.test.tsx`, `src/iam/BatchPreviewDialog.tsx`, `src/iam/BatchPreviewDialog.test.tsx`
- Modify: `src/iam/IamTab.tsx`. Hold `const batch = useIamBatch(profile)`, render the dialog, wire `Assignments.onPreview`, and wire the change log's batch undo.
- Modify: `src/iam/useIamChange.ts`, only the parameter type of `applyGate`.
- Modify: `src/iam/ChangeLog.tsx`, `src/iam/ChangeLog.test.tsx`
- Modify: `docs/manual-test-checklist.md`

**Interfaces:**
- Consumes `iamApi.previewBatch/applyBatch/undoBatch`, `refreshIam`, `iamKeys`, the draft's `removeApplied`, and `REFRESH_DELAY_MS` and `NOTICE_MS` from `useIamChange`.
- Produces:
  - `useIamBatch(profile)` returns `{ pending, notices, start(changes, opts?: { undoOf?: string[]; onApplied?: (applied: IamChange[]) => void }), apply(typed), retryPreview(), cancel(), dismissNotice(id) }`.
  - `pending` is `{ changes, undoOf, rev, phase: "loading" | "ready" | "applying" | "result", preview, error, stale, result }`.
  - `BatchPreviewDialog`.

- [ ] **Step 1: Write failing tests.**
  - `useIamBatch`:
    - `start` loads a preview, and `apply` sends the typed text plus `undoOf`.
    - On full success: the dialog closes, the notice is `"변경 3개를 적용했어요"` (plus any `notes`), `onApplied` receives all changes, and `refreshIam` runs after `REFRESH_DELAY_MS`. Use fake timers.
    - On partial failure (`failed: { index: 1, … }` with `logIds: ["b-1"]`): the phase becomes `"result"`, `onApplied` receives only the first change, and the refresh is still scheduled.
    - An `AppError` from apply marks it `stale`, with the same rule as `useIamChange`.
    - A profile change or unmount ignores late responses.
  - `BatchPreviewDialog`:
    - The title is `"변경 3개 미리보기"`.
    - Items are listed in preview order, each with its summary, calls (collapsed under a toggle) and its own warnings. The batch warnings and the impact list are present.
    - When `confirmText` is `"변경 2개 적용"`, [적용] stays disabled until exactly that text is typed. With `"bob"`, it needs `"bob"`.
    - A block disables [적용], showing the existing hint copy.
    - The result phase shows `"3개 중 1개를 적용하고 2번째에서 멈췄어요: <summary>: <message>"` and [적용된 1개 되돌리기]. Clicking that calls `iamApi.undoBatch(batchId)`, then `start(changes, { undoOf })`. [닫기] closes the dialog.
    - With k = 0, there is no undo button.
  - `ChangeLog`:
    - Entries sharing a `batchId` are grouped under `"묶음 · 변경 2개 · <time>"` with [묶음 되돌리기].
    - Clicking it calls `iamApi.undoBatch` and then the new `onStartBatch(changes, { undoOf })` prop.
    - The button is disabled, with a reason, when nothing is undoable or the batch belongs to another account.
    - Single entries still have [되돌리기].

- [ ] **Step 2: Implement.**
  - `applyGate` takes `{ warnings: PreviewWarning[]; confirmText: string | null }` instead of `ChangePreview`. A `ChangePreview` still fits, so existing callers don't change. The batch hook and dialog call it with `{ warnings: [...p.warnings, ...p.changes.flatMap((i) => i.warnings)], confirmText: p.confirmText }`.
  - `useIamBatch` mirrors `useIamChange`: the rev counter, the in-flight guard, profile ref, timers cleaned on unmount, and notices with `NOTICE_MS` (kept until dismissed when there are `notes`).
  - On a result with `failed`, keep `pending` in phase `"result"` with the result and the preview, so the dialog can show the message.
  - The undo button inside the result does `iamApi.undoBatch(result.batchId)`, then `start(u.changes, { undoOf: u.undoOf })`.
  - IamTab: `Assignments.onPreview = (changes) => batch.start(changes, { onApplied: draft.removeApplied })`, and ChangeLog's `onStartBatch = (changes, opts) => batch.start(changes, opts)`.
  - `BatchPreviewDialog` follows the `ChangePreviewDialog` rules: first focus on [취소], Esc cancels, Enter never applies, and the typed text resets when `rev` changes.
  - Checklist: add a section "IAM 할당 표 (테스트 계정에서만 확인한다)" with these items:
    1. Policy tab states.
    2. Inherited popover.
    3. Locked rows.
    4. Paint-drag.
    5. Keyboard.
    6. "다른 주체와 같게".
    7. 열 추가.
    8. The tray, kept across IAM screens and cleared on a profile change.
    9. Batch preview with one target (type the name) versus many (type `변경 N개 적용`).
    10. Applying a 3-change batch: three log rows grouped as one 묶음.
    11. Mid failure: put a policy the profile may not attach second, and check that the first change applied, the rest did not run, the message is shown, and [적용된 k개 되돌리기] works.
    12. 묶음 되돌리기 from the change log.
    13. The 50 limit.

- [ ] **Step 3: Verify and commit.** Run `npx vitest run` (full), `npx tsc --noEmit` and `npm run build`.

  Mutation-check: make the result path call `onApplied` with all changes even on failure; the partial-failure test must fail. Restore it.

  Commit with message `feat(iam): batch preview, apply and undo for the assignment tray`.

---

### Task K: Docs, final review, merge (controller)
- README (English):
  - Add an "Assignment matrix" bullet to the IAM workspace section. The tables are principals × managed policies and users × groups. Cells toggle by click or drag, and changes collect in a tray that is previewed, applied, logged and undone as one batch.
  - Add nothing to the permissions list, because the write actions are already there.
- Optional: add IAM assignment fixtures to `scripts/screenshots/iam.ts`, so the demo shows the 할당 view.
- Whole-branch review with the most capable model, then one fix wave, then a fast-forward merge to `main` and a push.
