//! 버전이 가득 찬 관리형 정책 편집: 가장 오래된 버전을 지운 뒤 새 버전을 만들므로, 만들기가 실패하면 지운 버전은 돌아오지 않는다.
//! 그래서 새 문서를 Access Analyzer로 검사한 결과(`PolicyCheck`)를 미리보기에 넣는다.

use super::*;

const UNCHECKED: &str = "정책 검사를 할 수 없어 버전 삭제 뒤 저장이 실패할 수 있어요";

fn full(mut s: Snapshot) -> Snapshot {
    s.policies.get_mut(UNUSED_POLICY).unwrap().versions = versions(&["v1", "v2", "v3", "v4", "v5"], "v5");
    s
}

fn checked(s: &Snapshot, change: &IamChange, check: PolicyCheck) -> ChangePreview {
    super::super::preview(s, change, &Facts { policy_check: check, ..Facts::default() })
}

fn edit() -> IamChange {
    update_managed(UNUSED_POLICY, allow(&["sqs:SendMessage"]))
}

#[test]
fn only_a_full_policy_deletes_a_version_first() {
    assert!(deletes_policy_version(&full(snapshot()), &edit()));
    assert!(!deletes_policy_version(&snapshot(), &edit()));
    assert!(!deletes_policy_version(&full(snapshot()), &attach(BOB, UNUSED_POLICY)));
}

#[test]
fn a_document_that_passed_the_check_needs_no_extra_confirmation() {
    let p = checked(&full(snapshot()), &edit(), PolicyCheck::Passed);
    assert!(!has_level(&p, WarnLevel::Confirm), "{:?}", p.warnings);
    assert!(only(&p, WarnLevel::Warn).contains("v1"), "버전을 지운다는 주의는 그대로예요");
}

#[test]
fn a_document_that_could_not_be_checked_is_confirmed_by_the_policy_name() {
    for check in [PolicyCheck::Unavailable, PolicyCheck::NotRun] {
        let p = checked(&full(snapshot()), &edit(), check.clone());
        assert_eq!(only(&p, WarnLevel::Confirm), UNCHECKED, "{check:?}");
        assert_eq!(p.confirm_text.as_deref(), Some("unused-policy"));
    }
}

#[test]
fn a_document_with_errors_is_blocked_with_the_analyzers_reasons() {
    let errors = PolicyCheck::Errors(vec!["작업 이름이 올바르지 않아요".into(), "ARN 형식이 올바르지 않아요".into()]);
    let p = checked(&full(snapshot()), &edit(), errors);
    assert_eq!(only(&p, WarnLevel::Block), "정책 문서에 오류가 있어 적용할 수 없어요: 작업 이름이 올바르지 않아요 / ARN 형식이 올바르지 않아요");
    assert!(!has_level(&p, WarnLevel::Confirm), "막힌 변경은 확인을 묻지 않아요");
    assert!(!p.reversible);
}

#[test]
fn the_check_matters_only_when_a_version_is_deleted() {
    for check in [PolicyCheck::Unavailable, PolicyCheck::Errors(vec!["오류".into()])] {
        let p = checked(&snapshot(), &edit(), check);
        assert_clean(&p);
    }
}

#[test]
fn a_broken_document_is_not_blamed_twice() {
    let broken = update_managed(UNUSED_POLICY, "{ not json".into());
    let p = checked(&full(snapshot()), &broken, PolicyCheck::Errors(vec!["JSON 형식이 올바르지 않아요".into()]));
    let blocks = messages(&p, WarnLevel::Block);
    assert_eq!(blocks.len(), 1, "{blocks:?}");
    assert!(!blocks[0].contains("정책 문서에 오류가 있어"), "{}", blocks[0]);
}
