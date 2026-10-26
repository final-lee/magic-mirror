//! 미리보기에서 본 계획과 적용 직전에 다시 계산한 계획의 비교. AWS 없이 고정 스냅숏과 고정 시각으로 확인한다.

use serde_json::json;

use super::*;
use crate::iam::change::{preview, Facts, IamChange};
use crate::iam::fixtures::*;
use crate::iam::model::{Snapshot, VersionRec};

const NOW: i64 = 1_792_000_000;

fn plan_of(s: &Snapshot, change: &IamChange) -> Plan {
    Plan::of(&s.account_id, &preview(s, change, &Facts::default()))
}

fn edit_unused(document: &str) -> IamChange {
    IamChange::UpdateManagedPolicy { policy_arn: UNUSED_POLICY.into(), document: document.into() }
}

fn doc(actions: &[&str]) -> String {
    policy(json!([{ "Effect": "Allow", "Action": actions, "Resource": "*" }])).to_string()
}

fn with_versions(mut s: Snapshot, ids: &[&str], default: &str) -> Snapshot {
    s.policies.get_mut(UNUSED_POLICY).unwrap().versions = ids.iter().map(|id| VersionRec { id: id.to_string(), is_default: *id == default, created_at: None }).collect();
    s
}

fn attach_s3_to_bob() -> IamChange {
    IamChange::AttachPolicy { target: BOB.into(), policy_arn: S3_FULL.into() }
}

/// 미리보기를 기억해 두고, 적용할 때처럼 꺼내서 다시 계산한 계획과 견준다.
fn apply_after_preview(store: &mut PlanStore, seen: &Snapshot, now: &Snapshot, change: &IamChange) -> Result<(), AppError> {
    store.remember("prod", change, plan_of(seen, change), NOW);
    check(store.take("prod", change, NOW + 30).as_ref(), &plan_of(now, change))
}

#[test]
fn a_change_applied_as_it_was_previewed_goes_through() {
    let s = snapshot();
    let mut store = PlanStore::default();
    assert_eq!(apply_after_preview(&mut store, &s, &s, &attach_s3_to_bob()), Ok(()));
    let edit = edit_unused(&doc(&["sqs:SendMessage"]));
    assert_eq!(apply_after_preview(&mut store, &s, &s, &edit), Ok(()));
}

#[test]
fn a_fifth_version_that_appears_after_the_preview_is_refused() {
    let change = edit_unused(&doc(&["sqs:SendMessage"]));
    let before = with_versions(snapshot(), &["v1", "v2", "v3", "v4"], "v4");
    let after = with_versions(snapshot(), &["v1", "v2", "v3", "v4", "v5"], "v5");
    assert_eq!(plan_of(&before, &change).calls.len(), 1, "미리보기에는 새 버전 만들기만 있었어요");
    assert_eq!(plan_of(&after, &change).calls[0].api, "iam:DeletePolicyVersion", "지금은 버전 하나를 먼저 지워요");
    let mut store = PlanStore::default();
    assert_eq!(apply_after_preview(&mut store, &before, &after, &change), Err(AppError::other(DRIFTED)));
}

#[test]
fn a_different_version_to_delete_is_refused() {
    let change = edit_unused(&doc(&["sqs:SendMessage"]));
    let seen = with_versions(snapshot(), &["v1", "v2", "v3", "v4", "v5"], "v5");
    // 그 사이 누군가 v1을 지우고 v6을 만들었다: 이제 지울 버전은 v2다
    let now = with_versions(snapshot(), &["v2", "v3", "v4", "v5", "v6"], "v6");
    let mut store = PlanStore::default();
    assert_eq!(apply_after_preview(&mut store, &seen, &now, &change), Err(AppError::other(DRIFTED)));
}

#[test]
fn applying_without_a_preview_is_refused() {
    let mut store = PlanStore::default();
    let s = snapshot();
    assert_eq!(check(store.take("prod", &attach_s3_to_bob(), NOW).as_ref(), &plan_of(&s, &attach_s3_to_bob())), Err(AppError::other(DRIFTED)));
    // 다른 변경의 미리보기는 이 변경의 미리보기가 아니다
    store.remember("prod", &attach_s3_to_bob(), plan_of(&s, &attach_s3_to_bob()), NOW);
    let other = IamChange::AttachPolicy { target: CAROL.into(), policy_arn: S3_FULL.into() };
    assert_eq!(store.take("prod", &other, NOW), None);
}

#[test]
fn one_preview_allows_at_most_one_apply() {
    let s = snapshot();
    let change = attach_s3_to_bob();
    let mut store = PlanStore::default();
    store.remember("prod", &change, plan_of(&s, &change), NOW);
    assert_eq!(check(store.take("prod", &change, NOW + 1).as_ref(), &plan_of(&s, &change)), Ok(()));
    assert_eq!(check(store.take("prod", &change, NOW + 2).as_ref(), &plan_of(&s, &change)), Err(AppError::other(DRIFTED)));
}

#[test]
fn a_summary_that_changed_after_the_preview_is_refused() {
    // 미리보기 때는 bob에게 인라인 정책 extra가 없어서 "추가하기"였는데, 그 사이 누군가 같은 이름으로 만들었다: 같은 호출이 덮어쓰기가 된다
    let change = IamChange::PutInlinePolicy { target: BOB.into(), name: "extra".into(), document: doc(&["sqs:SendMessage"]) };
    let seen = snapshot();
    let mut now = snapshot();
    now.users[1].inline.push(inline("extra", policy(json!([{ "Effect": "Allow", "Action": "sqs:SendMessage", "Resource": "*" }]))));
    let (before, after) = (plan_of(&seen, &change), plan_of(&now, &change));
    assert_eq!((&before.calls, &before.checks, before.reversible), (&after.calls, &after.checks, after.reversible));
    assert_ne!(before.summary, after.summary);
    let mut store = PlanStore::default();
    assert_eq!(apply_after_preview(&mut store, &seen, &now, &change), Err(AppError::other(DRIFTED)));
}

#[test]
fn a_change_that_can_no_longer_be_undone_is_refused() {
    // 미리보기 때는 키가 활성이라 되돌릴 수 있었는데, 그 사이 누군가 꺼서 지금은 되돌릴 것이 없다
    let change = IamChange::SetAccessKeyStatus { user_name: "bob".into(), access_key_id: "AKIA1".into(), status: "Inactive".into() };
    let s = snapshot();
    let plan_with = |status: &str| Plan::of(&s.account_id, &preview(&s, &change, &Facts::with_key_status(Some(status))));
    let (seen, now) = (plan_with("Active"), plan_with("Inactive"));
    assert_eq!((&seen.summary, &seen.calls, &seen.checks), (&now.summary, &now.calls, &now.checks));
    assert!(seen.reversible && !now.reversible);
    assert_eq!(check(Some(&seen), &now), Err(AppError::other(DRIFTED)));
}

#[test]
fn a_preview_of_another_account_is_refused() {
    let s = snapshot();
    let mut elsewhere = snapshot();
    elsewhere.account_id = "222222222222".into();
    // 이름으로 가리키는 변경은 다른 계정에서도 같은 호출이 된다: 계정이 같아야만 같은 계획이다
    let change = IamChange::AddToGroup { user_name: "bob".into(), group_name: "admins".into() };
    assert_eq!(plan_of(&s, &change).calls, plan_of(&elsewhere, &change).calls);
    let mut store = PlanStore::default();
    assert_eq!(apply_after_preview(&mut store, &s, &elsewhere, &change), Err(AppError::other(DRIFTED)));
}

#[test]
fn different_confirm_reasons_are_refused_but_notes_are_not_compared() {
    let change = attach_s3_to_bob();
    let seen = snapshot();
    // 그 사이 bob이 CloudFormation 스택 대상이 됐다: 주의(warn)만 늘어서 확인한 것은 그대로다
    let mut tagged = snapshot();
    tagged.users[1].tags.insert("aws:cloudformation:stack-name".into(), "users-stack".into());
    let mut store = PlanStore::default();
    assert_eq!(apply_after_preview(&mut store, &seen, &tagged, &change), Ok(()));

    // 그 사이 앱이 carol의 자격 증명을 쓰게 됐다: 떼면 이 앱의 권한이 줄어서 확인 이유가 새로 생긴다
    let detach = IamChange::DetachPolicy { target: CAROL.into(), policy_arn: S3_FULL.into() };
    let mut caller_now = snapshot();
    caller_now.caller_principal_arn = Some(CAROL.into());
    assert!(plan_of(&seen, &detach).checks.is_empty());
    assert!(!plan_of(&caller_now, &detach).checks.is_empty());
    assert_eq!(apply_after_preview(&mut store, &seen, &caller_now, &detach), Err(AppError::other(DRIFTED)));
}

#[test]
fn a_different_policy_document_is_a_different_change() {
    let s = snapshot();
    let mut store = PlanStore::default();
    store.remember("prod", &edit_unused(&doc(&["sqs:SendMessage"])), plan_of(&s, &edit_unused(&doc(&["sqs:SendMessage"]))), NOW);
    assert_eq!(store.take("prod", &edit_unused(&doc(&["sqs:*"])), NOW), None);
    // 같은 문서라도 공백이 다르면 보내는 문서가 다르다
    let pretty = serde_json::to_string_pretty(&policy(json!([{ "Effect": "Allow", "Action": ["sqs:SendMessage"], "Resource": "*" }]))).unwrap();
    assert_eq!(store.take("prod", &edit_unused(&pretty), NOW), None);
    assert!(store.take("prod", &edit_unused(&doc(&["sqs:SendMessage"])), NOW).is_some());
}

#[test]
fn the_same_change_sent_with_its_fields_in_another_order_finds_its_preview() {
    let s = snapshot();
    let a: IamChange = serde_json::from_value(json!({ "op": "attachPolicy", "target": BOB, "policyArn": S3_FULL })).unwrap();
    let b: IamChange = serde_json::from_value(json!({ "policyArn": S3_FULL, "target": BOB, "op": "attachPolicy" })).unwrap();
    let mut store = PlanStore::default();
    store.remember("prod", &a, plan_of(&s, &a), NOW);
    assert_eq!(check(store.take("prod", &b, NOW).as_ref(), &plan_of(&s, &b)), Ok(()));
}

#[test]
fn profiles_keep_their_own_previews() {
    let s = snapshot();
    let change = attach_s3_to_bob();
    let mut store = PlanStore::default();
    store.remember("dev", &change, plan_of(&s, &change), NOW);
    assert_eq!(store.take("prod", &change, NOW), None);
    assert!(store.take("dev", &change, NOW).is_some());
}

#[test]
fn a_newer_preview_of_the_same_change_replaces_the_older_one() {
    let change = edit_unused(&doc(&["sqs:SendMessage"]));
    let old = with_versions(snapshot(), &["v1", "v2", "v3", "v4"], "v4");
    let new = with_versions(snapshot(), &["v1", "v2", "v3", "v4", "v5"], "v5");
    let mut store = PlanStore::default();
    store.remember("prod", &change, plan_of(&old, &change), NOW);
    store.remember("prod", &change, plan_of(&new, &change), NOW + 5);
    assert_eq!(check(store.take("prod", &change, NOW + 6).as_ref(), &plan_of(&new, &change)), Ok(()));
    assert_eq!(store.take("prod", &change, NOW + 7), None, "앞의 미리보기가 남아 있으면 안 돼요");
}

#[test]
fn a_preview_older_than_ten_minutes_is_ignored() {
    let s = snapshot();
    let change = attach_s3_to_bob();
    let mut store = PlanStore::default();
    store.remember("prod", &change, plan_of(&s, &change), NOW);
    assert!(store.take("prod", &change, NOW + PLAN_TTL_SECS).is_some(), "딱 10분은 아직 써요");
    store.remember("prod", &change, plan_of(&s, &change), NOW);
    assert_eq!(store.take("prod", &change, NOW + PLAN_TTL_SECS + 1), None);
}

#[test]
fn only_the_latest_fifty_previews_are_kept() {
    let s = snapshot();
    let changes: Vec<IamChange> =
        (0..=MAX_PLANS).map(|i| IamChange::SetAccessKeyStatus { user_name: "bob".into(), access_key_id: format!("AKIA{i:04}"), status: "Inactive".into() }).collect();
    let mut store = PlanStore::default();
    for (i, change) in changes.iter().enumerate() {
        store.remember("prod", change, plan_of(&s, change), NOW + i as i64);
    }
    assert_eq!(store.take("prod", &changes[0], NOW + 100), None, "가장 오래된 것이 밀려났어요");
    for change in &changes[1..] {
        assert!(store.take("prod", change, NOW + 100).is_some(), "{change:?}");
    }
}
