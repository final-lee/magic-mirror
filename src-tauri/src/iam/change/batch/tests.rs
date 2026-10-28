//! 묶음 미리보기: 적용 순서, 변경마다 그 시점 상태로 계산하는 요약·호출·경고, 처음과 끝 상태를 한 번 비교한 영향, 묶음 규칙,
//! 확인 문구, 되돌릴 수 있음, JSON 모양. 스냅숏은 `fixtures::snapshot()`(alice가 앱이 쓰는 관리자 그룹 구성원)에서 출발한다.

use serde_json::{json, Value};

use super::*;
use crate::iam::catalog::AccessLevel;
use crate::iam::change::impact::{PermDelta, MAX_AFFECTED};
use crate::iam::change::preview as preview_one;
use crate::iam::change::scenarios::{account_arn, add_policy, add_to_group, allowing, attach, detach, group_rec, remove_from_group, set_status};
// 묶음을 쓰는 쪽이 보는 경로(`change`가 다시 내보내는 이름)로 가져온다
use crate::iam::change::{application_order, ordered, preview_batch, BatchItem, BatchPreview, MAX_BATCH};
use crate::iam::fixtures::*;

/// bob의 인라인 정책(prod-assets 읽기)을 걷어낸 스냅숏: 정책을 붙여 얻는 권한이 bob이 이미 가진 것에 가려지지 않는다.
fn bare_bob() -> Snapshot {
    let mut s = snapshot();
    s.users.iter_mut().find(|u| u.name == "bob").expect("bob").inline.clear();
    s
}

fn impact_names(p: &BatchPreview) -> Vec<&str> {
    p.impacts.iter().map(|i| i.principal.name.as_str()).collect()
}

fn impact_of<'a>(p: &'a BatchPreview, name: &str) -> &'a Impact {
    p.impacts.iter().find(|i| i.principal.name == name).unwrap_or_else(|| panic!("{name}의 영향이 없어요: {:?}", impact_names(p)))
}

fn delta<'a>(rows: &'a [PermDelta], prefix: &str, level: AccessLevel) -> Option<&'a PermDelta> {
    rows.iter().find(|d| d.prefix == prefix && d.level == level)
}

fn messages(warnings: &[Warning], level: WarnLevel) -> Vec<&str> {
    warnings.iter().filter(|w| w.level == level).map(|w| w.message.as_str()).collect()
}

fn block_messages(item: &BatchItem) -> Vec<&str> {
    messages(&item.warnings, WarnLevel::Block)
}

/// 묶음 전체의 경고와 변경마다의 경고를 모두.
fn every_warning(p: &BatchPreview) -> impl Iterator<Item = &Warning> {
    p.warnings.iter().chain(p.changes.iter().flat_map(|item| &item.warnings))
}

fn assert_clean(p: &BatchPreview) {
    assert!(every_warning(p).next().is_none(), "{:?}", every_warning(p).collect::<Vec<_>>());
    assert_eq!(p.confirm_text, None);
}

/// 서로 다른 정책 `n`개를 bob에게 붙이는 변경들(칸이 겹치지 않는다).
fn distinct_attaches(s: &mut Snapshot, n: usize) -> Vec<IamChange> {
    (0..n)
        .map(|i| {
            let policy_arn = add_policy(s, &format!("extra-{i}"), allowing(&["sqs:SendMessage"]));
            attach(BOB, &policy_arn)
        })
        .collect()
}

fn sorted_keys(v: &Value) -> Vec<&str> {
    let mut keys: Vec<&str> = v.as_object().expect("JSON 객체").keys().map(String::as_str).collect();
    keys.sort_unstable();
    keys
}

// ── 순서 ────────────────────────────────────────────────────────────────

#[test]
fn grants_come_first_and_keep_their_order() {
    let changes = vec![detach(CAROL, S3_FULL), add_to_group("bob", "admins"), remove_from_group("alice", "admins"), attach(BOB, S3_FULL)];
    assert_eq!(application_order(&changes), vec![1, 3, 0, 2]);
    let expected = vec![changes[1].clone(), changes[3].clone(), changes[0].clone(), changes[2].clone()];
    assert_eq!(ordered(&changes), expected);

    // 미리보기도 이 순서로 늘어놓는다
    let p = preview_batch(&snapshot(), &changes, &[]);
    assert_eq!(p.changes.iter().map(|item| item.change.clone()).collect::<Vec<_>>(), expected);

    // 한쪽뿐이면 받은 순서 그대로다
    assert_eq!(application_order(&[]), Vec::<usize>::new());
    assert_eq!(application_order(&[attach(BOB, S3_FULL), add_to_group("bob", "admins"), attach(CAROL, ADMIN_POLICY)]), vec![0, 1, 2]);
    assert_eq!(application_order(&[detach(CAROL, S3_FULL), remove_from_group("alice", "admins"), detach(ADMINS, ADMIN_POLICY)]), vec![0, 1, 2]);
}

// ── 변경마다, 그리고 처음과 끝 ──────────────────────────────────────────

#[test]
fn each_change_is_computed_on_the_state_before_it() {
    let mut s = bare_bob();
    s.groups.push(group_rec("dev-team", &[]));
    let reader = add_policy(&mut s, "x-read", allowing(&["s3:GetObject"]));
    let dev_team = account_arn("group/dev-team");
    let changes = vec![add_to_group("bob", "dev-team"), attach(&dev_team, &reader)];

    let p = preview_batch(&s, &changes, &[]);

    // 두 번째 변경(그룹에 정책 붙이기)은 bob이 이미 구성원이 된 상태에서 반영된다: 그 정책의 읽기 권한이 bob에게도 간다
    assert_eq!(impact_names(&p), vec!["bob", "dev-team"]);
    let bob = impact_of(&p, "bob");
    assert!(bob.lost.is_empty());
    let read = delta(&bob.gained, "s3", AccessLevel::Read).expect("bob이 S3 읽기를 얻어요");
    assert_eq!((read.count, read.sample.as_slice()), (1, ["s3:GetObject".to_string()].as_slice()));
    assert!(delta(&impact_of(&p, "dev-team").gained, "s3", AccessLevel::Read).is_some());

    // 요약과 호출은 변경마다 따로 나오고 dev-team 그룹을 가리킨다
    assert_eq!(p.changes[0].summary, "dev-team 그룹에 bob 추가하기");
    let second = &p.changes[1];
    assert_eq!(second.summary, "dev-team 그룹에 x-read 붙이기");
    assert_eq!(second.calls.len(), 1);
    assert_eq!(second.calls[0].api, "iam:AttachGroupPolicy");
    assert_eq!(second.calls[0].params.get("GroupName").map(String::as_str), Some("dev-team"));
    assert_eq!(second.calls[0].params.get("PolicyArn"), Some(&reader));
    assert_clean(&p);
    assert!(p.reversible);
}

#[test]
fn swapping_a_policy_shows_only_the_real_difference() {
    let mut s = bare_bob();
    let read_only = add_policy(&mut s, "read-only", allowing(&["s3:Get*", "s3:List*"]));
    s.users.iter_mut().find(|u| u.name == "bob").expect("bob").attached.push(read_only.clone());
    // S3_FULL(s3:*)은 read-only가 주던 것을 모두 포함한다
    let changes = vec![detach(BOB, &read_only), attach(BOB, S3_FULL)];

    let p = preview_batch(&s, &changes, &[]);

    // 처음과 끝만 비교한다
    let attached = apply_to_snapshot(&s, &attach(BOB, S3_FULL)).expect("붙일 수 있어요");
    let swapped = apply_to_snapshot(&attached, &detach(BOB, &read_only)).expect("뗄 수 있어요");
    let expected = analyze(&s, &swapped, vec![BOB.to_string()], s.caller_principal_arn.as_deref()).impacts;
    assert_eq!(p.impacts, expected);
    assert_eq!(impact_names(&p), vec!["bob"]);
    let bob = &p.impacts[0];
    assert!(bob.lost.is_empty() && bob.restricted.is_empty(), "{bob:?}");
    assert!(delta(&bob.gained, "s3", AccessLevel::Write).is_some());
    assert!(p.reversible);

    // 대조: 떼기만 따로 보면 읽기 권한을 잃는 것으로 나온다
    let alone = preview_one(&s, &changes[0], &Facts::default());
    assert!(delta(&alone.impacts[0].lost, "s3", AccessLevel::Read).is_some());
}

// ── 확인 문구 ───────────────────────────────────────────────────────────

#[test]
fn one_target_types_its_name() {
    let p = preview_batch(&snapshot(), &[attach(BOB, ADMIN_POLICY)], &[]);
    assert_eq!(p.confirm_text.as_deref(), Some("bob"));
    // 확인 이유와 대상은 그대로 보여 준다
    let confirms = messages(&p.warnings, WarnLevel::Confirm);
    assert_eq!(confirms.len(), 1, "{:?}", p.warnings);
    assert!(confirms[0].contains("관리자급") && confirms[0].contains("bob"), "{}", confirms[0]);
    assert!(p.reversible);
}

#[test]
fn many_targets_type_the_count() {
    let s = snapshot();
    let p = preview_batch(&s, &[attach(BOB, ADMIN_POLICY), attach(CAROL, ADMIN_POLICY)], &[]);
    assert_eq!(p.confirm_text.as_deref(), Some("변경 2개 적용"));

    // N은 대상 수가 아니라 변경 수다
    let p = preview_batch(&s, &[attach(BOB, ADMIN_POLICY), attach(BOB, S3_FULL), attach(CAROL, ADMIN_POLICY)], &[]);
    assert_eq!(p.confirm_text.as_deref(), Some("변경 3개 적용"));
}

#[test]
fn membership_and_attach_of_the_same_user_count_as_one_target() {
    let s = snapshot();
    // bob이 admins에 들어가 관리자급이 되니 확인이 필요하다
    let p = preview_batch(&s, &[add_to_group("bob", "admins"), attach(BOB, S3_FULL)], &[]);
    assert!(!messages(&p.warnings, WarnLevel::Confirm).is_empty(), "{:?}", p.warnings);
    assert_eq!(p.confirm_text.as_deref(), Some("bob"));

    // 대조: 정책을 다른 사용자에게 붙이면 대상이 둘이다
    let p = preview_batch(&s, &[add_to_group("bob", "admins"), attach(CAROL, S3_FULL)], &[]);
    assert_eq!(p.confirm_text.as_deref(), Some("변경 2개 적용"));
}

// ── 막힘 ────────────────────────────────────────────────────────────────

/// 묶음 규칙으로 막힌 묶음: 묶음 경고의 막힘이 `reason` 하나뿐이고, 영향도 확인도 되돌릴 수 있음도 없다.
fn assert_blocked_by(p: &BatchPreview, reason: &str) {
    assert_eq!(messages(&p.warnings, WarnLevel::Block), vec![reason], "{:?}", p.warnings);
    assert!(p.changes.iter().all(|item| block_messages(item).is_empty()), "변경마다의 막힘은 없어야 해요");
    assert!(!p.reversible);
    assert_eq!(p.confirm_text, None);
    assert!(p.impacts.is_empty());
    assert_eq!(p.impacts_omitted, 0);
    let confirms: Vec<_> = every_warning(p).filter(|w| w.level == WarnLevel::Confirm).collect();
    assert!(confirms.is_empty(), "{confirms:?}");
}

#[test]
fn batch_rules_block() {
    let mut s = snapshot();
    // 막힘이 없었다면 영향과 확인이 나왔을 변경(bob이 관리자급이 된다). 빈 묶음을 뺀 막힌 묶음마다 이런 변경을 함께 담아, 막힌 묶음이 영향과 확인을 내지 않는지 본다
    let makes_admin = attach(BOB, ADMIN_POLICY);
    let control = preview_batch(&s, std::slice::from_ref(&makes_admin), &[]);
    assert!(control.confirm_text.is_some() && !control.impacts.is_empty() && control.reversible);

    // 빈 묶음
    let p = preview_batch(&s, &[], &[]);
    assert_blocked_by(&p, EMPTY);
    assert!(p.changes.is_empty());

    // 50개까지는 되고 51개부터 막힌다
    let mut many = vec![makes_admin.clone()];
    many.extend(distinct_attaches(&mut s, MAX_BATCH));
    assert_eq!(many.len(), MAX_BATCH + 1);
    let fifty = preview_batch(&s, &many[..MAX_BATCH], &[]);
    assert!(every_warning(&fifty).all(|w| w.level != WarnLevel::Block), "{:?}", fifty.warnings);
    assert!(fifty.confirm_text.is_some() && !fifty.impacts.is_empty());
    // 너무 큰 묶음은 변경마다 계산하지 않는다(변경 목록이 비어 있다). 다른 묶음 규칙은 함께 나온다
    let too_many = preview_batch(&s, &many, &[]);
    assert_blocked_by(&too_many, TOO_MANY);
    assert!(too_many.changes.is_empty());
    let mut messy = many.clone();
    messy.push(set_status("alice", "AKIA1", "Inactive"));
    messy.push(makes_admin.clone());
    let p = preview_batch(&s, &messy, &[]);
    assert_eq!(messages(&p.warnings, WarnLevel::Block), vec![TOO_MANY, ONLY_ASSIGNMENTS, OVERLAP]);
    assert!(p.changes.is_empty() && !p.reversible && p.confirm_text.is_none() && p.impacts.is_empty());

    // 붙이기·떼기·넣기·빼기가 아닌 변경. 앱이 쓰는 키를 끄는 변경이라 따로 보면 확인이 필요하다
    let stop_own_key = set_status("alice", "AKIA1", "Inactive");
    let own_key = Facts { own_key_id: Some("AKIA1".into()), ..Facts::default() };
    assert!(preview_one(&s, &stop_own_key, &own_key).warnings.iter().any(|w| w.level == WarnLevel::Confirm));
    let p = preview_batch(&s, &[makes_admin.clone(), stop_own_key], &[Facts::default(), own_key]);
    assert_blocked_by(&p, ONLY_ASSIGNMENTS);
    assert_eq!(p.changes.len(), 2);

    // 같은 칸을 붙이고 떼는 변경, 그리고 같은 칸을 두 번 붙이는 변경
    let p = preview_batch(&s, &[attach(BOB, S3_FULL), detach(BOB, S3_FULL), add_to_group("bob", "admins")], &[]);
    assert_blocked_by(&p, OVERLAP);
    assert_blocked_by(&preview_batch(&s, &[makes_admin.clone(), makes_admin], &[]), OVERLAP);
    // 같은 사용자라도 그룹이 다르면, 같은 정책이라도 대상이 다르면 겹치지 않는다
    s.groups.push(group_rec("ops", &[]));
    let p = preview_batch(&s, &[add_to_group("bob", "admins"), add_to_group("bob", "ops"), attach(BOB, S3_FULL), attach(CAROL, ADMIN_POLICY)], &[]);
    assert!(every_warning(&p).all(|w| w.level != WarnLevel::Block), "{:?}", p.warnings);
}

#[test]
fn a_locked_target_blocks_the_whole_batch() {
    let s = snapshot();
    let changes = vec![attach(SLR, S3_FULL), attach(BOB, S3_FULL)];

    let p = preview_batch(&s, &changes, &[]);

    // 서비스 연결 역할의 막힘은 그 변경에 붙고, 묶음 전체는 적용할 수 없다
    assert_eq!(p.changes[0].change, changes[0]);
    let locked = block_messages(&p.changes[0]);
    assert_eq!(locked.len(), 1, "{:?}", p.changes[0].warnings);
    assert!(locked[0].contains("서비스 연결 역할"), "{}", locked[0]);
    assert!(block_messages(&p.changes[1]).is_empty());
    assert!(messages(&p.warnings, WarnLevel::Block).is_empty());
    assert!(!p.reversible);
    assert_eq!(p.confirm_text, None);
    assert!(p.impacts.is_empty());
}

#[test]
fn a_change_that_cannot_hold_blocks_the_batch() {
    // deploy 역할에는 S3_FULL이 붙어 있지 않다. CloudFormation 스택 대상이라는 주의도 함께 나오지만 막힘이 먼저다
    let s = snapshot();
    let changes = vec![attach(BOB, S3_FULL), detach(DEPLOY, S3_FULL)];

    let p = preview_batch(&s, &changes, &[]);

    let levels: Vec<WarnLevel> = p.changes[1].warnings.iter().map(|w| w.level).collect();
    assert_eq!(levels, vec![WarnLevel::Block, WarnLevel::Warn], "{:?}", p.changes[1].warnings);
    assert!(p.changes[1].warnings[0].message.contains("붙어 있지 않은"));
    assert!(p.changes[0].warnings.is_empty());
    assert!(!p.reversible);
    assert!(p.impacts.is_empty());
    assert_eq!(p.confirm_text, None);
}

// ── 앱의 자격 증명 ──────────────────────────────────────────────────────

#[test]
fn losing_own_admin_needs_confirm_and_is_not_reversible() {
    let mut s = snapshot();
    let read_only = add_policy(&mut s, "read-only", allowing(&["s3:Get*", "s3:List*"]));
    // 앱이 쓰는 alice의 관리자 권한은 그룹 admins에서만 온다
    let changes = vec![remove_from_group("alice", "admins"), attach(ALICE, &read_only)];

    let p = preview_batch(&s, &changes, &[]);

    let confirms = messages(&p.warnings, WarnLevel::Confirm);
    assert_eq!(confirms.len(), 1, "{:?}", p.warnings);
    assert!(confirms[0].starts_with("지금 이 앱이 쓰는 자격 증명(alice)의 권한이 줄어요"), "{}", confirms[0]);
    // 되돌릴 권한 이야기는 이 확인 하나에 붙는다: 되돌리는 변경들(그룹에 다시 넣기, 정책 떼기)의 API를 모두 말한다
    assert!(confirms[0].contains("되돌릴 수 없어요") && confirms[0].contains("(iam:AddUserToGroup, iam:DetachUserPolicy)"), "{}", confirms[0]);
    assert_eq!(p.confirm_text.as_deref(), Some("alice"));
    assert!(!p.reversible);
    // 변경마다 역변경은 있다. 권한이 있는 다른 자격 증명으로는 되돌릴 수 있다
    assert!(p.changes.iter().all(|item| item.inverse.is_some()));
}

#[test]
fn a_change_without_an_inverse_makes_the_batch_irreversible() {
    // carol은 이미 S3_FULL을 받고 있다: 달라지는 게 없으니 되돌릴 것도 없다
    let s = snapshot();

    let p = preview_batch(&s, &[attach(BOB, S3_FULL), attach(CAROL, S3_FULL)], &[]);

    assert!(p.changes[0].inverse.is_some() && p.changes[1].inverse.is_none());
    assert_eq!(messages(&p.changes[1].warnings, WarnLevel::Warn), vec!["이미 붙어 있어서 달라지는 게 없어요: AmazonS3FullAccess"]);
    assert!(every_warning(&p).all(|w| w.level != WarnLevel::Block));
    assert!(!p.reversible);
}

#[test]
fn attaching_a_policy_never_flags_unknown_actions() {
    // 카탈로그에 없는 작업이 든 정책을 붙이는 것은 오타로 보지 않는다. 사용자가 쓴 문서를 저장하는 변경만 그렇게 본다
    let mut s = snapshot();
    let typo = add_policy(&mut s, "typo", allowing(&["s3:NoSuchAction"]));

    let p = preview_batch(&s, &[attach(BOB, &typo)], &[]);

    assert!(every_warning(&p).all(|w| !w.message.contains("카탈로그에 없는 작업")), "{:?}", p.warnings);
    // 대조: 같은 문서를 인라인 정책으로 저장하는 변경은 알려 준다
    let put = IamChange::PutInlinePolicy { target: BOB.into(), name: "typo".into(), document: policy(allowing(&["s3:NoSuchAction"])).to_string() };
    let alone = preview_one(&s, &put, &Facts::default());
    assert!(alone.warnings.iter().any(|w| w.message.contains("카탈로그에 없는 작업")), "{:?}", alone.warnings);
}

#[test]
fn a_missing_undo_right_is_named_once() {
    let mut s = snapshot();
    let first = add_policy(&mut s, "read-one", allowing(&["s3:Get*"]));
    let second = add_policy(&mut s, "read-two", allowing(&["s3:List*"]));
    // 정책 두 개를 떼는 역변경이 같은 API(iam:DetachUserPolicy)를 두 번 부른다
    let changes = vec![remove_from_group("alice", "admins"), attach(ALICE, &first), attach(ALICE, &second)];

    let p = preview_batch(&s, &changes, &[]);

    let confirms = messages(&p.warnings, WarnLevel::Confirm);
    assert_eq!(confirms.len(), 1, "{:?}", p.warnings);
    assert_eq!(confirms[0].matches("iam:DetachUserPolicy").count(), 1, "{}", confirms[0]);
    assert!(confirms[0].contains("(iam:AddUserToGroup, iam:DetachUserPolicy)"), "{}", confirms[0]);
    assert!(!p.reversible);
}

#[test]
fn a_caller_that_keeps_its_iam_rights_can_undo_the_batch() {
    let mut s = snapshot();
    let read_only = add_policy(&mut s, "read-only", allowing(&["s3:Get*", "s3:List*"]));
    s.users.iter_mut().find(|u| u.name == "alice").expect("alice").inline.push(inline("iam-admin", policy(allowing(&["iam:*"]))));
    let changes = vec![remove_from_group("alice", "admins"), attach(ALICE, &read_only)];

    let p = preview_batch(&s, &changes, &[]);

    // 권한은 줄지만(ec2 등) 되돌리는 데 필요한 IAM 권한이 남는다
    let confirms = messages(&p.warnings, WarnLevel::Confirm);
    assert_eq!(confirms.len(), 1, "{:?}", p.warnings);
    assert!(confirms[0].starts_with("지금 이 앱이 쓰는 자격 증명(alice)의 권한이 줄어요") && !confirms[0].contains("되돌"), "{}", confirms[0]);
    assert!(p.reversible);
}

// ── 재료와 JSON ─────────────────────────────────────────────────────────

#[test]
fn facts_follow_their_change_after_reordering() {
    let mut s = snapshot();
    s.users.iter_mut().find(|u| u.name == "bob").expect("bob").attached.push(UNUSED_POLICY.into());
    // 스냅숏에 없는 정책: 읽다가 실패한 정책을 붙이는 변경
    let unreadable = "arn:aws:iam::aws:policy/SecurityAudit";
    // 받은 순서는 [떼기, 붙이기]이고 적용 순서는 [붙이기, 떼기]다. 재료는 받은 순서를 따른다
    let changes = vec![detach(BOB, UNUSED_POLICY), attach(CAROL, unreadable)];
    let facts = vec![Facts::default(), Facts { policy_error: Some("권한 없음 (iam:GetPolicy)".into()), ..Facts::default() }];

    let p = preview_batch(&s, &changes, &facts);

    assert_eq!(p.changes[0].change, changes[1]);
    assert_eq!(messages(&p.changes[0].warnings, WarnLevel::Warn), vec!["SecurityAudit 정책을 읽지 못했어요: 권한 없음 (iam:GetPolicy)"]);
    assert_eq!(p.changes[1].change, changes[0]);
    assert!(p.changes[1].warnings.is_empty(), "{:?}", p.changes[1].warnings);
    // 재료가 모자라면 기본값으로 계산한다
    let p = preview_batch(&s, &changes, &facts[..1]);
    assert!(p.changes[0].warnings.iter().all(|w| !w.message.contains("읽지 못했어요: 권한 없음")), "{:?}", p.changes[0].warnings);
}

#[test]
fn serializes_camel_case_without_inverse() {
    let p = preview_batch(&snapshot(), &[attach(BOB, ADMIN_POLICY)], &[]);
    assert!(p.changes[0].inverse.is_some(), "역변경은 있지만 보내지 않아요");

    let v = serde_json::to_value(&p).expect("직렬화");

    assert_eq!(v["changes"][0]["summary"], "bob에 AdministratorAccess 붙이기");
    assert_eq!(v["changes"][0]["change"], json!({ "op": "attachPolicy", "target": BOB, "policyArn": ADMIN_POLICY }));
    assert_eq!(v["changes"][0]["calls"][0]["api"], "iam:AttachUserPolicy");
    assert_eq!(v["confirmText"], "bob");
    assert_eq!(v["reversible"], true);
    assert_eq!(v["impacts"][0]["principal"]["name"], "bob");
    assert_eq!(v["warnings"][0]["level"], "confirm");
    assert_eq!(sorted_keys(&v), vec!["changes", "confirmText", "impacts", "reversible", "warnings"]);
    assert_eq!(sorted_keys(&v["changes"][0]), vec!["calls", "change", "summary", "warnings"]);

    // 확인할 것이 없으면 confirmText는 null로 보낸다
    let clean = serde_json::to_value(preview_batch(&snapshot(), &[attach(BOB, S3_FULL)], &[])).expect("직렬화");
    assert!(clean["confirmText"].is_null());
}

#[test]
fn impacts_omitted_is_sent_only_when_some_were_left_out() {
    let mut s = snapshot();
    let reader = add_policy(&mut s, "x-read", allowing(&["s3:GetObject"]));
    let changes: Vec<IamChange> = (0..31)
        .map(|i| {
            let u = user(&format!("u{i}"));
            let arn = u.arn.clone();
            s.users.push(u);
            attach(&arn, &reader)
        })
        .collect();

    let p = preview_batch(&s, &changes, &[]);

    // 영향받는 주체 31명 가운데 30명만 자세히 보낸다
    assert_eq!((p.impacts.len(), p.impacts_omitted), (30, 1));
    let v = serde_json::to_value(&p).expect("직렬화");
    assert_eq!(v["impactsOmitted"], 1);
    assert_eq!(v["impacts"].as_array().map(Vec::len), Some(30));
}

// ── 큰 그룹 ─────────────────────────────────────────────────────────────

/// 구성원이 60명인 그룹 `big`과 `s3:GetObject`만 허용하는 정책 `reader`가 든 스냅숏. (스냅숏, 그룹 ARN, 정책 ARN)
fn with_big_group() -> (Snapshot, String, String) {
    let mut s = snapshot();
    s.groups.push(group_rec("big", &[]));
    for i in 0..60 {
        let mut member = user(&format!("m{i}"));
        member.groups = vec!["big".into()];
        s.users.push(member);
    }
    let reader = add_policy(&mut s, "reader", allowing(&["s3:GetObject"]));
    (s, account_arn("group/big"), reader)
}

const NEW_ADMIN_BOB: &str = "관리자급 권한을 새로 얻는 주체: bob";

#[test]
fn a_big_group_change_does_not_push_a_later_target_out_of_the_analysis() {
    let (s, big, reader) = with_big_group();

    let p = preview_batch(&s, &[attach(&big, &reader), attach(BOB, ADMIN_POLICY)], &[]);

    // 그룹과 구성원 60명만으로 계산 한도(50명)를 넘는다. 그래도 변경이 직접 바꾸는 주체(big, bob)가 먼저 계산돼서 bob이 관리자급이 되는 확인이 나온다
    assert!(p.warnings.iter().any(|w| w.message.contains("처음 50개만 계산했어요")), "{:?}", p.warnings);
    assert_eq!(messages(&p.warnings, WarnLevel::Confirm), vec![NEW_ADMIN_BOB]);
    assert_eq!(p.confirm_text.as_deref(), Some("변경 2개 적용"));
    assert_eq!(impact_names(&p)[..2], ["big", "bob"]);
    assert!(impact_of(&p, "bob").lost.is_empty());
}

#[test]
fn the_received_order_does_not_change_which_targets_are_analyzed() {
    let (s, big, reader) = with_big_group();
    let group_first = preview_batch(&s, &[attach(&big, &reader), attach(BOB, ADMIN_POLICY)], &[]);

    let admin_first = preview_batch(&s, &[attach(BOB, ADMIN_POLICY), attach(&big, &reader)], &[]);

    assert_eq!(messages(&admin_first.warnings, WarnLevel::Confirm), vec![NEW_ADMIN_BOB]);
    assert_eq!(admin_first.confirm_text.as_deref(), Some("변경 2개 적용"));
    assert_eq!(messages(&admin_first.warnings, WarnLevel::Confirm), messages(&group_first.warnings, WarnLevel::Confirm));
    assert_eq!(admin_first.confirm_text, group_first.confirm_text);
}

#[test]
fn the_caller_reached_only_through_a_group_does_not_push_the_last_target_out() {
    // 50개를 모두 다른 주체에게 직접 바꾸는데, 앱이 쓰는 alice는 admins 그룹의 구성원으로만 영향받는다(대상이 아니다)
    let mut s = snapshot();
    let reader = add_policy(&mut s, "reader", allowing(&["s3:GetObject"]));
    let mut changes = vec![attach(ADMINS, &reader)];
    for i in 0..48 {
        let newcomer = user(&format!("n{i:02}"));
        changes.push(attach(&newcomer.arn, &reader));
        s.users.push(newcomer);
    }
    changes.push(attach(BOB, ADMIN_POLICY));
    assert_eq!(changes.len(), MAX_BATCH);

    let p = preview_batch(&s, &changes, &[]);

    // 영향받는 주체는 직접 바꾸는 50명과, admins를 거쳐서만 영향받는 앱의 alice까지 51명이다: 계산 한도(50명)보다 하나 많다.
    // alice를 앞으로 옮겨 계산해도 마지막 대상 bob이 빠지면 안 된다
    let targets: BTreeSet<&str> = changes.iter().filter_map(|c| if let IamChange::AttachPolicy { target, .. } = c { Some(target.as_str()) } else { None }).collect();
    assert_eq!(targets.len(), MAX_AFFECTED);
    assert!(!targets.contains(ALICE));
    assert_eq!(s.caller_principal_arn.as_deref(), Some(ALICE));
    assert_eq!(s.user("alice").map(|alice| alice.groups.clone()), Some(vec!["admins".to_string()]));
    assert_eq!(messages(&p.warnings, WarnLevel::Confirm), vec![NEW_ADMIN_BOB]);
    assert_eq!(p.confirm_text.as_deref(), Some("변경 50개 적용"));
    // 달라지는 주체는 새 사용자 48명과 bob이다(alice와 admins는 이미 관리자라 reader가 더하는 것이 없다)
    assert_eq!(p.impacts.len() + p.impacts_omitted, 49);
}
