//! 역할 삭제와 세션 끊기를 진짜 서버(PG14·PG16)에서 본다. 로그인한 역할은 CREATEROLE만 있는 `mm_chg_admin`이고(160000부터는 `mm_drop`의 ADMIN OPTION만 있다),
//! 삭제할 역할은 `mm_drop`이다. 삭제 시험은 `PgState`를 거친다: 계획을 새로 읽고, 본 계획과 견주고, 데이터베이스마다 돌리고, 기록을 남기고, 읽어 둔 스냅숏을 버린다.
//! AWS에는 닿지 않는다: 연결을 보관함에 미리 넣어 두면 명령은 새로 연결하지 않는다.
//! 계획은 서버에 있는 모든 데이터베이스를 한 단계씩 지나니, 로그인한 역할이 모든 데이터베이스에 붙을 수 있게 CONNECT를 준다(시험이 끝나면 `DROP OWNED`가 거둔다).

use std::sync::Arc;

use super::changes::{Env, ADMIN};
use super::*;
use crate::aws::context::AwsContext;
use crate::commands::AppState;
use crate::pg::change::model::PgChange;
use crate::pg::change::preview::{evaluate, PreviewCtx};
use crate::pg::commit::{commit, PgChanges, PgCommitResult, PgPlan, PgRequest};
use crate::pg::exec::{self, ExecError, LOCK_TEXT};
use crate::pg::pool::ConnKey;
use crate::pg::target::{PgTarget, PgTargetInfo, TargetKind};
use crate::pg_commands::PgState;

const ROLE: &str = "mm_drop";

/// 로그인한 역할이 서버의 모든 데이터베이스에 붙을 수 있게 한다
const CONNECT_EVERYWHERE: &str = r#"
DO $grant$
DECLARE d text;
BEGIN
  FOR d IN SELECT datname FROM pg_database WHERE datallowconn LOOP
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO mm_chg_admin', d);
  END LOOP;
END
$grant$;
"#;

/// 장면: 시험 데이터베이스에 `mm_drop`이 가진 테이블, 로그인한 역할의 ADMIN OPTION(160000부터)
fn setup(server: Server) -> String {
    let admin_option = if server.has_membership_options() { "GRANT mm_drop TO mm_chg_admin WITH ADMIN OPTION, INHERIT FALSE, SET FALSE;" } else { "" };
    format!(
        "CREATE ROLE mm_drop NOLOGIN;
         {admin_option}
         CREATE SCHEMA mm_d1;
         CREATE TABLE mm_d1.t1 (id integer);
         ALTER TABLE mm_d1.t1 OWNER TO mm_drop;
         {CONNECT_EVERYWHERE}"
    )
}

/// `PgState`를 열어 두고 서버의 모든 데이터베이스에 로그인한 역할의 연결을 보관함에 넣어 둔다
struct Rig {
    state: PgState,
    app: AppState,
    target: PgTarget,
    dir: tempfile::TempDir,
}

impl Rig {
    async fn open(env: &mut Env, server: Server) -> Rig {
        let (cluster, _) = env.snapshots().await;
        let target = PgTarget { profile: "dev".into(), region: "ap-northeast-2".into(), kind: TargetKind::Cluster, id: "live-drops".into() };
        let info = PgTargetInfo {
            arn: "arn:aws:rds:ap-northeast-2:123456789012:cluster:live-drops".into(),
            identifier: "live-drops".into(),
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
        let databases: Vec<String> = cluster.databases.iter().filter(|d| d.allow_conn).map(|d| d.name.clone()).collect();
        let epoch = state.open_for_tests(&target, ADMIN.into(), info, Arc::new(cluster)).expect("열기");
        for database in databases {
            let mut config = env.scene.config_as(ADMIN, ADMIN, "mm-live-drop");
            config.dbname(&database);
            let held = connected(&config).await;
            let key = ConnKey { target: target.clone(), user: ADMIN.into(), database };
            state.pool.get_or_connect_at_epoch(key, epoch, || async { Ok(held) }).await.expect("보관함에 넣지 못했어요");
        }
        let app = AppState { ctx: AwsContext::default(), adapters: Vec::new(), settings_path: std::path::PathBuf::new(), sso: Default::default() };
        Rig { state, app, target, dir }
    }

    fn log(&self) -> Vec<crate::pg::log::PgLogEntry> {
        crate::pg::log::read_all(&self.dir.path().join("db-changes.jsonl"))
    }
}

async fn role_exists(env: &Env, role: &str) -> bool {
    env.admin.client.query_one("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)", &[&role]).await.unwrap().get(0)
}

/// 역할의 이름이 든 곳: 소유자, ACL의 받는 쪽과 부여자, 기본 권한의 기록. 데이터베이스의 ACL은 모든 데이터베이스의 것을 본다
fn traces(cluster: &ClusterSnapshot, db: &DbSnapshot, role: &str) -> Vec<String> {
    let named = |acl: &[AclEntry]| acl.iter().any(|e| e.grantor == role || e.grantee.as_deref() == Some(role));
    let mut found = Vec::new();
    for d in &cluster.databases {
        if d.owner == role || named(&d.acl) {
            found.push(format!("데이터베이스 {}", d.name));
        }
    }
    found.extend(db.schemas.iter().filter(|s| s.owner == role || named(&s.acl)).map(|s| format!("스키마 {}", s.name)));
    found.extend(db.relations.iter().filter(|r| r.owner == role || named(&r.acl)).map(|r| format!("{}.{}", r.schema, r.name)));
    found.extend(db.functions.iter().filter(|f| f.owner == role || named(&f.acl)).map(|f| format!("{}.{}", f.schema, f.name)));
    found.extend(db.default_acls.iter().filter(|d| d.creator == role || named(&d.acl)).map(|d| format!("기본 권한 {} {:?}", d.creator, d.schema)));
    found
}

fn blocks(plan: &crate::pg::view::PgDropPlan) -> Vec<String> {
    plan.warnings.iter().filter(|w| w.level == crate::pg::view::PgWarnLevel::Block).map(|w| w.message.clone()).collect()
}

/// 소유한 테이블과 받은 권한과 기본 권한이 있는 역할을 두 데이터베이스에서 지운다. 끝나면 역할은 없고, 테이블은 로그인한 역할의 것이고,
/// 어느 ACL에도 그 이름이 없다. 160000부터는 그 역할이 준 구성원 관계가 계획에 보이고(`lost`), 끝나면 사라진다
pub(super) async fn a_role_is_dropped_in_every_database_and_leaves_no_trace(server: Server) {
    let mut env = Env::start(server, &[ROLE], &setup(server)).await;
    let other = format!("{}_b", env.scene.database);
    env.admin.client.batch_execute(&format!("CREATE DATABASE {other} OWNER app_owner")).await.unwrap();
    let mut other_config = env.scene.config.clone();
    other_config.dbname(&other);
    let mut other_admin = connected(&other_config).await;
    other_admin
        .client
        .batch_execute(
            "CREATE SCHEMA mo AUTHORIZATION mm_chg_admin;
             CREATE TABLE mo.t2 (id integer);
             ALTER TABLE mo.t2 OWNER TO mm_chg_admin;
             GRANT SELECT ON mo.t2 TO mm_drop;
             ALTER DEFAULT PRIVILEGES FOR ROLE mm_chg_admin IN SCHEMA mo GRANT SELECT ON TABLES TO mm_drop;",
        )
        .await
        .unwrap();
    if server.has_membership_options() {
        env.admin.client.batch_execute("GRANT app_read TO mm_drop WITH ADMIN OPTION; GRANT app_read TO carol GRANTED BY mm_drop;").await.unwrap();
    }

    let rig = Rig::open(&mut env, server).await;
    let plan = rig.state.drop_plan_for_tests(&rig.app, &rig.target, ROLE, ADMIN).await.expect("계획");
    assert!(blocks(&plan).is_empty(), "{:?}", blocks(&plan));
    let first = plan.steps.iter().find(|s| s.database.as_deref() == Some(env.scene.database.as_str())).expect("시험 데이터베이스의 단계");
    let membership = if server.has_membership_options() { "GRANT \"mm_drop\" TO \"mm_chg_admin\" WITH INHERIT TRUE" } else { "GRANT \"mm_drop\" TO \"mm_chg_admin\"" };
    assert_eq!(first.sql[0], membership);
    assert_eq!((first.owned, first.privileges, first.defaults), (1, 0, 0));
    let second = plan.steps.iter().find(|s| s.database.as_deref() == Some(other.as_str())).expect("둘째 데이터베이스의 단계");
    assert_eq!((second.owned, second.privileges, second.defaults), (0, 1, 1));
    if server.has_membership_options() {
        assert_eq!(plan.granted_memberships.iter().map(|m| (m.member.as_str(), m.group.as_str(), m.lost)).collect::<Vec<_>>(), [("carol", "app_read", true)]);
    } else {
        assert!(plan.granted_memberships.is_empty());
    }

    let result = rig.state.apply_drop_for_tests(&rig.app, &rig.target, ROLE, ADMIN, Some(ROLE.into())).await.expect("삭제");
    assert_eq!(result.stopped, None, "{result:?}");
    assert_eq!((result.total, result.done), (plan.steps.len() - 1, plan.steps.len() - 1));

    assert!(!role_exists(&env, ROLE).await);
    let (cluster, scene_db) = env.snapshots().await;
    let owner = scene_db.relations.iter().find(|r| r.schema == "mm_d1" && r.name == "t1").map(|r| r.owner.clone());
    assert_eq!(owner.as_deref(), Some(ADMIN), "테이블은 넘겨받은 역할의 것이에요");
    assert_eq!(traces(&cluster, &scene_db, ROLE), Vec::<String>::new());
    let other_db = db_snapshot(&mut other_admin, &other).await.expect("둘째 데이터베이스");
    assert_eq!(traces(&cluster, &other_db, ROLE), Vec::<String>::new());
    assert!(other_db.default_acls.iter().all(|d| d.acl.iter().all(|e| e.grantee.as_deref() != Some(ROLE))));
    if server.has_membership_options() {
        assert!(!cluster.members.iter().any(|m| m.member == "carol" && m.group == "app_read"), "그 역할이 준 구성원 관계는 사라져요");
    }
    // 구성원 관계는 남지 않았다
    assert!(!cluster.members.iter().any(|m| m.group == ROLE));
    // 기록 하나, 되돌릴 수 없다. 건드린 데이터베이스의 읽어 둔 스냅숏은 버려졌다
    let entries = rig.log();
    assert_eq!(entries.len(), 1);
    assert!(entries[0].ok && entries[0].inverse.is_none());
    assert_eq!(entries[0].change, PgChange::DropRole { role: ROLE.into() });
    assert_eq!(entries[0].sql.len(), plan.steps.iter().map(|s| s.sql.len()).sum::<usize>());
    for step in &plan.steps {
        let database = step.database.clone().unwrap_or_else(|| env.scene.database.clone());
        assert!(rig.state.kept_db_for_tests(&rig.target, &database).is_none(), "{database}의 스냅숏이 남았어요");
    }
    // 같은 계획은 한 번만 쓴다
    assert!(rig.state.apply_drop_for_tests(&rig.app, &rig.target, ROLE, ADMIN, Some(ROLE.into())).await.is_err());

    rig.state.close(&rig.target);
    drop(other_admin);
    env.admin.client.batch_execute(&format!("DROP DATABASE {other} WITH (FORCE)")).await.unwrap();
    env.cleanup(&[ROLE]).await;
}

/// 로그인한 역할이 뺄 수 없는 권한이 남을 때: 계획이 막고, 그 문장을 그래도 돌리면 서버도 멈춘다(경고나 권한 오류로). 막혀도 아무것도 바뀌지 않는다
pub(super) async fn a_privilege_that_would_stay_blocks_the_plan_and_the_server_stops_too(server: Server) {
    let extra = "CREATE TABLE mm_d1.t3 (id integer); ALTER TABLE mm_d1.t3 OWNER TO app_owner; GRANT SELECT ON mm_d1.t3 TO mm_drop;";
    let mut env = Env::start(server, &[ROLE], &format!("{}\n{extra}", setup(server))).await;
    let rig = Rig::open(&mut env, server).await;
    let plan = rig.state.drop_plan_for_tests(&rig.app, &rig.target, ROLE, ADMIN).await.expect("계획");
    assert_eq!(
        blocks(&plan),
        vec!["mm_drop 역할이 받은 권한 중 로그인한 역할이 뺄 수 없는 것이 있어요(1개, 예: mm_d1.t3 SELECT). 준 역할: app_owner".to_string()]
    );
    let refused = rig.state.apply_drop_for_tests(&rig.app, &rig.target, ROLE, ADMIN, Some(ROLE.into())).await.expect_err("막혀야 해요");
    assert!(refused.to_string().starts_with("막혀 있어서 적용할 수 없어요: "), "{refused}");
    assert!(role_exists(&env, ROLE).await);
    assert!(rig.log().is_empty(), "거부된 삭제는 기록이 없어요");

    // 예측이 서버와 같다: 그 단계의 문장을 그대로 돌리면 서버가 멈춘다
    let step = plan.steps.iter().find(|s| s.database.as_deref() == Some(env.scene.database.as_str())).expect("시험 데이터베이스의 단계");
    let mut config = env.scene.config_as(ADMIN, ADMIN, "mm-live-drop-run");
    config.dbname(&env.scene.database);
    let mut conn = connected(&config).await;
    let steps: Vec<exec::Step> = step.sql.iter().map(|run| exec::Step { run: run.clone(), expect: None }).collect();
    match exec::run(&mut conn, &steps).await {
        Err(ExecError::Failed(AppError::Other { message })) => {
            assert!(message.starts_with("적용하지 못했어요: ") && (message.contains("no privileges could be revoked") || message.contains("permission denied")), "{message}")
        }
        other => panic!("서버가 멈춰야 해요: {other:?}"),
    }
    // 멈추면 단계 안에서 받은 구성원 관계도 남지 않는다
    let members: i64 = env.admin.client.query_one("SELECT count(*) FROM pg_auth_members WHERE roleid = 'mm_drop'::regrole AND member = 'mm_chg_admin'::regrole AND NOT admin_option", &[]).await.unwrap().get(0);
    assert_eq!(members, 0, "구성원 관계가 남았어요");
    let acl: i64 = env.admin.client.query_one("SELECT count(*) FROM information_schema.table_privileges WHERE table_schema = 'mm_d1' AND table_name = 't3' AND grantee = 'mm_drop'", &[]).await.unwrap().get(0);
    assert_eq!(acl, 1, "권한은 그대로예요");
    rig.state.close(&rig.target);
    drop(conn);
    env.cleanup(&[ROLE]).await;
}

/// 다른 연결이 테이블을 잠그고 있으면 그 데이터베이스 단계에서 잠금 문구로 멈춘다. 앞선 데이터베이스는 정리됐고 역할은 남는다
pub(super) async fn a_lock_stops_the_drop_at_its_database_and_the_role_stays(server: Server) {
    let mut env = Env::start(server, &[ROLE], &setup(server)).await;
    let rig = Rig::open(&mut env, server).await;
    let plan = rig.state.drop_plan_for_tests(&rig.app, &rig.target, ROLE, ADMIN).await.expect("계획");
    assert!(blocks(&plan).is_empty(), "{:?}", blocks(&plan));
    let total = plan.steps.len() - 1;
    let at = plan.steps.iter().position(|s| s.database.as_deref() == Some(env.scene.database.as_str())).expect("시험 데이터베이스의 단계");

    let holder = connected(&env.scene.config).await;
    holder.client.batch_execute("BEGIN; LOCK TABLE mm_d1.t1 IN ACCESS SHARE MODE;").await.unwrap();
    let result = rig.state.apply_drop_for_tests(&rig.app, &rig.target, ROLE, ADMIN, Some(ROLE.into())).await;
    holder.client.batch_execute("ROLLBACK").await.unwrap();
    let result = result.expect("멈춘 삭제도 결과를 돌려줘요");
    assert_eq!(result.stopped, Some(format!("{total}개 데이터베이스 중 {at}개를 정리하고 멈췄어요: {LOCK_TEXT}")));
    assert_eq!((result.total, result.done), (total, at));
    assert!(role_exists(&env, ROLE).await, "멈춘 삭제는 역할을 지우지 않아요");
    // 멈춘 단계는 되돌려졌다: 테이블은 아직 mm_drop의 것이고 구성원 관계도 남지 않았다
    let (cluster, scene_db) = env.snapshots().await;
    let owner = scene_db.relations.iter().find(|r| r.schema == "mm_d1" && r.name == "t1").map(|r| r.owner.clone());
    assert_eq!(owner.as_deref(), Some(ROLE));
    assert!(!cluster.members.iter().any(|m| m.group == ROLE && m.member == ADMIN && !m.admin), "{:?}", cluster.members.iter().filter(|m| m.group == ROLE).collect::<Vec<_>>());
    let entries = rig.log();
    assert_eq!(entries.len(), 1);
    assert!(!entries[0].ok && entries[0].error == result.stopped);
    rig.state.close(&rig.target);
    env.cleanup(&[ROLE]).await;
}

/// 다른 연결로 `bob`이 붙어 있다. 변경을 거치는 길(`commit`)로 끊으면 그 pid가 2초 안에 사라진다
pub(super) async fn a_session_is_ended_through_the_commit_flow(server: Server) {
    let setup = "GRANT pg_signal_backend TO mm_chg_admin; ALTER ROLE bob PASSWORD 'bob';";
    let mut env = Env::start(server, &[], setup).await;
    // 시험 데이터베이스는 PUBLIC의 CONNECT를 거뒀으니 bob은 `postgres`에 붙는다
    let mut config = env.scene.config_as("bob", "bob", "mm-live-bob");
    config.dbname("postgres");
    let bob = connected(&config).await;
    let pid = bob.backend_pid;

    // 스냅숏은 로그인한 역할의 연결로 읽는다(앱과 같다): superuser가 읽으면 다른 역할 세션의 시작 시각이 보이는데, 로그인한 역할의 문장은 그것을 볼 수 없다
    let mut reader = connected(&env.scene.config_as(ADMIN, ADMIN, "mm-live-reader")).await;
    let cluster = cluster_snapshot(&mut reader, ADMIN).await.expect("클러스터 스냅숏을 읽지 못했어요");
    let db = db_snapshot(&mut reader, &env.scene.database).await.expect("데이터베이스 스냅숏을 읽지 못했어요");
    let session = cluster.sessions.iter().find(|s| s.pid == pid).expect("bob의 세션이 스냅숏에 있어야 해요");
    assert_eq!(session.backend_start, None, "pg_read_all_stats가 없으면 다른 역할 세션의 시작 시각은 보이지 않아요");
    assert_eq!(session.role.as_deref(), Some("bob"));
    let change = PgChange::Terminate { pid, role: "bob".into(), backend_start: session.backend_start.clone() };
    let own = [env.mm.pid];
    let default_db = env.scene.database.clone();
    let now = clock::now_secs();
    let context = PreviewCtx { cluster: &cluster, db: &db, own_pids: &own, read_replica: false, default_db: &default_db, now };
    let preview = evaluate(&context, &change).preview;
    assert!(preview.warnings.iter().all(|w| w.level != crate::pg::view::PgWarnLevel::Block), "{:?}", preview.warnings);
    assert_eq!(preview.confirm_text.as_deref(), Some("bob"));
    let dir = tempfile::tempdir().unwrap();
    let request = PgRequest {
        profile: "live".into(),
        target_arn: "arn:live".into(),
        login_user: ADMIN.into(),
        cluster: Arc::new(cluster.clone()),
        db: Arc::new(db.clone()),
        own_pids: own.to_vec(),
        read_replica: false,
        default_db,
        now,
        changes: PgChanges::One(change),
        confirm_text: Some("bob".into()),
        undo_of: Vec::new(),
        seen: Some(PgPlan::One(preview)),
        log_path: dir.path().join("db-changes.jsonl"),
        log_id: "live-terminate".into(),
    };
    let mut conn = connected(&env.scene.config_as(ADMIN, ADMIN, "mm-live-exec")).await;
    let committed = commit(request, |steps| async move { exec::run(&mut conn, &steps).await }, || async { Err(AppError::other("다시 읽지 않아요")) }).await;
    let Ok(PgCommitResult::One(result)) = committed.result else { panic!("적용돼야 해요: {:?}", committed.result.err()) };
    assert_eq!(result.summary, format!("세션 끊기: bob (pid {pid})"));

    let mut gone = false;
    for _ in 0..20 {
        let rows = env.admin.client.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1", &[&pid]).await.unwrap();
        if rows.is_empty() {
            gone = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(gone, "2초 안에 세션이 사라져야 해요");
    assert!(bob.client.is_closed());
    // 이미 끝난 세션을 다시 끊으면 줄이 없어서 `expect`의 문구로 실패한다
    let (cluster, db) = env.snapshots().await;
    let again = PgChange::Terminate { pid, role: "bob".into(), backend_start: None };
    let own = [env.mm.pid];
    let default_db = env.scene.database.clone();
    let context = PreviewCtx { cluster: &cluster, db: &db, own_pids: &own, read_replica: false, default_db: &default_db, now: clock::now_secs() };
    let evaluated = evaluate(&context, &again);
    let statement = evaluated.statements.first().expect("문장");
    let mut raw = connected(&env.scene.config_as(ADMIN, ADMIN, "mm-live-exec")).await;
    let outcome = exec::run(&mut raw, &[exec::Step { run: statement.run(None), expect: statement.expect }]).await;
    assert_eq!(outcome, Err(ExecError::Failed(AppError::other("세션이 이미 끝났어요"))));
    env.cleanup(&[]).await;
}
