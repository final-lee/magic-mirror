//! 묶음 미리보기: 할당 표에서 모은 붙이기·떼기·넣기·빼기를 적용 순서로 늘어놓고, 가상 스냅숏에 하나씩 반영하며 변경마다
//! 요약·호출·경고를 그 시점 상태로 계산한 뒤, 처음과 끝 상태를 한 번 비교해 권한 증감과 묶음 경고를 낸다. 순수 함수다.

use std::collections::BTreeSet;

use serde::Serialize;

use super::facts::Facts;
use super::impact::{affected, analyze, is_zero, shown, Ordered};
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

/// 변경이 바꾸는 주체(`warnings::principal_arn`). 사용자를 그룹에 넣고 빼는 변경도 그 사용자의 ARN으로 센다(같은 사용자에게 정책을 붙이는 변경과 한 대상이다).
/// 주체를 알 수 없으면(스냅숏에 없는 사용자 등) 사용자 이름이나 변경 자체로 가른다.
fn target_of(s: &Snapshot, c: &IamChange) -> String {
    warnings::principal_arn(s, c).unwrap_or_else(|| match c {
        IamChange::AddToGroup { user_name, .. } | IamChange::RemoveFromGroup { user_name, .. } => format!("user:{user_name}"),
        other => format!("{other:?}"),
    })
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
    if changes.len() > MAX_BATCH {
        // 너무 큰 묶음은 적용할 수 없으니 변경마다 스냅숏을 복제해 가며 계산하지 않고 묶음 규칙의 막힘만 돌려준다
        return BatchPreview { changes: Vec::new(), impacts: Vec::new(), impacts_omitted: 0, warnings: batch_warnings, confirm_text: None, reversible: false };
    }
    let mut state = s.clone();
    let mut items: Vec<BatchItem> = Vec::with_capacity(changes.len());
    // 영향을 계산할 주체. `analyze`는 앞에서부터 `MAX_AFFECTED`명만 계산하니, 변경마다 직접 바꾸는 주체(그룹은 그 자신)를 모두 먼저 넣고
    // 그룹 구성원처럼 `affected`가 더 돌려준 주체는 그 뒤에 넣는다: 큰 그룹을 바꾸는 변경이 뒤의 변경의 대상을 한도 밖으로 밀어내지 못한다.
    // 남는 틈: 직접 바꾸는 주체가 50명이고 앱의 자격 증명이 그룹을 거쳐서만 영향받으면, `analyze`가 앱의 자격 증명을 앞으로 옮기면서
    // 마지막 주체가 빠진다(계산을 줄였다는 주의는 그대로 나온다).
    let (mut touched, mut reached) = (Ordered::default(), Ordered::default());
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
                    if let Some(arn) = warnings::principal_arn(&state, c) {
                        touched.push(&arn);
                    }
                    for arn in affected(&state, c) {
                        reached.push(&arn);
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
        for arn in &reached.list {
            touched.push(arn);
        }
        let analysis = analyze(s, &state, touched.list, caller);
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
