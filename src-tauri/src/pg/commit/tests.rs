use std::fs;
use std::future::{ready, Ready};
use std::sync::Mutex;

use super::*;
use crate::pg::change::model::{PresetChoice, PresetKind};
use crate::pg::change::preview::{evaluate, evaluate_batch};
use crate::pg::change::support::*;
use crate::pg::fixtures::*;
use crate::pg::model::Privilege::Select;

const ARN: &str = "arn:aws:rds:ap-northeast-2:111111111111:cluster:c";
const LOST: &str = "적용하지 못했어요: 데이터베이스 연결이 끊겼어요";
const UNKNOWN: &str = "데이터베이스 연결이 끊겨 적용됐는지 알 수 없어요. 다시 읽어서 확인해 주세요";

struct Harness {
    dir: tempfile::TempDir,
    scene: Scene,
}

type Steps = Mutex<Vec<Vec<(String, Option<&'static str>)>>>;

fn exec_with(calls: &Steps, outcome: Result<(), ExecError>) -> impl FnOnce(Vec<Step>) -> Ready<Result<(), ExecError>> + '_ {
    move |steps| {
        calls.lock().unwrap().push(steps.iter().map(|s| (s.run.clone(), s.expect)).collect());
        ready(outcome)
    }
}

type Reread = Result<(Arc<ClusterSnapshot>, Arc<DbSnapshot>), AppError>;

fn reread_with(result: Reread) -> impl FnOnce() -> Ready<Reread> {
    move || ready(result)
}

fn never_reread() -> impl FnOnce() -> Ready<Reread> {
    || panic!("다시 읽으면 안 돼요")
}

impl Harness {
    fn new(scene: Scene) -> Harness {
        Harness { dir: tempfile::tempdir().unwrap(), scene }
    }

    fn path(&self) -> PathBuf {
        self.dir.path().join("db-changes.jsonl")
    }

    fn plan_of(&self, changes: &PgChanges) -> PgPlan {
        match changes {
            PgChanges::One(change) => PgPlan::One(evaluate(&ctx(&self.scene), change).preview),
            PgChanges::Batch { database, changes } => PgPlan::Batch(evaluate_batch(&ctx(&self.scene), database, changes).preview),
        }
    }

    fn request(&self, changes: PgChanges) -> PgRequest {
        let seen = Some(self.plan_of(&changes));
        PgRequest {
            profile: "prod".into(),
            target_arn: ARN.into(),
            login_user: self.scene.cluster.login_user.clone(),
            cluster: Arc::new(self.scene.cluster.clone()),
            db: Arc::new(self.scene.db.clone()),
            own_pids: Vec::new(),
            read_replica: false,
            default_db: "appdb".into(),
            now: NOW,
            changes,
            confirm_text: None,
            undo_of: Vec::new(),
            seen,
            log_path: self.path(),
            log_id: "log-1".into(),
        }
    }

    fn log(&self) -> Vec<PgLogEntry> {
        log::read_all(&self.path())
    }

    fn log_text(&self) -> String {
        fs::read_to_string(self.path()).unwrap_or_default()
    }
}

fn one(change: PgChange) -> PgChanges {
    PgChanges::One(change)
}

fn batch(changes: Vec<PgChange>) -> PgChanges {
    PgChanges::Batch { database: "appdb".into(), changes }
}

fn add_carol() -> PgChange {
    membership("app_read", "carol", true, false)
}

fn applied(committed: PgCommitted) -> PgApplyResult {
    match committed.result {
        Ok(PgCommitResult::One(result)) => result,
        Ok(PgCommitResult::Batch(_)) => panic!("묶음 결과예요"),
        Err(e) => panic!("실패했어요: {e}"),
    }
}

fn refusal(committed: &PgCommitted) -> String {
    assert!(!committed.ran, "거부됐으면 문장을 돌리지 않아요");
    error_text(committed.result.as_ref().err().expect("거부돼야 해요"))
}

fn failure(committed: &PgCommitted) -> String {
    error_text(committed.result.as_ref().err().expect("실패해야 해요"))
}

fn create_login(name: &str) -> PgChange {
    PgChange::CreateRole { name: name.into(), login: true, groups: Vec::new(), connection_limit: -1, valid_until: None, preset: None }
}

// ───────────────────────── 하나 ─────────────────────────

#[tokio::test]
async fn a_change_runs_its_statements_and_is_logged_with_its_masked_sql_and_inverse() {
    let h = Harness::new(admin_of(PG16, &["app_read"]));
    let calls = Steps::default();
    let committed = commit(h.request(one(add_carol())), exec_with(&calls, Ok(())), never_reread()).await;
    assert!(committed.ran);
    let result = applied(committed);
    assert_eq!((result.log_id.as_str(), result.summary.as_str(), result.password.as_deref(), result.notes.len()), ("log-1", "그룹에 넣기: carol → app_read", None, 0));
    let sent = calls.lock().unwrap().clone();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].iter().map(|(run, _)| run.as_str()).collect::<Vec<_>>(), evaluate(&ctx(&h.scene), &add_carol()).statements.iter().map(|s| s.run(None)).collect::<Vec<_>>());
    let log = h.log();
    assert_eq!(log.len(), 1);
    let e = &log[0];
    assert_eq!((e.id.as_str(), e.profile.as_str(), e.target_arn.as_str(), e.database.as_str(), e.login_user.as_str()), ("log-1", "prod", ARN, "appdb", "mm"));
    assert_eq!((e.ok, e.error.as_deref(), e.undone, e.batch_id.as_deref(), e.undo_of.as_deref()), (true, None, false, None, None));
    assert_eq!(e.change, add_carol());
    assert_eq!(e.inverse, Some(vec![membership("app_read", "carol", false, false)]));
    assert_eq!(e.sql, evaluate(&ctx(&h.scene), &add_carol()).preview.sql);
}

#[tokio::test]
async fn nothing_runs_without_a_matching_plan() {
    let h = Harness::new(admin_of(PG16, &["app_read"]));
    let calls = Steps::default();
    let mut req = h.request(one(add_carol()));
    req.seen = None;
    assert_eq!(refusal(&commit(req, exec_with(&calls, Ok(())), never_reread()).await), STALE);

    // 다른 변경의 계획
    let mut req = h.request(one(add_carol()));
    req.seen = Some(h.plan_of(&one(membership("app_read", "bob", true, false))));
    assert_eq!(refusal(&commit(req, exec_with(&calls, Ok(())), never_reread()).await), STALE);

    // 하나짜리 변경에 묶음의 계획
    let mut req = h.request(one(add_carol()));
    req.seen = Some(h.plan_of(&batch(vec![add_carol()])));
    assert_eq!(refusal(&commit(req, exec_with(&calls, Ok(())), never_reread()).await), STALE);
    assert!(calls.lock().unwrap().is_empty());
    assert!(h.log().is_empty());
}

#[tokio::test]
async fn a_member_added_to_the_grantee_group_after_the_preview_is_stale_though_the_sql_is_equal() {
    let before = admin_of(PG16, &["app_read"]);
    let change = PgChange::Grant { database: "appdb".into(), grantee: "app_read".into(), add: true, items: vec![item(rel("audit", "events"), &[Select])] };
    let seen = Harness::new(before.clone()).plan_of(&one(change.clone()));
    // 그 사이 app_read에 구성원이 생겼다: 문장은 같지만 영향이 늘었다
    let h = Harness::new(before.add_role(login("dave")).add_member(member_with("dave", "app_read", true, true)));
    let mut req = h.request(one(change));
    req.seen = Some(seen);
    let calls = Steps::default();
    assert_eq!(refusal(&commit(req, exec_with(&calls, Ok(())), never_reread()).await), STALE);
    assert!(calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_login_switch_between_preview_and_apply_is_stale() {
    let h = Harness::new(admin_of(PG16, &["app_read"]));
    let mut req = h.request(one(add_carol()));
    let mut other = (*req.cluster).clone();
    other.login_user = "nobody".into();
    req.cluster = Arc::new(other);
    let calls = Steps::default();
    assert_eq!(refusal(&commit(req, exec_with(&calls, Ok(())), never_reread()).await), STALE);
}

#[tokio::test]
async fn a_blocked_change_is_refused_with_the_gate_text() {
    // mm은 app_read의 구성원을 바꿀 수 없다
    let h = Harness::new(admin(PG16));
    let calls = Steps::default();
    let text = refusal(&commit(h.request(one(add_carol())), exec_with(&calls, Ok(())), never_reread()).await);
    assert!(text.starts_with("막혀 있어서 적용할 수 없어요: "), "{text}");
    assert!(calls.lock().unwrap().is_empty() && h.log().is_empty());
}

#[tokio::test]
async fn a_confirm_text_is_required_and_must_match() {
    let h = Harness::new(admin_of(PG16, &["rds_superuser"]).add_role(role("rds_superuser")));
    let change = membership("rds_superuser", "carol", true, false);
    let calls = Steps::default();
    let text = refusal(&commit(h.request(one(change.clone())), exec_with(&calls, Ok(())), never_reread()).await);
    assert_eq!(text, "확인 문구가 달라요. 입력해야 할 이름: carol");
    let mut req = h.request(one(change.clone()));
    req.confirm_text = Some("carl".into());
    assert_eq!(refusal(&commit(req, exec_with(&calls, Ok(())), never_reread()).await), "확인 문구가 달라요. 입력해야 할 이름: carol");
    let mut req = h.request(one(change));
    req.confirm_text = Some("carol".into());
    applied(commit(req, exec_with(&calls, Ok(())), never_reread()).await);
    assert_eq!(calls.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_failed_run_is_logged_as_failed_without_an_inverse_and_returns_the_error() {
    let h = Harness::new(admin_of(PG16, &["app_read"]));
    let calls = Steps::default();
    let error = AppError::other("적용하지 못했어요: role \"carol\" does not exist");
    let committed = commit(h.request(one(add_carol())), exec_with(&calls, Err(ExecError::Failed(error.clone()))), never_reread()).await;
    assert!(committed.ran);
    assert_eq!(committed.result.err(), Some(error));
    let log = h.log();
    assert_eq!(log.len(), 1);
    assert_eq!((log[0].ok, log[0].error.as_deref(), log[0].inverse.clone()), (false, Some("적용하지 못했어요: role \"carol\" does not exist"), None));
}

// ───────────────────────── 비밀번호 ─────────────────────────

#[tokio::test]
async fn a_created_login_gets_a_password_that_is_in_the_result_and_nowhere_in_the_log() {
    let h = Harness::new(admin(PG16));
    let calls = Steps::default();
    let result = applied(commit(h.request(one(create_login("newbie"))), exec_with(&calls, Ok(())), never_reread()).await);
    let password = result.password.clone().expect("비밀번호가 결과에 있어야 해요");
    assert_eq!(password.len(), 24);
    let sent: Vec<String> = calls.lock().unwrap()[0].iter().map(|(run, _)| run.clone()).collect();
    assert!(sent.iter().any(|run| run.contains("PASSWORD 'SCRAM-SHA-256$")), "{sent:?}");
    assert!(sent.iter().all(|run| !run.contains(&password)), "평문은 문장에 없어요");
    let text = h.log_text();
    assert!(!text.contains(&password) && !text.contains("SCRAM"), "{text}");
    assert!(text.contains("PASSWORD '••••••••'"));
    assert_eq!(h.log()[0].inverse.as_ref().map(Vec::len), Some(1));
}

#[tokio::test]
async fn a_failed_password_change_returns_no_password() {
    let h = Harness::new(admin_of(PG16, &["carol"]));
    let calls = Steps::default();
    let committed = commit(h.request(one(PgChange::Password { role: "carol".into() })), exec_with(&calls, Err(ExecError::Failed(AppError::other("적용하지 못했어요: x")))), never_reread()).await;
    assert_eq!(failure(&committed), "적용하지 못했어요: x");
    assert!(!h.log_text().contains("SCRAM"));
}

// ───────────────────────── COMMIT의 답을 못 받았을 때 ─────────────────────────

fn after_state(h: &Harness, change: &PgChange) -> (Arc<ClusterSnapshot>, Arc<DbSnapshot>) {
    let (cluster, db) = evaluate(&ctx(&h.scene), change).after;
    (Arc::new(cluster), Arc::new(db))
}

#[tokio::test]
async fn an_unknown_commit_that_the_reread_shows_applied_is_a_success_with_a_note() {
    let h = Harness::new(admin_of(PG16, &["app_read"]));
    let calls = Steps::default();
    let committed = commit(h.request(one(add_carol())), exec_with(&calls, Err(ExecError::CommitUnknown)), reread_with(Ok(after_state(&h, &add_carol())))).await;
    let result = applied(committed);
    assert_eq!(result.notes, vec!["연결이 끊겼지만 적용된 것을 확인했어요".to_string()]);
    let log = h.log();
    assert!(log[0].ok && log[0].inverse.is_some());
}

#[tokio::test]
async fn an_unknown_commit_that_the_reread_shows_unchanged_is_the_before_commit_failure() {
    let h = Harness::new(admin_of(PG16, &["app_read"]));
    let calls = Steps::default();
    let same = (Arc::new(h.scene.cluster.clone()), Arc::new(h.scene.db.clone()));
    let committed = commit(h.request(one(add_carol())), exec_with(&calls, Err(ExecError::CommitUnknown)), reread_with(Ok(same))).await;
    assert_eq!(failure(&committed), LOST);
    assert_eq!(h.log()[0].error.as_deref(), Some(LOST));
    assert!(!h.log()[0].ok);
}

#[tokio::test]
async fn an_unknown_commit_with_a_third_state_or_a_failed_reread_stays_unknown() {
    let h = Harness::new(admin_of(PG16, &["app_read"]));
    let calls = Steps::default();
    let mut third = (*after_state(&h, &add_carol()).0).clone();
    third.members.clear();
    let committed = commit(h.request(one(add_carol())), exec_with(&calls, Err(ExecError::CommitUnknown)), reread_with(Ok((Arc::new(third), Arc::new(h.scene.db.clone()))))).await;
    assert_eq!(failure(&committed), UNKNOWN);

    let h = Harness::new(admin_of(PG16, &["app_read"]));
    let committed = commit(h.request(one(add_carol())), exec_with(&calls, Err(ExecError::CommitUnknown)), reread_with(Err(AppError::other("읽지 못했어요")))).await;
    assert_eq!(failure(&committed), UNKNOWN);
    assert_eq!((h.log()[0].ok, h.log()[0].error.as_deref()), (false, Some(UNKNOWN)));
}

#[tokio::test]
async fn an_unknown_password_change_is_not_compared_and_asks_for_a_reset() {
    let h = Harness::new(admin_of(PG16, &["carol"]));
    let calls = Steps::default();
    let committed = commit(h.request(one(PgChange::Password { role: "carol".into() })), exec_with(&calls, Err(ExecError::CommitUnknown)), never_reread()).await;
    let expected = format!("{UNKNOWN} 비밀번호를 다시 재설정해 주세요");
    assert_eq!(failure(&committed), expected);
    assert_eq!(h.log()[0].error.as_deref(), Some(expected.as_str()));
}

// ───────────────────────── 역할 삭제 ─────────────────────────

fn drop_role(role: &str) -> PgChange {
    PgChange::DropRole { role: role.into() }
}

/// `newbie`를 만든 기록을 담은 장면: 그 역할은 이미 있다
fn created_newbie() -> Harness {
    let h = Harness::new(admin_of(PG16, &["newbie"]).add_role(role("newbie")));
    let create = PgChange::CreateRole { name: "newbie".into(), login: false, groups: Vec::new(), connection_limit: -1, valid_until: None, preset: None };
    log::append(&h.path(), &entry_of("c1", create, Some(vec![drop_role("newbie")]))).unwrap();
    h
}

fn entry_of(id: &str, change: PgChange, inverse: Option<Vec<PgChange>>) -> PgLogEntry {
    PgLogEntry {
        id: id.into(),
        at: "2026-10-29T00:00:00Z".into(),
        profile: "prod".into(),
        target_arn: ARN.into(),
        database: "appdb".into(),
        login_user: "mm".into(),
        change,
        summary: "요약".into(),
        sql: Vec::new(),
        ok: true,
        error: None,
        inverse,
        undo_of: None,
        undone: false,
        batch_id: None,
    }
}

#[tokio::test]
async fn a_drop_role_is_refused_unless_it_undoes_the_creation() {
    let h = created_newbie();
    let calls = Steps::default();
    // undoOf 없이
    assert_eq!(refusal(&commit(h.request(one(drop_role("newbie"))), exec_with(&calls, Ok(())), never_reread()).await), NOT_UNDOABLE);
    // 묶음에서도 같다
    assert_eq!(refusal(&commit(h.request(batch(vec![drop_role("newbie")])), exec_with(&calls, Ok(())), never_reread()).await), NOT_UNDOABLE);
    // 역할 만들기가 아닌 기록을 되돌린다고 하면서
    log::append(&h.path(), &entry_of("m1", add_carol(), Some(vec![drop_role("newbie")]))).unwrap();
    let mut req = h.request(one(drop_role("newbie")));
    req.undo_of = vec!["m1".into()];
    assert_eq!(refusal(&commit(req, exec_with(&calls, Ok(())), never_reread()).await), NOT_UNDOABLE);
    // 만들지 않은 역할을 지우려 하면
    let mut req = h.request(one(drop_role("tmp")));
    req.undo_of = vec!["c1".into()];
    assert_eq!(refusal(&commit(req, exec_with(&calls, Ok(())), never_reread()).await), NOT_UNDOABLE);
    assert!(calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn undoing_a_creation_drops_the_role_and_marks_the_entry_undone() {
    let h = created_newbie();
    let calls = Steps::default();
    let mut req = h.request(one(drop_role("newbie")));
    req.undo_of = vec!["c1".into()];
    req.confirm_text = Some("newbie".into());
    let result = applied(commit(req, exec_with(&calls, Ok(())), never_reread()).await);
    assert_eq!(result.log_id, "log-1");
    let log = h.log();
    assert!(log[0].undone, "되돌린 기록에 표시해야 해요");
    assert_eq!((log[1].id.as_str(), log[1].undo_of.as_deref()), ("log-1", Some("c1")));
}

#[tokio::test]
async fn a_role_that_gained_members_or_groups_after_creation_is_not_dropped() {
    let h = created_newbie();
    let h = Harness { scene: h.scene.clone().add_member(member("carol", "newbie")), dir: h.dir };
    let calls = Steps::default();
    let mut req = h.request(one(drop_role("newbie")));
    req.undo_of = vec!["c1".into()];
    assert_eq!(refusal(&commit(req, exec_with(&calls, Ok(())), never_reread()).await), UNDO_AFTER_MORE);

    let h = created_newbie();
    let h = Harness { scene: h.scene.clone().add_member(member("newbie", "app_read")), dir: h.dir };
    let mut req = h.request(one(drop_role("newbie")));
    req.undo_of = vec!["c1".into()];
    assert_eq!(refusal(&commit(req, exec_with(&calls, Ok(())), never_reread()).await), UNDO_AFTER_MORE);
}

#[tokio::test]
async fn a_group_created_with_the_role_may_be_dropped_with_it() {
    let preset = PresetChoice { preset: PresetKind::ReadOnly, database: Some("appdb".into()), schemas: vec!["app".into()], creators: Vec::new(), group: Some("newbie_grp".into()), create_group: true };
    let create = PgChange::CreateRole { name: "newbie".into(), login: false, groups: Vec::new(), connection_limit: -1, valid_until: None, preset: Some(preset) };
    let scene = admin_of(PG16, &["newbie", "newbie_grp"]).add_role(role("newbie")).add_role(role("newbie_grp")).add_member(member("newbie", "newbie_grp"));
    let h = Harness::new(scene);
    log::append(&h.path(), &entry_of("c1", create, Some(vec![drop_role("newbie"), drop_role("newbie_grp")]))).unwrap();
    let calls = Steps::default();
    let mut req = h.request(batch(vec![drop_role("newbie"), drop_role("newbie_grp")]));
    req.undo_of = vec!["c1".into()];
    req.confirm_text = Some("변경 2개 적용".into());
    // 묶음의 변경은 되돌릴 기록과 같다
    let committed = commit(req, exec_with(&calls, Ok(())), never_reread()).await;
    assert!(committed.result.is_ok(), "{:?}", committed.result.err());
}

// ───────────────────────── 되돌리기 점검 ─────────────────────────

fn undoing(h: &Harness, ids: &[&str], changes: PgChanges) -> PgRequest {
    let mut req = h.request(changes);
    req.undo_of = ids.iter().map(|s| s.to_string()).collect();
    req
}

#[tokio::test]
async fn an_undo_must_match_its_log_entries() {
    let h = Harness::new(admin_of(PG16, &["app_read"]));
    let remove = membership("app_read", "carol", false, false);
    let calls = Steps::default();
    log::append(&h.path(), &entry_of("ok1", add_carol(), Some(vec![remove.clone()]))).unwrap();
    let mut failed = entry_of("bad", add_carol(), Some(vec![remove.clone()]));
    failed.ok = false;
    let mut none = entry_of("none", add_carol(), None);
    none.ok = true;
    let mut done = entry_of("done", add_carol(), Some(vec![remove.clone()]));
    done.undone = true;
    let mut elsewhere = entry_of("else", add_carol(), Some(vec![remove.clone()]));
    elsewhere.target_arn = "arn:other".into();
    for e in [failed, none, done, elsewhere] {
        log::append(&h.path(), &e).unwrap();
    }
    let cases = [
        ("zzz", NOT_FOUND.to_string()),
        ("bad", NOT_UNDOABLE.to_string()),
        ("none", NOT_UNDOABLE.to_string()),
        ("done", ALREADY_UNDONE.to_string()),
        ("else", "다른 대상의 변경이에요: arn:other".to_string()),
    ];
    for (id, expected) in cases {
        let text = refusal(&commit(undoing(&h, &[id], one(remove.clone())), exec_with(&calls, Ok(())), never_reread()).await);
        assert_eq!(text, expected, "{id}");
    }
    // 기록의 되돌림과 다른 변경
    let other = membership("app_read", "bob", false, false);
    assert_eq!(refusal(&commit(undoing(&h, &["ok1"], one(other)), exec_with(&calls, Ok(())), never_reread()).await), "되돌리려는 변경이 기록과 달라요");
    assert!(calls.lock().unwrap().is_empty());
    // 맞으면 적용하고 표시한다
    applied(commit(undoing(&h, &["ok1"], one(remove)), exec_with(&calls, Ok(())), never_reread()).await);
    assert!(h.log().iter().find(|e| e.id == "ok1").unwrap().undone);
}

// ───────────────────────── 묶음 ─────────────────────────

fn two_changes() -> Vec<PgChange> {
    vec![add_carol(), PgChange::Grant { database: "appdb".into(), grantee: "app_read".into(), add: true, items: vec![item(rel("audit", "events"), &[Select])] }]
}

#[tokio::test]
async fn a_batch_is_one_transaction_with_one_log_entry_per_change() {
    let h = Harness::new(admin_of(PG16, &["app_read"]));
    let calls = Steps::default();
    let committed = commit(h.request(batch(two_changes())), exec_with(&calls, Ok(())), never_reread()).await;
    assert!(committed.ran);
    let Ok(PgCommitResult::Batch(result)) = committed.result else { panic!("묶음 결과예요") };
    assert_eq!((result.batch_id.as_str(), result.summary.as_str()), ("log-1", "변경 2개"));
    assert_eq!(result.log_ids, vec!["log-1-1".to_string(), "log-1-2".to_string()]);
    let sent = calls.lock().unwrap().clone();
    assert_eq!(sent.len(), 1, "묶음 전체가 한 번의 exec다");
    let log = h.log();
    assert_eq!(log.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), vec!["log-1-1", "log-1-2"]);
    assert!(log.iter().all(|e| e.ok && e.batch_id.as_deref() == Some("log-1") && e.inverse.is_some()));
    // 도는 차례(구성원 넣기, 권한 주기)로 남는다
    assert_eq!(log[0].change, add_carol());
    assert_eq!(sent[0].len(), log.iter().map(|e| e.sql.len()).sum::<usize>());
}

#[tokio::test]
async fn a_failed_batch_logs_every_change_as_failed() {
    let h = Harness::new(admin_of(PG16, &["app_read"]));
    let calls = Steps::default();
    let committed = commit(h.request(batch(two_changes())), exec_with(&calls, Err(ExecError::Failed(AppError::other(LOCKED)))), never_reread()).await;
    assert_eq!(failure(&committed), LOCKED);
    let log = h.log();
    assert_eq!(log.len(), 2);
    assert!(log.iter().all(|e| !e.ok && e.error.as_deref() == Some(LOCKED) && e.inverse.is_none()));
}

const LOCKED: &str = "다른 작업이 객체를 잠그고 있어 적용하지 못했어요. 잠시 뒤 다시 시도하세요";

#[tokio::test]
async fn a_batch_undo_takes_a_list_of_entries_in_order() {
    let h = Harness::new(admin_of(PG16, &["app_read"]));
    let remove = membership("app_read", "carol", false, false);
    let revoke = PgChange::Grant { database: "appdb".into(), grantee: "app_read".into(), add: false, items: vec![item(rel("audit", "events"), &[Select])] };
    log::append(&h.path(), &entry_of("a", add_carol(), Some(vec![remove.clone()]))).unwrap();
    log::append(&h.path(), &entry_of("b", two_changes()[1].clone(), Some(vec![revoke.clone()]))).unwrap();
    let calls = Steps::default();
    let committed = commit(undoing(&h, &["a", "b"], batch(vec![remove, revoke])), exec_with(&calls, Ok(())), never_reread()).await;
    assert!(committed.result.is_ok(), "{:?}", committed.result.err());
    assert!(h.log().iter().filter(|e| e.id == "a" || e.id == "b").all(|e| e.undone));
}

// ───────────────────────── 되돌리기 명령 ─────────────────────────

#[test]
fn an_undo_of_one_entry_and_of_a_batch_follow_the_log() {
    let remove = membership("app_read", "carol", false, false);
    let batched = |id: &str, undone: bool, ok: bool, inverse: Option<Vec<PgChange>>| {
        let mut e = entry_of(id, add_carol(), inverse);
        (e.undone, e.ok, e.batch_id) = (undone, ok, Some("b1".into()));
        e
    };
    // 새것이 먼저
    let entries = vec![
        batched("b1-5", false, true, Some(vec![remove.clone()])),
        batched("b1-4", false, true, Some(Vec::new())),
        batched("b1-3", true, true, Some(vec![remove.clone()])),
        batched("b1-2", false, false, Some(vec![remove.clone()])),
        batched("b1-1", false, true, Some(vec![remove.clone(), remove.clone()])),
        entry_of("solo", add_carol(), None),
    ];
    let undo = undo_batch_of(&entries, "b1").unwrap();
    assert_eq!(undo.undo_of, vec!["b1-5".to_string(), "b1-1".to_string()]);
    assert_eq!(undo.changes, vec![remove.clone(), remove.clone(), remove.clone()]);
    assert_eq!(undo.database, "appdb");
    assert_eq!(undo_batch_of(&entries, "none").unwrap_err(), AppError::other(NOT_FOUND));
    let only_bad: Vec<PgLogEntry> = entries.iter().filter(|e| e.id == "b1-2" || e.id == "b1-3").cloned().collect();
    assert_eq!(undo_batch_of(&only_bad, "b1").unwrap_err(), AppError::other(NOT_UNDOABLE));

    let single = undo_of(&entries, "b1-5").unwrap();
    assert_eq!((single.changes, single.undo_of), (vec![remove], vec!["b1-5".to_string()]));
    assert_eq!(undo_of(&entries, "zzz").unwrap_err(), AppError::other(NOT_FOUND));
    assert_eq!(undo_of(&entries, "solo").unwrap_err(), AppError::other(NOT_UNDOABLE));
    assert_eq!(undo_of(&entries, "b1-4").unwrap_err(), AppError::other(NOT_UNDOABLE));
    assert_eq!(undo_of(&entries, "b1-2").unwrap_err(), AppError::other(NOT_UNDOABLE));
    assert_eq!(undo_of(&entries, "b1-3").unwrap_err(), AppError::other(ALREADY_UNDONE));
}

#[test]
fn an_apply_result_prints_without_its_password() {
    let result = PgApplyResult { log_id: "x".into(), summary: "s".into(), password: Some("Secret-Password-1234567".into()), notes: Vec::new() };
    let printed = format!("{result:?}");
    assert!(!printed.contains("Secret"), "{printed}");
    assert!(printed.contains(crate::pg::password::MASK));
    assert_eq!(serde_json::to_value(&result).unwrap()["password"], "Secret-Password-1234567");
    let none = serde_json::to_value(PgApplyResult { log_id: "x".into(), summary: "s".into(), password: None, notes: Vec::new() }).unwrap();
    assert!(none.get("password").is_none() && none.get("notes").is_none());
}

// ───────────────────────── 수정 1 ─────────────────────────

fn preset_create(group: Option<&str>, create_group: bool, kind: PresetKind) -> PgChange {
    let preset = PresetChoice { preset: kind, database: Some("appdb".into()), schemas: vec!["app".into()], creators: Vec::new(), group: group.map(Into::into), create_group };
    PgChange::CreateRole { name: "newbie".into(), login: false, groups: Vec::new(), connection_limit: -1, valid_until: None, preset: Some(preset) }
}

async fn undo_drop(scene: Scene, create: PgChange) -> PgCommitted {
    let h = Harness::new(scene);
    log::append(&h.path(), &entry_of("c1", create, Some(vec![drop_role("newbie")]))).unwrap();
    let mut req = h.request(one(drop_role("newbie")));
    req.undo_of = vec!["c1".into()];
    req.confirm_text = Some("newbie".into());
    commit(req, exec_with(&Steps::default(), Ok(())), never_reread()).await
}

#[tokio::test]
async fn undoing_a_create_that_joined_an_existing_group_or_rds_superuser_is_allowed() {
    // 이미 있는 그룹에 넣는 프리셋
    let scene = admin_of(PG16, &["newbie"]).add_role(role("newbie")).add_member(member("newbie", "app_read"));
    let committed = undo_drop(scene, preset_create(Some("app_read"), false, PresetKind::ReadOnly)).await;
    assert!(committed.result.is_ok(), "{:?}", committed.result.err());
    // 관리자 프리셋은 rds_superuser에 넣는다
    let scene = admin_of(PG16, &["newbie"]).add_role(role("newbie")).add_role(role("rds_superuser")).add_member(member("newbie", "rds_superuser"));
    let committed = undo_drop(scene, preset_create(None, false, PresetKind::Admin)).await;
    assert!(committed.result.is_ok(), "{:?}", committed.result.err());
    // 만든 변경에 없던 그룹에 들어갔으면 여전히 거부한다
    let scene = admin_of(PG16, &["newbie"]).add_role(role("newbie")).add_member(member("newbie", "app_read")).add_member(member("newbie", "app_write"));
    let committed = undo_drop(scene, preset_create(Some("app_read"), false, PresetKind::ReadOnly)).await;
    assert_eq!(error_text(committed.result.as_ref().err().unwrap()), UNDO_AFTER_MORE);
}

#[tokio::test]
async fn an_undo_of_several_entries_writes_undo_of_on_each_new_entry_in_run_order() {
    let h = Harness::new(admin_of(PG16, &["app_read"]));
    let remove = membership("app_read", "carol", false, false);
    let revoke = PgChange::Grant { database: "appdb".into(), grantee: "app_read".into(), add: false, items: vec![item(rel("audit", "events"), &[Select])] };
    log::append(&h.path(), &entry_of("a", add_carol(), Some(vec![remove.clone()]))).unwrap();
    log::append(&h.path(), &entry_of("b", two_changes()[1].clone(), Some(vec![revoke.clone()]))).unwrap();
    let calls = Steps::default();
    let committed = commit(undoing(&h, &["a", "b"], batch(vec![remove.clone(), revoke.clone()])), exec_with(&calls, Ok(())), never_reread()).await;
    assert!(committed.result.is_ok(), "{:?}", committed.result.err());
    let log = h.log();
    let new: Vec<(&str, &PgChange, Option<&str>)> = log.iter().filter(|e| e.id.starts_with("log-1")).map(|e| (e.id.as_str(), &e.change, e.undo_of.as_deref())).collect();
    // 도는 차례는 권한 빼기, 구성원 빼기다. 각 기록은 자기가 되돌리는 기록을 가리킨다
    assert_eq!(new, vec![("log-1-1", &revoke, Some("b")), ("log-1-2", &remove, Some("a"))]);
}

#[tokio::test]
async fn undoing_a_create_with_a_preset_group_marks_every_new_entry_with_the_created_entry() {
    let preset = PresetChoice { preset: PresetKind::ReadOnly, database: Some("appdb".into()), schemas: vec!["app".into()], creators: Vec::new(), group: Some("newbie_grp".into()), create_group: true };
    let create = PgChange::CreateRole { name: "newbie".into(), login: false, groups: Vec::new(), connection_limit: -1, valid_until: None, preset: Some(preset) };
    let scene = admin_of(PG16, &["newbie", "newbie_grp"]).add_role(role("newbie")).add_role(role("newbie_grp")).add_member(member("newbie", "newbie_grp"));
    let h = Harness::new(scene);
    log::append(&h.path(), &entry_of("c1", create, Some(vec![drop_role("newbie"), drop_role("newbie_grp")]))).unwrap();
    let mut req = h.request(batch(vec![drop_role("newbie"), drop_role("newbie_grp")]));
    req.undo_of = vec!["c1".into()];
    req.confirm_text = Some("변경 2개 적용".into());
    let committed = commit(req, exec_with(&Steps::default(), Ok(())), never_reread()).await;
    assert!(committed.result.is_ok(), "{:?}", committed.result.err());
    let marked: Vec<Option<String>> = h.log().iter().filter(|e| e.id.starts_with("log-1")).map(|e| e.undo_of.clone()).collect();
    assert_eq!(marked, vec![Some("c1".to_string()), Some("c1".to_string())]);
}

#[tokio::test]
async fn a_single_undo_entry_marks_the_new_entry() {
    let h = created_newbie();
    let mut req = h.request(one(drop_role("newbie")));
    req.undo_of = vec!["c1".into()];
    req.confirm_text = Some("newbie".into());
    applied(commit(req, exec_with(&Steps::default(), Ok(())), never_reread()).await);
    assert_eq!(h.log().last().unwrap().undo_of.as_deref(), Some("c1"));
}

#[tokio::test]
async fn a_log_write_failure_keeps_the_variant_of_the_apply_error() {
    let h = Harness::new(admin_of(PG16, &["app_read"]));
    let mut req = h.request(one(add_carol()));
    // 파일 밑에는 폴더를 만들 수 없어서 기록이 실패한다
    fs::write(h.dir.path().join("blocker"), "x").unwrap();
    req.log_path = h.dir.path().join("blocker").join("db-changes.jsonl");
    let committed = commit(req, exec_with(&Steps::default(), Err(ExecError::Failed(AppError::Network { message: "끊겼어요".into() }))), never_reread()).await;
    match committed.result {
        Err(AppError::Network { message }) => assert!(message.starts_with("끊겼어요 (변경 기록을 저장하지 못했어요"), "{message}"),
        other => panic!("Network 오류여야 해요: {:?}", other.err()),
    }
}

#[tokio::test]
async fn an_unknown_create_with_a_password_asks_for_a_reset_too() {
    let hint = format!("{UNKNOWN} 비밀번호를 다시 재설정해 주세요");
    let h = Harness::new(admin(PG16));
    let committed = commit(h.request(one(create_login("newbie"))), exec_with(&Steps::default(), Err(ExecError::CommitUnknown)), reread_with(Err(AppError::other("읽지 못했어요")))).await;
    assert_eq!(failure(&committed), hint);
    assert_eq!(h.log()[0].error.as_deref(), Some(hint.as_str()));
    // 세 번째 상태도 같다
    let h = Harness::new(admin(PG16));
    let mut other = h.scene.cluster.clone();
    other.roles.push(role("stranger"));
    let committed = commit(h.request(one(create_login("newbie"))), exec_with(&Steps::default(), Err(ExecError::CommitUnknown)), reread_with(Ok((Arc::new(other), Arc::new(h.scene.db.clone()))))).await;
    assert_eq!(failure(&committed), hint);
    // 비밀번호 없는 역할 만들기는 힌트가 없다
    let h = Harness::new(admin(PG16));
    let plain = PgChange::CreateRole { name: "grp".into(), login: false, groups: Vec::new(), connection_limit: -1, valid_until: None, preset: None };
    let committed = commit(h.request(one(plain)), exec_with(&Steps::default(), Err(ExecError::CommitUnknown)), reread_with(Err(AppError::other("읽지 못했어요")))).await;
    assert_eq!(failure(&committed), UNKNOWN);
}

#[tokio::test]
async fn a_log_write_failure_is_told_for_the_errors_without_a_message_field_too() {
    for (error, text) in [(AppError::SsoExpired, "SSO 세션이 만료됐어요"), (AppError::Throttled, "요청이 너무 많아요")] {
        let h = Harness::new(admin_of(PG16, &["app_read"]));
        let mut req = h.request(one(add_carol()));
        fs::write(h.dir.path().join("blocker"), "x").unwrap();
        req.log_path = h.dir.path().join("blocker").join("db-changes.jsonl");
        let committed = commit(req, exec_with(&Steps::default(), Err(ExecError::Failed(error))), never_reread()).await;
        match committed.result {
            Err(AppError::Other { message }) => assert!(message.starts_with(&format!("{text} (변경 기록을 저장하지 못했어요")), "{message}"),
            other => panic!("기록을 저장하지 못했다는 말이 실려야 해요: {:?}", other.err()),
        }
    }
    // 기록이 저장되면 오류의 종류는 그대로다: 화면이 다시 로그인하게 한다
    let h = Harness::new(admin_of(PG16, &["app_read"]));
    let committed = commit(h.request(one(add_carol())), exec_with(&Steps::default(), Err(ExecError::Failed(AppError::SsoExpired))), never_reread()).await;
    assert_eq!(committed.result.err(), Some(AppError::SsoExpired));
}

// ───────────────────────── 세션 끊기 ─────────────────────────

const OWN_PID: i32 = 4242;
const OTHER_PID: i32 = 777;

fn live_session(pid: i32, role: &str) -> crate::pg::model::SessionRec {
    crate::pg::model::SessionRec {
        pid,
        role: Some(role.into()),
        database: Some("appdb".into()),
        client_addr: None,
        application_name: "psql".into(),
        state: Some("idle".into()),
        backend_start: Some("2026-10-29T00:00:00Z".into()),
        query_start: None,
        wait_event: None,
    }
}

/// `mm`은 `pg_signal_backend`의 구성원이고, `alice`의 세션과 이 앱의 세션이 있다
fn terminate_scene() -> Scene {
    let mut scene = admin(PG16).add_member(member_with("mm", "pg_signal_backend", true, true));
    scene.cluster.sessions = vec![live_session(OTHER_PID, "alice"), live_session(OWN_PID, "mm")];
    scene
}

fn terminate(pid: i32, role: &str) -> PgChange {
    PgChange::Terminate { pid, role: role.into(), backend_start: Some("2026-10-29T00:00:00Z".into()) }
}

/// 미리보기(`pg_preview`)와 같은 길로 계획을 만들고 `pg_apply`와 같은 길로 적용을 요청한다
fn terminate_request(h: &Harness, change: PgChange) -> PgRequest {
    let own = [OWN_PID];
    let context = PreviewCtx { cluster: &h.scene.cluster, db: &h.scene.db, own_pids: &own, read_replica: false, default_db: "appdb", now: NOW };
    let seen = Some(PgPlan::One(evaluate(&context, &change).preview));
    PgRequest { own_pids: own.to_vec(), seen, ..h.request(one(change)) }
}

#[tokio::test]
async fn ending_this_apps_own_session_is_blocked_in_the_preview_and_refused_at_apply() {
    let h = Harness::new(terminate_scene());
    let change = terminate(OWN_PID, "mm");
    let req = terminate_request(&h, change);
    let Some(PgPlan::One(preview)) = &req.seen else { panic!("미리보기") };
    assert!(preview.warnings.iter().any(|w| w.level == PgWarnLevel::Block && w.message == "이 앱의 세션은 끊을 수 없어요"), "{:?}", preview.warnings);
    let calls = Steps::default();
    let text = refusal(&commit(req, exec_with(&calls, Ok(())), never_reread()).await);
    assert_eq!(text, "막혀 있어서 적용할 수 없어요: 이 앱의 세션은 끊을 수 없어요");
    assert!(calls.lock().unwrap().is_empty() && h.log().is_empty());
}

#[tokio::test]
async fn ending_a_session_asks_for_its_role_as_the_confirmation_and_then_runs_the_guarded_statement() {
    let h = Harness::new(terminate_scene());
    let change = terminate(OTHER_PID, "alice");
    let mut req = terminate_request(&h, change.clone());
    let Some(PgPlan::One(preview)) = &req.seen else { panic!("미리보기") };
    assert_eq!(preview.confirm_text.as_deref(), Some("alice"));
    assert!(preview.warnings.iter().any(|w| w.level == PgWarnLevel::Confirm && w.message == "세션을 끊어요. 되돌릴 수 없어요"));
    assert!(!preview.reversible);

    // 확인 문구 없이는 돌리지 않는다
    let calls = Steps::default();
    assert_eq!(refusal(&commit(terminate_request(&h, change.clone()), exec_with(&calls, Ok(())), never_reread()).await), "확인 문구가 달라요. 입력해야 할 이름: alice");
    assert!(calls.lock().unwrap().is_empty());

    req.confirm_text = Some("alice".into());
    let result = applied(commit(req, exec_with(&calls, Ok(())), never_reread()).await);
    assert_eq!(result.summary, "세션 끊기: alice (pid 777)");
    let sent = calls.lock().unwrap().clone();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].len(), 1);
    let (sql, expect) = &sent[0][0];
    assert!(sql.starts_with("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = 777 AND usename = 'alice'"), "{sql}");
    assert_eq!(*expect, Some("세션이 이미 끝났어요"));
    let entry = &h.log()[0];
    assert!(entry.ok && entry.inverse.is_none() && entry.change == change);
}

#[tokio::test]
async fn a_session_that_is_gone_fails_with_the_expect_text() {
    let h = Harness::new(terminate_scene());
    let mut req = terminate_request(&h, terminate(OTHER_PID, "alice"));
    req.confirm_text = Some("alice".into());
    // 가짜 실행도 서버의 `exec`처럼 문장이 든 `expect`를 실패 문구로 쓴다(줄이 없을 때)
    let committed = commit(
        req,
        |steps: Vec<Step>| {
            let text = steps.iter().find_map(|s| s.expect).expect("확인 문구가 있어야 해요");
            ready(Err(ExecError::Failed(AppError::other(text))))
        },
        never_reread(),
    )
    .await;
    assert_eq!(failure(&committed), "세션이 이미 끝났어요");
    let entry = &h.log()[0];
    assert!(!entry.ok);
    assert_eq!(entry.error.as_deref(), Some("세션이 이미 끝났어요"));
}
