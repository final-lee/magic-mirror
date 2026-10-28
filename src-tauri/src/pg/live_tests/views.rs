//! 화면 계약을 만드는 순수 함수(`summary`, `checks`)를 진짜 서버에서 읽은 스냅숏에 돌려 본다. 심는 장면과 접속 도구는 부모(`live_tests`)의 것을 쓴다.
//!
//! 이 시험이 장면에 더하는 것: 역할 `mm_gap_reader`(`app` 스키마의 모든 테이블에 SELECT만 받았고 기본 권한은 없다)와,
//! app_read가 읽지 못하던 `app.locked`의 SELECT. 그래서 app_read는 `app`의 모든 테이블을 읽고, 그 새 테이블은 시드의 기본 권한 덕에 읽는다.
//! 기본 권한을 거두면 같은 app_read가 빈틈으로 잡혀야 한다: 점검이 기본 권한 때문에 조용한 것인지, 그냥 못 보는 것인지를 가른다.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::Arc;

use super::*;
use crate::aws::context::AwsContext;
use crate::commands::AppState;
use crate::pg::checks::findings;
use crate::pg::eval::SourceKind;
use crate::pg::pool::ConnKey;
use crate::pg::summary::{cell_detail, database_view, parse_privilege, role_summaries, search_objects, who_can_view};
use crate::pg::target::{PgTarget, PgTargetInfo, TargetKind};
use crate::pg::view::{PgCoverage, PgFindingKind, PgFindings, PgObjectKind, PgObjectRef};
use crate::pg_commands::PgState;

/// 다른 시험이 만든 역할과 겹치지 않는 이름이다. 이미 있으면 만들지 않는다(역할은 클러스터 전체의 것이다)
const VIEW_ROLES: &str = r#"
DO $seed$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mm_gap_reader') THEN CREATE ROLE mm_gap_reader NOLOGIN; END IF;
END
$seed$;
"#;

const VIEW_OBJECTS: &str = r#"
GRANT USAGE ON SCHEMA app TO mm_gap_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA app TO mm_gap_reader;
GRANT SELECT ON app.locked TO app_read;
"#;

/// 시드의 기본 권한(`app_owner`가 `app`에 만드는 테이블은 app_read가 읽는다)을 거둔다
const DROP_DEFAULT_SELECT: &str = "ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA app REVOKE SELECT ON TABLES FROM app_read";

/// 기본 권한 한 행을 (만드는 역할, 스키마, 받는 쪽과 권한들)로 줄인 것
type DefaultRow = (String, Option<String>, Vec<(String, Vec<String>)>);

fn gap_roles(found: &PgFindings) -> BTreeSet<String> {
    found
        .groups
        .iter()
        .filter(|g| g.kind == PgFindingKind::DefaultPrivilegeGap)
        .flat_map(|g| g.items.iter())
        .filter_map(|item| item.role.clone())
        .collect()
}

fn group_roles(found: &PgFindings, kind: PgFindingKind) -> BTreeSet<String> {
    found.groups.iter().filter(|g| g.kind == kind).flat_map(|g| g.items.iter()).filter_map(|item| item.role.clone()).collect()
}

pub(super) async fn the_builders_read_the_seeded_database(server: Server) {
    let scene = seed(server).await;
    let admin = connect_to(&scene.config).await;
    admin.batch_execute(VIEW_ROLES).await.expect("역할을 더하지 못했어요");
    admin.batch_execute(VIEW_OBJECTS).await.expect("객체를 더하지 못했어요");
    let mut conn = scene.connect().await;
    let cluster = cluster_snapshot(&mut conn, "iam_admin").await.expect("클러스터 스냅숏");
    let db = db_snapshot(&mut conn, &scene.database).await.expect("데이터베이스 스냅숏");
    let now = clock::now_secs();

    // ── 권한 표 ──
    let view = database_view(&cluster, &db);
    assert_eq!(view.database, scene.database);
    let tables: BTreeMap<&str, usize> = view.schemas.iter().map(|s| (s.name.as_str(), s.table_count)).collect();
    // app: orders·customers·locked, audit: events(파티션 자식과 외부 테이블은 세지 않는다), 뷰·구체화 뷰·시퀀스도 세지 않는다
    assert_eq!((tables["app"], tables["audit"], tables["scratch"]), (3, 1, 0), "{tables:?}");
    assert!(tables.contains_key("public"), "새 데이터베이스의 public 스키마도 읽혀요: {tables:?}");
    assert_eq!(view.cells.len(), cluster.roles.len() * view.schemas.len(), "모든 역할 × 모든 스키마");
    assert_eq!(view.db_privileges.len(), cluster.roles.len());

    let cell = |role: &str, schema: &str| view.cells.iter().find(|c| c.role == role && c.schema == schema).unwrap_or_else(|| panic!("{role}/{schema}"));
    let alice = cell("alice", "app");
    assert!(alice.usage && alice.inherited_only, "alice는 app_write → app_read를 거쳐서만 받아요: {alice:?}");
    assert_eq!((alice.read, alice.write), (PgCoverage::All, PgCoverage::Some));
    let reader = cell("app_read", "app");
    assert!(reader.usage && !reader.inherited_only && reader.read == PgCoverage::All, "app_read는 locked까지 모두 읽어요: {reader:?}");
    assert_eq!(cell("bob", "app").read, PgCoverage::None, "NOINHERIT라서 그룹의 권한이 없어요");

    let db_privilege = |role: &str| {
        let row = view.db_privileges.iter().find(|p| p.role == role).unwrap_or_else(|| panic!("{role}"));
        (row.connect, row.create, row.temp)
    };
    assert_eq!(db_privilege("app_owner"), (true, true, true));
    assert_eq!(db_privilege("alice"), (true, false, true));
    assert_eq!(db_privilege("bob"), (false, false, true), "PUBLIC의 CONNECT를 거뒀고 NOINHERIT라서 CONNECT가 없어요");
    assert!(db_privilege("postgres").0, "superuser는 모두 가져요");

    // 시드의 기본 권한 둘: app_owner가 app에 만드는 테이블은 app_read가 SELECT, app_owner가 만드는 시퀀스는 app_write가 USAGE.
    // 모든 스키마의 기본 권한은 서버 기본값에서 출발하므로 소유자 자신의 권한도 항목에 든다
    let defaults: Vec<DefaultRow> = view
        .default_privileges
        .iter()
        .map(|row| (row.creator.clone(), row.schema.clone(), row.grants.iter().map(|g| (g.grantee.clone(), g.privileges.clone())).collect()))
        .collect();
    let granted = |grantee: &str, privileges: &[&str]| (grantee.to_string(), privileges.iter().map(|p| p.to_string()).collect::<Vec<_>>());
    assert_eq!(
        defaults,
        [
            ("app_owner".to_string(), Some("app".to_string()), vec![granted("app_read", &["SELECT"])]),
            ("app_owner".to_string(), None, vec![granted("app_owner", &["SELECT", "UPDATE", "USAGE"]), granted("app_write", &["USAGE"])]),
        ]
    );
    assert!(view.default_privileges.iter().all(|row| row.grants.iter().all(|g| !g.grantable)));

    // ── 칸 상세, 검색, 누가 할 수 있나 ──
    let detail = cell_detail(&cluster, &db, "alice", "app").expect("칸 상세");
    let orders = detail.objects.iter().find(|o| o.object.name == "orders").expect("orders");
    assert_eq!(orders.object.kind, PgObjectKind::Table);
    assert!(orders.privileges.iter().all(|p| p.sources.iter().all(|s| s.kind == SourceKind::Group)), "{orders:?}");
    let select = orders.privileges.iter().find(|p| p.privilege == "SELECT").expect("SELECT");
    assert_eq!(select.sources[0].via, ["app_write", "app_read"]);
    assert!(detail.objects.iter().any(|o| o.object.kind == PgObjectKind::Function && o.object.name == "plain"), "PUBLIC의 EXECUTE가 보여요");
    assert!(detail.objects.iter().any(|o| o.object.name == "customers" && o.rls), "행 수준 보안이 켜진 테이블");

    let found_objects: Vec<String> = search_objects(&cluster, &db, "ORDER").iter().map(|o| format!("{:?} {}", o.kind, o.name)).collect();
    assert!(found_objects.iter().any(|f| f == "Table orders") && found_objects.iter().any(|f| f == "Sequence orders_id_seq"), "{found_objects:?}");

    let orders_ref = PgObjectRef { kind: PgObjectKind::Table, schema: Some("app".into()), name: "orders".into(), signature: None };
    let who = who_can_view(&cluster, &db, &orders_ref, parse_privilege("SELECT").expect("SELECT")).expect("누가 할 수 있나");
    let listed: BTreeSet<&str> = who.allowed.iter().map(|r| r.role.as_str()).collect();
    // 서버의 답과 같은 역할들이다(has_table_privilege)
    let rows = conn.client.query("SELECT rolname FROM pg_roles WHERE has_table_privilege(rolname, 'app.orders'::regclass, 'SELECT') ORDER BY 1", &[]).await.expect("서버의 답");
    let asked: Vec<String> = rows.iter().map(|row| row.get(0)).collect();
    assert_eq!(listed, asked.iter().map(String::as_str).collect::<BTreeSet<_>>());
    assert!(["alice", "app_owner", "app_read", "app_write", "carol", "mm_gap_reader", "postgres"].iter().all(|r| listed.contains(r)), "{listed:?}");

    // 역할 요약: 서버의 속성과 구성원 관계가 그대로 요약된다
    let summaries = role_summaries(&cluster, now);
    let alice_summary = summaries.iter().find(|r| r.name == "alice").expect("alice");
    assert_eq!(alice_summary.member_of.iter().map(|m| (m.group.as_str(), m.inherit)).collect::<Vec<_>>(), [("app_write", true)]);
    assert_eq!(alice_summary.attributes.connection_limit, 5);
    assert_eq!(alice_summary.attributes.valid_until.as_deref(), Some("2031-01-01T00:00:00Z"));
    let bob_summary = summaries.iter().find(|r| r.name == "bob").expect("bob");
    assert!(!bob_summary.attributes.inherit && !bob_summary.member_of[0].inherit);
    assert!(summaries.iter().find(|r| r.name == "pg_read_all_data").expect("pg_read_all_data").system);

    // ── 점검 ──
    let found = findings(&cluster, &[&db], Vec::new(), now);
    let definers: Vec<_> = found.groups.iter().filter(|g| g.kind == PgFindingKind::SecurityDefinerPath).flat_map(|g| g.items.iter()).collect();
    assert_eq!(definers.len(), 1, "search_path를 고정한 safe_touch는 빠져요: {definers:?}");
    let touch = definers[0].object.as_ref().expect("함수");
    assert_eq!((touch.kind, touch.schema.as_deref(), touch.name.as_str(), touch.signature.as_deref()), (PgObjectKind::Function, Some("app"), "touch", Some("order_id integer")));
    assert_eq!(definers[0].database.as_deref(), Some(scene.database.as_str()));

    // app_read는 새 테이블도 읽는다(시드의 기본 권한). 그 그룹을 상속하는 app_write·alice도 그렇다. SELECT만 받은 mm_gap_reader는 못 읽는다
    let gaps = gap_roles(&found);
    assert!(gaps.contains("mm_gap_reader"), "{gaps:?}");
    for covered in ["app_read", "app_write", "alice", "bob", "carol", "app_owner"] {
        assert!(!gaps.contains(covered), "{covered}는 빈틈이 아니에요: {gaps:?}");
    }
    let gap = found.groups.iter().find(|g| g.kind == PgFindingKind::DefaultPrivilegeGap).and_then(|g| g.items.iter().find(|i| i.role.as_deref() == Some("mm_gap_reader"))).expect("mm_gap_reader의 항목");
    assert_eq!(gap.detail, "mm_gap_reader 역할은 app의 지금 테이블은 읽지만 app_owner 역할이 새로 만드는 테이블은 못 읽어요");
    assert_eq!(gap.object, Some(PgObjectRef::schema("app")));

    // 서버가 말하는 사실: PG14까지는 public 스키마를 PUBLIC이 만들 수 있다
    let public_create = group_objects(&found, PgFindingKind::PublicSchemaCreate);
    assert_eq!(public_create.contains("public"), server == Server::Pg14, "{public_create:?}");
    assert!(!public_create.contains("app"));
    assert!(group_roles(&found, PgFindingKind::CreateRole).contains("postgres"), "superuser의 CREATEROLE");
    assert!(!found.groups.iter().any(|g| g.kind == PgFindingKind::Md5Encryption), "도커 서버는 scram-sha-256이에요");

    // 기본 권한을 거두고 다시 읽으면 같은 app_read가 빈틈으로 잡힌다
    admin.batch_execute(DROP_DEFAULT_SELECT).await.expect("기본 권한을 거두지 못했어요");
    let db = db_snapshot(&mut conn, &scene.database).await.expect("데이터베이스 스냅숏");
    let again = findings(&cluster, &[&db], Vec::new(), now);
    let gaps = gap_roles(&again);
    for uncovered in ["app_read", "app_write", "alice", "mm_gap_reader"] {
        assert!(gaps.contains(uncovered), "{uncovered}는 이제 빈틈이어야 해요: {gaps:?}");
    }
    for fine in ["bob", "carol", "app_owner"] {
        assert!(!gaps.contains(fine), "{fine}: {gaps:?}");
    }
    assert!(database_view(&cluster, &db).default_privileges.iter().all(|row| row.schema.as_deref() != Some("app") || row.grants.is_empty()));
}

/// 그룹의 항목이 가리키는 객체의 이름들
fn group_objects(found: &PgFindings, kind: PgFindingKind) -> BTreeSet<String> {
    found.groups.iter().filter(|g| g.kind == kind).flat_map(|g| g.items.iter()).filter_map(|item| item.object.as_ref().map(|o| o.name.clone())).collect()
}

/// 서버는 문장 시간 제한에 걸린 문장을 SQLSTATE 57014로 취소한다. 앱은 그 오류를 시간 초과 문구로 바꾼다
pub(super) async fn a_statement_timeout_reads_as_the_read_timeout_text(server: Server) {
    let scene = seed(server).await;
    let mut conn = scene.connect().await;
    let failed = read(&mut conn, async |tx| {
        // 읽기가 거는 30초 대신 짧게 건다: 같은 `statement_timeout`이 같은 코드로 문장을 취소한다
        tx.batch_execute("SET LOCAL statement_timeout = '50ms'").await?;
        tx.batch_execute("SELECT pg_sleep(5)").await
    })
    .await;
    assert_eq!(failed, Err(AppError::other("질의가 30초 안에 끝나지 않았어요. 잠시 뒤 다시 읽어 주세요")));
    // 연결은 그대로 쓸 수 있다
    assert_eq!(read(&mut conn, async |tx| tx.batch_execute("SELECT 1").await).await, Ok(()));
}

/// `pg_sessions`: 세션 목록에서 앱의 연결 보관함에 든 연결만 `own`이다. 가짜 서버는 `pg_stat_activity`에 답하지 못해서 진짜 서버로 본다.
/// AWS에는 닿지 않는다: 이 시험의 연결을 보관함에 미리 넣어 두면 명령은 새로 연결하지 않고 그것을 쓴다.
pub(super) async fn the_sessions_command_marks_the_connection_the_app_holds(server: Server) {
    let scene = seed(server).await;
    let mut held = scene.connect().await;
    let cluster = cluster_snapshot(&mut held, "iam_admin").await.expect("클러스터 스냅숏");
    // 보관함에 넣지 않은 이 시험의 다른 연결: 서버에는 세션으로 보이지만 앱의 연결은 아니다
    let elsewhere = scene.connect().await;
    let (held_pid, elsewhere_pid) = (held.backend_pid, elsewhere.backend_pid);
    assert_ne!(held_pid, elsewhere_pid);

    let target = PgTarget { profile: "dev".into(), region: "ap-northeast-2".into(), kind: TargetKind::Cluster, id: "live".into() };
    let info = PgTargetInfo {
        arn: "arn:aws:rds:ap-northeast-2:123456789012:cluster:live".into(),
        identifier: "live".into(),
        kind: TargetKind::Cluster,
        engine: "aurora-postgresql".into(),
        engine_version: format!("{}.0", server.major()),
        endpoint: "127.0.0.1".into(),
        port: 5432,
        default_database: scene.database.clone(),
        iam_auth: true,
        read_replica: false,
    };
    let state = PgState::default();
    let epoch = state.open_for_tests(&target, "iam_admin".into(), info, Arc::new(cluster)).expect("열기");
    let key = ConnKey { target: target.clone(), user: "iam_admin".into(), database: scene.database.clone() };
    state.pool.get_or_connect_at_epoch(key, epoch, || async { Ok(held) }).await.expect("보관함에 넣지 못했어요");

    let app = AppState { ctx: AwsContext::default(), adapters: Vec::new(), settings_path: PathBuf::new(), sso: Default::default() };
    let listed = state.sessions_for_tests(&app, &target).await.expect("세션을 읽지 못했어요");
    let own: BTreeMap<i32, bool> = listed.iter().map(|session| (session.pid, session.own)).collect();
    assert_eq!(own.get(&held_pid), Some(&true), "보관함의 연결이 앱의 연결로 표시되지 않았어요: {own:?}");
    assert_eq!(own.get(&elsewhere_pid), Some(&false), "보관함 밖의 연결은 앱의 연결이 아니에요: {own:?}");
    assert_eq!(own.values().filter(|own| **own).count(), 1, "앱의 연결은 보관함의 하나뿐이에요: {own:?}");
    drop(elsewhere);
}
