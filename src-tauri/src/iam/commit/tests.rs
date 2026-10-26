//! 적용 관문 테스트: 거부할 때는 쓰기를 부르지 않고 기록도 남기지 않는다. 적용하면 성공이든 실패든 기록에 남는다.

use std::future::{ready, Ready};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use super::*;
use crate::iam::change::{apply_to_snapshot, preview};
use crate::iam::clock::{iso, parse_iso};
use crate::iam::fixtures::*;
use crate::iam::log::{append, read_all};

const NOW: i64 = 1_792_000_000;

fn attach(target: &str, policy: &str) -> IamChange {
    IamChange::AttachPolicy { target: target.into(), policy_arn: policy.into() }
}

fn detach(target: &str, policy: &str) -> IamChange {
    IamChange::DetachPolicy { target: target.into(), policy_arn: policy.into() }
}

fn request(dir: &Path, change: IamChange) -> Request {
    Request {
        profile: "prod".into(),
        snapshot: Arc::new(snapshot()),
        key_status: None,
        change,
        confirm_text: None,
        undo_of: None,
        log_path: dir.join("iam-changes.jsonl"),
        now: NOW,
        log_id: "log-1".into(),
    }
}

fn calls_of(names: &[&str]) -> Result<Vec<String>, AppError> {
    Ok(names.iter().map(|n| n.to_string()).collect())
}

/// 몇 번 불렸는지 세고 정해 둔 결과를 돌려주는 가짜 쓰기.
fn counting(calls: &Arc<AtomicUsize>, result: Result<Vec<String>, AppError>) -> impl FnOnce() -> Ready<Result<Vec<String>, AppError>> {
    let calls = calls.clone();
    move || {
        calls.fetch_add(1, Ordering::SeqCst);
        ready(result)
    }
}

fn refusal(committed: &Committed) -> String {
    match &committed.result {
        Err(AppError::Other { message }) => message.clone(),
        other => panic!("거부돼야 해요: {other:?}"),
    }
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
    preview(&snapshot(), &change, None)
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

// ── 적용 ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_blocked_change_is_refused_without_writing_or_logging() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let req = request(dir.path(), attach(SLR, S3_FULL));
    let log = req.log_path.clone();
    let committed = commit(req, counting(&calls, calls_of(&["iam:AttachRolePolicy"]))).await;
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
        let committed = commit(req, counting(&calls, calls_of(&["iam:DetachGroupPolicy"]))).await;
        assert!(refusal(&committed).contains("확인 문구"));
        assert!(!committed.wrote);
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(read_all(&dir.path().join("iam-changes.jsonl")).is_empty());

    let mut req = request(dir.path(), detach(ADMINS, ADMIN_POLICY));
    req.confirm_text = Some("admins".into());
    let committed = commit(req, counting(&calls, calls_of(&["iam:DetachGroupPolicy"]))).await;
    assert!(committed.result.is_ok() && committed.wrote);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_change_that_cannot_hold_in_the_fresh_state_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    // 붙어 있지 않은 정책을 떼려는 요청: 미리보기를 보고 난 뒤에 상태가 바뀐 경우와 같다
    let committed = commit(request(dir.path(), detach(BOB, S3_FULL)), counting(&calls, calls_of(&[]))).await;
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
    let committed = commit(req, counting(&calls, calls_of(&["iam:AttachUserPolicy"]))).await;

    assert!(committed.wrote);
    assert_eq!(committed.result, Ok(ApplyResult { log_id: "log-1".into(), summary: expected_summary.clone() }));
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
    let committed = commit(req, counting(&calls, Err(denied.clone()))).await;

    assert_eq!(committed.result, Err(denied));
    assert!(committed.wrote, "일부가 적용됐을 수 있어 스냅숏을 버려야 해요");
    let entries = read_all(&log);
    assert_eq!(entries.len(), 1);
    let entry = &entries[0];
    assert!(!entry.ok);
    assert_eq!(entry.error.as_deref(), Some("권한 없음 (iam:AttachUserPolicy)"));
    assert_eq!(entry.inverse, None, "적용되지 않은 변경은 되돌릴 것이 없어요");
    assert_eq!(entry.calls, vec!["iam:AttachUserPolicy".to_string()]);
    assert!(!entry.undone);
}

#[tokio::test]
async fn an_undo_marks_the_original_undone_and_is_logged_as_an_undo() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let first = request(dir.path(), attach(BOB, S3_FULL));
    let log = first.log_path.clone();
    commit(first, counting(&calls, calls_of(&["iam:AttachUserPolicy"]))).await.result.unwrap();

    // 되돌리기는 변경이 적용된 뒤의 상태를 기준으로 미리보기를 다시 계산한다
    let mut undo = request(dir.path(), detach(BOB, S3_FULL));
    undo.snapshot = Arc::new(apply_to_snapshot(&snapshot(), &attach(BOB, S3_FULL)).unwrap());
    undo.undo_of = Some("log-1".into());
    undo.log_id = "log-2".into();
    let committed = commit(undo, counting(&calls, calls_of(&["iam:DetachUserPolicy"]))).await;
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
    commit(first, counting(&calls, calls_of(&["iam:AttachUserPolicy"]))).await.result.unwrap();

    let mut undo = request(dir.path(), detach(BOB, S3_FULL));
    undo.snapshot = Arc::new(apply_to_snapshot(&snapshot(), &attach(BOB, S3_FULL)).unwrap());
    undo.undo_of = Some("log-1".into());
    undo.log_id = "log-2".into();
    let committed = commit(undo, counting(&calls, Err(AppError::Throttled))).await;
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
        let committed = commit(req, counting(&calls, calls_of(&["iam:DetachUserPolicy"]))).await;
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
    let committed = commit(req, counting(&calls, calls_of(&["iam:AttachUserPolicy"]))).await;
    let result = committed.result.expect("적용은 성공했어요");
    assert!(result.summary.contains("변경 기록을 저장하지 못했어요"), "{}", result.summary);
    assert!(result.summary.starts_with(&preview_of(attach(BOB, S3_FULL)).summary));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(committed.wrote);
}

#[tokio::test]
async fn key_changes_log_the_status_the_key_had() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let change = IamChange::SetAccessKeyStatus { user_name: "bob".into(), access_key_id: "AKIA1".into(), status: "Inactive".into() };
    let mut req = request(dir.path(), change.clone());
    req.key_status = Some("Active".into());
    let log = req.log_path.clone();
    commit(req, counting(&calls, calls_of(&["iam:UpdateAccessKey"]))).await.result.unwrap();
    let entries = read_all(&log);
    assert_eq!(entries[0].inverse, Some(IamChange::SetAccessKeyStatus { user_name: "bob".into(), access_key_id: "AKIA1".into(), status: "Active".into() }));
    assert_eq!(entries[0].calls, vec!["iam:UpdateAccessKey".to_string()]);
}

#[tokio::test]
async fn deleting_a_key_needs_its_id_and_leaves_nothing_to_undo() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut req = request(dir.path(), delete_key_change());
    req.key_status = Some("Active".into());
    let refused = commit(req, counting(&calls, calls_of(&["iam:DeleteAccessKey"]))).await;
    assert!(refusal(&refused).contains("확인 문구"));

    let mut req = request(dir.path(), delete_key_change());
    req.key_status = Some("Active".into());
    req.confirm_text = Some("AKIA1".into());
    let log = req.log_path.clone();
    commit(req, counting(&calls, calls_of(&["iam:DeleteAccessKey"]))).await.result.unwrap();
    assert_eq!(read_all(&log)[0].inverse, None);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn the_apply_result_has_the_contract_fields() {
    let value = serde_json::to_value(ApplyResult { log_id: "x".into(), summary: "요약".into() }).unwrap();
    assert_eq!(value, serde_json::json!({ "logId": "x", "summary": "요약" }));
}
