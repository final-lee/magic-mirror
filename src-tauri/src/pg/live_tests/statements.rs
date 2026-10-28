//! 문장 만들기(`change::sql_text`)가 짠 문장이 진짜 서버(PG14·PG16)에서 문법에 맞게 돌고, 서버가 뜻하는 대로 바꾸는지 본다.
//! 비밀번호는 서버가 우리가 만든 SCRAM 검증값을 받아들이고 그 비밀번호로 로그인되는지까지 본다.
//! 문장을 보내는 길은 이 시험의 도구(`batch_execute`)다. 앱이 문장을 보내는 길(`exec`)은 따로 있다.
//! 심는 장면과 접속 도구는 부모(`live_tests`)의 것을 쓴다. 이 시험이 만드는 역할은 `mm_stmt`로 시작하고 시험이 끝날 때 지운다.

use tokio_postgres::error::SqlState;
use tokio_postgres::NoTls;

use super::*;
use crate::pg::change::sql_text::{
    alter_default_privileges, alter_role, alter_role_password, create_role, drop_owned, drop_role, grant_privileges, grant_role, reassign_owned, revoke_privileges,
    revoke_role, terminate, AttrClause, OnClause, Part, Statement,
};
use crate::pg::model::{DefaultObjType, RoleRec};
use crate::pg::password::{NewPassword, ScramHash};
use crate::pg::sql::{ident, literal};

use Privilege::{Connect, Create, Execute, Insert, Select, Temporary, Usage};

/// 비밀번호 자리가 없는 문장을 보낸다(자리가 있는 문장을 `shown`으로 보내면 가림 글자가 비밀번호가 되므로 막는다)
async fn run(conn: &Connected, statement: &Statement) {
    assert!(!statement.parts.contains(&Part::Password), "비밀번호 자리가 있는 문장은 run_with_password로 보내요");
    conn.client.batch_execute(&statement.shown()).await.unwrap_or_else(|e| panic!("{}: {e}", statement.shown()));
}

/// 비밀번호 자리가 있는 문장을 검증값과 함께 보낸다. 실패 문구에는 가린 글만 쓴다
async fn run_with_password(conn: &Connected, statement: &Statement, hash: &ScramHash) {
    if let Err(e) = conn.client.batch_execute(&statement.run(Some(hash))).await {
        panic!("{}: {}", statement.shown(), e.as_db_error().map_or_else(|| "연결 오류".to_string(), |db| db.message().to_string()));
    }
}

/// 이 역할이 이 비밀번호로 로그인하고 곧 끊는다(시험 데이터베이스는 PUBLIC의 CONNECT를 거뒀으니 `postgres`에 붙는다).
/// 실패하면 서버가 보낸 오류를 돌려준다: 잘못된 비밀번호(28P01)와 다른 까닭의 거절을 가를 수 있다
async fn log_in(scene: &Scene, user: &str, password: &str) -> Result<(), tokio_postgres::Error> {
    let mut config = scene.config_as(user, password, "mm-live-statements");
    config.dbname("postgres");
    config.connect(NoTls).await.map(|_| ())
}

async fn cluster(conn: &mut Connected) -> ClusterSnapshot {
    cluster_snapshot(conn, "iam_admin").await.expect("클러스터 스냅숏을 읽지 못했어요")
}

async fn objects(conn: &mut Connected, scene: &Scene) -> DbSnapshot {
    db_snapshot(conn, &scene.database).await.expect("데이터베이스 스냅숏을 읽지 못했어요")
}

fn role<'a>(snap: &'a ClusterSnapshot, name: &str) -> Option<&'a RoleRec> {
    snap.roles.iter().find(|r| r.name == name)
}

fn pair(snap: &ClusterSnapshot, member: &str, group: &str) -> Option<MemberRec> {
    snap.members.iter().find(|m| m.member == member && m.group == group).cloned()
}

/// 구성원 관계의 부여들을 (부여자, ADMIN) 쌍으로
fn grantors(pair: &MemberRec) -> Vec<(String, bool)> {
    pair.grants.iter().map(|g| (g.grantor.clone(), g.admin)).collect()
}

/// 기본 권한 시험의 한 경우: 객체 종류, 스키마, 넘기는 권한들, 그 뒤 받은 권한 이름들(`aclexplode`의 이름, 정렬)
type DefaultCase<'a> = (DefaultObjType, Option<&'a str>, &'a [Privilege], &'a [&'a str]);

/// 지난 시험이 남긴 역할을 지운다(시험 데이터베이스는 시험마다 새로 만들어서 거기에 남은 객체는 없다). 이름은 `pg::sql`로 감싼다
async fn drop_leftovers(conn: &Connected, roles: &[&str]) {
    for name in roles {
        let sql = format!(
            "DO $cleanup$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = {}) THEN DROP OWNED BY {}; DROP ROLE {}; END IF; END $cleanup$",
            literal(name),
            ident(name),
            ident(name)
        );
        conn.client.batch_execute(&sql).await.unwrap_or_else(|e| panic!("지난 시험의 역할 {name}을 지우지 못했어요: {e}"));
    }
}

// ───────────────────────── 역할 ─────────────────────────

/// 역할 만들기·속성 바꾸기·비밀번호 다시 정하기·지우기. 이름과 값에 따옴표가 들어 있어도 한 이름, 한 값으로 읽힌다
pub(super) async fn role_statements_create_alter_and_reset_roles(server: Server) {
    let scene = seed(server).await;
    let mut conn = scene.connect().await;
    let odd = "mm_stmt \"q\"; DROP ROLE postgres; --";
    drop_leftovers(&conn, &["mm_stmt_group", "mm_stmt_user", odd]).await;

    // 그룹과, 비밀번호·접속 제한·만료가 있는 사용자
    run(&conn, &create_role("mm_stmt_group", false, false, -1, None)).await;
    let first = NewPassword::generate();
    let first_hash = first.scram();
    run_with_password(&conn, &create_role("mm_stmt_user", true, true, 5, Some("2031-01-01T00:00:00Z")), &first_hash).await;
    let snap = cluster(&mut conn).await;
    let group = role(&snap, "mm_stmt_group").expect("그룹이 없어요");
    assert_eq!((group.login, group.inherit, group.conn_limit, group.valid_until.as_deref()), (false, true, -1, None));
    let user = role(&snap, "mm_stmt_user").expect("사용자가 없어요");
    assert_eq!((user.login, user.conn_limit, user.valid_until.as_deref()), (true, 5, Some("2031-01-01T00:00:00Z")));
    // 서버가 우리가 만든 SCRAM 검증값을 받아들였고, 그 비밀번호로 로그인된다
    let first_password = first.expose();
    log_in(&scene, "mm_stmt_user", &first_password).await.expect("만든 비밀번호로 로그인되지 않아요");

    // 비밀번호를 다시 정하면 새 비밀번호만 로그인된다
    let second = NewPassword::generate();
    let second_hash = second.scram();
    run_with_password(&conn, &alter_role_password("mm_stmt_user"), &second_hash).await;
    let second_password = second.expose();
    log_in(&scene, "mm_stmt_user", &second_password).await.expect("다시 정한 비밀번호로 로그인되지 않아요");
    // 이전 비밀번호는 다른 까닭이 아니라 비밀번호가 틀려서(28P01) 거절돼야 한다
    let refused = log_in(&scene, "mm_stmt_user", &first_password).await.expect_err("이전 비밀번호로 아직 로그인돼요");
    assert_eq!(refused.code(), Some(&SqlState::INVALID_PASSWORD), "비밀번호가 틀려서가 아니라 다른 까닭으로 거절됐어요: {refused:?}");

    // 속성을 모두 반대로, 그리고 순서를 뒤집어 다시 되돌린다
    let off = [AttrClause::Login(false), AttrClause::CreateDb(true), AttrClause::CreateRole(false), AttrClause::Inherit(false), AttrClause::ConnectionLimit(-1), AttrClause::ValidUntil(None)];
    run(&conn, &alter_role("mm_stmt_user", &off)).await;
    let snap = cluster(&mut conn).await;
    let user = role(&snap, "mm_stmt_user").expect("사용자가 없어요");
    assert_eq!((user.login, user.create_db, user.create_role, user.inherit, user.conn_limit, user.valid_until.as_deref()), (false, true, false, false, -1, None));
    let on = [
        AttrClause::ValidUntil(Some("2032-02-02T00:00:00Z".into())),
        AttrClause::ConnectionLimit(3),
        AttrClause::Inherit(true),
        AttrClause::CreateRole(true),
        AttrClause::CreateDb(false),
        AttrClause::Login(true),
    ];
    run(&conn, &alter_role("mm_stmt_user", &on)).await;
    let snap = cluster(&mut conn).await;
    let user = role(&snap, "mm_stmt_user").expect("사용자가 없어요");
    assert_eq!((user.login, user.create_db, user.create_role, user.inherit, user.conn_limit), (true, false, true, true, 3));
    assert_eq!(user.valid_until.as_deref(), Some("2032-02-02T00:00:00Z"));

    // 이름에 따옴표와 세미콜론이 있어도 그 이름의 역할 하나가 만들어지고, 다른 역할은 그대로다
    run(&conn, &create_role(odd, false, false, -1, None)).await;
    let snap = cluster(&mut conn).await;
    assert!(role(&snap, odd).is_some() && role(&snap, "postgres").is_some());
    // 값에 따옴표를 넣어 문장을 깨려 해도 값 안에 머문다: 서버가 시각이 아니라고 거절하고, 아무것도 만들어지지 않는다
    let broken = create_role("mm_stmt_injected", false, false, -1, Some("2031-01-01'; DROP ROLE postgres; --"));
    let refused = conn.client.batch_execute(&broken.shown()).await.expect_err("시각이 아닌 값이 받아들여졌어요");
    assert!(refused.as_db_error().is_some_and(|db| db.message().contains("invalid input syntax")), "{refused}");
    let snap = cluster(&mut conn).await;
    assert!(role(&snap, "mm_stmt_injected").is_none() && role(&snap, "postgres").is_some());

    for name in [odd, "mm_stmt_user", "mm_stmt_group"] {
        run(&conn, &drop_role(name)).await;
    }
    let snap = cluster(&mut conn).await;
    assert!(["mm_stmt_group", "mm_stmt_user", odd].iter().all(|name| role(&snap, name).is_none()), "시험 역할이 남았어요");
}

// ───────────────────────── 구성원 관계 ─────────────────────────

/// 그룹에 넣기·ADMIN OPTION과 함께 넣기·ADMIN OPTION만 빼기·빼기. PG16에서는 `WITH INHERIT TRUE`와 `GRANTED BY`도 본다
pub(super) async fn membership_statements_grant_and_revoke(server: Server) {
    let scene = seed(server).await;
    let mut conn = scene.connect().await;
    drop_leftovers(&conn, &["mm_stmt_g", "mm_stmt_m1", "mm_stmt_m2", "mm_stmt_gr"]).await;
    for name in ["mm_stmt_g", "mm_stmt_m1", "mm_stmt_m2"] {
        run(&conn, &create_role(name, false, false, -1, None)).await;
    }
    // m2는 NOINHERIT라서 PG16에서 평범한 부여는 INHERIT 옵션이 꺼진 채로 들어간다
    run(&conn, &alter_role("mm_stmt_m2", &[AttrClause::Inherit(false)])).await;
    let options = |m: &MemberRec| (m.admin, m.inherit, m.set);
    let pg16 = server.has_membership_options();

    run(&conn, &grant_role("mm_stmt_g", "mm_stmt_m1", false, false)).await;
    run(&conn, &grant_role("mm_stmt_g", "mm_stmt_m2", true, false)).await;
    let snap = cluster(&mut conn).await;
    assert_eq!(options(&pair(&snap, "mm_stmt_m1", "mm_stmt_g").expect("m1 → g")), (false, pg16.then_some(true), pg16.then_some(true)));
    assert_eq!(options(&pair(&snap, "mm_stmt_m2", "mm_stmt_g").expect("m2 → g")), (true, pg16.then_some(false), pg16.then_some(true)));

    // ADMIN OPTION만 빼면 구성원은 그대로다
    run(&conn, &revoke_role("mm_stmt_g", "mm_stmt_m2", true, None)).await;
    let snap = cluster(&mut conn).await;
    assert_eq!(pair(&snap, "mm_stmt_m2", "mm_stmt_g").map(|m| m.admin), Some(false));
    // 빼면 쌍이 없어진다
    run(&conn, &revoke_role("mm_stmt_g", "mm_stmt_m2", false, None)).await;
    run(&conn, &revoke_role("mm_stmt_g", "mm_stmt_m1", false, None)).await;
    let snap = cluster(&mut conn).await;
    assert!(pair(&snap, "mm_stmt_m1", "mm_stmt_g").is_none() && pair(&snap, "mm_stmt_m2", "mm_stmt_g").is_none());

    if pg16 {
        // `WITH INHERIT TRUE`는 NOINHERIT 구성원에게도 상속하는 부여를 준다. 옵션 둘은 쉼표로 이어 쓴다
        run(&conn, &grant_role("mm_stmt_g", "mm_stmt_m2", false, true)).await;
        let snap = cluster(&mut conn).await;
        assert_eq!(options(&pair(&snap, "mm_stmt_m2", "mm_stmt_g").expect("m2 → g")), (false, Some(true), Some(true)));
        run(&conn, &grant_role("mm_stmt_g", "mm_stmt_m2", true, true)).await;
        let snap = cluster(&mut conn).await;
        assert_eq!(options(&pair(&snap, "mm_stmt_m2", "mm_stmt_g").expect("m2 → g")), (true, Some(true), Some(true)));
        run(&conn, &revoke_role("mm_stmt_g", "mm_stmt_m2", false, None)).await;

        // 부여자를 정해 거두기: gr이 준 부여만 거두고 superuser(postgres)가 준 부여는 남는다
        run(&conn, &create_role("mm_stmt_gr", false, false, -1, None)).await;
        conn.client
            .batch_execute(
                "GRANT mm_stmt_g TO mm_stmt_gr WITH ADMIN OPTION;
                 GRANT mm_stmt_g TO mm_stmt_m1;
                 GRANT mm_stmt_g TO mm_stmt_m1 WITH ADMIN OPTION GRANTED BY mm_stmt_gr;",
            )
            .await
            .expect("부여하지 못했어요");
        let snap = cluster(&mut conn).await;
        assert_eq!(grantors(&pair(&snap, "mm_stmt_m1", "mm_stmt_g").expect("m1 → g")), [("mm_stmt_gr".to_string(), true), ("postgres".to_string(), false)]);
        run(&conn, &revoke_role("mm_stmt_g", "mm_stmt_m1", true, Some("mm_stmt_gr"))).await;
        let snap = cluster(&mut conn).await;
        assert_eq!(grantors(&pair(&snap, "mm_stmt_m1", "mm_stmt_g").expect("m1 → g")), [("mm_stmt_gr".to_string(), false), ("postgres".to_string(), false)]);
        run(&conn, &revoke_role("mm_stmt_g", "mm_stmt_m1", false, Some("mm_stmt_gr"))).await;
        let snap = cluster(&mut conn).await;
        assert_eq!(grantors(&pair(&snap, "mm_stmt_m1", "mm_stmt_g").expect("m1 → g")), [("postgres".to_string(), false)], "superuser가 준 부여는 남아요");
        run(&conn, &revoke_role("mm_stmt_g", "mm_stmt_m1", false, None)).await;
        run(&conn, &drop_role("mm_stmt_gr")).await;
    }

    for name in ["mm_stmt_m2", "mm_stmt_m1", "mm_stmt_g"] {
        run(&conn, &drop_role(name)).await;
    }
}

// ───────────────────────── 객체 권한과 기본 권한 ─────────────────────────

/// 권한 주기·빼기를 객체 종류마다, 모든 테이블·모든 시퀀스, PUBLIC에게. 기본 권한을 객체 종류마다
pub(super) async fn privilege_statements_change_the_acls(server: Server) {
    let scene = seed(server).await;
    let mut conn = scene.connect().await;
    let who = "mm_stmt_acl";
    drop_leftovers(&conn, &[who, "PUBLIC"]).await;
    run(&conn, &create_role(who, false, false, -1, None)).await;
    let database = scene.database.as_str();

    // 권한을 준 뒤 받은 권한을 읽고, 거둔 뒤 비었는지 본다. 권한은 일부러 선언 순서와 다르게 넘긴다
    let database_acl = async |conn: &mut Connected| cluster(conn).await.databases.into_iter().find(|d| d.name == scene.database).expect("데이터베이스가 없어요").acl;
    let on_database = OnClause::Database(database);
    run(&conn, &grant_privileges(&[Temporary, Connect], &on_database, who)).await;
    assert_eq!(granted(&database_acl(&mut conn).await, Some(who)), ["CONNECT", "TEMPORARY"]);
    run(&conn, &revoke_privileges(&[Connect, Temporary], &on_database, who)).await;
    assert!(granted(&database_acl(&mut conn).await, Some(who)).is_empty());

    let on_schema = OnClause::Schema("audit");
    run(&conn, &grant_privileges(&[Usage, Create], &on_schema, who)).await;
    assert_eq!(granted(&schema_rec(&objects(&mut conn, &scene).await, "audit").acl, Some(who)), ["CREATE", "USAGE"]);
    run(&conn, &revoke_privileges(&[Create, Usage], &on_schema, who)).await;
    assert!(granted(&schema_rec(&objects(&mut conn, &scene).await, "audit").acl, Some(who)).is_empty());

    let on_table = OnClause::Table("app", "customers");
    run(&conn, &grant_privileges(&[Insert, Select], &on_table, who)).await;
    assert_eq!(granted(&relation(&objects(&mut conn, &scene).await, "app", "customers").acl, Some(who)), ["INSERT", "SELECT"]);
    run(&conn, &revoke_privileges(&[Select, Insert], &on_table, who)).await;
    assert!(granted(&relation(&objects(&mut conn, &scene).await, "app", "customers").acl, Some(who)).is_empty());

    let on_sequence = OnClause::Sequence("app", "ticket_seq");
    run(&conn, &grant_privileges(&[Usage, Select], &on_sequence, who)).await;
    assert_eq!(granted(&relation(&objects(&mut conn, &scene).await, "app", "ticket_seq").acl, Some(who)), ["SELECT", "USAGE"]);
    run(&conn, &revoke_privileges(&[Usage, Select], &on_sequence, who)).await;
    assert!(granted(&relation(&objects(&mut conn, &scene).await, "app", "ticket_seq").acl, Some(who)).is_empty());

    // 함수의 인자 목록은 서버가 찍어 준 글 그대로 넣는다
    let signature = function(&objects(&mut conn, &scene).await, "plain").signature.clone();
    assert_eq!(signature, "a integer, b text");
    let on_routine = OnClause::Routine("app", "plain", &signature);
    run(&conn, &grant_privileges(&[Execute], &on_routine, who)).await;
    assert_eq!(granted(&function(&objects(&mut conn, &scene).await, "plain").acl, Some(who)), ["EXECUTE"]);
    run(&conn, &revoke_privileges(&[Execute], &on_routine, who)).await;
    assert!(granted(&function(&objects(&mut conn, &scene).await, "plain").acl, Some(who)).is_empty());

    // 스키마의 모든 테이블에는 시퀀스가 들지 않고, 모든 시퀀스에는 테이블이 들지 않는다
    run(&conn, &grant_privileges(&[Select], &OnClause::AllTables("app"), who)).await;
    run(&conn, &grant_privileges(&[Usage], &OnClause::AllSequences("app"), who)).await;
    let snap = objects(&mut conn, &scene).await;
    for rel in snap.relations.iter().filter(|r| r.schema == "app") {
        let expected: &[&str] = if rel.kind == RelKind::Sequence { &["USAGE"] } else { &["SELECT"] };
        assert_eq!(granted(&rel.acl, Some(who)), expected, "app.{}", rel.name);
    }
    assert!(snap.relations.iter().filter(|r| r.schema == "audit").all(|r| granted(&r.acl, Some(who)).is_empty()), "다른 스키마에는 주지 않아요");
    run(&conn, &revoke_privileges(&[Select], &OnClause::AllTables("app"), who)).await;
    run(&conn, &revoke_privileges(&[Usage], &OnClause::AllSequences("app"), who)).await;
    let snap = objects(&mut conn, &scene).await;
    assert!(snap.relations.iter().all(|r| granted(&r.acl, Some(who)).is_empty()));

    // PUBLIC: 키워드로 쓰인다. 함수는 처음부터 PUBLIC이 실행할 수 있다
    let on_locked = OnClause::Table("app", "locked");
    run(&conn, &grant_privileges(&[Select], &on_locked, "PUBLIC")).await;
    assert_eq!(granted(&relation(&objects(&mut conn, &scene).await, "app", "locked").acl, None), ["SELECT"]);
    run(&conn, &revoke_privileges(&[Select], &on_locked, "PUBLIC")).await;
    assert!(granted(&relation(&objects(&mut conn, &scene).await, "app", "locked").acl, None).is_empty());
    run(&conn, &revoke_privileges(&[Execute], &on_routine, "PUBLIC")).await;
    assert!(granted(&function(&objects(&mut conn, &scene).await, "plain").acl, None).is_empty());
    run(&conn, &grant_privileges(&[Execute], &on_routine, "PUBLIC")).await;
    assert_eq!(granted(&function(&objects(&mut conn, &scene).await, "plain").acl, None), ["EXECUTE"]);

    // `grantee`가 PUBLIC에 대해 기대는 서버의 규칙(주석은 `pg::sql::grantee`):
    // 1) 서버는 따옴표를 친 소문자 "public"도 PUBLIC(모든 역할)으로 읽는다. 그래서 `grantee("public")`도 모든 역할에게 준다
    run(&conn, &grant_privileges(&[Select], &on_locked, "public")).await;
    assert_eq!(granted(&relation(&objects(&mut conn, &scene).await, "app", "locked").acl, None), ["SELECT"], "\"public\"은 모든 역할이에요");
    run(&conn, &revoke_privileges(&[Select], &on_locked, "PUBLIC")).await;
    assert!(granted(&relation(&objects(&mut conn, &scene).await, "app", "locked").acl, None).is_empty());
    // 2) 소문자 public은 역할 이름으로 예약돼 있다
    let reserved = conn.client.batch_execute(&create_role("public", false, false, -1, None).shown()).await.expect_err("public이라는 역할이 만들어졌어요");
    assert!(reserved.as_db_error().is_some_and(|db| db.message().contains("is reserved")), "{reserved}");
    // 3) 이름이 PUBLIC인 역할은 만들 수 있다. 하지만 `grantee("PUBLIC")`은 그 역할이 아니라 언제나 모든 역할이다
    run(&conn, &create_role("PUBLIC", false, false, -1, None)).await;
    run(&conn, &grant_privileges(&[Select], &on_locked, "PUBLIC")).await;
    let acl = relation(&objects(&mut conn, &scene).await, "app", "locked").acl.clone();
    assert_eq!(granted(&acl, None), ["SELECT"], "모든 역할이 받아야 해요");
    assert!(granted(&acl, Some("PUBLIC")).is_empty(), "이름이 PUBLIC인 역할이 받으면 안 돼요");
    run(&conn, &revoke_privileges(&[Select], &on_locked, "PUBLIC")).await;
    run(&conn, &drop_role("PUBLIC")).await;

    // 기본 권한: 객체 종류마다 주고 거둔다. 스키마의 기본 권한은 스키마를 정할 수 없다
    let cases: [DefaultCase; 5] = [
        (DefaultObjType::Tables, Some("app"), &[Insert, Select], &["INSERT", "SELECT"]),
        (DefaultObjType::Sequences, Some("app"), &[Usage, Select], &["SELECT", "USAGE"]),
        (DefaultObjType::Functions, Some("app"), &[Execute], &["EXECUTE"]),
        (DefaultObjType::Types, Some("app"), &[Usage], &["USAGE"]),
        (DefaultObjType::Schemas, None, &[Usage, Create], &["CREATE", "USAGE"]),
    ];
    for (object_type, schema, privileges, names) in cases {
        run(&conn, &alter_default_privileges("app_owner", schema, true, privileges, object_type, who)).await;
        let snap = objects(&mut conn, &scene).await;
        let found = snap.default_acls.iter().find(|d| d.creator == "app_owner" && d.schema.as_deref() == schema && d.obj_type == object_type);
        assert_eq!(found.map(|d| granted(&d.acl, Some(who))), Some(names.to_vec()), "{object_type:?}");
        run(&conn, &alter_default_privileges("app_owner", schema, false, privileges, object_type, who)).await;
        let snap = objects(&mut conn, &scene).await;
        assert!(snap.default_acls.iter().all(|d| granted(&d.acl, Some(who)).is_empty()), "{object_type:?}: 거두지 못했어요");
    }
    // PUBLIC에게도: 함수의 기본 EXECUTE를 거둔다
    run(&conn, &alter_default_privileges("app_owner", None, false, &[Execute], DefaultObjType::Functions, "PUBLIC")).await;
    let snap = objects(&mut conn, &scene).await;
    let functions = snap.default_acls.iter().find(|d| d.creator == "app_owner" && d.schema.is_none() && d.obj_type == DefaultObjType::Functions);
    assert_eq!(functions.map(|d| granted(&d.acl, None)), Some(vec![]), "모든 역할의 기본 EXECUTE를 거둔 기본 권한이 있어야 해요");

    run(&conn, &drop_role(who)).await;
}

// ───────────────────────── 소유권, 세션 ─────────────────────────

/// 역할이 가진 객체를 넘기고 지운다. 세션은 pid·역할·시작한 초가 맞을 때만 끊는다
pub(super) async fn ownership_and_session_statements(server: Server) {
    let scene = seed(server).await;
    let mut conn = scene.connect().await;
    let backslash = "mm_stmt\\back";
    drop_leftovers(&conn, &["mm_stmt_owner", "mm_stmt_heir", backslash]).await;

    // 소유권: 넘기면 새 주인이 갖고, 그 주인의 것을 지우면 객체가 사라진다
    run(&conn, &create_role("mm_stmt_owner", false, false, -1, None)).await;
    run(&conn, &create_role("mm_stmt_heir", false, false, -1, None)).await;
    conn.client
        .batch_execute("GRANT CREATE ON SCHEMA scratch TO mm_stmt_owner; SET ROLE mm_stmt_owner; CREATE TABLE scratch.mm_stmt_t (id integer); RESET ROLE;")
        .await
        .expect("테이블을 만들지 못했어요");
    let owner = async |conn: &mut Connected| objects(conn, &scene).await.relations.into_iter().find(|r| r.schema == "scratch" && r.name == "mm_stmt_t").map(|r| r.owner);
    assert_eq!(owner(&mut conn).await.as_deref(), Some("mm_stmt_owner"));
    run(&conn, &reassign_owned("mm_stmt_owner", "mm_stmt_heir")).await;
    assert_eq!(owner(&mut conn).await.as_deref(), Some("mm_stmt_heir"));
    // 이전 주인에게 남은 권한(스키마의 CREATE)은 `DROP OWNED`가 거둔다
    run(&conn, &drop_owned("mm_stmt_owner")).await;
    run(&conn, &drop_role("mm_stmt_owner")).await;
    run(&conn, &drop_owned("mm_stmt_heir")).await;
    assert_eq!(owner(&mut conn).await, None, "새 주인의 테이블이 지워져야 해요");
    run(&conn, &drop_role("mm_stmt_heir")).await;

    // 세션 끊기: 시작한 초나 역할이 다르면 줄이 없고, 맞으면 한 줄(true)이 오고 세션이 끝난다
    let alice = connect_to(&scene.config_as("alice", "alice", "mm-live-terminate")).await;
    let pid: i32 = alice.query_one("SELECT pg_backend_pid()", &[]).await.expect("pid를 읽지 못했어요").get(0);
    let started = sessions(&mut conn).await.expect("세션을 읽지 못했어요").into_iter().find(|s| s.pid == pid).and_then(|s| s.backend_start).expect("alice의 세션과 시작 시각이 있어야 해요");
    let rows = async |statement: Statement| conn.client.query(&statement.shown(), &[]).await.expect("세션을 끊는 문장이 돌지 않아요");
    assert!(rows(terminate(pid, "alice", Some("2000-01-01T00:00:00Z"))).await.is_empty(), "시작한 초가 다르면 끊지 않아요");
    assert!(rows(terminate(pid, "bob", Some(&started))).await.is_empty(), "역할이 다르면 끊지 않아요");
    assert!(!alice.is_closed());
    let ended = rows(terminate(pid, "alice", Some(&started))).await;
    assert_eq!(ended.iter().map(|row| row.get::<_, bool>(0)).collect::<Vec<_>>(), [true]);
    for _ in 0..50 {
        if alice.is_closed() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(alice.is_closed(), "세션이 끝나지 않았어요");
    assert!(rows(terminate(pid, "alice", Some(&started))).await.is_empty(), "이미 끝난 세션은 줄이 없어요(그때 `expect`의 문구가 오류가 돼요)");

    // 역슬래시가 있는 이름: E'…' 꼴이라 `standard_conforming_strings`를 꺼도 같은 이름으로 읽힌다
    let password = NewPassword::generate();
    let hash = password.scram();
    run_with_password(&conn, &create_role(backslash, true, true, -1, None), &hash).await;
    // 시험 데이터베이스는 PUBLIC의 CONNECT를 거뒀으니 새 역할은 `postgres`에 붙는다
    let mut slash_config = scene.config_as(backslash, &password.expose(), "mm-live-backslash");
    slash_config.dbname("postgres");
    let slash_user = connect_to(&slash_config).await;
    let slash_pid: i32 = slash_user.query_one("SELECT pg_backend_pid()", &[]).await.expect("pid를 읽지 못했어요").get(0);
    let strict = connect_to(&scene.config).await;
    strict.batch_execute("SET standard_conforming_strings = off").await.expect("설정하지 못했어요");
    let ended = strict.query(&terminate(slash_pid, backslash, None).shown(), &[]).await.expect("세션을 끊는 문장이 돌지 않아요");
    assert_eq!(ended.iter().map(|row| row.get::<_, bool>(0)).collect::<Vec<_>>(), [true], "역슬래시가 있는 이름이 같은 이름으로 읽히지 않았어요");
    drop(slash_user);
    run(&conn, &drop_role(backslash)).await;
}
