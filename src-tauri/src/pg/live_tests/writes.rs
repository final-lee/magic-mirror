//! `exec`가 진짜 서버(PG14·PG16)에서 한 트랜잭션으로 적용하고, 실패하면 아무것도 남기지 않는지 본다.
//! 로그인한 역할은 CREATEROLE만 있는 `mm_chg_admin`이고 비밀번호로 붙는다(앱의 실제 길은 IAM 토큰이지만 서버 쪽에서 보면 같은 로그인이다).
//! 시험이 만드는 역할은 `mm_w_`로 시작하고 끝에 지운다.

use std::time::{Duration, Instant};

use super::changes::{Env, ADMIN};
use super::*;
use crate::pg::change::model::{PgChange, PresetChoice, PresetKind};
use crate::pg::change::preview::{evaluate, evaluate_batch, PreviewCtx};
use crate::pg::change::resolve::{resolve, ResolveCtx};
use crate::pg::commit::{commit, PgChanges, PgCommitResult, PgPlan, PgRequest};
use crate::pg::exec::{self, ExecError, Step, LOCK_TEXT};

const SETUP: &str = r#"
    CREATE SCHEMA mm_w1 AUTHORIZATION mm_chg_admin;
    CREATE TABLE mm_w1.t1 (id integer);
    ALTER TABLE mm_w1.t1 OWNER TO mm_chg_admin;
"#;

fn step(sql: &str) -> Step {
    Step { run: sql.into(), expect: None }
}

/// 비밀번호로 붙은 앱 연결(알림 수신기까지 앱과 같다)
async fn app_connection(env: &Env, user: &str, password: &str) -> Connected {
    connected(&env.scene.config_as(user, password, "mm-live-exec")).await
}

async fn exists(env: &Env, role: &str) -> bool {
    env.admin.client.query_one("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)", &[&role]).await.unwrap().get(0)
}

async fn can_select(env: &Env, role: &str) -> bool {
    env.admin.client.query_one("SELECT has_table_privilege($1, 'mm_w1.t1', 'SELECT')", &[&role]).await.unwrap().get(0)
}

/// 소유한 테이블에 준 권한이 커밋되고 서버도 그렇게 본다
pub(super) async fn a_grant_commits_and_the_server_agrees(server: Server) {
    let mut env = Env::start(server, &[], SETUP).await;
    let mut conn = app_connection(&env, ADMIN, ADMIN).await;
    assert!(!can_select(&env, "app_read").await);
    exec::run(&mut conn, &[step("GRANT SELECT ON TABLE \"mm_w1\".\"t1\" TO \"app_read\"")]).await.expect("적용돼야 해요");
    assert!(can_select(&env, "app_read").await);
    env.cleanup(&[]).await;
}

/// 두 번째 문장이 실패하면(없는 역할에 권한) 첫 문장의 역할도 남지 않는다
pub(super) async fn a_run_that_fails_midway_leaves_nothing(server: Server) {
    let mut env = Env::start(server, &["mm_w_first"], SETUP).await;
    let mut conn = app_connection(&env, ADMIN, ADMIN).await;
    let outcome = exec::run(&mut conn, &[step("CREATE ROLE \"mm_w_first\" NOLOGIN"), step("GRANT SELECT ON TABLE \"mm_w1\".\"t1\" TO \"mm_w_missing\"")]).await;
    match outcome {
        Err(ExecError::Failed(AppError::Other { message })) => assert!(message.starts_with("적용하지 못했어요: ") && message.contains("mm_w_missing"), "{message}"),
        other => panic!("실패해야 해요: {other:?}"),
    }
    assert!(!exists(&env, "mm_w_first").await, "첫 문장의 역할이 남았어요");
    // 연결은 이어 쓸 수 있다
    exec::run(&mut conn, &[step("CREATE ROLE \"mm_w_first\" NOLOGIN")]).await.expect("되돌린 뒤 다시 쓸 수 있어야 해요");
    assert!(exists(&env, "mm_w_first").await);
    env.cleanup(&["mm_w_first"]).await;
}

/// 다른 연결이 객체를 잠그고 있으면 5초 안팎에 잠금 문구로 실패한다
pub(super) async fn a_lock_wait_fails_with_the_lock_text(server: Server) {
    let mut env = Env::start(server, &[], SETUP).await;
    let other = connected(&env.scene.config).await;
    other.client.batch_execute("BEGIN; GRANT SELECT ON mm_w1.t1 TO PUBLIC;").await.unwrap();
    let mut conn = app_connection(&env, ADMIN, ADMIN).await;
    let started = Instant::now();
    let outcome = exec::run(&mut conn, &[step("GRANT SELECT ON TABLE \"mm_w1\".\"t1\" TO \"app_read\"")]).await;
    let waited = started.elapsed();
    other.client.batch_execute("ROLLBACK").await.unwrap();
    assert_eq!(outcome, Err(ExecError::Failed(AppError::other(LOCK_TEXT))));
    assert!((Duration::from_secs(5)..Duration::from_secs(8)).contains(&waited), "{waited:?}");
    assert!(!can_select(&env, "app_read").await);
    env.cleanup(&[]).await;
}

/// 문장은 오류 없이 끝나지만 서버가 클래스 01 경고를 보내면(GRANT OPTION이 없다) 실패로 다루고 아무것도 주지 않는다
pub(super) async fn a_warning_notice_fails_the_run(server: Server) {
    let setup = format!("{SETUP}\nCREATE ROLE mm_w_holder LOGIN PASSWORD 'mm_w_holder'; GRANT CONNECT ON DATABASE {{db}} TO mm_w_holder; GRANT USAGE ON SCHEMA mm_w1 TO mm_w_holder; GRANT SELECT ON mm_w1.t1 TO mm_w_holder;");
    let mut env = Env::start(server, &["mm_w_holder"], &setup).await;
    let mut conn = app_connection(&env, "mm_w_holder", "mm_w_holder").await;
    let outcome = exec::run(&mut conn, &[step("GRANT SELECT ON TABLE \"mm_w1\".\"t1\" TO \"app_read\"")]).await;
    match outcome {
        Err(ExecError::Failed(AppError::Other { message })) => assert!(message.starts_with("적용하지 못했어요: ") && message.contains("no privileges were granted"), "{message}"),
        other => panic!("경고가 실패여야 해요: {other:?}"),
    }
    assert!(!can_select(&env, "app_read").await);
    env.cleanup(&["mm_w_holder"]).await;
}

/// 로그인 역할을 만들면 결과의 비밀번호로 붙을 수 있고 서버에는 SCRAM 검증값만 저장된다
pub(super) async fn a_created_login_gets_a_working_scram_password(server: Server) {
    // 프리셋 되돌리기 시험에 쓸 그룹: 로그인한 역할이 ADMIN OPTION을 가졌다(160000부터는 그것이 있어야 구성원을 넣을 수 있다)
    let setup = format!("{SETUP}\nCREATE ROLE mm_w_grp NOLOGIN; GRANT mm_w_grp TO mm_chg_admin WITH ADMIN OPTION;");
    let mut env = Env::start(server, &["mm_w_login", "mm_w_login2", "mm_w_grp"], &setup).await;
    let (cluster, db) = env.snapshots().await;
    let change = PgChange::CreateRole { name: "mm_w_login".into(), login: true, groups: Vec::new(), connection_limit: -1, valid_until: None, preset: None };
    let default_db = env.scene.database.clone();
    let own = [env.mm.pid];
    let ctx = PreviewCtx { cluster: &cluster, db: &db, own_pids: &own, read_replica: false, default_db: &default_db, now: clock::now_secs() };
    let seen = PgPlan::One(evaluate(&ctx, &change).preview);
    let dir = tempfile::tempdir().unwrap();
    let request = PgRequest {
        profile: "live".into(),
        target_arn: "arn:live".into(),
        login_user: ADMIN.into(),
        cluster: std::sync::Arc::new(cluster.clone()),
        db: std::sync::Arc::new(db.clone()),
        own_pids: own.to_vec(),
        read_replica: false,
        default_db,
        now: clock::now_secs(),
        changes: PgChanges::One(change),
        confirm_text: None,
        undo_of: Vec::new(),
        seen: Some(seen),
        log_path: dir.path().join("db-changes.jsonl"),
        log_id: "live-1".into(),
    };
    let mut conn = app_connection(&env, ADMIN, ADMIN).await;
    let committed = commit(request, |steps| async move { exec::run(&mut conn, &steps).await }, || async { Err(AppError::other("다시 읽지 않아요")) }).await;
    let Ok(PgCommitResult::One(result)) = committed.result else { panic!("적용돼야 해요: {:?}", committed.result.err()) };
    let password = result.password.clone().expect("비밀번호");
    assert_eq!(password.len(), 24);
    // 받은 비밀번호로 붙는다
    // 시험 데이터베이스는 PUBLIC의 CONNECT를 거뒀으니 기본 데이터베이스로 붙는다
    let mut config = env.scene.config_as("mm_w_login", &password, "mm-live-login");
    config.dbname("postgres");
    drop(connected(&config).await);
    let stored: String = env.admin.client.query_one("SELECT rolpassword FROM pg_authid WHERE rolname = 'mm_w_login'", &[]).await.unwrap().get(0);
    assert!(stored.starts_with("SCRAM-SHA-256$"), "{stored}");
    assert!(!stored.contains(&password));
    let logged = std::fs::read_to_string(dir.path().join("db-changes.jsonl")).unwrap();
    assert!(!logged.contains(&password) && !logged.contains("SCRAM"));

    // 이미 있는 그룹에 넣는 프리셋으로 만든 역할을 되돌린다: 만든 뒤 서버가 저절로 더한 구성원 관계(160000의 ADMIN 부여 등)가 허용 목록 안에 있어야 한다
    let preset = PresetChoice {
        preset: PresetKind::ReadOnly,
        database: Some(env.scene.database.clone()),
        schemas: vec!["mm_w1".into()],
        creators: Vec::new(),
        group: Some("mm_w_grp".into()),
        create_group: false,
    };
    let create = PgChange::CreateRole { name: "mm_w_login2".into(), login: true, groups: Vec::new(), connection_limit: -1, valid_until: None, preset: Some(preset) };
    let log_path = dir.path().join("db-changes.jsonl");
    let mut conn = app_connection(&env, ADMIN, ADMIN).await;
    let committed = commit(preset_request(&mut env, PgChanges::One(create), Vec::new(), None, &log_path, "live-2").await, |steps| async move { exec::run(&mut conn, &steps).await }, || async { Err(AppError::other("다시 읽지 않아요")) }).await;
    assert!(committed.result.is_ok(), "{:?}", committed.result.err());
    assert!(exists(&env, "mm_w_login2").await);
    let entries = crate::pg::log::read_all(&log_path);
    let undo = crate::pg::commit::undo_of(&entries, "live-2").expect("되돌릴 수 있어야 해요");
    assert_eq!(undo.undo_of, vec!["live-2".to_string()]);
    let changes = if undo.changes.len() == 1 { PgChanges::One(undo.changes[0].clone()) } else { PgChanges::Batch { database: undo.database.clone(), changes: undo.changes.clone() } };
    let mut conn = app_connection(&env, ADMIN, ADMIN).await;
    let undone = commit(preset_request(&mut env, changes, undo.undo_of.clone(), Some("mm_w_login2"), &log_path, "live-3").await, |steps| async move { exec::run(&mut conn, &steps).await }, || async { Err(AppError::other("다시 읽지 않아요")) }).await;
    assert!(undone.result.is_ok(), "되돌리기가 거부됐어요: {:?}", undone.result.err());
    assert!(!exists(&env, "mm_w_login2").await, "되돌리면 역할이 없어져요");
    assert!(crate::pg::log::read_all(&log_path).iter().any(|e| e.id == "live-2" && e.undone));
    env.cleanup(&["mm_w_login", "mm_w_login2", "mm_w_grp"]).await;
}

/// 지금 서버의 스냅숏으로 미리보기를 만들고, 그 계획으로 적용을 요청한다(`pg_preview` 다음 `pg_apply`와 같은 길)
async fn preset_request(env: &mut Env, changes: PgChanges, undo_of: Vec<String>, confirm: Option<&str>, log_path: &std::path::Path, log_id: &str) -> PgRequest {
    let (cluster, db) = env.snapshots().await;
    let default_db = env.scene.database.clone();
    let own = [env.mm.pid];
    let now = clock::now_secs();
    let ctx = PreviewCtx { cluster: &cluster, db: &db, own_pids: &own, read_replica: false, default_db: &default_db, now };
    let seen = match &changes {
        PgChanges::One(change) => PgPlan::One(evaluate(&ctx, change).preview),
        PgChanges::Batch { database, changes } => PgPlan::Batch(evaluate_batch(&ctx, database, changes).preview),
    };
    PgRequest {
        profile: "live".into(),
        target_arn: "arn:live".into(),
        login_user: ADMIN.into(),
        cluster: std::sync::Arc::new(cluster.clone()),
        db: std::sync::Arc::new(db.clone()),
        own_pids: own.to_vec(),
        read_replica: false,
        default_db,
        now,
        changes,
        confirm_text: confirm.map(str::to_string),
        undo_of,
        seen: Some(seen),
        log_path: log_path.to_path_buf(),
        log_id: log_id.into(),
    }
}

/// PG16: 구성원 관계를 거둘 때 `GRANTED BY`로 그 부여자의 줄만 지운다. 그 전 버전은 부여자를 따로 가리지 못하니 보지 않는다
pub(super) async fn a_membership_revoke_removes_only_the_named_grantors_row(server: Server) {
    if !server.has_membership_options() {
        return;
    }
    let setup = "CREATE ROLE mm_w_g NOLOGIN; CREATE ROLE mm_w_m NOLOGIN; GRANT mm_w_g TO mm_chg_admin WITH ADMIN OPTION; GRANT mm_w_g TO mm_w_m;";
    let roles = ["mm_w_g", "mm_w_m"];
    let mut env = Env::start(server, &roles, setup).await;
    let mut conn = app_connection(&env, ADMIN, ADMIN).await;
    // mm_chg_admin 자신의 줄을 더한다
    exec::run(&mut conn, &[step("GRANT \"mm_w_g\" TO \"mm_w_m\"")]).await.expect("부여");
    async fn rows(env: &Env) -> Vec<String> {
        let rows = env
            .admin
            .client
            .query("SELECT pg_get_userbyid(grantor) FROM pg_auth_members WHERE roleid = 'mm_w_g'::regrole AND member = 'mm_w_m'::regrole ORDER BY 1", &[])
            .await
            .unwrap();
        rows.iter().map(|r| r.get::<_, String>(0)).collect()
    }
    assert_eq!(rows(&env).await, vec![ADMIN.to_string(), "postgres".to_string()]);

    let (cluster, db) = env.snapshots().await;
    let change = PgChange::Membership { group: "mm_w_g".into(), member: "mm_w_m".into(), add: false, admin: false };
    let own = [env.mm.pid];
    let resolved = resolve(&ResolveCtx { cluster: &cluster, db: &db, own_pids: &own, read_replica: false }, &change);
    assert!(resolved.blocks.is_empty(), "{:?}", resolved.blocks);
    let steps: Vec<Step> = resolved.statements.iter().map(|s| Step { run: s.run(None), expect: s.expect }).collect();
    assert!(steps.iter().any(|s| s.run.contains("GRANTED BY")), "{:?}", steps.iter().map(|s| &s.run).collect::<Vec<_>>());
    exec::run(&mut conn, &steps).await.expect("거두기");
    assert_eq!(rows(&env).await, vec!["postgres".to_string()], "다른 부여자의 줄은 남아야 해요");
    env.cleanup(&roles).await;
}

/// `PgState::preview` 다음 `PgState::apply`: 미리보기가 기억한 계획을 적용이 꺼내 쓰고, 닫힘이 `exec`를 돌리고, 끝나면 읽어 둔 스냅숏이 새로고침된다.
/// AWS에는 닿지 않는다: 연결을 보관함에 미리 넣어 두면 명령은 새로 연결하지 않는다
pub(super) async fn preview_then_apply_runs_through_the_state(server: Server) {
    use crate::commands::AppState;
    use crate::aws::context::AwsContext;
    use crate::pg::pool::ConnKey;
    use crate::pg::target::{PgTarget, PgTargetInfo, TargetKind};
    use crate::pg_commands::PgState;

    let mut env = Env::start(server, &[], SETUP).await;
    let (cluster, _) = env.snapshots().await;
    let target = PgTarget { profile: "dev".into(), region: "ap-northeast-2".into(), kind: TargetKind::Cluster, id: "live-writes".into() };
    let info = PgTargetInfo {
        arn: "arn:aws:rds:ap-northeast-2:123456789012:cluster:live-writes".into(),
        identifier: "live-writes".into(),
        kind: TargetKind::Cluster,
        engine: "aurora-postgresql".into(),
        engine_version: format!("{}.0", server.major()),
        endpoint: "127.0.0.1".into(),
        port: 5432,
        default_database: env.scene.database.clone(),
        iam_auth: true,
        read_replica: false,
    };
    let dir = tempfile::tempdir().unwrap();
    let state = PgState::new(dir.path().join("db-changes.jsonl"));
    let epoch = state.open_for_tests(&target, ADMIN.into(), info, std::sync::Arc::new(cluster)).expect("열기");
    let held = app_connection(&env, ADMIN, ADMIN).await;
    let key = ConnKey { target: target.clone(), user: ADMIN.into(), database: env.scene.database.clone() };
    state.pool.get_or_connect_at_epoch(key, epoch, || async { Ok(held) }).await.expect("보관함에 넣지 못했어요");
    let app = AppState { ctx: AwsContext::default(), adapters: Vec::new(), settings_path: std::path::PathBuf::new(), sso: Default::default() };

    let change = PgChange::Grant {
        database: env.scene.database.clone(),
        grantee: "app_read".into(),
        add: true,
        items: vec![crate::pg::change::model::GrantItem {
            target: crate::pg::change::model::GrantTarget::Relation { schema: "mm_w1".into(), name: "t1".into() },
            privileges: vec![Privilege::Select],
        }],
    };
    // 미리보기 없이는 적용하지 않는다
    let refused = state.apply_for_tests(&app, &target, change.clone(), None).await;
    assert_eq!(refused.err(), Some(AppError::other("미리보기 뒤에 바뀌었어요. 미리보기를 다시 받아 주세요")));
    assert!(!can_select(&env, "app_read").await);

    let shown = state.preview_for_tests(&app, &target, change.clone()).await.expect("미리보기");
    assert_eq!(shown.login_user, ADMIN);
    assert!(!can_select(&env, "app_read").await, "미리보기는 아무것도 바꾸지 않아요");
    let Ok(PgCommitResult::One(result)) = state.apply_for_tests(&app, &target, change.clone(), None).await else { panic!("적용돼야 해요") };
    assert!(can_select(&env, "app_read").await);
    assert_eq!(result.summary, shown.summary);
    // 끝난 뒤 읽어 둔 데이터베이스 스냅숏이 새로고침됐다
    let kept = state.kept_db_for_tests(&target, &env.scene.database).expect("읽어 둔 스냅숏");
    let rel = kept.relations.iter().find(|r| r.schema == "mm_w1" && r.name == "t1").expect("t1");
    assert!(rel.acl.iter().any(|e| e.grantee.as_deref() == Some("app_read") && e.privilege == Privilege::Select), "{:?}", rel.acl);
    // 계획은 한 번만 쓴다
    assert!(state.apply_for_tests(&app, &target, change, None).await.is_err());
    let entries = crate::pg::log::read_all(&dir.path().join("db-changes.jsonl"));
    assert_eq!(entries.len(), 1);
    assert!(entries[0].ok);
    env.cleanup(&[]).await;
}
