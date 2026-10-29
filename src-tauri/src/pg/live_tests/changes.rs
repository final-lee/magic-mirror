//! 변경의 예측이 진짜 서버(PG14·PG16)와 같은지 본다. 각 경우는 이렇게 간다:
//! 1. 지금의 스냅숏으로 `resolve`한다(로그인한 역할은 CREATEROLE만 있는 `mm_admin`이다).
//! 2. `after::apply`로 예측한 스냅숏을 만든다.
//! 3. 풀린 문장을 `mm_admin`으로 한 트랜잭션에 돌려 커밋한다(비밀번호 자리는 새로 만든 비밀번호의 검증값으로).
//! 4. 스냅숏을 다시 읽어 예측과 비교한다: 역할, 구성원 관계(부여 줄까지), 모든 ACL, 기본 권한.
//!
//! 막히는 경우(`blocked_rights_fail_on_the_server_too`)는 문장을 그래도 돌려서 서버가 오류를 내거나 클래스 01 경고를 보내는지 본다:
//! 앱은 그 경고를 실패로 보고 되돌린다(그래서 `exec`가 클래스 01을 실패로 다룬다).
//! 이 시험이 만드는 역할은 `mm_chg_`로 시작하고 시험이 끝날 때 지운다. 객체는 시험 데이터베이스(시험마다 새로 만든다)에만 둔다.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use futures::future::poll_fn;
use tokio_postgres::{AsyncMessage, Client};

use super::*;
use crate::pg::change::after::apply;
use crate::pg::change::model::{AttributesSet, GrantItem, GrantTarget, PgChange, PresetChoice, PresetKind};
use crate::pg::change::resolve::{resolve, ResolveCtx, Resolved};
use crate::pg::change::sql_text::{Part, Statement};
use crate::pg::password::NewPassword;
use crate::pg::sql::{ident, literal};

use Privilege::{Insert, Select, Update, Usage};

const ADMIN: &str = "mm_chg_admin";

/// 서버에 붙은 연결 하나와, 그 연결이 받은 알림(`SQLSTATE: 문구`)
struct Session {
    client: Client,
    notices: Arc<Mutex<Vec<String>>>,
    pid: i32,
}

async fn session(scene: &Scene, user: &str, password: &str) -> Session {
    let (client, mut connection) = scene.config_as(user, password, "mm-live-changes").connect(NoTls).await.unwrap_or_else(|e| panic!("{user}로 붙지 못했어요: {e}"));
    let notices = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&notices);
    tokio::spawn(async move {
        while let Some(Ok(message)) = poll_fn(|cx| connection.poll_message(cx)).await {
            if let AsyncMessage::Notice(notice) = message {
                sink.lock().unwrap().push(format!("{}: {}", notice.code().code(), notice.message()));
            }
        }
    });
    let pid: i32 = client.query_one("SELECT pg_backend_pid()", &[]).await.expect("pid를 읽지 못했어요").get(0);
    Session { client, notices, pid }
}

/// 풀린 문장들을 한 트랜잭션에 돌린다. 하나라도 실패하면 되돌리고 오류 문구를 돌려준다. 성공하면 커밋하고 받은 알림을 돌려준다
async fn run_in_transaction(session: &Session, statements: &[Statement]) -> Result<Vec<String>, String> {
    session.notices.lock().unwrap().clear();
    session.client.batch_execute("BEGIN").await.map_err(|e| e.to_string())?;
    for statement in statements {
        let hash = statement.parts.contains(&Part::Password).then(|| NewPassword::generate().scram());
        // 돌린 글에는 검증값이 들어 있다. 실패 문구에는 가린 글을 쓴다
        let outcome: Result<(), String> = match statement.expect {
            // exec와 같다: 첫 줄의 첫 칸이 `true`가 아니면 문장이 가진 문구로 실패한다
            Some(text) => match session.client.query(&statement.run(hash.as_ref()), &[]).await {
                Ok(rows) if rows.first().is_some_and(|row| row.try_get::<_, bool>(0).unwrap_or(false)) => Ok(()),
                Ok(_) => Err(text.to_string()),
                Err(e) => Err(describe(&e)),
            },
            None => session.client.batch_execute(&statement.run(hash.as_ref())).await.map_err(|e| describe(&e)),
        };
        if let Err(reason) = outcome {
            let _ = session.client.batch_execute("ROLLBACK").await;
            return Err(format!("{}: {reason}", statement.shown()));
        }
    }
    session.client.batch_execute("COMMIT").await.map_err(|e| e.to_string())?;
    let notices = session.notices.lock().unwrap().clone();
    Ok(notices)
}

fn describe(error: &tokio_postgres::Error) -> String {
    error.as_db_error().map_or_else(|| error.to_string(), |db| format!("{} {}", db.code().code(), db.message()))
}

// ───────────────────────── 스냅숏 비교 ─────────────────────────

fn acl_lines(owner: &str, label: &str, acl: &[AclEntry]) -> Vec<String> {
    let mut lines: Vec<String> =
        acl.iter().map(|e| format!("{label} acl {} -> {} {} grantable={}", e.grantor, e.grantee.as_deref().unwrap_or("PUBLIC"), e.privilege.as_str(), e.grantable)).collect();
    lines.push(format!("{label} owner {owner}"));
    lines
}

/// 스냅숏을 순서와 OID와 읽은 시각에 상관없이 비교할 수 있는 줄들로 바꾼다
fn digest(cluster: &ClusterSnapshot, db: &DbSnapshot) -> BTreeSet<String> {
    let mut lines = BTreeSet::new();
    for r in &cluster.roles {
        lines.insert(format!(
            "role {} login={} inherit={} createrole={} createdb={} repl={} bypassrls={} super={} limit={} until={:?} comment={:?}",
            r.name, r.login, r.inherit, r.create_role, r.create_db, r.replication, r.bypass_rls, r.superuser, r.conn_limit, r.valid_until, r.comment
        ));
    }
    for m in &cluster.members {
        lines.insert(format!("member {} -> {} admin={} inherit={:?} set={:?}", m.member, m.group, m.admin, m.inherit, m.set));
        for g in &m.grants {
            lines.insert(format!("grant {} -> {} by {} admin={} inherit={:?} set={:?}", m.member, m.group, g.grantor, g.admin, g.inherit, g.set));
        }
    }
    for d in &cluster.databases {
        lines.extend(acl_lines(&d.owner, &format!("database {}", d.name), &d.acl));
    }
    for s in &db.schemas {
        lines.extend(acl_lines(&s.owner, &format!("schema {}", s.name), &s.acl));
    }
    for r in &db.relations {
        lines.extend(acl_lines(&r.owner, &format!("relation {}.{} {:?}", r.schema, r.name, r.kind), &r.acl));
    }
    for f in &db.functions {
        lines.extend(acl_lines(&f.owner, &format!("function {}.{}({})", f.schema, f.name, f.signature), &f.acl));
    }
    for d in &db.default_acls {
        lines.extend(acl_lines("-", &format!("default {} {:?} {:?}", d.creator, d.schema, d.obj_type), &d.acl));
        lines.insert(format!("default record {} {:?} {:?}", d.creator, d.schema, d.obj_type));
    }
    lines
}

fn assert_same(label: &str, predicted: &BTreeSet<String>, actual: &BTreeSet<String>) {
    let only_predicted: Vec<_> = predicted.difference(actual).collect();
    let only_actual: Vec<_> = actual.difference(predicted).collect();
    assert!(only_predicted.is_empty() && only_actual.is_empty(), "{label}\n예측에만 있는 것: {only_predicted:#?}\n서버에만 있는 것: {only_actual:#?}");
}

// ───────────────────────── 한 경우의 환경 ─────────────────────────

struct Env {
    scene: Scene,
    /// superuser로 붙은 연결: 장면을 차리고 스냅숏을 읽는다
    admin: Connected,
    /// 로그인한 역할(`ADMIN`)로 붙은 연결
    mm: Session,
}

impl Env {
    /// 지난 시험이 남긴 같은 이름의 역할을 지우고 `mm_chg_admin`을 만든다. 장면 SQL(`setup`)을 superuser로 돌린 뒤 그 역할로 붙는다
    async fn start(server: Server, roles: &[&str], setup: &str) -> Env {
        let scene = seed(server).await;
        let admin = scene.connect().await;
        let mut all = vec![ADMIN];
        all.extend(roles);
        for name in all.iter().rev() {
            reset_role(&admin, name).await;
        }
        let mut sql = format!("CREATE ROLE {} LOGIN CREATEROLE PASSWORD {}; GRANT CONNECT ON DATABASE {} TO {};", ident(ADMIN), literal(ADMIN), ident(&scene.database), ident(ADMIN));
        sql.push_str(&setup.replace("{db}", &ident(&scene.database)));
        admin.client.batch_execute(&sql).await.unwrap_or_else(|e| panic!("장면을 차리지 못했어요: {e}\n{sql}"));
        let mm = session(&scene, ADMIN, ADMIN).await;
        Env { scene, admin, mm }
    }

    async fn snapshots(&mut self) -> (ClusterSnapshot, DbSnapshot) {
        let cluster = cluster_snapshot(&mut self.admin, ADMIN).await.expect("클러스터 스냅숏을 읽지 못했어요");
        let db = db_snapshot(&mut self.admin, &self.scene.database).await.expect("데이터베이스 스냅숏을 읽지 못했어요");
        (cluster, db)
    }

    /// 변경을 풀고(막히면 실패), 문장을 `mm_chg_admin`으로 돌려 커밋하고, 다시 읽은 스냅숏이 예측과 같은지 본다
    async fn commit_matches_prediction(&mut self, label: &str, change: &PgChange) -> Resolved {
        let (cluster, db) = self.snapshots().await;
        let own = [self.mm.pid];
        let resolved = resolve(&ResolveCtx { cluster: &cluster, db: &db, own_pids: &own, read_replica: false }, change);
        assert!(resolved.blocks.is_empty(), "{label}: 막혔어요: {:?}", resolved.blocks);
        let (mut predicted_cluster, mut predicted_db) = (cluster, db);
        apply(&mut predicted_cluster, &mut predicted_db, &resolved.ops);
        let notices = run_in_transaction(&self.mm, &resolved.statements).await.unwrap_or_else(|e| panic!("{label}: 문장이 실패했어요: {e}"));
        assert!(notices.iter().all(|n| !n.starts_with("01")), "{label}: 서버가 경고를 보냈어요(앱은 이것을 실패로 봐요): {notices:?}");
        let (actual_cluster, actual_db) = self.snapshots().await;
        assert_same(label, &digest(&predicted_cluster, &predicted_db), &digest(&actual_cluster, &actual_db));
        resolved
    }

    async fn cleanup(&mut self, roles: &[&str]) {
        let mut all: Vec<&str> = roles.to_vec();
        all.push(ADMIN);
        for name in all.iter().rev() {
            reset_role(&self.admin, name).await;
        }
    }
}

/// 이 데이터베이스에서 역할이 가진 것을 거두고 역할을 지운다. 다른 데이터베이스에 남은 객체 때문에 못 지우면 이름을 바꿔 치운다
async fn reset_role(conn: &Connected, name: &str) {
    let exists = conn.client.query_one("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)", &[&name]).await.expect("역할을 찾지 못했어요").get::<_, bool>(0);
    if !exists {
        return;
    }
    let drop = format!("DROP OWNED BY {}; DROP ROLE {};", ident(name), ident(name));
    if conn.client.batch_execute(&drop).await.is_err() {
        let old = format!("{name}_old_{}", NEXT_DATABASE.fetch_add(1, Ordering::SeqCst));
        conn.client.batch_execute(&format!("ALTER ROLE {} NOLOGIN; ALTER ROLE {} RENAME TO {}", ident(name), ident(name), ident(&old))).await.expect("역할을 치우지 못했어요");
    }
}

fn grant_item(target: GrantTarget, privileges: &[Privilege]) -> GrantItem {
    GrantItem { target, privileges: privileges.to_vec() }
}

fn relation_target(schema: &str, name: &str) -> GrantTarget {
    GrantTarget::Relation { schema: schema.into(), name: name.into() }
}

fn grant(env: &Env, grantee: &str, add: bool, items: Vec<GrantItem>) -> PgChange {
    PgChange::Grant { database: env.scene.database.clone(), grantee: grantee.into(), add, items }
}

fn default_privilege(env: &Env, schema: Option<&str>, object_type: DefaultObjType, grantee: &str, privileges: &[Privilege], add: bool) -> PgChange {
    PgChange::DefaultPrivilege {
        database: env.scene.database.clone(),
        creator: ADMIN.into(),
        schema: schema.map(Into::into),
        object_type,
        grantee: grantee.into(),
        privileges: privileges.to_vec(),
        add,
    }
}

fn membership(group: &str, member: &str, add: bool, admin: bool) -> PgChange {
    PgChange::Membership { group: group.into(), member: member.into(), add, admin }
}

// ───────────────────────── 경우들 ─────────────────────────

/// `mm_chg_admin`이 소유한 테이블에 권한을 주고 빼고, 상속한 소유자 역할의 테이블에 권한을 준다
pub(super) async fn grants_on_owned_and_inherited_tables_match_the_server(server: Server) {
    let setup = r#"
        CREATE ROLE mm_chg_owner2 NOLOGIN;
        CREATE SCHEMA mm_chg1 AUTHORIZATION mm_chg_admin;
        CREATE TABLE mm_chg1.t1 (id integer);
        ALTER TABLE mm_chg1.t1 OWNER TO mm_chg_admin;
        CREATE SCHEMA mm_chg2 AUTHORIZATION mm_chg_owner2;
        CREATE TABLE mm_chg2.t2 (id integer);
        ALTER TABLE mm_chg2.t2 OWNER TO mm_chg_owner2;
        GRANT mm_chg_owner2 TO mm_chg_admin;
    "#;
    let roles = ["mm_chg_owner2"];
    let mut env = Env::start(server, &roles, setup).await;
    let own = grant(&env, "alice", true, vec![grant_item(relation_target("mm_chg1", "t1"), &[Select, Insert])]);
    env.commit_matches_prediction("소유한 테이블에 주기", &own).await;
    let revoke = grant(&env, "alice", false, vec![grant_item(relation_target("mm_chg1", "t1"), &[Insert])]);
    env.commit_matches_prediction("소유한 테이블에서 빼기", &revoke).await;
    let public = grant(&env, "PUBLIC", true, vec![grant_item(GrantTarget::Schema { name: "mm_chg1".into() }, &[Usage])]);
    env.commit_matches_prediction("PUBLIC에게 스키마 USAGE", &public).await;
    let inherited = grant(&env, "bob", true, vec![grant_item(relation_target("mm_chg2", "t2"), &[Select, Update])]);
    let resolved = env.commit_matches_prediction("상속한 소유자의 테이블에 주기", &inherited).await;
    assert!(resolved.ops.iter().all(|op| matches!(op, crate::pg::change::resolve::Op::Privileges { effects, .. } if effects.iter().all(|e| e.grantor == "mm_chg_owner2"))));
    env.cleanup(&roles).await;
}

/// 다른 부여자의 항목이 남는 빼기와, 모든 테이블·모든 시퀀스(뷰와 구체화 뷰 포함)
pub(super) async fn revokes_that_leave_other_grantors_and_bulk_grants_match_the_server(server: Server) {
    let setup = r#"
        CREATE ROLE mm_chg_owner3 NOLOGIN;
        CREATE ROLE mm_chg_g3 NOLOGIN;
        GRANT mm_chg_g3 TO mm_chg_admin;
        CREATE SCHEMA mm_chg3 AUTHORIZATION mm_chg_owner3;
        CREATE TABLE mm_chg3.t3 (id integer);
        ALTER TABLE mm_chg3.t3 OWNER TO mm_chg_owner3;
        GRANT USAGE ON SCHEMA mm_chg3 TO mm_chg_g3, mm_chg_admin;
        SET ROLE mm_chg_owner3;
        GRANT SELECT ON mm_chg3.t3 TO mm_chg_g3 WITH GRANT OPTION;
        GRANT SELECT ON mm_chg3.t3 TO mm_chg_admin;
        GRANT SELECT ON mm_chg3.t3 TO alice;
        RESET ROLE;
        SET ROLE mm_chg_g3;
        GRANT SELECT ON mm_chg3.t3 TO alice;
        RESET ROLE;
        CREATE SCHEMA mm_chg4 AUTHORIZATION mm_chg_admin;
        SET ROLE mm_chg_admin;
        CREATE TABLE mm_chg4.tab (id integer);
        CREATE VIEW mm_chg4.vw AS SELECT id FROM mm_chg4.tab;
        CREATE MATERIALIZED VIEW mm_chg4.mv AS SELECT id FROM mm_chg4.tab;
        CREATE SEQUENCE mm_chg4.sq;
        CREATE TABLE mm_chg4.part (at date) PARTITION BY RANGE (at);
        CREATE TABLE mm_chg4.part_1 PARTITION OF mm_chg4.part FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
        RESET ROLE;
    "#;
    let roles = ["mm_chg_owner3", "mm_chg_g3"];
    let mut env = Env::start(server, &roles, setup).await;
    // 로그인한 역할은 SELECT를 GRANT OPTION 없이 갖고, 상속한 그룹이 GRANT OPTION을 갖는다: 부여자는 그 그룹이다
    let give = grant(&env, "bob", true, vec![grant_item(relation_target("mm_chg3", "t3"), &[Select])]);
    let resolved = env.commit_matches_prediction("상속한 그룹의 GRANT OPTION으로 주기", &give).await;
    assert!(matches!(&resolved.ops[0], crate::pg::change::resolve::Op::Privileges { effects, .. } if effects.iter().all(|e| e.grantor == "mm_chg_g3")));
    let revoke = grant(&env, "alice", false, vec![grant_item(relation_target("mm_chg3", "t3"), &[Select])]);
    let resolved = env.commit_matches_prediction("다른 부여자의 항목이 남는 빼기", &revoke).await;
    assert_eq!(resolved.stays, vec!["mm_chg_owner3 → mm_chg3.t3 SELECT".to_string()]);

    let tables = grant(&env, "bob", true, vec![grant_item(GrantTarget::AllTables { schema: "mm_chg4".into() }, &[Select, Update])]);
    env.commit_matches_prediction("모든 테이블", &tables).await;
    let sequences = grant(&env, "bob", true, vec![grant_item(GrantTarget::AllSequences { schema: "mm_chg4".into() }, &[Usage, Select])]);
    env.commit_matches_prediction("모든 시퀀스", &sequences).await;
    let revoke_tables = grant(&env, "bob", false, vec![grant_item(GrantTarget::AllTables { schema: "mm_chg4".into() }, &[Update])]);
    env.commit_matches_prediction("모든 테이블에서 빼기", &revoke_tables).await;
    env.cleanup(&roles).await;
}

/// 모든 스키마와 스키마별 기본 권한을 주고 빼는 것. 스키마별 빼기가 전역 항목을 지우지 않는 것도 서버가 그렇다
pub(super) async fn default_privileges_match_the_server(server: Server) {
    let setup = "CREATE SCHEMA mm_chg5 AUTHORIZATION mm_chg_admin;";
    let mut env = Env::start(server, &[], setup).await;
    use DefaultObjType::{Functions, Sequences, Tables};
    let steps = [
        ("전역 기본 권한 주기", None, Tables, "alice", vec![Select], true),
        ("스키마별 기본 권한 주기", Some("mm_chg5"), Tables, "bob", vec![Select, Insert], true),
        ("스키마별 빼기는 전역 항목을 못 지운다", Some("mm_chg5"), Tables, "alice", vec![Select], false),
        ("스키마별 항목 빼기", Some("mm_chg5"), Tables, "bob", vec![Select, Insert], false),
        ("전역 항목 빼기", None, Tables, "alice", vec![Select], false),
        ("PUBLIC의 함수 EXECUTE 거두기", None, Functions, "PUBLIC", vec![Privilege::Execute], false),
        ("PUBLIC의 함수 EXECUTE 되돌리기(기본값과 같아져 기록이 없어진다)", None, Functions, "PUBLIC", vec![Privilege::Execute], true),
        ("스키마별 PUBLIC 빼기는 내장 기본값을 못 지운다", Some("mm_chg5"), Functions, "PUBLIC", vec![Privilege::Execute], false),
        ("시퀀스 기본 권한", None, Sequences, "alice", vec![Usage, Select], true),
        ("자기 자신의 기본 권한 거두기", None, Sequences, ADMIN, vec![Update], false),
        ("자기 자신의 기본 권한 되돌리기", None, Sequences, ADMIN, vec![Update], true),
        ("시퀀스 기본 권한 빼기", None, Sequences, "alice", vec![Usage, Select], false),
    ];
    for (label, schema, object_type, grantee, privileges, add) in steps {
        let change = default_privilege(&env, schema, object_type, grantee, &privileges, add);
        env.commit_matches_prediction(label, &change).await;
    }
    env.cleanup(&[]).await;
}

/// 구성원 관계: 넣기, ADMIN OPTION과 함께 넣기, ADMIN만 빼기, 빼기. PG16은 부여자가 다른 줄이 남는 `GRANTED BY` 빼기까지
pub(super) async fn memberships_match_the_server(server: Server) {
    let setup = r#"
        CREATE ROLE mm_chg_g6 NOLOGIN;
        CREATE ROLE mm_chg_m6a NOLOGIN;
        CREATE ROLE mm_chg_m6b NOLOGIN NOINHERIT;
        GRANT mm_chg_g6 TO mm_chg_admin WITH ADMIN OPTION;
        GRANT mm_chg_g6 TO mm_chg_m6a;
    "#;
    let roles = ["mm_chg_g6", "mm_chg_m6a", "mm_chg_m6b"];
    let mut env = Env::start(server, &roles, setup).await;
    // PG14에서는 이미 있는 쌍에 ADMIN OPTION을 더하면 부여자가 로그인한 역할이 된다. PG16에서는 새 줄이 생긴다
    env.commit_matches_prediction("이미 있는 쌍에 ADMIN OPTION", &membership("mm_chg_g6", "mm_chg_m6a", true, true)).await;
    env.commit_matches_prediction("NOINHERIT 구성원 넣기", &membership("mm_chg_g6", "mm_chg_m6b", true, false)).await;
    env.commit_matches_prediction("ADMIN만 빼기", &membership("mm_chg_g6", "mm_chg_m6a", false, true)).await;
    if server.has_membership_options() {
        // superuser가 준 줄이 하나 더 생긴다: 로그인한 역할은 그 부여자의 권한이 없어서 자기 줄만 거둘 수 있다
        env.admin.client.batch_execute("GRANT mm_chg_g6 TO mm_chg_m6b").await.expect("부여하지 못했어요");
        env.commit_matches_prediction("자기 줄만 GRANTED BY로 빼기", &membership("mm_chg_g6", "mm_chg_m6b", false, false)).await;
        let (cluster, db) = env.snapshots().await;
        let ctx = ResolveCtx { cluster: &cluster, db: &db, own_pids: &[], read_replica: false };
        assert!(resolve(&ctx, &membership("mm_chg_g6", "mm_chg_m6b", false, false)).blocks.len() == 1, "남은 줄은 postgres가 준 것이라 못 뺀다");
    } else {
        env.commit_matches_prediction("빼기", &membership("mm_chg_g6", "mm_chg_m6b", false, false)).await;
    }
    env.commit_matches_prediction("빼기(남은 쌍)", &membership("mm_chg_g6", "mm_chg_m6a", false, false)).await;
    env.cleanup(&roles).await;
}

/// 속성 바꾸기와 비밀번호 다시 정하기
pub(super) async fn attribute_changes_match_the_server(server: Server) {
    let setup = r#"
        ALTER ROLE mm_chg_admin CREATEDB;
        CREATE ROLE mm_chg_t7 LOGIN PASSWORD 'old';
        GRANT mm_chg_t7 TO mm_chg_admin WITH ADMIN OPTION;
    "#;
    let roles = ["mm_chg_t7"];
    let mut env = Env::start(server, &roles, setup).await;
    let set = |login, create_db, create_role, inherit, connection_limit, valid_until: Option<&str>| PgChange::Attributes {
        role: "mm_chg_t7".into(),
        set: AttributesSet { login, create_db, create_role, inherit, connection_limit, valid_until: valid_until.map(Into::into) },
    };
    env.commit_matches_prediction("속성을 모두 바꾸기", &set(false, true, false, false, 4, Some("2031-03-03T03:03:03.000Z"))).await;
    env.commit_matches_prediction("몇 개만 되돌리기", &set(true, true, false, false, -1, Some("2031-03-03T03:03:03Z"))).await;
    env.commit_matches_prediction("모두 되돌리기", &set(true, false, false, true, -1, None)).await;
    let before = env.snapshots().await;
    let resolved = env.commit_matches_prediction("비밀번호 다시 정하기", &PgChange::Password { role: "mm_chg_t7".into() }).await;
    assert!(resolved.statements[0].parts.contains(&Part::Password));
    assert_same("비밀번호는 스냅숏을 바꾸지 않는다", &digest(&before.0, &before.1), &{
        let (c, d) = env.snapshots().await;
        digest(&c, &d)
    });
    env.cleanup(&roles).await;
}

/// 읽기 프리셋과 새 그룹을 함께 만들기. PG16에서는 로그인한 역할의 암묵적인 ADMIN 줄까지 같아야 한다
pub(super) async fn a_preset_that_creates_a_group_matches_the_server(server: Server) {
    let setup = r#"
        CREATE ROLE mm_chg_g8 NOLOGIN;
        GRANT mm_chg_g8 TO mm_chg_admin WITH ADMIN OPTION;
        GRANT app_owner TO mm_chg_admin;
    "#;
    let roles = ["mm_chg_ro", "mm_chg_alice2", "mm_chg_g8"];
    let mut env = Env::start(server, &roles, setup).await;
    let preset = PresetChoice {
        preset: PresetKind::ReadOnly,
        database: Some(env.scene.database.clone()),
        schemas: vec!["app".into()],
        creators: vec!["app_owner".into()],
        group: Some("mm_chg_ro".into()),
        create_group: true,
    };
    let change = PgChange::CreateRole { name: "mm_chg_alice2".into(), login: true, groups: vec!["mm_chg_g8".into()], connection_limit: 3, valid_until: Some("2031-01-01T00:00:00Z".into()), preset: Some(preset) };
    let resolved = env.commit_matches_prediction("읽기 프리셋과 새 그룹", &change).await;
    assert_eq!(resolved.statements.len(), 10);
    // 같은 변경을 createrole_self_grant가 켜진 세션 설정으로 다시 해 보는 것은 서버 설정을 바꿔야 해서 `after`의 단위 시험이 맡는다
    env.cleanup(&roles).await;
}

/// 권한 없는 역할이 하는 변경은 `resolve`가 막고, 그 문장을 그래도 돌리면 서버가 오류를 내거나 클래스 01 경고를 보낸다
pub(super) async fn blocked_rights_fail_on_the_server_too(server: Server) {
    let setup = r#"
        CREATE ROLE mm_chg_plain LOGIN PASSWORD 'plain';
        GRANT CONNECT ON DATABASE {db} TO mm_chg_plain;
        CREATE ROLE mm_chg_owner9 NOLOGIN;
        CREATE ROLE mm_chg_g9 NOLOGIN;
        CREATE ROLE mm_chg_mgr9 NOLOGIN;
        CREATE SCHEMA mm_chg9 AUTHORIZATION mm_chg_owner9;
        CREATE TABLE mm_chg9.t9 (id integer);
        ALTER TABLE mm_chg9.t9 OWNER TO mm_chg_owner9;
        GRANT USAGE ON SCHEMA mm_chg9 TO mm_chg_plain;
        GRANT SELECT ON mm_chg9.t9 TO alice;
    "#;
    let roles = ["mm_chg_plain", "mm_chg_owner9", "mm_chg_g9", "mm_chg_mgr9", "mm_chg_g11", "mm_chg_gra", "mm_chg_grb", "mm_chg_mgr11", "mm_chg_bob11"];
    let mut env = Env::start(server, &roles, setup).await;
    let plain = session(&env.scene, "mm_chg_plain", "plain").await;
    if server.has_membership_options() {
        // ADMIN OPTION이 상속하지 않는 관계 끝에만 있다
        env.admin.client.batch_execute("GRANT mm_chg_mgr9 TO mm_chg_plain WITH INHERIT FALSE; GRANT mm_chg_g9 TO mm_chg_mgr9 WITH ADMIN OPTION").await.expect("부여하지 못했어요");
        // mgr11는 ADMIN 줄이 둘(gra와 grb가 줬다)이고 g11을 bob11에게 줬다. 로그인한 역할은 둘 다 상속해서 두 줄을 모두 거둘 수 있지만, 마지막 REVOKE가 걸린다
        let dependent = r#"
            CREATE ROLE mm_chg_g11 NOLOGIN; CREATE ROLE mm_chg_gra NOLOGIN; CREATE ROLE mm_chg_grb NOLOGIN;
            CREATE ROLE mm_chg_mgr11 NOLOGIN; CREATE ROLE mm_chg_bob11 NOLOGIN;
            GRANT mm_chg_g11 TO mm_chg_gra WITH ADMIN OPTION; GRANT mm_chg_g11 TO mm_chg_grb WITH ADMIN OPTION;
            GRANT mm_chg_gra, mm_chg_grb TO mm_chg_plain;
            GRANT mm_chg_g11 TO mm_chg_mgr11 WITH ADMIN OPTION GRANTED BY mm_chg_gra;
            GRANT mm_chg_g11 TO mm_chg_mgr11 WITH ADMIN OPTION GRANTED BY mm_chg_grb;
            SET ROLE mm_chg_mgr11; GRANT mm_chg_g11 TO mm_chg_bob11; RESET ROLE;
        "#;
        env.admin.client.batch_execute(dependent).await.expect("장면을 차리지 못했어요");
    }
    let alice = session(&env.scene, "alice", "alice").await;

    let mut cases: Vec<(&str, PgChange)> = vec![
        ("받은 GRANT OPTION 없이 주기", grant_for(&env, "carol", true, "mm_chg9", "t9", &[Select])),
        ("권한 없이 빼기", grant_for(&env, "alice", false, "mm_chg9", "t9", &[Select])),
        ("ADMIN OPTION 없이 구성원 넣기", membership("mm_chg_g9", "carol", true, false)),
        (
            "CREATEROLE 없이 속성 바꾸기",
            PgChange::Attributes { role: "carol".into(), set: AttributesSet { login: false, create_db: false, create_role: false, inherit: true, connection_limit: -1, valid_until: None } },
        ),
        ("CREATEROLE 없이 역할 만들기", PgChange::CreateRole { name: "mm_chg_new".into(), login: false, groups: vec![], connection_limit: -1, valid_until: None, preset: None }),
        (
            "다른 역할의 기본 권한 바꾸기",
            PgChange::DefaultPrivilege {
                database: env.scene.database.clone(),
                creator: "app_owner".into(),
                schema: None,
                object_type: DefaultObjType::Tables,
                grantee: "carol".into(),
                privileges: vec![Select],
                add: true,
            },
        ),
        ("권한 없이 세션 끊기", PgChange::Terminate { pid: alice.pid, role: "alice".into(), backend_start: None }),
    ];
    if server.has_membership_options() {
        cases.push(("ADMIN OPTION이 상속하지 않는 관계 끝에만 있을 때", membership("mm_chg_g9", "carol", true, false)));
        cases.push(("같이 거두는 ADMIN 줄이 마지막 줄일 때", membership("mm_chg_g11", "mm_chg_mgr11", false, false)));
    }
    for (label, change) in cases {
        let (cluster, db) = {
            let mut cluster = cluster_snapshot(&mut env.admin, "mm_chg_plain").await.expect("클러스터 스냅숏을 읽지 못했어요");
            cluster.restrict_password_commands = false;
            (cluster, db_snapshot(&mut env.admin, &env.scene.database).await.expect("데이터베이스 스냅숏을 읽지 못했어요"))
        };
        let resolved = resolve(&ResolveCtx { cluster: &cluster, db: &db, own_pids: &[plain.pid], read_replica: false }, &change);
        assert!(!resolved.blocks.is_empty(), "{label}: 막혀야 해요");
        let outcome = run_in_transaction(&plain, &resolved.statements).await;
        match outcome {
            Err(error) => assert!(!error.is_empty(), "{label}"),
            Ok(notices) => assert!(notices.iter().any(|n| n.starts_with("01")), "{label}: 서버가 오류도 경고도 내지 않았어요: {notices:?}"),
        }
    }
    drop(alice);
    drop(plain);
    env.cleanup(&roles).await;
}

fn grant_for(env: &Env, grantee: &str, add: bool, schema: &str, name: &str, privileges: &[Privilege]) -> PgChange {
    grant(env, grantee, add, vec![grant_item(relation_target(schema, name), privileges)])
}
