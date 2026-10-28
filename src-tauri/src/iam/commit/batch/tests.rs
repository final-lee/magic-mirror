//! 묶음 적용 테스트: 거부할 때는 쓰기를 부르지 않고 기록도 남기지 않는다. 적용하면 변경마다 기록에 남고, 실패하면 거기서 멈춘다.
//! 쓰기는 가짜다: 받은 호출 목록을 모으고, 정해진 번째 호출을 실패시킨다.

use std::fs;
use std::future::{ready, Ready};
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::json;

use super::*;
use crate::iam::change::apply_to_snapshot;
use crate::iam::clock::iso;
use crate::iam::commit::plan::DRIFTED;
use crate::iam::fixtures::*;
use crate::iam::log::{append, read_all};
use crate::iam::model::GroupRec;

const NOW: i64 = 1_792_000_000;

fn attach(target: &str, policy: &str) -> IamChange {
    IamChange::AttachPolicy { target: target.into(), policy_arn: policy.into() }
}

fn detach(target: &str, policy: &str) -> IamChange {
    IamChange::DetachPolicy { target: target.into(), policy_arn: policy.into() }
}

/// bob에게 `UNUSED_POLICY`가 붙어 있는 스냅숏(떼기를 시험할 수 있다).
fn bob_has_unused() -> Snapshot {
    let mut s = snapshot();
    s.users.iter_mut().find(|u| u.name == "bob").expect("bob").attached.push(UNUSED_POLICY.into());
    s
}

fn add_to_group(user: &str, group: &str) -> IamChange {
    IamChange::AddToGroup { user_name: user.into(), group_name: group.into() }
}

const OPS: &str = "arn:aws:iam::111111111111:group/ops";
const MID_STOP_ADMIN_BOB: &str = "중간에 멈추면 관리자급 권한을 새로 얻는 주체: bob";

/// 구성원이 없는 그룹 ops에 관리자 정책이 붙어 있는 스냅숏. [bob을 ops에 넣기, ops에서 관리자 정책 떼기]는 끝 상태에서 bob에게 달라지는 게 없지만,
/// 떼기가 실패해 멈추면 bob은 관리자급이 된 채로 남는다.
fn ops_is_admin() -> Snapshot {
    let mut s = snapshot();
    s.groups.push(GroupRec { arn: OPS.into(), name: "ops".into(), path: "/".into(), attached: vec![ADMIN_POLICY.into()], ..Default::default() });
    s
}

/// 사용자가 이 스냅숏·변경으로 미리보기를 봤다고 친다(본 계획을 다시 계산해 넣는다). `changes`는 받은 순서다.
fn request(dir: &Path, s: Snapshot, changes: Vec<IamChange>) -> BatchRequest {
    let facts = vec![Facts::default(); changes.len()];
    let seen = Some(BatchPlan::of(&s.account_id, &preview_batch(&s, &changes, &facts)));
    BatchRequest {
        profile: "prod".into(),
        snapshot: Arc::new(s),
        facts,
        changes,
        confirm_text: None,
        undo_of: None,
        seen,
        log_path: dir.join("iam-changes.jsonl"),
        now: NOW,
        batch_id: "b1".into(),
    }
}

/// 가짜 쓰기가 받은 호출 목록들, 부른 순서대로.
type Written = Arc<Mutex<Vec<Vec<ApiCall>>>>;

fn written_apis(written: &Written) -> Vec<Vec<String>> {
    written.lock().unwrap().iter().map(|calls| calls.iter().map(|call| call.api.clone()).collect()).collect()
}

/// 받은 호출 목록을 모으고, `fail_at`번째(1부터) 호출은 권한 없음으로 실패시키는 가짜 쓰기. 실패한 호출은 성공한 것이 없다.
fn writer(written: &Written, fail_at: Option<usize>) -> impl FnMut(Vec<ApiCall>) -> Ready<Applied> {
    let written = written.clone();
    move |plan| {
        let mut all = written.lock().unwrap();
        all.push(plan.clone());
        if Some(all.len()) == fail_at {
            return ready(Applied { done: Vec::new(), result: Err(AppError::AccessDenied { action: plan[0].api.clone() }) });
        }
        ready(Applied { done: plan, result: Ok(()) })
    }
}

/// `writer`와 같되, `break_on`번째(1부터) 호출이 IAM을 바꾼 직후에 변경 기록을 쓸 수 없게 만든다: 기록 파일 자리에 폴더를 두고,
/// 그 전에 쌓인 기록은 `.bak`으로 옮겨 둔다(읽어서 확인할 수 있게).
fn writer_breaking_the_log(written: &Written, log: &Path, break_on: usize) -> impl FnMut(Vec<ApiCall>) -> Ready<Applied> {
    let (written, log) = (written.clone(), log.to_path_buf());
    move |plan| {
        let mut all = written.lock().unwrap();
        all.push(plan.clone());
        if all.len() == break_on {
            if log.exists() {
                fs::rename(&log, saved_log(&log)).unwrap();
            }
            fs::create_dir(&log).unwrap();
        }
        ready(Applied { done: plan, result: Ok(()) })
    }
}

fn saved_log(log: &Path) -> std::path::PathBuf {
    log.with_extension("jsonl.bak")
}

/// 적용했지만 변경 기록에 남기지 못한 변경을 알리는 알림.
fn unlogged(summary: &str) -> String {
    format!("{summary}: 적용했지만 변경 기록에 남기지 못했어요")
}

fn refusal(committed: &BatchCommitted) -> String {
    match &committed.result {
        Err(AppError::Other { message }) => message.clone(),
        other => panic!("거부돼야 해요: {other:?}"),
    }
}

// ── 적용 ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn applies_every_change_in_order_and_logs_each() {
    let dir = tempfile::tempdir().unwrap();
    let written = Written::default();
    // 받은 순서는 [떼기, 붙이기]이고 적용 순서는 [붙이기, 떼기]다
    let req = request(dir.path(), bob_has_unused(), vec![detach(BOB, UNUSED_POLICY), attach(BOB, S3_FULL)]);
    let (log, planned) = (req.log_path.clone(), req.seen.clone().unwrap());

    let committed = commit_batch(req, writer(&written, None)).await;

    assert!(committed.wrote);
    assert_eq!(committed.result, Ok(BatchResult { batch_id: "b1".into(), log_ids: vec!["b1-1".into(), "b1-2".into()], failed: None, notes: vec![] }));
    // 붙이기 호출이 먼저 가고, 쓰기는 사용자가 본 호출 그대로 받는다
    assert_eq!(written_apis(&written), vec![vec!["iam:AttachUserPolicy"], vec!["iam:DetachUserPolicy"]]);
    assert_eq!(*written.lock().unwrap(), planned.items.iter().map(|item| item.1.clone()).collect::<Vec<_>>());
    let logged = |id: &str, summary: &str, call: &str, change: IamChange, inverse: IamChange| ChangeLogEntry {
        id: id.into(),
        at: iso(NOW),
        profile: "prod".into(),
        account_id: ACCOUNT.into(),
        caller_arn: ALICE.into(),
        change,
        summary: summary.into(),
        calls: vec![call.into()],
        ok: true,
        error: None,
        inverse: Some(inverse),
        undo_of: None,
        undone: false,
        batch_id: Some("b1".into()),
    };
    assert_eq!(
        read_all(&log),
        vec![
            logged("b1-1", &planned.items[0].0, "iam:AttachUserPolicy", attach(BOB, S3_FULL), detach(BOB, S3_FULL)),
            logged("b1-2", &planned.items[1].0, "iam:DetachUserPolicy", detach(BOB, UNUSED_POLICY), attach(BOB, UNUSED_POLICY)),
        ]
    );
}

#[tokio::test]
async fn stops_at_the_first_failure() {
    let dir = tempfile::tempdir().unwrap();
    let written = Written::default();
    let changes = vec![attach(BOB, S3_FULL), attach(BOB, UNUSED_POLICY), attach(CAROL, UNUSED_POLICY)];
    let req = request(dir.path(), snapshot(), changes.clone());
    let (log, planned) = (req.log_path.clone(), req.seen.clone().unwrap());

    let committed = commit_batch(req, writer(&written, Some(2))).await;

    assert!(committed.wrote, "일부가 적용됐으니 스냅숏을 버려야 해요");
    let message = "권한 없음 (iam:AttachUserPolicy)".to_string();
    let failed = BatchFailure { index: 1, summary: planned.items[1].0.clone(), message: message.clone() };
    assert_eq!(committed.result, Ok(BatchResult { batch_id: "b1".into(), log_ids: vec!["b1-1".into()], failed: Some(failed), notes: vec![] }));
    assert_eq!(written.lock().unwrap().len(), 2, "세 번째 변경은 쓰지 않아요");
    let entries = read_all(&log);
    assert_eq!(entries.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), vec!["b1-1", "b1-2"], "b1-3은 기록하지 않아요");
    assert!(entries[0].ok && entries[0].error.is_none() && entries[0].inverse == Some(detach(BOB, S3_FULL)));
    let second = &entries[1];
    assert_eq!((second.ok, second.error.as_deref(), second.batch_id.as_deref()), (false, Some(message.as_str()), Some("b1")));
    assert_eq!(second.change, changes[1]);
    assert_eq!(second.summary, planned.items[1].0);
    assert!(second.calls.is_empty(), "성공한 호출이 없어요: {:?}", second.calls);
    assert_eq!(second.inverse, None, "적용되지 않은 변경은 되돌릴 것이 없어요");
}

#[tokio::test]
async fn a_failure_on_the_first_change_applies_and_logs_only_that_one() {
    let dir = tempfile::tempdir().unwrap();
    let written = Written::default();
    let req = request(dir.path(), snapshot(), vec![attach(BOB, S3_FULL), attach(CAROL, UNUSED_POLICY)]);
    let (log, summary) = (req.log_path.clone(), req.seen.as_ref().unwrap().items[0].0.clone());

    let committed = commit_batch(req, writer(&written, Some(1))).await;

    assert!(committed.wrote);
    let failed = BatchFailure { index: 0, summary, message: "권한 없음 (iam:AttachUserPolicy)".into() };
    assert_eq!(committed.result, Ok(BatchResult { batch_id: "b1".into(), log_ids: vec![], failed: Some(failed), notes: vec![] }));
    assert_eq!(written.lock().unwrap().len(), 1);
    let entries = read_all(&log);
    assert_eq!(entries.iter().map(|e| (e.id.as_str(), e.ok)).collect::<Vec<_>>(), vec![("b1-1", false)]);
}

#[tokio::test]
async fn stops_before_the_next_change_when_the_log_stops_saving() {
    let dir = tempfile::tempdir().unwrap();
    let written = Written::default();
    let req = request(dir.path(), snapshot(), vec![attach(BOB, S3_FULL), attach(BOB, UNUSED_POLICY), attach(CAROL, UNUSED_POLICY)]);
    let (log, planned) = (req.log_path.clone(), req.seen.clone().unwrap());

    // 첫 변경은 IAM에 적용됐지만 그 기록을 파일에 덧붙이지 못한다
    let committed = commit_batch(req, writer_breaking_the_log(&written, &log, 1)).await;

    assert!(committed.wrote);
    let result = committed.result.unwrap();
    assert_eq!(written.lock().unwrap().len(), 1, "기록할 수 없는 쓰기는 더 하지 않아요");
    assert!(result.log_ids.is_empty(), "파일에 없는 기록 id는 알리지 않아요: {:?}", result.log_ids);
    // 멈춘 곳은 적용하지 않은 다음 변경이다
    let stopped = BatchFailure { index: 1, summary: planned.items[1].0.clone(), message: "변경 기록을 저장하지 못해서 멈췄어요".into() };
    assert_eq!(result.failed, Some(stopped));
    // 기록하지 못한 이유 다음에, 기록에 남지 않은 변경(첫 변경)의 요약을 적은 알림이 온다
    assert_eq!(result.notes.len(), 2, "{:?}", result.notes);
    assert!(result.notes[0].starts_with("변경 기록을 저장하지 못했어요"), "{:?}", result.notes);
    assert_eq!(result.notes[1], unlogged(&planned.items[0].0));
    assert!(!saved_log(&log).exists(), "저장된 기록은 없어요");
}

#[tokio::test]
async fn a_log_that_stops_saving_midway_keeps_the_ids_saved_before_it() {
    let dir = tempfile::tempdir().unwrap();
    let written = Written::default();
    let req = request(dir.path(), snapshot(), vec![attach(BOB, S3_FULL), attach(BOB, UNUSED_POLICY), attach(CAROL, UNUSED_POLICY)]);
    let (log, planned) = (req.log_path.clone(), req.seen.clone().unwrap());

    // 둘째 변경을 적용한 직후부터 기록을 저장하지 못한다
    let committed = commit_batch(req, writer_breaking_the_log(&written, &log, 2)).await;

    assert!(committed.wrote);
    let result = committed.result.unwrap();
    assert_eq!(written.lock().unwrap().len(), 2, "셋째 변경은 쓰지 않아요");
    assert_eq!(result.log_ids, vec!["b1-1".to_string()], "둘째 변경의 기록 id는 파일에 없어요");
    let stopped = BatchFailure { index: 2, summary: planned.items[2].0.clone(), message: "변경 기록을 저장하지 못해서 멈췄어요".into() };
    assert_eq!(result.failed, Some(stopped));
    // 기록에 남지 않은 변경은 둘째 변경이다. 앞 변경(b1-1)은 기록에 남았으니 알리지 않는다
    assert_eq!(result.notes.len(), 2, "{:?}", result.notes);
    assert!(result.notes[0].starts_with("변경 기록을 저장하지 못했어요"), "{:?}", result.notes);
    assert_eq!(result.notes[1], unlogged(&planned.items[1].0));
    let saved: Vec<String> = read_all(&saved_log(&log)).into_iter().map(|e| e.id).collect();
    assert_eq!(saved, vec!["b1-1"], "앞 변경의 기록은 파일에 남아요");
}

#[tokio::test]
async fn a_log_that_stops_saving_at_the_last_change_is_only_a_note() {
    let dir = tempfile::tempdir().unwrap();
    let written = Written::default();
    let req = request(dir.path(), snapshot(), vec![attach(BOB, S3_FULL), attach(CAROL, UNUSED_POLICY)]);
    let (log, planned) = (req.log_path.clone(), req.seen.clone().unwrap());

    // 마지막 변경을 적용한 직후부터 기록을 저장하지 못한다: 멈출 다음 변경이 없다
    let committed = commit_batch(req, writer_breaking_the_log(&written, &log, 2)).await;

    assert!(committed.wrote);
    let result = committed.result.unwrap();
    assert_eq!(written.lock().unwrap().len(), 2, "두 변경 모두 적용됐어요");
    assert_eq!(result.log_ids, vec!["b1-1".to_string()], "마지막 변경의 기록 id는 파일에 없어요");
    assert_eq!(result.failed, None);
    // 멈출 변경이 없어도 마지막 변경이 기록에 남지 않았다는 것은 알림으로 남는다
    assert_eq!(result.notes.len(), 2, "{:?}", result.notes);
    assert!(result.notes[0].starts_with("변경 기록을 저장하지 못했어요"), "{:?}", result.notes);
    assert_eq!(result.notes[1], unlogged(&planned.items[1].0));
    let saved: Vec<String> = read_all(&saved_log(&log)).into_iter().map(|e| e.id).collect();
    assert_eq!(saved, vec!["b1-1"]);
}

// ── 거부 ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_risky_mid_stop_state_needs_its_confirm_text_to_apply() {
    let dir = tempfile::tempdir().unwrap();
    let written = Written::default();
    let changes = vec![add_to_group("bob", "ops"), detach(OPS, ADMIN_POLICY)];
    let req = request(dir.path(), ops_is_admin(), changes.clone());
    // 사용자가 본 계획에 멈출 때의 확인과 확인 문구가 들어 있다
    let planned = req.seen.clone().unwrap();
    assert_eq!(planned.checks.iter().map(|w| w.message.as_str()).collect::<Vec<_>>(), vec![MID_STOP_ADMIN_BOB]);
    assert_eq!(planned.confirm_text.as_deref(), Some("변경 2개 적용"));
    let log = req.log_path.clone();

    // 적용할 때 다시 계산해도 같은 확인이 나오니, 문구가 없거나 다르면 거부한다
    for typed in [None, Some("bob"), Some("ops")] {
        let wrong = BatchRequest { confirm_text: typed.map(str::to_string), ..request(dir.path(), ops_is_admin(), changes.clone()) };
        let committed = commit_batch(wrong, writer(&written, None)).await;
        assert_eq!(refusal(&committed), "확인 문구가 달라요. 입력해야 할 이름: 변경 2개 적용", "{typed:?}");
        assert!(!committed.wrote);
    }
    assert!(written.lock().unwrap().is_empty());
    assert!(!log.exists());

    // 대조: 맞는 문구를 넣으면 붙이기·넣기가 먼저, 떼기·빼기가 나중에 적용된다
    let right = BatchRequest { confirm_text: Some("변경 2개 적용".into()), ..req };
    let committed = commit_batch(right, writer(&written, None)).await;
    assert_eq!(committed.result, Ok(BatchResult { batch_id: "b1".into(), log_ids: vec!["b1-1".into(), "b1-2".into()], failed: None, notes: vec![] }));
    assert_eq!(written_apis(&written), vec![vec!["iam:AddUserToGroup"], vec!["iam:DetachGroupPolicy"]]);
}

#[tokio::test]
async fn refuses_a_plan_seen_without_the_mid_stop_confirm() {
    let dir = tempfile::tempdir().unwrap();
    let written = Written::default();
    // 사용자가 본 계획에는 멈출 때의 확인이 없었다(예전 미리보기): 적용 때 다시 계산하면 확인이 생기니 달라진 계획이다
    let mut req = request(dir.path(), ops_is_admin(), vec![add_to_group("bob", "ops"), detach(OPS, ADMIN_POLICY)]);
    let seen = req.seen.as_mut().unwrap();
    seen.checks.retain(|w| w.message != MID_STOP_ADMIN_BOB);
    seen.confirm_text = None;
    req.confirm_text = Some("변경 2개 적용".into());
    let log = req.log_path.clone();

    let committed = commit_batch(req, writer(&written, None)).await;

    assert_eq!(refusal(&committed), DRIFTED);
    assert!(!committed.wrote);
    assert!(written.lock().unwrap().is_empty());
    assert!(!log.exists());
}

#[tokio::test]
async fn refuses_when_the_plan_changed() {
    let dir = tempfile::tempdir().unwrap();
    let written = Written::default();
    let changes = vec![detach(BOB, UNUSED_POLICY), attach(BOB, S3_FULL)];
    // 미리보기 때는 bob에 UNUSED_POLICY가 붙어 있었는데 그 사이 누군가 뗐다: 떼기는 이제 할 수 없는 변경이다
    let seen = request(dir.path(), bob_has_unused(), changes);
    let req = BatchRequest { snapshot: Arc::new(snapshot()), ..seen };
    let log = req.log_path.clone();

    let committed = commit_batch(req, writer(&written, None)).await;

    assert_eq!(refusal(&committed), DRIFTED);
    assert!(!committed.wrote);
    assert!(written.lock().unwrap().is_empty());
    assert!(!log.exists(), "거부한 요청은 기록에 남기지 않아요");
}

#[tokio::test]
async fn refuses_without_a_preview() {
    let dir = tempfile::tempdir().unwrap();
    let written = Written::default();
    let req = BatchRequest { seen: None, ..request(dir.path(), snapshot(), vec![attach(BOB, S3_FULL)]) };
    let log = req.log_path.clone();

    let committed = commit_batch(req, writer(&written, None)).await;

    assert_eq!(committed.result, Err(AppError::other(DRIFTED)));
    assert!(!committed.wrote);
    assert!(written.lock().unwrap().is_empty());
    assert!(!log.exists());
}

#[tokio::test]
async fn refuses_a_wrong_confirm_text() {
    let dir = tempfile::tempdir().unwrap();
    let written = Written::default();
    let changes = vec![attach(BOB, ADMIN_POLICY), attach(CAROL, ADMIN_POLICY)];
    let req = request(dir.path(), snapshot(), changes.clone());
    assert_eq!(req.seen.as_ref().unwrap().confirm_text.as_deref(), Some("변경 2개 적용"));
    let log = req.log_path.clone();

    for typed in [None, Some("bob"), Some("변경 2개 적용 "), Some("변경 3개 적용")] {
        let wrong = BatchRequest { confirm_text: typed.map(str::to_string), ..request(dir.path(), snapshot(), changes.clone()) };
        let committed = commit_batch(wrong, writer(&written, None)).await;
        assert_eq!(refusal(&committed), "확인 문구가 달라요. 입력해야 할 이름: 변경 2개 적용", "{typed:?}");
        assert!(!committed.wrote);
    }
    assert!(written.lock().unwrap().is_empty());
    assert!(!log.exists());

    // 대조: 맞는 문구를 넣으면 적용된다
    let right = BatchRequest { confirm_text: Some("변경 2개 적용".into()), ..req };
    let committed = commit_batch(right, writer(&written, None)).await;
    assert!(committed.result.is_ok() && committed.wrote);
    assert_eq!(written.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn a_blocked_batch_is_refused_whatever_is_typed() {
    let dir = tempfile::tempdir().unwrap();
    let written = Written::default();
    // 서비스 연결 역할은 바꿀 수 없다: 묶음 전체를 적용할 수 없다
    let req = request(dir.path(), snapshot(), vec![attach(BOB, S3_FULL), attach(SLR, S3_FULL)]);
    let req = BatchRequest { confirm_text: Some("bob".into()), ..req };
    let log = req.log_path.clone();

    let committed = commit_batch(req, writer(&written, None)).await;

    let message = refusal(&committed);
    assert!(message.starts_with("막혀 있어서 적용할 수 없어요") && message.contains("서비스 연결 역할"), "{message}");
    assert!(!committed.wrote);
    assert!(written.lock().unwrap().is_empty());
    assert!(!log.exists());
}

#[tokio::test]
async fn a_batch_rule_block_refuses_the_batch_before_writing() {
    let dir = tempfile::tempdir().unwrap();
    let written = Written::default();
    // 같은 칸을 붙이고 떼는 변경이 겹친다. 그리고 빈 묶음
    let cases = [
        (vec![attach(BOB, S3_FULL), detach(BOB, S3_FULL)], "막혀 있어서 적용할 수 없어요: 같은 대상을 바꾸는 변경이 겹쳐요"),
        (Vec::new(), "막혀 있어서 적용할 수 없어요: 적용할 변경이 없어요"),
    ];
    for (changes, expected) in cases {
        let req = request(dir.path(), snapshot(), changes);
        let log = req.log_path.clone();
        let committed = commit_batch(req, writer(&written, None)).await;
        assert_eq!(refusal(&committed), expected);
        assert!(!committed.wrote);
        assert!(!log.exists());
    }
    assert!(written.lock().unwrap().is_empty());
}

// ── 되돌리기 ────────────────────────────────────────────────────────────

fn recorded(id: &str, batch: &str, change: IamChange, inverse: Option<IamChange>) -> ChangeLogEntry {
    ChangeLogEntry {
        id: id.into(),
        at: iso(NOW),
        profile: "prod".into(),
        account_id: ACCOUNT.into(),
        caller_arn: ALICE.into(),
        change,
        summary: id.into(),
        calls: vec![],
        ok: true,
        error: None,
        inverse,
        undo_of: None,
        undone: false,
        batch_id: Some(batch.into()),
    }
}

/// 묶음 b1이 적용된 뒤의 기록과 스냅숏: bob에게 S3_FULL을 붙이고 UNUSED_POLICY를 뗐다.
fn applied_batch(dir: &Path) -> Snapshot {
    let entries = [
        recorded("b1-1", "b1", attach(BOB, S3_FULL), Some(detach(BOB, S3_FULL))),
        recorded("b1-2", "b1", detach(BOB, UNUSED_POLICY), Some(attach(BOB, UNUSED_POLICY))),
    ];
    for entry in &entries {
        append(&dir.join("iam-changes.jsonl"), entry).unwrap();
    }
    let before = bob_has_unused();
    let attached = apply_to_snapshot(&before, &attach(BOB, S3_FULL)).unwrap();
    apply_to_snapshot(&attached, &detach(BOB, UNUSED_POLICY)).unwrap()
}

#[tokio::test]
async fn undo_batches_mark_each_original_entry() {
    let dir = tempfile::tempdir().unwrap();
    let written = Written::default();
    let now = applied_batch(dir.path());
    // 받은 순서는 [b1-1의 역변경(떼기), b1-2의 역변경(붙이기)]이고 적용 순서는 붙이기가 먼저다: 짝은 변경과 함께 옮겨 간다
    let mut req = request(dir.path(), now, vec![detach(BOB, S3_FULL), attach(BOB, UNUSED_POLICY)]);
    req.undo_of = Some(vec!["b1-1".into(), "b1-2".into()]);
    req.batch_id = "b2".into();
    let log = req.log_path.clone();

    let committed = commit_batch(req, writer(&written, None)).await;

    assert_eq!(committed.result, Ok(BatchResult { batch_id: "b2".into(), log_ids: vec!["b2-1".into(), "b2-2".into()], failed: None, notes: vec![] }));
    assert_eq!(written_apis(&written), vec![vec!["iam:AttachUserPolicy"], vec!["iam:DetachUserPolicy"]]);
    let entries = read_all(&log);
    let view: Vec<(&str, bool, Option<&str>, Option<&str>)> = entries.iter().map(|e| (e.id.as_str(), e.undone, e.undo_of.as_deref(), e.batch_id.as_deref())).collect();
    assert_eq!(
        view,
        vec![
            ("b1-1", true, None, Some("b1")),
            ("b1-2", true, None, Some("b1")),
            ("b2-1", false, Some("b1-2"), Some("b2")),
            ("b2-2", false, Some("b1-1"), Some("b2")),
        ]
    );
    assert_eq!((entries[2].change.clone(), entries[3].change.clone()), (attach(BOB, UNUSED_POLICY), detach(BOB, S3_FULL)));
    // 되돌린 변경도 다시 되돌릴 수 있게 역변경이 남는다
    assert_eq!((entries[2].inverse.clone(), entries[3].inverse.clone()), (Some(detach(BOB, UNUSED_POLICY)), Some(attach(BOB, S3_FULL))));
}

#[tokio::test]
async fn a_failed_undo_marks_only_the_entries_it_undid() {
    let dir = tempfile::tempdir().unwrap();
    let written = Written::default();
    let now = applied_batch(dir.path());
    let mut req = request(dir.path(), now, vec![attach(BOB, UNUSED_POLICY), detach(BOB, S3_FULL)]);
    req.undo_of = Some(vec!["b1-2".into(), "b1-1".into()]);
    req.batch_id = "b2".into();
    let log = req.log_path.clone();

    // 첫 변경(붙이기)은 되고 두 번째(떼기)가 거부된다
    let committed = commit_batch(req, writer(&written, Some(2))).await;

    assert_eq!(committed.result.as_ref().map(|r| (r.log_ids.clone(), r.failed.as_ref().map(|f| f.index))), Ok((vec!["b2-1".to_string()], Some(1))));
    let entries = read_all(&log);
    let view: Vec<(&str, bool, bool)> = entries.iter().map(|e| (e.id.as_str(), e.undone, e.ok)).collect();
    assert_eq!(view, vec![("b1-1", false, true), ("b1-2", true, true), ("b2-1", false, true), ("b2-2", false, false)]);
    assert_eq!(entries[3].undo_of.as_deref(), Some("b1-1"), "실패한 기록도 무엇을 되돌리려 했는지 남아요");
}

#[tokio::test]
async fn a_failed_undone_mark_is_only_a_note_and_does_not_stop_the_undo() {
    let dir = tempfile::tempdir().unwrap();
    let written = Written::default();
    let now = applied_batch(dir.path());
    // 되돌림 표시는 임시 파일에 쓴 뒤 바꿔치기한다: 그 자리에 폴더가 있으면 표시만 못 한다(새 기록은 덧붙인다)
    fs::create_dir(dir.path().join("iam-changes.jsonl.tmp")).unwrap();
    let mut req = request(dir.path(), now, vec![attach(BOB, UNUSED_POLICY), detach(BOB, S3_FULL)]);
    req.undo_of = Some(vec!["b1-2".into(), "b1-1".into()]);
    req.batch_id = "b2".into();
    let log = req.log_path.clone();

    let committed = commit_batch(req, writer(&written, None)).await;

    let result = committed.result.unwrap();
    assert_eq!(written.lock().unwrap().len(), 2, "표시를 못 해도 나머지 변경은 적용해요");
    assert_eq!((result.log_ids, result.failed), (vec!["b2-1".to_string(), "b2-2".to_string()], None));
    assert_eq!(result.notes.len(), 2, "{:?}", result.notes);
    assert!(result.notes.iter().all(|note| note.starts_with("이전 기록에 '되돌림' 표시를 하지 못했어요")), "{:?}", result.notes);
    let entries = read_all(&log);
    let view: Vec<(&str, bool)> = entries.iter().map(|e| (e.id.as_str(), e.undone)).collect();
    assert_eq!(view, vec![("b1-1", false), ("b1-2", false), ("b2-1", false), ("b2-2", false)]);
}

#[tokio::test]
async fn undo_ids_must_match_the_changes() {
    let dir = tempfile::tempdir().unwrap();
    let written = Written::default();
    let now = applied_batch(dir.path());
    let log_text = || fs::read_to_string(dir.path().join("iam-changes.jsonl")).unwrap();
    let before = log_text();
    let changes = vec![attach(BOB, UNUSED_POLICY), detach(BOB, S3_FULL)];

    // 길이가 다르다
    let mut short = request(dir.path(), now.clone(), changes.clone());
    short.undo_of = Some(vec!["b1-2".into()]);
    let committed = commit_batch(short, writer(&written, None)).await;
    assert_eq!(committed.result, Err(AppError::other("되돌릴 기록과 변경의 수가 맞지 않아요")));
    assert!(!committed.wrote);

    // 길이는 같지만 짝이 바뀌었다: 기록된 역변경과 다른 변경을 되돌리기로 위장한 요청
    let mut swapped = request(dir.path(), now.clone(), changes.clone());
    swapped.undo_of = Some(vec!["b1-1".into(), "b1-2".into()]);
    let committed = commit_batch(swapped, writer(&written, None)).await;
    assert_eq!(committed.result, Err(AppError::other("되돌리려는 변경이 기록과 달라요")));
    assert!(!committed.wrote);
    assert_eq!(log_text(), before);

    // 이미 되돌린 기록은 다시 되돌릴 수 없다
    crate::iam::log::mark_undone(&dir.path().join("iam-changes.jsonl"), "b1-2").unwrap();
    let marked = log_text();
    let mut again = request(dir.path(), now, changes);
    again.undo_of = Some(vec!["b1-2".into(), "b1-1".into()]);
    let committed = commit_batch(again, writer(&written, None)).await;
    assert_eq!(committed.result, Err(AppError::other("이미 되돌린 변경이에요")));
    assert!(!committed.wrote);

    assert!(written.lock().unwrap().is_empty(), "거부한 요청은 쓰지 않아요");
    assert_eq!(log_text(), marked, "거부한 요청은 기록을 바꾸지 않아요");
}

#[test]
fn undo_batch_lists_inverses_newest_first() {
    // `change_log_of`처럼 새것이 먼저다. 다른 묶음과 묶음이 아닌 기록은 건너뛴다. 실패한 기록은 역변경이 적혀 있어도(실제로는 없다) 되돌리지 않는다
    let mut failed = recorded("b1-3", "b1", attach(CAROL, S3_FULL), Some(detach(CAROL, S3_FULL)));
    failed.ok = false;
    failed.error = Some("권한 없음".into());
    let entries = vec![
        recorded("b2-1", "b2", attach(BOB, S3_FULL), Some(detach(BOB, S3_FULL))),
        failed,
        recorded("b1-2", "b1", detach(BOB, UNUSED_POLICY), Some(attach(BOB, UNUSED_POLICY))),
        ChangeLogEntry { batch_id: None, ..recorded("single", "-", attach(BOB, S3_FULL), Some(detach(BOB, S3_FULL))) },
        recorded("b1-1", "b1", attach(BOB, S3_FULL), Some(detach(BOB, S3_FULL))),
    ];

    let undo = undo_batch_of(&entries, "b1").unwrap();

    assert_eq!(undo, UndoBatch { changes: vec![attach(BOB, UNUSED_POLICY), detach(BOB, S3_FULL)], undo_of: vec!["b1-2".into(), "b1-1".into()] });
}

#[test]
fn undo_batch_skips_undone_entries_and_errors_when_nothing_is_left() {
    let ok = recorded("b1-1", "b1", attach(BOB, S3_FULL), Some(detach(BOB, S3_FULL)));
    let mut undone = recorded("b1-2", "b1", attach(CAROL, UNUSED_POLICY), Some(detach(CAROL, UNUSED_POLICY)));
    undone.undone = true;
    // 새것이 먼저: b1-2는 이미 되돌렸고 b1-1만 남는다
    let undo = undo_batch_of(&[undone.clone(), ok.clone()], "b1").unwrap();
    assert_eq!(undo, UndoBatch { changes: vec![detach(BOB, S3_FULL)], undo_of: vec!["b1-1".into()] });

    assert_eq!(undo_batch_of(&[undone.clone(), ok.clone()], "nope"), Err(AppError::other("변경 기록을 찾지 못했어요")));
    assert_eq!(undo_batch_of(&[], "b1"), Err(AppError::other("변경 기록을 찾지 못했어요")));

    // 모두 되돌렸거나, 되돌릴 역변경이 없으면 되돌릴 것이 없다
    let mut all_undone = ok.clone();
    all_undone.undone = true;
    assert_eq!(undo_batch_of(&[undone, all_undone], "b1"), Err(AppError::other("되돌릴 변경이 없어요")));
    let no_inverse = recorded("b1-1", "b1", attach(BOB, S3_FULL), None);
    assert_eq!(undo_batch_of(&[no_inverse], "b1"), Err(AppError::other("되돌릴 변경이 없어요")));
}

// ── 화면으로 가는 모양 ───────────────────────────────────────────────────

#[test]
fn results_serialize_with_the_contract_names() {
    let done = BatchResult { batch_id: "b1".into(), log_ids: vec!["b1-1".into(), "b1-2".into()], failed: None, notes: vec![] };
    // 실패가 없으면 failed는 null이고, 알릴 것이 없으면 notes는 보내지 않는다
    assert_eq!(serde_json::to_value(&done).unwrap(), json!({ "batchId": "b1", "logIds": ["b1-1", "b1-2"], "failed": null }));

    let failed = BatchResult {
        batch_id: "b1".into(),
        log_ids: vec!["b1-1".into()],
        failed: Some(BatchFailure { index: 1, summary: "bob에 UnusedPolicy 붙이기".into(), message: "권한 없음 (iam:AttachUserPolicy)".into() }),
        notes: vec!["변경 기록을 저장하지 못했어요: 디스크가 가득 찼어요".into()],
    };
    assert_eq!(
        serde_json::to_value(&failed).unwrap(),
        json!({
            "batchId": "b1",
            "logIds": ["b1-1"],
            "failed": { "index": 1, "summary": "bob에 UnusedPolicy 붙이기", "message": "권한 없음 (iam:AttachUserPolicy)" },
            "notes": ["변경 기록을 저장하지 못했어요: 디스크가 가득 찼어요"],
        })
    );

    let undo = UndoBatch { changes: vec![detach(BOB, S3_FULL)], undo_of: vec!["b1-1".into()] };
    assert_eq!(serde_json::to_value(&undo).unwrap(), json!({ "changes": [{ "op": "detachPolicy", "target": BOB, "policyArn": S3_FULL }], "undoOf": ["b1-1"] }));
}
