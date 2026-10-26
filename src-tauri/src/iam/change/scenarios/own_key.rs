//! 이 앱이 지금 쓰는 액세스 키를 끄거나 지우는 변경. 적용하면 그 자리에서 앱이 AWS에 접근하지 못하고, 앱 안에서는 되돌릴 수 없다.

use super::*;

const OWN_KEY: &str = "적용하면 이 앱이 바로 AWS에 접근하지 못하고, 여기서는 되돌릴 수 없어요";

/// 자격 증명의 키 ID를 읽은 미리보기(키는 지금 `Active`).
fn seen_with_key(s: &Snapshot, change: &IamChange, own_key_id: Option<&str>) -> ChangePreview {
    let facts = Facts { key_status: Some("Active".into()), own_key_id: own_key_id.map(str::to_string), ..Facts::default() };
    super::super::preview(s, change, &facts)
}

fn own_inverse(s: &Snapshot, change: &IamChange, own_key_id: Option<&str>) -> Option<IamChange> {
    let facts = Facts { key_status: Some("Active".into()), own_key_id: own_key_id.map(str::to_string), ..Facts::default() };
    super::super::inverse(s, change, &facts)
}

#[test]
fn turning_off_the_key_this_app_uses_needs_the_key_id_and_cannot_be_undone() {
    let s = snapshot();
    let change = set_status("bob", "AKIA1", "Inactive");
    let p = seen_with_key(&s, &change, Some("AKIA1"));
    assert_eq!(only(&p, WarnLevel::Confirm), OWN_KEY);
    assert_eq!(p.confirm_text.as_deref(), Some("AKIA1"));
    assert!(!p.reversible);
    assert_eq!(own_inverse(&s, &change, Some("AKIA1")), None);
}

#[test]
fn another_key_of_the_same_user_is_not_the_apps_key() {
    let s = snapshot();
    let change = set_status("bob", "AKIA2", "Inactive");
    let p = seen_with_key(&s, &change, Some("AKIA1"));
    assert_clean(&p);
    assert!(p.reversible);
    assert_eq!(own_inverse(&s, &change, Some("AKIA1")), Some(set_status("bob", "AKIA2", "Active")));
}

#[test]
fn a_temporary_key_from_sso_or_a_role_matches_no_users_key() {
    // 임시 자격 증명(ASIA…)은 IAM 사용자의 키를 쓰지 않는다. 앱이 IAM 사용자 alice로 접근해도 alice의 키를 끄는 것은 앱의 키가 아니다
    let s = snapshot();
    let change = set_status("alice", "AKIA9", "Inactive");
    let p = seen_with_key(&s, &change, Some("ASIAEXAMPLETEMPORARY"));
    assert!(!messages(&p, WarnLevel::Confirm).contains(&OWN_KEY), "{:?}", p.warnings);
    assert!(p.reversible);
}

#[test]
fn when_the_key_id_cannot_be_read_any_key_of_the_iam_user_in_use_counts() {
    let s = snapshot();
    let p = seen_with_key(&s, &set_status("alice", "AKIA9", "Inactive"), None);
    assert_eq!(only(&p, WarnLevel::Confirm), OWN_KEY);
    assert_eq!(p.confirm_text.as_deref(), Some("AKIA9"));
    assert!(!p.reversible);
    // 다른 사용자의 키는 앱의 키가 아니다
    assert_clean(&seen_with_key(&s, &set_status("bob", "AKIA1", "Inactive"), None));
}

#[test]
fn the_fallback_is_only_for_an_app_signed_in_as_an_iam_user() {
    // 앱이 역할로 접근하면 어떤 사용자의 키도 앱의 키가 아니다
    let s = called_by(snapshot(), Some(DEPLOY));
    assert_clean(&seen_with_key(&s, &set_status("alice", "AKIA9", "Inactive"), None));
    let unknown = called_by(snapshot(), None);
    assert_clean(&seen_with_key(&unknown, &set_status("alice", "AKIA9", "Inactive"), None));
}

#[test]
fn deleting_the_key_this_app_uses_says_so_besides_the_usual_confirmation() {
    let s = snapshot();
    let p = seen_with_key(&s, &delete_key("bob", "AKIA1"), Some("AKIA1"));
    let confirms = messages(&p, WarnLevel::Confirm);
    assert_eq!(confirms.len(), 2, "{:?}", p.warnings);
    assert!(confirms.contains(&OWN_KEY));
    assert!(confirms.iter().any(|m| m.contains("액세스 키를 삭제하면")));
    assert_eq!(p.confirm_text.as_deref(), Some("AKIA1"));
    assert!(!p.reversible);
}

#[test]
fn turning_the_apps_key_on_is_not_flagged() {
    let s = snapshot();
    let p = seen_with_key(&s, &set_status("bob", "AKIA1", "Active"), Some("AKIA1"));
    assert!(!messages(&p, WarnLevel::Confirm).contains(&OWN_KEY));
    assert_eq!(p.confirm_text, None);
}
