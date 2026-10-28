//! 적용 관문 테스트: 거부할 때는 쓰기를 부르지 않고 기록도 남기지 않는다. 적용하면 성공이든 실패든 기록에 남는다.

use std::future::{ready, Ready};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use super::plan::DRIFTED;
use super::*;
use crate::iam::change::{apply_to_snapshot, preview};
use crate::iam::clock::{iso, parse_iso};
use crate::iam::fixtures::*;
use crate::iam::log::{append, read_all};
use crate::iam::model::VersionRec;

const NOW: i64 = 1_792_000_000;

fn attach(target: &str, policy: &str) -> IamChange {
    IamChange::AttachPolicy { target: target.into(), policy_arn: policy.into() }
}

fn detach(target: &str, policy: &str) -> IamChange {
    IamChange::DetachPolicy { target: target.into(), policy_arn: policy.into() }
}

/// 사용자가 이 요청의 스냅숏·재료로 미리보기를 봤다고 친다(본 계획을 다시 계산해 넣는다). 요청을 고친 뒤에도 부른다.
fn previewed(mut req: Request) -> Request {
    req.seen = Some(Plan::of(&req.snapshot.account_id, &preview(&req.snapshot, &req.change, &req.facts)));
    req
}

/// 미리보기를 본 뒤의 적용 요청.
fn request(dir: &Path, change: IamChange) -> Request {
    previewed(Request {
        profile: "prod".into(),
        snapshot: Arc::new(snapshot()),
        facts: Facts::default(),
        change,
        confirm_text: None,
        undo_of: None,
        seen: None,
        log_path: dir.join("iam-changes.jsonl"),
        now: NOW,
        log_id: "log-1".into(),
    })
}

fn with_key_status(req: Request, status: &str) -> Request {
    previewed(Request { facts: Facts::with_key_status(Some(status)), ..req })
}

/// 몇 번 불렸는지 세고, 받은 호출 목록을 모두 성공시키는 가짜 쓰기.
fn succeeding(count: &Arc<AtomicUsize>) -> impl FnOnce(Vec<ApiCall>) -> Ready<Applied> {
    let count = count.clone();
    move |plan| {
        count.fetch_add(1, Ordering::SeqCst);
        ready(Applied { done: plan, result: Ok(()) })
    }
}

/// 앞의 `done`개 호출만 성공하고 그다음 호출이 `error`로 실패하는 가짜 쓰기.
fn failing_after(count: &Arc<AtomicUsize>, done: usize, error: AppError) -> impl FnOnce(Vec<ApiCall>) -> Ready<Applied> {
    let count = count.clone();
    move |plan| {
        count.fetch_add(1, Ordering::SeqCst);
        ready(Applied { done: plan.into_iter().take(done).collect(), result: Err(error) })
    }
}

fn refusal(committed: &Committed) -> String {
    match &committed.result {
        Err(AppError::Other { message }) => message.clone(),
        other => panic!("거부돼야 해요: {other:?}"),
    }
}

/// 버전이 `ids`이고 `default`가 기본인 고객 관리형 정책(unused-policy)이 있는 스냅숏.
fn with_versions(ids: &[&str], default: &str) -> Snapshot {
    let mut s = snapshot();
    s.policies.get_mut(UNUSED_POLICY).unwrap().versions = ids.iter().map(|id| VersionRec { id: id.to_string(), is_default: *id == default, created_at: None }).collect();
    s
}

fn edit_unused() -> IamChange {
    IamChange::UpdateManagedPolicy { policy_arn: UNUSED_POLICY.into(), document: policy(serde_json::json!([{ "Effect": "Allow", "Action": "sqs:SendMessage", "Resource": "*" }])).to_string() }
}

/// 버전이 가득 찬 정책을 고치는 요청. 문서 검사는 통과했다.
fn full_policy_edit(dir: &Path) -> Request {
    let req = request(dir, edit_unused());
    previewed(Request { snapshot: Arc::new(with_versions(&["v1", "v2", "v3", "v4", "v5"], "v5")), facts: Facts { policy_check: PolicyCheck::Passed, ..Facts::default() }, ..req })
}

// ── 낡은 스냅숏과 기록 id ───────────────────────────────────────────────

#[test]
fn a_snapshot_older_than_a_minute_is_stale() {
    let read = parse_iso("2026-10-26T00:00:00Z").unwrap();
    assert!(!is_stale("2026-10-26T00:00:00Z", read));
    assert!(!is_stale("2026-10-26T00:00:00Z", read + FRESH_SECS));
    assert!(is_stale("2026-10-26T00:00:00Z", read + FRESH_SECS + 1));
    // 시계가 어긋나 미래로 찍혀도 낡은 것은 아니다
    assert!(!is_stale("2026-10-26T00:00:00Z", read - 30));
    // 시각을 읽지 못하면 믿지 않는다
    assert!(is_stale("", read));
    assert!(is_stale("yesterday", read));
}

#[test]
fn log_ids_are_unique_even_within_the_same_millisecond() {
    let ids: std::collections::HashSet<String> = (0..1_000).map(|_| new_log_id(1_792_000_000_123)).collect();
    assert_eq!(ids.len(), 1_000);
    assert!(ids.iter().all(|id| id.starts_with(&format!("{:x}-", 1_792_000_000_123u128)) && id.is_ascii() && !id.contains(char::is_whitespace)));
}

// ── 관문 ────────────────────────────────────────────────────────────────

fn preview_of(change: IamChange) -> ChangePreview {
    preview(&snapshot(), &change, &Facts::default())
}

#[test]
fn a_block_warning_refuses_whatever_is_typed() {
    let p = preview_of(attach(SLR, S3_FULL));
    assert!(p.warnings.iter().any(|w| w.level == crate::iam::change::WarnLevel::Block));
    for typed in [None, Some(""), Some("anything")] {
        let AppError::Other { message } = gate(&p, typed).unwrap_err() else { panic!("Other여야 해요") };
        assert!(message.contains("막혀") && message.contains("서비스 연결 역할"), "{message}");
    }
}

#[test]
fn a_confirmation_must_match_the_name_exactly() {
    let p = preview_of(detach(ADMINS, ADMIN_POLICY));
    assert_eq!(p.confirm_text.as_deref(), Some("admins"));
    for wrong in [None, Some(""), Some("Admins"), Some("admins "), Some(" admins"), Some("admin"), Some("alice")] {
        let AppError::Other { message } = gate(&p, wrong).unwrap_err() else { panic!("Other여야 해요") };
        assert!(message.contains("확인 문구") && message.contains("admins"), "{wrong:?}: {message}");
    }
    assert_eq!(gate(&p, Some("admins")), Ok(()));
}

#[test]
fn nothing_is_asked_when_nothing_needs_confirming() {
    let p = preview_of(attach(BOB, S3_FULL));
    for typed in [None, Some(""), Some("whatever")] {
        assert_eq!(gate(&p, typed), Ok(()));
    }
}

#[test]
fn a_confirm_warning_without_a_name_to_type_cannot_be_applied() {
    let mut p = preview_of(detach(ADMINS, ADMIN_POLICY));
    p.confirm_text = None;
    assert!(gate(&p, Some("admins")).is_err());
    assert!(gate(&p, None).is_err());
}

// ── 되돌리기 점검 ───────────────────────────────────────────────────────

fn recorded(id: &str, change: IamChange, inverse: Option<IamChange>) -> ChangeLogEntry {
    ChangeLogEntry {
        id: id.into(),
        at: iso(NOW),
        profile: "prod".into(),
        account_id: ACCOUNT.into(),
        caller_arn: ALICE.into(),
        change,
        summary: "요약".into(),
        calls: vec![],
        ok: true,
        error: None,
        inverse,
        undo_of: None,
        undone: false,
        batch_id: None,
    }
}

#[test]
fn the_undo_of_a_record_is_its_stored_inverse() {
    let entries = vec![recorded("a", attach(BOB, S3_FULL), Some(detach(BOB, S3_FULL))), recorded("b", attach(BOB, S3_FULL), None)];
    assert_eq!(undo_change_of(&entries, "a"), Ok(detach(BOB, S3_FULL)));
    assert_eq!(undo_change_of(&entries, "b"), Err(AppError::other("되돌릴 수 없는 변경이에요")));
    assert_eq!(undo_change_of(&entries, "zzz"), Err(AppError::other("변경 기록을 찾을 수 없어요")));
    let mut done = recorded("c", attach(BOB, S3_FULL), Some(detach(BOB, S3_FULL)));
    done.undone = true;
    assert_eq!(undo_change_of(&[done], "c"), Err(AppError::other("이미 되돌린 변경이에요")));
}

#[test]
fn a_failed_change_cannot_be_undone() {
    let mut failed = recorded("f", attach(BOB, S3_FULL), None);
    failed.ok = false;
    failed.error = Some("권한 없음".into());
    assert_eq!(undo_change_of(&[failed], "f"), Err(AppError::other("되돌릴 수 없는 변경이에요")));
}

#[test]
fn an_undo_request_must_carry_exactly_the_recorded_inverse_in_the_same_account() {
    let entries = vec![recorded("a", attach(BOB, S3_FULL), Some(detach(BOB, S3_FULL)))];
    assert_eq!(check_undo(&entries, "a", &detach(BOB, S3_FULL), ACCOUNT), Ok(()));
    // 다른 변경을 되돌리기로 위장해서 기록만 지우려는 요청
    let other_change = check_undo(&entries, "a", &detach(CAROL, S3_FULL), ACCOUNT).unwrap_err();
    assert!(other_change.to_string().contains("기록과 달라요"), "{other_change}");
    let other_account = check_undo(&entries, "a", &detach(BOB, S3_FULL), "999999999999").unwrap_err();
    assert!(other_account.to_string().contains("111111111111"), "{other_account}");
    assert!(check_undo(&entries, "nope", &detach(BOB, S3_FULL), ACCOUNT).is_err());
}

#[test]
fn an_undone_record_cannot_be_undone_again() {
    let mut done = recorded("a", attach(BOB, S3_FULL), Some(detach(BOB, S3_FULL)));
    done.undone = true;
    assert_eq!(check_undo(&[done], "a", &detach(BOB, S3_FULL), ACCOUNT), Err(AppError::other("이미 되돌린 변경이에요")));
}

// ── 미리보기에서 본 계획 ─────────────────────────────────────────────────

#[tokio::test]
async fn a_change_applied_as_it_was_previewed_writes_exactly_the_previewed_calls() {
    let dir = tempfile::tempdir().unwrap();
    let req = request(dir.path(), attach(BOB, S3_FULL));
    let expected = req.seen.clone().unwrap().calls;
    let received = Arc::new(Mutex::new(Vec::new()));
    let sink = received.clone();
    let committed = commit(req, move |plan| {
        sink.lock().unwrap().extend(plan.clone());
        ready(Applied { done: plan, result: Ok(()) })
    })
    .await;
    assert!(committed.result.is_ok() && committed.wrote);
    assert_eq!(*received.lock().unwrap(), expected);
}

#[tokio::test]
async fn a_fifth_version_that_appeared_after_the_preview_is_refused_without_writing() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    // 미리보기 때는 버전이 4개였다(새 버전 만들기만 보였다)
    let seen = request(dir.path(), edit_unused());
    let seen = previewed(Request { snapshot: Arc::new(with_versions(&["v1", "v2", "v3", "v4"], "v4")), ..seen });
    assert_eq!(seen.seen.as_ref().unwrap().calls.len(), 1);
    // 적용할 때는 5개라 가장 오래된 버전을 먼저 지워야 한다
    let req = Request { snapshot: Arc::new(with_versions(&["v1", "v2", "v3", "v4", "v5"], "v5")), facts: Facts { policy_check: PolicyCheck::Passed, ..Facts::default() }, ..seen };
    let log = req.log_path.clone();
    let committed = commit(req, succeeding(&calls)).await;
    assert_eq!(refusal(&committed), DRIFTED);
    assert!(!committed.wrote);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(!log.exists(), "거부한 요청은 기록에 남기지 않아요");
}

#[tokio::test]
async fn applying_without_a_preview_is_refused_without_writing() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let req = Request { seen: None, ..request(dir.path(), attach(BOB, S3_FULL)) };
    let committed = commit(req, succeeding(&calls)).await;
    assert_eq!(refusal(&committed), DRIFTED);
    assert!(!committed.wrote);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_preview_from_another_account_is_refused_without_writing() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    // 이름으로 가리키는 변경이라 호출은 같지만, 프로필이 그 사이 다른 계정을 가리키게 됐다
    let change = IamChange::AddToGroup { user_name: "bob".into(), group_name: "admins".into() };
    let mut req = request(dir.path(), change);
    let mut elsewhere = snapshot();
    elsewhere.account_id = "222222222222".into();
    req.snapshot = Arc::new(elsewhere);
    req.confirm_text = Some("bob".into());
    let committed = commit(req, succeeding(&calls)).await;
    assert_eq!(refusal(&committed), DRIFTED);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_change_whose_state_changed_after_the_preview_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    // 미리보기 때는 bob에 S3 정책이 붙어 있었는데 그 사이 누군가 뗐다
    let attached = Arc::new(apply_to_snapshot(&snapshot(), &attach(BOB, S3_FULL)).unwrap());
    let seen = previewed(Request { snapshot: attached, ..request(dir.path(), detach(BOB, S3_FULL)) });
    let req = Request { snapshot: Arc::new(snapshot()), ..seen };
    let committed = commit(req, succeeding(&calls)).await;
    assert_eq!(refusal(&committed), DRIFTED);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

// ── 적용 ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_blocked_change_is_refused_without_writing_or_logging() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let req = request(dir.path(), attach(SLR, S3_FULL));
    let log = req.log_path.clone();
    let committed = commit(req, succeeding(&calls)).await;
    assert!(refusal(&committed).contains("서비스 연결 역할"));
    assert!(!committed.wrote);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(!log.exists(), "거부한 요청은 기록에 남기지 않아요");
}

#[tokio::test]
async fn a_confirmation_that_does_not_match_is_refused_without_writing() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    for typed in [None, Some("Admins".to_string()), Some("alice".to_string())] {
        let mut req = request(dir.path(), detach(ADMINS, ADMIN_POLICY));
        req.confirm_text = typed;
        let committed = commit(req, succeeding(&calls)).await;
        assert!(refusal(&committed).contains("확인 문구"));
        assert!(!committed.wrote);
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(read_all(&dir.path().join("iam-changes.jsonl")).is_empty());

    let mut req = request(dir.path(), detach(ADMINS, ADMIN_POLICY));
    req.confirm_text = Some("admins".into());
    let committed = commit(req, succeeding(&calls)).await;
    assert!(committed.result.is_ok() && committed.wrote);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn removing_the_caller_from_a_group_whose_admin_policy_could_not_be_read_needs_the_name_before_writing() {
    // 리뷰 I1 P7: 읽은 정책만 보면 아무 권한도 달라지지 않지만, 적용하면 이 앱이 관리자 권한을 잃을 수 있다
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut s = snapshot();
    s.policies.remove(ADMIN_POLICY);
    let change = IamChange::RemoveFromGroup { user_name: "alice".into(), group_name: "admins".into() };
    let req = previewed(Request { snapshot: Arc::new(s.clone()), ..request(dir.path(), change.clone()) });
    assert_eq!(req.seen.as_ref().unwrap().confirm_text.as_deref(), Some("alice"));
    let committed = commit(req, succeeding(&calls)).await;
    assert!(refusal(&committed).contains("확인 문구"));
    assert!(!committed.wrote);
    assert_eq!(calls.load(Ordering::SeqCst), 0);

    let mut req = previewed(Request { snapshot: Arc::new(s), ..request(dir.path(), change) });
    req.confirm_text = Some("alice".into());
    assert!(commit(req, succeeding(&calls)).await.result.is_ok());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_deny_on_the_caller_over_a_policy_that_could_not_be_read_needs_the_name_before_writing() {
    // 재검토 I-1 P8a: alice의 권한은 전부 읽지 못한 AdministratorAccess에서 온다. iam:* Deny를 더하면 이 앱은 IAM을 못 쓰는데 계산에는 안 나온다
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut s = snapshot();
    s.policies.remove(ADMIN_POLICY);
    let lock = policy(serde_json::json!([{ "Effect": "Deny", "Action": "iam:*", "Resource": "*" }])).to_string();
    let change = IamChange::PutInlinePolicy { target: ALICE.into(), name: "lock".into(), document: lock };
    let req = previewed(Request { snapshot: Arc::new(s.clone()), ..request(dir.path(), change.clone()) });
    let seen = req.seen.clone().unwrap();
    assert_eq!(seen.confirm_text.as_deref(), Some("alice"));
    assert!(!seen.reversible);
    let committed = commit(req, succeeding(&calls)).await;
    assert!(refusal(&committed).contains("확인 문구"));
    assert!(!committed.wrote);
    assert_eq!(calls.load(Ordering::SeqCst), 0);

    // 같은 스냅숏으로 다시 계산한 계획은 미리보기에서 본 것과 같다: 이름을 넣으면 적용된다
    let mut req = previewed(Request { snapshot: Arc::new(s), ..request(dir.path(), change) });
    req.confirm_text = Some("alice".into());
    assert!(commit(req, succeeding(&calls)).await.result.is_ok());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_change_that_cannot_hold_in_the_current_state_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    // 붙어 있지 않은 정책을 떼려는 요청: 미리보기에서도 막혀 있었다
    let committed = commit(request(dir.path(), detach(BOB, S3_FULL)), succeeding(&calls)).await;
    assert!(refusal(&committed).contains("붙어 있지 않은"));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_successful_change_is_logged_with_its_inverse_and_calls() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let req = request(dir.path(), attach(BOB, S3_FULL));
    let log = req.log_path.clone();
    let expected_summary = preview_of(attach(BOB, S3_FULL)).summary;
    let committed = commit(req, succeeding(&calls)).await;

    assert!(committed.wrote);
    assert_eq!(committed.result, Ok(ApplyResult { log_id: "log-1".into(), summary: expected_summary.clone(), notes: vec![] }));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let entries = read_all(&log);
    assert_eq!(
        entries,
        vec![ChangeLogEntry {
            id: "log-1".into(),
            at: iso(NOW),
            profile: "prod".into(),
            account_id: ACCOUNT.into(),
            caller_arn: ALICE.into(),
            change: attach(BOB, S3_FULL),
            summary: expected_summary,
            calls: vec!["iam:AttachUserPolicy".into()],
            ok: true,
            error: None,
            inverse: Some(detach(BOB, S3_FULL)),
            undo_of: None,
            undone: false,
            batch_id: None,
        }]
    );
}

#[tokio::test]
async fn a_failed_change_is_logged_as_failed_and_the_error_is_returned() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let req = request(dir.path(), attach(BOB, S3_FULL));
    let log = req.log_path.clone();
    let denied = AppError::AccessDenied { action: "iam:AttachUserPolicy".into() };
    let committed = commit(req, failing_after(&calls, 0, denied.clone())).await;

    assert_eq!(committed.result, Err(denied));
    assert!(committed.wrote, "일부가 적용됐을 수 있어 스냅숏을 버려야 해요");
    let entries = read_all(&log);
    assert_eq!(entries.len(), 1);
    let entry = &entries[0];
    assert!(!entry.ok);
    assert_eq!(entry.error.as_deref(), Some("권한 없음 (iam:AttachUserPolicy)"));
    assert_eq!(entry.inverse, None, "적용되지 않은 변경은 되돌릴 것이 없어요");
    assert!(entry.calls.is_empty(), "성공한 호출이 없어요: {:?}", entry.calls);
    assert!(!entry.undone);
}

#[tokio::test]
async fn a_policy_document_with_errors_is_refused_before_any_version_is_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let errors = vec!["Action 이름이 올바르지 않아요".to_string(), "Resource ARN이 올바르지 않아요".to_string()];
    let req = full_policy_edit(dir.path());
    let req = previewed(Request { facts: Facts { policy_check: PolicyCheck::Errors(errors), ..req.facts.clone() }, ..req });
    let log = req.log_path.clone();
    let committed = commit(req, succeeding(&calls)).await;
    assert_eq!(refusal(&committed), "정책 문서에 오류가 있어 적용하지 않았어요: Action 이름이 올바르지 않아요 / Resource ARN이 올바르지 않아요");
    assert!(!committed.wrote);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(!log.exists());
}

#[tokio::test]
async fn a_failure_after_a_version_was_deleted_logs_what_was_done_and_names_the_version() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let req = full_policy_edit(dir.path());
    let log = req.log_path.clone();
    let malformed = AppError::other("MalformedPolicyDocument: 문서가 올바르지 않아요");
    let committed = commit(req, failing_after(&calls, 1, malformed)).await;

    let message = refusal(&committed);
    assert!(message.contains("MalformedPolicyDocument") && message.contains("이미 삭제한 버전: v1"), "{message}");
    assert!(committed.wrote);
    let entries = read_all(&log);
    assert_eq!(entries[0].calls, vec!["iam:DeletePolicyVersion".to_string()], "기록에는 실제로 성공한 호출만 남아요");
    assert!(entries[0].error.as_deref().is_some_and(|e| e.contains("이미 삭제한 버전: v1")), "{:?}", entries[0].error);
    assert!(!entries[0].ok && entries[0].inverse.is_none());
}

#[tokio::test]
async fn a_success_that_deleted_a_version_says_which_one() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut req = full_policy_edit(dir.path());
    req.confirm_text = req.seen.as_ref().unwrap().confirm_text.clone();
    let log = req.log_path.clone();
    let result = commit(req, succeeding(&calls)).await.result.unwrap();
    assert!(result.summary.ends_with("(삭제한 버전: v1)"), "{}", result.summary);
    let entries = read_all(&log);
    assert_eq!(entries[0].calls, vec!["iam:DeletePolicyVersion".to_string(), "iam:CreatePolicyVersion".to_string()]);
    assert_eq!(entries[0].summary, result.summary);
}

#[tokio::test]
async fn when_both_the_write_and_the_log_fail_both_are_reported() {
    let dir = tempfile::tempdir().unwrap();
    let blocker = dir.path().join("file");
    std::fs::write(&blocker, "x").unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut req = request(dir.path(), attach(BOB, S3_FULL));
    req.log_path = blocker.join("iam-changes.jsonl");
    let committed = commit(req, failing_after(&calls, 0, AppError::Throttled)).await;
    let message = refusal(&committed);
    assert!(message.contains("요청이 너무 많아요") && message.contains("변경 기록을 저장하지 못했어요"), "{message}");
}

#[tokio::test]
async fn an_undo_marks_the_original_undone_and_is_logged_as_an_undo() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let first = request(dir.path(), attach(BOB, S3_FULL));
    let log = first.log_path.clone();
    commit(first, succeeding(&calls)).await.result.unwrap();

    // 되돌리기는 변경이 적용된 뒤의 상태를 기준으로 미리보기를 다시 계산한다
    let mut undo = request(dir.path(), detach(BOB, S3_FULL));
    undo.snapshot = Arc::new(apply_to_snapshot(&snapshot(), &attach(BOB, S3_FULL)).unwrap());
    undo.undo_of = Some("log-1".into());
    undo.log_id = "log-2".into();
    let committed = commit(previewed(undo), succeeding(&calls)).await;
    assert!(committed.result.is_ok() && committed.wrote);

    let entries = read_all(&log);
    assert_eq!(entries.len(), 2);
    assert!(entries[0].undone && entries[0].undo_of.is_none());
    assert_eq!(entries[1].undo_of.as_deref(), Some("log-1"));
    assert!(!entries[1].undone);
    assert_eq!(entries[1].inverse, Some(attach(BOB, S3_FULL)), "되돌린 기록도 다시 되돌릴 수 있어요");
    assert_eq!(undo_change_of(&entries, "log-1"), Err(AppError::other("이미 되돌린 변경이에요")));
}

#[tokio::test]
async fn a_failed_undo_leaves_the_original_available() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let first = request(dir.path(), attach(BOB, S3_FULL));
    let log = first.log_path.clone();
    commit(first, succeeding(&calls)).await.result.unwrap();

    let mut undo = request(dir.path(), detach(BOB, S3_FULL));
    undo.snapshot = Arc::new(apply_to_snapshot(&snapshot(), &attach(BOB, S3_FULL)).unwrap());
    undo.undo_of = Some("log-1".into());
    undo.log_id = "log-2".into();
    let committed = commit(previewed(undo), failing_after(&calls, 0, AppError::Throttled)).await;
    assert_eq!(committed.result, Err(AppError::Throttled));
    let entries = read_all(&log);
    assert!(!entries[0].undone);
    assert!(!entries[1].ok && entries[1].undo_of.as_deref() == Some("log-1"));
}

#[tokio::test]
async fn an_undo_that_does_not_match_the_record_is_refused_before_anything_happens() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let log = dir.path().join("iam-changes.jsonl");
    append(&log, &recorded("a", attach(BOB, S3_FULL), Some(detach(BOB, S3_FULL)))).unwrap();
    let mut elsewhere = recorded("b", attach(BOB, S3_FULL), Some(detach(BOB, S3_FULL)));
    elsewhere.account_id = "999999999999".into();
    append(&log, &elsewhere).unwrap();
    let mut done = recorded("c", attach(BOB, S3_FULL), Some(detach(BOB, S3_FULL)));
    done.undone = true;
    append(&log, &done).unwrap();
    append(&log, &recorded("d", delete_key_change(), None)).unwrap();
    let before = std::fs::read_to_string(&log).unwrap();

    let state_with_bob_attached = Arc::new(apply_to_snapshot(&snapshot(), &attach(BOB, S3_FULL)).unwrap());
    let cases = [
        ("zzz", detach(BOB, S3_FULL), "찾을 수 없어요"),
        ("a", detach(CAROL, S3_FULL), "기록과 달라요"),
        ("b", detach(BOB, S3_FULL), "999999999999"),
        ("c", detach(BOB, S3_FULL), "이미 되돌린"),
        ("d", detach(BOB, S3_FULL), "되돌릴 수 없는"),
    ];
    for (id, change, expected) in cases {
        let mut req = request(dir.path(), change);
        req.snapshot = state_with_bob_attached.clone();
        req.undo_of = Some(id.into());
        let committed = commit(previewed(req), succeeding(&calls)).await;
        assert!(refusal(&committed).contains(expected), "{id}: {:?}", committed.result);
        assert!(!committed.wrote);
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(std::fs::read_to_string(&log).unwrap(), before);
}

fn delete_key_change() -> IamChange {
    IamChange::DeleteAccessKey { user_name: "bob".into(), access_key_id: "AKIA1".into() }
}

#[tokio::test]
async fn a_log_that_cannot_be_written_does_not_hide_a_change_that_was_applied() {
    let dir = tempfile::tempdir().unwrap();
    let blocker = dir.path().join("file");
    std::fs::write(&blocker, "x").unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut req = request(dir.path(), attach(BOB, S3_FULL));
    req.log_path = blocker.join("iam-changes.jsonl");
    let committed = commit(req, succeeding(&calls)).await;
    let result = committed.result.expect("적용은 성공했어요");
    // 요약은 바꾼 일 그대로이고, 하지 못한 일은 닫을 때까지 남는 안내(notes)로 따로 알린다
    assert_eq!(result.summary, preview_of(attach(BOB, S3_FULL)).summary);
    assert_eq!(result.notes.len(), 1, "{:?}", result.notes);
    assert!(result.notes[0].starts_with("변경 기록을 저장하지 못했어요: "), "{:?}", result.notes);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(committed.wrote);
}

#[tokio::test]
async fn an_undo_whose_original_record_could_not_be_marked_says_so_in_a_note() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let first = request(dir.path(), attach(BOB, S3_FULL));
    let log = first.log_path.clone();
    commit(first, succeeding(&calls)).await.result.unwrap();
    // 기록을 바꿔치기할 임시 파일 자리에 폴더가 있어서 "되돌림" 표시를 하지 못한다
    let mut temp = log.as_os_str().to_owned();
    temp.push(".tmp");
    std::fs::create_dir(&temp).unwrap();

    let mut undo = request(dir.path(), detach(BOB, S3_FULL));
    undo.snapshot = Arc::new(apply_to_snapshot(&snapshot(), &attach(BOB, S3_FULL)).unwrap());
    undo.undo_of = Some("log-1".into());
    undo.log_id = "log-2".into();
    let result = commit(previewed(undo), succeeding(&calls)).await.result.expect("되돌리기는 적용됐어요");
    assert_eq!(result.notes.len(), 1, "{:?}", result.notes);
    assert!(result.notes[0].starts_with("이전 기록에 '되돌림' 표시를 하지 못했어요: "), "{:?}", result.notes);
    assert!(!result.summary.contains("되돌림"), "{}", result.summary);
    let entries = read_all(&log);
    assert_eq!(entries.len(), 2, "되돌리기 기록은 남았어요");
    assert!(!entries[0].undone);
}

#[tokio::test]
async fn key_changes_log_the_status_the_key_had() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let change = IamChange::SetAccessKeyStatus { user_name: "bob".into(), access_key_id: "AKIA1".into(), status: "Inactive".into() };
    let req = with_key_status(request(dir.path(), change), "Active");
    let log = req.log_path.clone();
    commit(req, succeeding(&calls)).await.result.unwrap();
    let entries = read_all(&log);
    assert_eq!(entries[0].inverse, Some(IamChange::SetAccessKeyStatus { user_name: "bob".into(), access_key_id: "AKIA1".into(), status: "Active".into() }));
    assert_eq!(entries[0].calls, vec!["iam:UpdateAccessKey".to_string()]);
}

#[tokio::test]
async fn turning_off_the_apps_own_key_needs_its_id_and_leaves_nothing_to_undo() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let change = IamChange::SetAccessKeyStatus { user_name: "bob".into(), access_key_id: "AKIA1".into(), status: "Inactive".into() };
    let own = |req: Request| previewed(Request { facts: Facts { key_status: Some("Active".into()), own_key_id: Some("AKIA1".into()), ..Facts::default() }, ..req });

    let refused = commit(own(request(dir.path(), change.clone())), succeeding(&calls)).await;
    assert!(refusal(&refused).contains("확인 문구"));

    let mut req = own(request(dir.path(), change));
    req.confirm_text = Some("AKIA1".into());
    let log = req.log_path.clone();
    commit(req, succeeding(&calls)).await.result.unwrap();
    assert_eq!(read_all(&log)[0].inverse, None, "이 앱의 키를 끄면 이 앱으로는 되돌릴 수 없어요");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn deleting_a_key_needs_its_id_and_leaves_nothing_to_undo() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let req = with_key_status(request(dir.path(), delete_key_change()), "Active");
    let refused = commit(req, succeeding(&calls)).await;
    assert!(refusal(&refused).contains("확인 문구"));

    let mut req = with_key_status(request(dir.path(), delete_key_change()), "Active");
    req.confirm_text = Some("AKIA1".into());
    let log = req.log_path.clone();
    commit(req, succeeding(&calls)).await.result.unwrap();
    assert_eq!(read_all(&log)[0].inverse, None);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn the_apply_result_has_the_contract_fields() {
    let value = serde_json::to_value(ApplyResult { log_id: "x".into(), summary: "요약".into(), notes: vec![] }).unwrap();
    assert_eq!(value, serde_json::json!({ "logId": "x", "summary": "요약" }));
    // 하지 못한 일이 있을 때만 notes를 보낸다
    let value = serde_json::to_value(ApplyResult { log_id: "x".into(), summary: "요약".into(), notes: vec!["변경 기록을 저장하지 못했어요: 디스크가 가득 찼어요".into()] }).unwrap();
    assert_eq!(value, serde_json::json!({ "logId": "x", "summary": "요약", "notes": ["변경 기록을 저장하지 못했어요: 디스크가 가득 찼어요"] }));
}
