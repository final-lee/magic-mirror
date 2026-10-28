//! 진짜 PostgreSQL 14·16에 붙어 보는 시험. 모두 `#[ignore]`라 `cargo test`는 건너뛴다.
//! `scripts/pg-live-test.sh`가 Docker로 두 서버를 띄우고 환경 변수 `MM_PG_LIVE_14`, `MM_PG_LIVE_16`(superuser로 `postgres`
//! 데이터베이스에 붙는 URL)을 넘겨 이 시험들을 돌린다.
//!
//! 시험 도구는 TLS 없이(`NoTls`) 붙는다. 앱의 접속은 `connect`뿐이고, 거기에는 평문으로 가는 길이 없다.
//!
//! 시험마다 새 데이터베이스 `mm_live_<n>`을 만들고 같은 장면을 심는다(`seed`). 역할은 클러스터 전체의 것이라 이미 있으면 다시 만들지 않는다.
//! 같은 서버를 여러 번, 여러 시험이 써도 된다.
//!
//! - 역할: `app_owner`(LOGIN), `app_read`(NOLOGIN), `app_write`(NOLOGIN, `app_read`의 구성원), `alice`(LOGIN, `app_write`의 구성원),
//!   `bob`(LOGIN NOINHERIT, `app_read`의 구성원), `carol`(LOGIN, `pg_read_all_data`의 구성원)
//! - 스키마 `app`, `audit`, `scratch`. 테이블·뷰·구체화 뷰·시퀀스·파티션 테이블·외부 테이블, SECURITY DEFINER 함수(`search_path`가 있는 것과 없는 것),
//!   GRANT, 기본 권한(`ALTER DEFAULT PRIVILEGES`), 데이터베이스의 CONNECT(PUBLIC에서 거두고 `app_read`에 부여)
//!
//! 실효 권한 비교 시험(`effective_privileges_match_postgres`, `a_noinherit_database_owner_matches_postgres`)은 이 장면에 서버 규칙의
//! 모서리를 건드리는 역할(`mm_cmp_*`)과 객체(`app.cmp_*` 등)를 더한다. 다른 시험이 기대하는 장면은 그대로 둔다.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::net::IpAddr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio_postgres::{Client, Config, NoTls};

use super::catalog::{self, cluster_snapshot, db_snapshot, db_snapshot_capped, read, sessions};
use super::connect::Connected;
use super::eval::{schema_cells, who_can, Coverage, Ctx, Obj, SourceKind};
use super::model::{AclEntry, DbSnapshot, DefaultAclRec, DefaultObjType, FunctionRec, MemberRec, Privilege, RelKind, RelationRec, SchemaRec};
use crate::error::AppError;
use crate::iam::clock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Server {
    Pg14,
    Pg16,
}

impl Server {
    fn major(self) -> i32 {
        match self {
            Server::Pg14 => 14,
            Server::Pg16 => 16,
        }
    }

    /// superuser로 `postgres` 데이터베이스에 붙는 URL
    fn url(self) -> String {
        let var = match self {
            Server::Pg14 => "MM_PG_LIVE_14",
            Server::Pg16 => "MM_PG_LIVE_16",
        };
        std::env::var(var).unwrap_or_else(|_| panic!("환경 변수 {var}가 없어요. scripts/pg-live-test.sh로 돌리세요"))
    }

    /// 구성원 관계마다 INHERIT·SET 옵션이 있는 것은 PG16부터다
    fn has_membership_options(self) -> bool {
        self == Server::Pg16
    }
}

/// 서버가 막 떴을 때는 포트가 열리기까지 잠깐 걸릴 수 있어 몇 번 다시 해 본다
async fn connect_to(config: &Config) -> Client {
    let mut last_error = None;
    for _ in 0..40 {
        match config.connect(NoTls).await {
            Ok((client, connection)) => {
                tokio::spawn(async move {
                    let _ = connection.await;
                });
                return client;
            }
            Err(e) => {
                last_error = Some(e);
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
    }
    panic!("포트 {:?}에 붙지 못했어요: {last_error:?}", config.get_ports());
}

/// 앱의 `Connected`를 시험 서버에 붙인 연결로 만든다. pid는 앱이 쓰는 `backend_pid`로 읽는다
async fn connected(config: &Config) -> Connected {
    let mut client = connect_to(config).await;
    let backend_pid = catalog::backend_pid(&mut client).await.expect("서버 쪽 pid를 읽지 못했어요");
    Connected { client, backend_pid }
}

/// 한 시험의 장면: 심어 둔 데이터베이스와, superuser로 거기에 붙는 설정
struct Scene {
    database: String,
    config: Config,
}

impl Scene {
    async fn connect(&self) -> Connected {
        connected(&self.config).await
    }

    /// 같은 데이터베이스에 다른 역할로 붙는다(심어 둔 역할 `alice`의 비밀번호는 `alice`다)
    fn config_as(&self, user: &str, password: &str, application_name: &str) -> Config {
        let mut config = self.config.clone();
        config.user(user).password(password).application_name(application_name);
        config
    }
}

/// 클러스터 전체에 걸친 장면: 역할. 이미 있으면 만들지 않고, 속성과 구성원 관계는 매번 같은 값으로 맞춘다
const ROLES_SEED: &str = r#"
DO $seed$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_owner') THEN CREATE ROLE app_owner LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_read') THEN CREATE ROLE app_read NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_write') THEN CREATE ROLE app_write NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'alice') THEN CREATE ROLE alice LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bob') THEN CREATE ROLE bob LOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'carol') THEN CREATE ROLE carol LOGIN; END IF;
END
$seed$;
GRANT app_read TO app_write;
GRANT app_write TO alice;
-- PG16: bob은 NOINHERIT라서 이 부여의 INHERIT 옵션이 false가 된다(부여할 때 구성원의 속성을 따른다)
GRANT app_read TO bob;
GRANT pg_read_all_data TO carol;
ALTER ROLE alice WITH PASSWORD 'alice' VALID UNTIL '2031-01-01 00:00:00+00' CONNECTION LIMIT 5;
ALTER ROLE carol VALID UNTIL 'infinity';
ALTER ROLE alice SET search_path = app, public;
COMMENT ON ROLE app_read IS 'read-only access to the app schema';
"#;

/// 시험 데이터베이스 안의 장면. `{db}`는 데이터베이스 이름이다
const DATABASE_SEED: &str = r#"
CREATE SCHEMA app AUTHORIZATION app_owner;
CREATE SCHEMA audit AUTHORIZATION app_owner;
CREATE SCHEMA scratch AUTHORIZATION app_owner;

-- 데이터 래퍼는 superuser만 만든다. 처리기가 없어서 읽을 수는 없지만 카탈로그에는 외부 테이블로 남는다
CREATE FOREIGN DATA WRAPPER mm_dummy;
CREATE SERVER mm_dummy_server FOREIGN DATA WRAPPER mm_dummy;
CREATE FOREIGN TABLE audit.remote_log (line text) SERVER mm_dummy_server;
ALTER FOREIGN TABLE audit.remote_log OWNER TO app_owner;

SET ROLE app_owner;

CREATE TABLE app.orders (id serial PRIMARY KEY, customer text NOT NULL, total numeric(10, 2) NOT NULL DEFAULT 0);
CREATE TABLE app.customers (id integer PRIMARY KEY, name text NOT NULL);
ALTER TABLE app.customers ENABLE ROW LEVEL SECURITY;
CREATE VIEW app.order_totals AS SELECT customer, sum(total) AS total FROM app.orders GROUP BY customer;
CREATE MATERIALIZED VIEW app.order_summary AS SELECT count(*) AS orders FROM app.orders;
CREATE SEQUENCE app.ticket_seq;
CREATE TABLE audit.events (id bigint, at timestamptz NOT NULL, what text) PARTITION BY RANGE (at);
CREATE TABLE audit.events_2026 PARTITION OF audit.events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');

-- search_path가 없는 SECURITY DEFINER, 있는 SECURITY DEFINER, 보통 함수, 프로시저, 집계(읽지 않는다)
CREATE FUNCTION app.touch(order_id integer) RETURNS void LANGUAGE sql SECURITY DEFINER
  AS $$ UPDATE app.orders SET total = total WHERE id = order_id $$;
CREATE FUNCTION app.safe_touch(order_id integer) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, app
  AS $$ UPDATE app.orders SET total = total WHERE id = order_id $$;
CREATE FUNCTION app.plain(a integer, b text) RETURNS text LANGUAGE sql AS $$ SELECT b $$;
CREATE PROCEDURE app.cleanup() LANGUAGE sql AS $$ DELETE FROM app.orders WHERE total = 0 $$;
CREATE AGGREGATE app.my_sum(integer) (SFUNC = int4pl, STYPE = integer, INITCOND = '0');

GRANT USAGE ON SCHEMA app TO app_read;
GRANT USAGE ON SCHEMA audit TO app_write;
GRANT SELECT ON ALL TABLES IN SCHEMA app TO app_read;
GRANT INSERT, UPDATE ON app.orders TO app_write;
GRANT USAGE ON SEQUENCE app.orders_id_seq TO app_write;
REVOKE EXECUTE ON FUNCTION app.touch(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.touch(integer) TO app_write;

ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA app GRANT SELECT ON TABLES TO app_read;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner GRANT USAGE ON SEQUENCES TO app_write;

-- ACL이 비어 있는 테이블: 소유자도 권한을 거뒀다. 위의 GRANT와 기본 권한이 지난 뒤에 만든다
CREATE TABLE app.locked (note text);
REVOKE ALL ON app.locked FROM app_owner, app_read;

RESET ROLE;
REVOKE CONNECT ON DATABASE {db} FROM PUBLIC;
GRANT CONNECT ON DATABASE {db} TO app_read;
ALTER ROLE alice IN DATABASE {db} SET statement_timeout = '5s';
ALTER DATABASE {db} SET work_mem = '8MB';
"#;

static NEXT_DATABASE: AtomicU32 = AtomicU32::new(1);

/// 새 데이터베이스 `mm_live_<n>`을 만들고 장면을 심는다
async fn seed(server: Server) -> Scene {
    let mut config: Config = server.url().parse().expect("접속 URL이 올바르지 않아요");
    config.application_name("mm-live");
    let admin = connect_to(&config).await;
    admin.batch_execute(ROLES_SEED).await.expect("역할을 심지 못했어요");
    // 이전 실행이 남긴 데이터베이스와 겹치지 않게 시각을 넣는다
    let millis = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let database = format!("mm_live_{millis}_{}", NEXT_DATABASE.fetch_add(1, Ordering::SeqCst));
    admin.batch_execute(&format!("CREATE DATABASE {database} OWNER app_owner")).await.expect("데이터베이스를 만들지 못했어요");
    config.dbname(&database);
    let db = connect_to(&config).await;
    db.batch_execute(&DATABASE_SEED.replace("{db}", &database)).await.expect("장면을 심지 못했어요");
    Scene { database, config }
}

// ───────────────────────── 읽는 도우미 ─────────────────────────

/// `grantee`(None이면 PUBLIC)가 받은 권한의 이름들(정렬)
fn granted(acl: &[AclEntry], grantee: Option<&str>) -> Vec<&'static str> {
    let mut names: Vec<_> = acl.iter().filter(|entry| entry.grantee.as_deref() == grantee).map(|entry| entry.privilege.as_str()).collect();
    names.sort_unstable();
    names
}

/// 테이블 소유자가 기본으로 갖는 권한(PG14·16)
const TABLE_OWNER_DEFAULT: [&str; 7] = ["DELETE", "INSERT", "REFERENCES", "SELECT", "TRIGGER", "TRUNCATE", "UPDATE"];

fn relation<'a>(snap: &'a DbSnapshot, schema: &str, name: &str) -> &'a RelationRec {
    snap.relations.iter().find(|r| r.schema == schema && r.name == name).unwrap_or_else(|| panic!("{schema}.{name} 관계가 없어요"))
}

fn schema_rec<'a>(snap: &'a DbSnapshot, name: &str) -> &'a SchemaRec {
    snap.schemas.iter().find(|s| s.name == name).unwrap_or_else(|| panic!("{name} 스키마가 없어요"))
}

fn function<'a>(snap: &'a DbSnapshot, name: &str) -> &'a FunctionRec {
    snap.functions.iter().find(|f| f.name == name).unwrap_or_else(|| panic!("{name} 함수가 없어요"))
}

fn default_acl(snap: &DbSnapshot, obj_type: DefaultObjType) -> &DefaultAclRec {
    snap.default_acls.iter().find(|d| d.obj_type == obj_type).unwrap_or_else(|| panic!("{obj_type:?} 기본 권한이 없어요"))
}

fn assert_just_now(fetched_at: &str, before: i64, after: i64) {
    let fetched = clock::parse_iso(fetched_at).unwrap_or_else(|| panic!("fetched_at이 ISO 8601이 아니에요: {fetched_at}"));
    assert!((before..=after).contains(&fetched), "{fetched_at}는 읽은 때({before}~{after})가 아니에요");
}

// ───────────────────────── 시험 ─────────────────────────

/// 시험을 PG14와 PG16에서 하나씩 돌린다: `<시험 이름>::pg14`, `<시험 이름>::pg16`
macro_rules! on_both_servers {
    ($($scenario:ident),* $(,)?) => {
        $(
            mod $scenario {
                use super::*;

                #[tokio::test]
                #[ignore = "Docker로 띄운 PostgreSQL이 필요해요(scripts/pg-live-test.sh)"]
                async fn pg14() {
                    super::$scenario(Server::Pg14).await
                }

                #[tokio::test]
                #[ignore = "Docker로 띄운 PostgreSQL이 필요해요(scripts/pg-live-test.sh)"]
                async fn pg16() {
                    super::$scenario(Server::Pg16).await
                }
            }
        )*
    };
}

on_both_servers!(
    cluster_snapshot_reads_the_seeded_roles_and_memberships,
    one_membership_granted_by_several_roles_is_one_pair,
    the_set_option_of_a_membership_is_read,
    valid_until_is_read_as_utc_and_minus_infinity_as_expired,
    db_snapshot_reads_schemas_relations_functions_and_default_acls,
    the_object_cap_cuts_the_snapshot,
    read_refuses_to_write,
    a_read_is_a_read_only_repeatable_read_transaction_with_a_local_timeout,
    all_statements_of_a_read_see_one_snapshot,
    a_snapshot_is_named_by_the_server_and_refuses_another_name,
    sessions_list_the_client_backends,
    a_user_with_pg_read_all_stats_sees_every_session,
    the_backend_pid_is_the_servers_own,
    the_catalog_is_readable_without_special_privileges,
    effective_privileges_match_postgres,
    a_noinherit_database_owner_matches_postgres,
);

async fn cluster_snapshot_reads_the_seeded_roles_and_memberships(server: Server) {
    let scene = seed(server).await;
    let mut conn = scene.connect().await;
    let before = clock::now_secs();
    let snap = cluster_snapshot(&mut conn, "iam_admin").await.expect("클러스터 스냅숏을 읽지 못했어요");
    let after = clock::now_secs();

    // 서버
    assert_eq!(snap.version_num / 10_000, server.major(), "version_num {}", snap.version_num);
    assert!(snap.version.starts_with(&format!("{}.", server.major())), "version {}", snap.version);
    assert_eq!(snap.password_encryption, "scram-sha-256");
    assert_eq!(snap.login_user, "iam_admin");
    assert_just_now(&snap.fetched_at, before, after);

    // 역할: 이름순이고, 속성이 심은 대로다
    assert!(snap.roles.windows(2).all(|pair| pair[0].name < pair[1].name), "역할은 이름순이어야 해요");
    let role = |name: &str| snap.roles.iter().find(|r| r.name == name).unwrap_or_else(|| panic!("역할 {name}가 없어요"));
    let owner = role("app_owner");
    assert_eq!((owner.login, owner.inherit, owner.superuser), (true, true, false));
    assert_eq!((owner.create_role, owner.create_db, owner.replication, owner.bypass_rls), (false, false, false, false));
    assert_eq!((owner.conn_limit, owner.valid_until.as_deref(), owner.comment.as_deref()), (-1, None, None));
    let app_read = role("app_read");
    assert!(!app_read.login);
    assert_eq!(app_read.comment.as_deref(), Some("read-only access to the app schema"));
    assert!(!role("app_write").login);
    let alice = role("alice");
    assert!(alice.login && alice.inherit);
    assert_eq!((alice.conn_limit, alice.valid_until.as_deref()), (5, Some("2031-01-01T00:00:00Z")));
    let bob = role("bob");
    assert!(bob.login && !bob.inherit, "bob은 NOINHERIT예요");
    let carol = role("carol");
    assert_eq!((carol.login, carol.valid_until.as_deref()), (true, None), "infinity는 만료 없음이에요");
    let postgres = role("postgres");
    assert!(postgres.superuser && postgres.create_role && postgres.create_db && postgres.replication && postgres.bypass_rls);
    assert!(!role("pg_read_all_data").login, "미리 정의된 역할도 읽혀요");

    // 구성원 관계: 쌍마다 하나. INHERIT·SET 옵션은 PG16부터 있고, bob의 INHERIT은 false다(SET은 모두 기본값 true)
    assert!(
        snap.members.windows(2).all(|pair| (&pair[0].member, &pair[0].group) < (&pair[1].member, &pair[1].group)),
        "구성원 관계는 (구성원, 그룹) 순이고 쌍마다 하나여야 해요"
    );
    let expected_option = |value: bool| server.has_membership_options().then_some(value);
    for (member, group, inherit) in
        [("app_write", "app_read", true), ("alice", "app_write", true), ("bob", "app_read", false), ("carol", "pg_read_all_data", true)]
    {
        let found: Vec<&MemberRec> = snap.members.iter().filter(|m| m.member == member && m.group == group).collect();
        assert_eq!(found.len(), 1, "{member} → {group}: {found:?}");
        assert_eq!((found[0].admin, found[0].inherit, found[0].set), (false, expected_option(inherit), expected_option(true)), "{member} → {group}");
    }
    assert_eq!(snap.members.iter().filter(|m| m.member == "alice").count(), 1, "alice는 app_write 하나에만 속해요");

    // 데이터베이스: 템플릿은 빠지고, 이름순이다
    assert!(snap.databases.windows(2).all(|pair| pair[0].name < pair[1].name));
    assert!(!snap.databases.iter().any(|d| d.name.starts_with("template")), "템플릿은 빠져야 해요");
    let seeded = snap.databases.iter().find(|d| d.name == scene.database).expect("심은 데이터베이스가 없어요");
    assert_eq!((seeded.owner.as_str(), seeded.allow_conn), ("app_owner", true));
    // PUBLIC에서 CONNECT를 거뒀고(TEMPORARY만 남았다), app_read에게 CONNECT를 줬다
    assert_eq!(granted(&seeded.acl, Some("app_owner")), ["CONNECT", "CREATE", "TEMPORARY"]);
    assert_eq!(granted(&seeded.acl, None), ["TEMPORARY"]);
    assert_eq!(granted(&seeded.acl, Some("app_read")), ["CONNECT"]);
    assert_eq!(seeded.acl.len(), 5);
    let connect_grant = seeded.acl.iter().find(|e| e.grantee.as_deref() == Some("app_read")).expect("app_read의 CONNECT가 없어요");
    assert_eq!((connect_grant.grantor.as_str(), connect_grant.privilege, connect_grant.grantable), ("app_owner", Privilege::Connect, false));
    // ACL이 NULL인 데이터베이스는 서버 기본값으로 채워진다: PUBLIC은 CONNECT와 TEMPORARY
    let default_db = snap.databases.iter().find(|d| d.name == "postgres").expect("postgres 데이터베이스가 없어요");
    assert_eq!(default_db.owner, "postgres");
    assert_eq!(granted(&default_db.acl, None), ["CONNECT", "TEMPORARY"]);

    // 역할별 설정: 역할 전체, 역할+데이터베이스, 데이터베이스 전체
    let settings = |role: Option<&str>, database: Option<&str>| -> Vec<&str> {
        snap.settings.iter().filter(|s| s.role.as_deref() == role && s.database.as_deref() == database).map(|s| s.setting.as_str()).collect()
    };
    let search_path = settings(Some("alice"), None);
    assert!(search_path.len() == 1 && search_path[0].starts_with("search_path=") && search_path[0].contains("app"), "{search_path:?}");
    assert_eq!(settings(Some("alice"), Some(scene.database.as_str())), ["statement_timeout=5s"]);
    assert_eq!(settings(None, Some(scene.database.as_str())), ["work_mem=8MB"]);

    // 세션: 이 연결이 들어 있다
    assert!(snap.sessions.iter().any(|s| s.pid == conn.backend_pid), "이 연결의 세션이 없어요");
}

/// PG16부터 같은 구성원 관계를 부여자마다 따로 둘 수 있다. 앱은 한 쌍으로 합쳐 읽는다.
/// 서버가 같은 쌍의 줄을 어떤 순서로 주는지는 정해져 있지 않다. 그래서 옵션마다 허용한 부여가 서로 반대인 쌍을 둘 두어,
/// 어느 순서로 와도 합치지 않는 구현은 둘 중 하나에서 드러나게 한다
async fn one_membership_granted_by_several_roles_is_one_pair(server: Server) {
    let scene = seed(server).await;
    let mut conn = scene.connect().await;
    let drop_roles = "DROP ROLE IF EXISTS mm_dup_x; DROP ROLE IF EXISTS mm_dup_y; DROP ROLE IF EXISTS mm_dup_admin; DROP ROLE IF EXISTS mm_dup_group;";
    conn.client.batch_execute(drop_roles).await.expect("지난 시험의 역할을 지우지 못했어요");
    conn.client
        .batch_execute(
            "CREATE ROLE mm_dup_group NOLOGIN; CREATE ROLE mm_dup_x NOLOGIN; CREATE ROLE mm_dup_y NOLOGIN; CREATE ROLE mm_dup_admin NOLOGIN;
             GRANT mm_dup_group TO mm_dup_admin WITH ADMIN OPTION;",
        )
        .await
        .expect("역할을 만들지 못했어요");
    let grants = if server.has_membership_options() {
        // x: 먼저 superuser가 INHERIT만, 나중에 mm_dup_admin이 ADMIN과 SET을 준다. y: 먼저 superuser가 ADMIN과 SET을, 나중에 mm_dup_admin이 INHERIT만 준다
        "GRANT mm_dup_group TO mm_dup_x WITH INHERIT TRUE, SET FALSE;
         GRANT mm_dup_group TO mm_dup_x WITH ADMIN OPTION, INHERIT FALSE, SET TRUE GRANTED BY mm_dup_admin;
         GRANT mm_dup_group TO mm_dup_y WITH ADMIN OPTION, INHERIT FALSE, SET TRUE;
         GRANT mm_dup_group TO mm_dup_y WITH INHERIT TRUE, SET FALSE GRANTED BY mm_dup_admin;"
    } else {
        "GRANT mm_dup_group TO mm_dup_x; GRANT mm_dup_group TO mm_dup_y;"
    };
    conn.client.batch_execute(grants).await.expect("부여하지 못했어요");
    let raw_rows: i64 = conn
        .client
        .query_one(
            "SELECT count(*) FROM pg_auth_members am JOIN pg_roles m ON m.oid = am.member JOIN pg_roles g ON g.oid = am.roleid
             WHERE m.rolname IN ('mm_dup_x', 'mm_dup_y') AND g.rolname = 'mm_dup_group'",
            &[],
        )
        .await
        .expect("부여를 세지 못했어요")
        .get(0);
    assert_eq!(raw_rows, if server.has_membership_options() { 4 } else { 2 }, "서버에는 부여자마다 한 줄이 있어요");

    let snap = cluster_snapshot(&mut conn, "iam_admin").await.expect("클러스터 스냅숏을 읽지 못했어요");
    // 하나라도 허용하면 허용이다: INHERIT·ADMIN·SET 모두, 어느 부여가 허용했든
    let expected = if server.has_membership_options() { (true, Some(true), Some(true)) } else { (false, None, None) };
    for member in ["mm_dup_x", "mm_dup_y"] {
        let pair: Vec<&MemberRec> = snap.members.iter().filter(|m| m.member == member && m.group == "mm_dup_group").collect();
        assert_eq!(pair.len(), 1, "{member}: 한 쌍으로 합쳐야 해요: {pair:?}");
        assert_eq!((pair[0].admin, pair[0].inherit, pair[0].set), expected, "{member}");
    }

    conn.client.batch_execute(drop_roles).await.expect("시험 역할을 지우지 못했어요");
}

/// PG16의 SET 옵션(`SET ROLE`을 허용하는지)은 부여마다 읽는다. PG16에서 CREATEROLE 사용자가 만든 역할은
/// ADMIN만 있고 INHERIT도 SET도 없이 그 사용자에게 부여되어, 만든 사용자라도 그 역할로 `SET ROLE`을 할 수 없다
async fn the_set_option_of_a_membership_is_read(server: Server) {
    let scene = seed(server).await;
    let mut conn = scene.connect().await;
    let drop_roles = "DROP ROLE IF EXISTS mm_set_created; DROP ROLE IF EXISTS mm_set_creator; DROP ROLE IF EXISTS mm_set_member;
                      DROP ROLE IF EXISTS mm_set_plain; DROP ROLE IF EXISTS mm_set_group;";
    conn.client.batch_execute(drop_roles).await.expect("지난 시험의 역할을 지우지 못했어요");
    conn.client
        .batch_execute(
            "CREATE ROLE mm_set_group NOLOGIN; CREATE ROLE mm_set_member NOLOGIN; CREATE ROLE mm_set_plain NOLOGIN;
             CREATE ROLE mm_set_creator NOLOGIN CREATEROLE;
             GRANT mm_set_group TO mm_set_plain;
             SET ROLE mm_set_creator; CREATE ROLE mm_set_created NOLOGIN; RESET ROLE;",
        )
        .await
        .expect("역할을 만들지 못했어요");
    // 일부러 INHERIT과 SET을 끈 부여. PG16 전에는 이런 옵션이 없어서 평범한 부여다
    let restricted = if server.has_membership_options() {
        "GRANT mm_set_group TO mm_set_member WITH INHERIT FALSE, SET FALSE"
    } else {
        "GRANT mm_set_group TO mm_set_member"
    };
    conn.client.batch_execute(restricted).await.expect("부여하지 못했어요");

    let snap = cluster_snapshot(&mut conn, "iam_admin").await.expect("클러스터 스냅숏을 읽지 못했어요");
    let options = |member: &str, group: &str| -> Option<(bool, Option<bool>, Option<bool>)> {
        snap.members.iter().find(|m| m.member == member && m.group == group).map(|m| (m.admin, m.inherit, m.set))
    };
    if server.has_membership_options() {
        assert_eq!(options("mm_set_member", "mm_set_group"), Some((false, Some(false), Some(false))));
        assert_eq!(options("mm_set_plain", "mm_set_group"), Some((false, Some(true), Some(true))), "옵션을 안 쓰면 기본값은 둘 다 true예요");
        assert_eq!(options("mm_set_creator", "mm_set_created"), Some((true, Some(false), Some(false))), "만든 사용자는 ADMIN만 받아요");
    } else {
        assert_eq!(options("mm_set_member", "mm_set_group"), Some((false, None, None)));
        assert_eq!(options("mm_set_plain", "mm_set_group"), Some((false, None, None)));
        assert_eq!(options("mm_set_creator", "mm_set_created"), None, "PG15 이하는 만든 사용자에게 아무것도 부여하지 않아요");
    }

    conn.client.batch_execute(drop_roles).await.expect("시험 역할을 지우지 못했어요");
}

/// `VALID UNTIL`은 UTC ISO 8601로 읽는다. `infinity`와 설정 없음은 None이고, `-infinity`(비밀번호로는 로그인할 수 없다)는 만료로 보이는 가장 오래된 시각이다
async fn valid_until_is_read_as_utc_and_minus_infinity_as_expired(server: Server) {
    let scene = seed(server).await;
    let mut conn = scene.connect().await;
    let drop_roles = "DROP ROLE IF EXISTS mm_valid_dead; DROP ROLE IF EXISTS mm_valid_offset; DROP ROLE IF EXISTS mm_valid_open; DROP ROLE IF EXISTS mm_valid_unset;";
    conn.client.batch_execute(drop_roles).await.expect("지난 시험의 역할을 지우지 못했어요");
    conn.client
        .batch_execute(
            "CREATE ROLE mm_valid_dead NOLOGIN VALID UNTIL '-infinity';
             CREATE ROLE mm_valid_offset NOLOGIN VALID UNTIL '2031-01-01 09:00:00+09';
             CREATE ROLE mm_valid_open NOLOGIN VALID UNTIL 'infinity';
             CREATE ROLE mm_valid_unset NOLOGIN;",
        )
        .await
        .expect("역할을 만들지 못했어요");

    let snap = cluster_snapshot(&mut conn, "iam_admin").await.expect("클러스터 스냅숏을 읽지 못했어요");
    let valid_until = |name: &str| snap.roles.iter().find(|r| r.name == name).unwrap_or_else(|| panic!("역할 {name}가 없어요")).valid_until.clone();
    let dead = valid_until("mm_valid_dead");
    assert_eq!(dead.as_deref(), Some("1970-01-01T00:00:00Z"), "-infinity는 만료로 보여야 해요");
    assert_eq!(dead.as_deref().and_then(clock::parse_iso), Some(0));
    assert_eq!(valid_until("mm_valid_offset").as_deref(), Some("2031-01-01T00:00:00Z"), "UTC로 바꿔 읽어요");
    assert_eq!(valid_until("mm_valid_open"), None);
    assert_eq!(valid_until("mm_valid_unset"), None);

    conn.client.batch_execute(drop_roles).await.expect("시험 역할을 지우지 못했어요");
}

async fn db_snapshot_reads_schemas_relations_functions_and_default_acls(server: Server) {
    let scene = seed(server).await;
    let mut conn = scene.connect().await;
    let before = clock::now_secs();
    let snap = db_snapshot(&mut conn, &scene.database).await.expect("데이터베이스 스냅숏을 읽지 못했어요");
    let after = clock::now_secs();

    assert_eq!((snap.database.as_str(), snap.owner.as_str(), snap.truncated), (scene.database.as_str(), "app_owner", false));
    assert_just_now(&snap.fetched_at, before, after);

    // 스키마: 시스템 스키마는 빠진다
    let schema_names: Vec<&str> = snap.schemas.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(schema_names, ["app", "audit", "public", "scratch"]);
    let app = schema_rec(&snap, "app");
    assert_eq!(app.owner, "app_owner");
    assert_eq!(granted(&app.acl, Some("app_owner")), ["CREATE", "USAGE"]);
    assert_eq!(granted(&app.acl, Some("app_read")), ["USAGE"]);
    assert_eq!(granted(&schema_rec(&snap, "audit").acl, Some("app_write")), ["USAGE"]);
    // ACL이 NULL인 스키마는 서버 기본값(소유자만)으로 채워진다
    let scratch = schema_rec(&snap, "scratch");
    assert_eq!((scratch.acl.len(), granted(&scratch.acl, Some("app_owner"))), (2, vec!["CREATE", "USAGE"]));
    // `public`은 PG15에서 바뀌었다
    let public = schema_rec(&snap, "public");
    match server {
        Server::Pg14 => {
            assert_eq!(public.owner, "postgres");
            assert_eq!(granted(&public.acl, None), ["CREATE", "USAGE"], "PG14의 public은 PUBLIC에게 CREATE도 줘요");
        }
        Server::Pg16 => {
            assert_eq!(public.owner, "pg_database_owner");
            assert_eq!(granted(&public.acl, None), ["USAGE"]);
        }
    }

    // 관계: (스키마, 이름) 순. 파티션 자식, 인덱스, 시스템 스키마의 것은 빠진다
    let listed: Vec<(&str, &str, RelKind)> = snap.relations.iter().map(|r| (r.schema.as_str(), r.name.as_str(), r.kind)).collect();
    assert_eq!(
        listed,
        [
            ("app", "customers", RelKind::Table),
            ("app", "locked", RelKind::Table),
            ("app", "order_summary", RelKind::MatView),
            ("app", "order_totals", RelKind::View),
            ("app", "orders", RelKind::Table),
            ("app", "orders_id_seq", RelKind::Sequence),
            ("app", "ticket_seq", RelKind::Sequence),
            ("audit", "events", RelKind::Partitioned),
            ("audit", "remote_log", RelKind::Foreign),
        ]
    );
    assert!(snap.relations.iter().all(|r| r.owner == "app_owner"));
    assert_eq!(snap.relations.iter().filter(|r| r.rls).map(|r| r.name.as_str()).collect::<Vec<_>>(), ["customers"]);
    let orders = relation(&snap, "app", "orders");
    let owner_privileges = granted(&orders.acl, Some("app_owner"));
    assert!(TABLE_OWNER_DEFAULT.iter().all(|p| owner_privileges.contains(p)), "{owner_privileges:?}");
    assert_eq!(granted(&orders.acl, Some("app_read")), ["SELECT"]);
    assert_eq!(granted(&orders.acl, Some("app_write")), ["INSERT", "UPDATE"]);
    let select_grant = orders.acl.iter().find(|e| e.grantee.as_deref() == Some("app_read")).expect("app_read의 SELECT가 없어요");
    assert_eq!((select_grant.grantor.as_str(), select_grant.privilege, select_grant.grantable), ("app_owner", Privilege::Select, false));
    assert_eq!(granted(&relation(&snap, "app", "order_totals").acl, Some("app_read")), ["SELECT"]);
    // ACL이 NULL인 시퀀스는 서버 기본값, 명시된 시퀀스는 그대로
    let ticket = relation(&snap, "app", "ticket_seq");
    assert_eq!((ticket.acl.len(), granted(&ticket.acl, Some("app_owner"))), (3, vec!["SELECT", "UPDATE", "USAGE"]));
    assert_eq!(granted(&relation(&snap, "app", "orders_id_seq").acl, Some("app_write")), ["USAGE"]);
    // 소유자도 권한을 거둬 ACL이 빈 테이블은 빈 채로 남는다
    assert!(relation(&snap, "app", "locked").acl.is_empty());

    // 함수: 집계는 빠지고 프로시저는 들어온다. 인자 목록은 같은 이름을 구분하는 것이다
    let listed: Vec<(&str, &str, &str)> = snap.functions.iter().map(|f| (f.schema.as_str(), f.name.as_str(), f.signature.as_str())).collect();
    assert_eq!(
        listed,
        [
            ("app", "cleanup", ""),
            ("app", "plain", "a integer, b text"),
            ("app", "safe_touch", "order_id integer"),
            ("app", "touch", "order_id integer"),
        ]
    );
    let flags = |name: &str| (function(&snap, name).security_definer, function(&snap, name).search_path_set);
    assert_eq!(flags("touch"), (true, false), "search_path가 없는 SECURITY DEFINER");
    assert_eq!(flags("safe_touch"), (true, true));
    assert_eq!(flags("plain"), (false, false));
    assert_eq!(flags("cleanup"), (false, false));
    assert!(snap.functions.iter().all(|f| f.owner == "app_owner"));
    let touch = function(&snap, "touch");
    assert_eq!(granted(&touch.acl, None), Vec::<&str>::new(), "PUBLIC의 EXECUTE를 거뒀어요");
    assert_eq!(granted(&touch.acl, Some("app_write")), ["EXECUTE"]);
    // ACL이 NULL인 함수는 서버 기본값: PUBLIC이 EXECUTE를 갖는다
    assert_eq!(granted(&function(&snap, "plain").acl, None), ["EXECUTE"]);

    // 기본 권한: 스키마 안의 것과 모든 스키마의 것
    assert_eq!(snap.default_acls.len(), 2, "{:?}", snap.default_acls);
    let tables = default_acl(&snap, DefaultObjType::Tables);
    assert_eq!((tables.creator.as_str(), tables.schema.as_deref()), ("app_owner", Some("app")));
    assert_eq!(
        tables.acl,
        [AclEntry { grantor: "app_owner".into(), grantee: Some("app_read".into()), privilege: Privilege::Select, grantable: false }]
    );
    let sequences = default_acl(&snap, DefaultObjType::Sequences);
    assert_eq!((sequences.creator.as_str(), sequences.schema.as_deref()), ("app_owner", None));
    assert_eq!(granted(&sequences.acl, Some("app_write")), ["USAGE"]);
    assert_eq!(granted(&sequences.acl, Some("app_owner")), ["SELECT", "UPDATE", "USAGE"], "모든 스키마의 기본 권한은 서버 기본값에서 출발해요");
}

/// 관계가 먼저 자리를 잡고(권한 격자와 점검이 다루는 것은 주로 테이블이다), 함수는 남는 자리만큼 든다
async fn the_object_cap_cuts_the_snapshot(server: Server) {
    let scene = seed(server).await;
    let mut conn = scene.connect().await;
    let full = db_snapshot(&mut conn, &scene.database).await.expect("데이터베이스 스냅숏을 읽지 못했어요");
    assert_eq!((full.relations.len(), full.functions.len(), full.truncated), (9, 4, false));
    let capped = async |conn: &mut Connected, max: usize| db_snapshot_capped(conn, &scene.database, max).await.expect("상한을 둔 스냅숏을 읽지 못했어요");
    let names = |snap: &DbSnapshot| -> (Vec<String>, Vec<String>) {
        (snap.relations.iter().map(|r| r.name.clone()).collect(), snap.functions.iter().map(|f| f.name.clone()).collect())
    };
    let (all_relations, all_functions) = names(&full);

    // 딱 상한이면 자르지 않는다(관계 9 + 함수 4)
    let exact = capped(&mut conn, 13).await;
    assert_eq!(DbSnapshot { fetched_at: full.fetched_at.clone(), ..exact }, full);

    // 하나 모자라면 관계는 모두 들고, 이름순으로 뒤의 함수 하나가 잘린다
    let cut = capped(&mut conn, 12).await;
    assert!(cut.truncated);
    assert_eq!(names(&cut), (all_relations.clone(), all_functions[..3].to_vec()));

    // 관계 9개가 먼저 자리를 잡고 함수는 남는 한 자리만 얻는다
    let cut = capped(&mut conn, 10).await;
    assert!(cut.truncated);
    assert_eq!(names(&cut), (all_relations.clone(), all_functions[..1].to_vec()));

    // 관계만으로 꽉 차면 함수는 하나도 없다
    let cut = capped(&mut conn, 9).await;
    assert!(cut.truncated);
    assert_eq!(names(&cut), (all_relations.clone(), vec![]));

    // 관계만으로 넘으면 관계도 상한까지만 들고, 함수는 읽지 않는다
    let cut = capped(&mut conn, 6).await;
    assert!(cut.truncated);
    assert_eq!(names(&cut), (all_relations[..6].to_vec(), vec![]));
    let cut = capped(&mut conn, 3).await;
    assert!(cut.truncated);
    assert_eq!(names(&cut), (all_relations[..3].to_vec(), vec![]));

    // 자르는 것은 관계와 함수뿐이다
    assert_eq!((cut.schemas, cut.default_acls), (full.schemas, full.default_acls));

    // 함수가 하나도 없어도 관계가 잘린 것은 알아봐야 한다(함수를 읽다가 우연히 넘는 것이 아니다)
    conn.client
        .batch_execute("DROP FUNCTION app.touch(integer), app.safe_touch(integer), app.plain(integer, text); DROP PROCEDURE app.cleanup();")
        .await
        .expect("함수를 지우지 못했어요");
    let exact = capped(&mut conn, 9).await;
    assert_eq!((exact.relations.len(), exact.functions.len(), exact.truncated), (9, 0, false), "딱 상한이면 자르지 않아요");
    let cut = capped(&mut conn, 8).await;
    assert_eq!((names(&cut), cut.truncated), ((all_relations[..8].to_vec(), vec![]), true));
}

async fn read_refuses_to_write(server: Server) {
    let scene = seed(server).await;
    let mut conn = scene.connect().await;
    let attempts = [
        ("테이블 만들기", "CREATE TABLE mm_write_probe()"),
        ("행 넣기", "INSERT INTO app.orders (customer) VALUES ('x')"),
        ("권한 주기", "GRANT SELECT ON app.orders TO carol"),
        ("역할 만들기", "CREATE ROLE mm_write_probe"),
    ];
    for (what, sql) in attempts {
        let mut sqlstate = None;
        let result = read(&mut conn, async |tx| {
            let attempt = tx.batch_execute(sql).await;
            sqlstate = attempt.as_ref().err().and_then(|e| e.code()).map(|code| code.code().to_string());
            attempt
        })
        .await;
        // 서버가 읽기 전용 트랜잭션이라며 거절한다
        assert_eq!(sqlstate.as_deref(), Some("25006"), "{what}: {result:?}");
        assert!(matches!(&result, Err(AppError::Other { message }) if message.contains("read-only transaction")), "{what}: {result:?}");
    }

    // 아무것도 바뀌지 않았다. 거절당한 뒤에도 연결은 쓸 수 있다
    let count = async |sql: &str| -> i64 { conn.client.query_one(sql, &[]).await.expect("세지 못했어요").get(0) };
    assert_eq!(count("SELECT count(*) FROM pg_class WHERE relname = 'mm_write_probe'").await, 0);
    assert_eq!(count("SELECT count(*) FROM app.orders").await, 0);
    assert_eq!(count("SELECT count(*) FROM pg_roles WHERE rolname = 'mm_write_probe'").await, 0);
    assert_eq!(count("SELECT count(*) FROM information_schema.table_privileges WHERE grantee = 'carol' AND table_name = 'orders'").await, 0);
    assert!(sessions(&mut conn).await.is_ok());
}

/// 읽기 하나는 읽기 전용이고 한 시점을 보는(REPEATABLE READ) 트랜잭션 하나다. 문장 시간 제한은 그 트랜잭션에만 걸린다
async fn a_read_is_a_read_only_repeatable_read_transaction_with_a_local_timeout(server: Server) {
    let scene = seed(server).await;
    let mut conn = scene.connect().await;
    let inside = read(&mut conn, async |tx| {
        let timeout: String = tx.query_one("SHOW statement_timeout", &[]).await?.try_get(0)?;
        let read_only: String = tx.query_one("SHOW transaction_read_only", &[]).await?.try_get(0)?;
        let isolation: String = tx.query_one("SELECT current_setting('transaction_isolation')", &[]).await?.try_get(0)?;
        Ok((timeout, read_only, isolation))
    })
    .await
    .expect("읽지 못했어요");
    assert_eq!(inside, ("30s".to_string(), "on".to_string(), "repeatable read".to_string()));
    // `SET LOCAL`이라 트랜잭션이 끝나면 연결에 남지 않는다
    let show = async |name: &str| -> String {
        let sql = format!("SHOW {name}");
        conn.client.query_one(sql.as_str(), &[]).await.expect("값을 읽지 못했어요").get(0)
    };
    assert_eq!(show("statement_timeout").await, "0");
    assert_eq!(show("transaction_read_only").await, "off");
    assert_eq!(show("transaction_isolation").await, "read committed");
}

/// 한 읽기의 모든 문장은 같은 시점을 본다. 읽는 도중 다른 세션이 역할을 만들어도 이 읽기에는 보이지 않는다
/// (READ COMMITTED였다면 문장마다 새 시점을 봐서 역할 목록과 구성원 관계가 서로 다른 상태에서 올 수 있다)
async fn all_statements_of_a_read_see_one_snapshot(server: Server) {
    let scene = seed(server).await;
    let mut conn = scene.connect().await;
    let other = connect_to(&scene.config).await;
    other.batch_execute("DROP ROLE IF EXISTS mm_snapshot_probe").await.expect("지난 시험의 역할을 지우지 못했어요");

    let count_probe = "SELECT count(*) FROM pg_roles WHERE rolname = 'mm_snapshot_probe'";
    let (first, second) = read(&mut conn, async |tx| {
        let first: i64 = tx.query_one(count_probe, &[]).await?.try_get(0)?;
        // 읽는 도중에 다른 세션이 역할을 만들고 바로 커밋한다
        other.batch_execute("CREATE ROLE mm_snapshot_probe NOLOGIN").await?;
        let second: i64 = tx.query_one(count_probe, &[]).await?.try_get(0)?;
        Ok((first, second))
    })
    .await
    .expect("읽지 못했어요");
    assert_eq!((first, second), (0, 0), "읽는 동안 만들어진 역할이 보이면 문장마다 다른 시점을 보는 거예요");

    // 읽기가 끝난 뒤의 새 읽기에는 보인다
    let seen_later = read(&mut conn, async |tx| tx.query_one(count_probe, &[]).await?.try_get::<_, i64>(0)).await.expect("읽지 못했어요");
    assert_eq!(seen_later, 1);

    other.batch_execute("DROP ROLE mm_snapshot_probe").await.expect("시험 역할을 지우지 못했어요");
}

/// 스냅숏의 이름은 서버가 말해 주는 연결한 데이터베이스의 이름이다. 요청한 이름과 다르면 거절한다
async fn a_snapshot_is_named_by_the_server_and_refuses_another_name(server: Server) {
    let scene = seed(server).await;
    let mut conn = scene.connect().await;
    let snap = db_snapshot(&mut conn, &scene.database).await.expect("데이터베이스 스냅숏을 읽지 못했어요");
    assert_eq!(snap.database, scene.database);

    let refused = db_snapshot(&mut conn, "not_this_database").await;
    assert_eq!(refused, Err(AppError::other(format!("연결한 데이터베이스가 요청과 달라요: not_this_database / {}", scene.database))));
    // 거절한 뒤에도 연결은 쓸 수 있다
    assert!(db_snapshot(&mut conn, &scene.database).await.is_ok());
}

async fn sessions_list_the_client_backends(server: Server) {
    let scene = seed(server).await;
    let mut conn = scene.connect().await;
    // alice도 붙어 있고, 방금 질의를 마쳐서 쉬는 중이다
    let alice = connect_to(&scene.config_as("alice", "alice", "mm-live-alice")).await;
    alice.query_one("SELECT 1", &[]).await.expect("alice가 질의하지 못했어요");

    let listed = sessions(&mut conn).await.expect("세션을 읽지 못했어요");
    let own = listed.iter().find(|s| s.pid == conn.backend_pid).expect("이 연결의 세션이 없어요");
    assert_eq!((own.role.as_deref(), own.database.as_deref()), (Some("postgres"), Some(scene.database.as_str())));
    assert_eq!((own.application_name.as_str(), own.state.as_deref()), ("mm-live", Some("active")));
    // 주소는 `/32` 같은 꼬리 없이 주소만, 시각은 ISO 8601 UTC다
    let addr = own.client_addr.as_deref().expect("TCP로 붙었으니 주소가 있어야 해요");
    assert!(addr.parse::<IpAddr>().is_ok(), "{addr}");
    for time in [&own.backend_start, &own.query_start] {
        let time = time.as_deref().expect("시각이 있어야 해요");
        assert!(time.ends_with('Z') && clock::parse_iso(time).is_some(), "{time}");
    }
    let other = listed.iter().find(|s| s.role.as_deref() == Some("alice")).expect("alice의 세션이 없어요");
    assert_eq!((other.database.as_deref(), other.application_name.as_str(), other.state.as_deref()), (Some(scene.database.as_str()), "mm-live-alice", Some("idle")));
    assert_ne!(other.pid, own.pid);

    // 오래된 세션부터 나온다
    let started: Vec<i64> = listed.iter().filter_map(|s| s.backend_start.as_deref()).filter_map(clock::parse_iso).collect();
    assert!(started.windows(2).all(|pair| pair[0] <= pair[1]), "{started:?}");
    // 서버의 백그라운드 프로세스(체크포인터, 자동 정리 등)는 세션이 아니다
    let background: Vec<i32> = conn
        .client
        .query("SELECT pid FROM pg_stat_activity WHERE backend_type <> 'client backend'", &[])
        .await
        .expect("백그라운드 프로세스를 읽지 못했어요")
        .iter()
        .map(|row| row.get(0))
        .collect();
    assert!(!background.is_empty(), "서버에는 백그라운드 프로세스가 있어야 해요");
    assert!(listed.iter().all(|s| !background.contains(&s.pid)));
}

/// superuser가 아니어도 `pg_read_all_stats` 멤버면 모든 세션이 모든 칸과 함께 읽힌다
async fn a_user_with_pg_read_all_stats_sees_every_session(server: Server) {
    let scene = seed(server).await;
    let admin = scene.connect().await;
    admin.client.batch_execute("DROP ROLE IF EXISTS mm_monitor").await.expect("지난 시험의 역할을 지우지 못했어요");
    admin
        .client
        .batch_execute("CREATE ROLE mm_monitor LOGIN PASSWORD 'monitor'; GRANT pg_read_all_stats TO mm_monitor")
        .await
        .expect("역할을 만들지 못했어요");
    // 시험 데이터베이스는 PUBLIC의 CONNECT를 거뒀으니 `postgres`에 붙는다
    let mut config = scene.config_as("mm_monitor", "monitor", "mm-live-monitor");
    config.dbname("postgres");
    let mut monitor = connected(&config).await;

    let seen = sessions(&mut monitor).await.expect("세션을 읽지 못했어요");
    let other = seen.iter().find(|s| s.pid == admin.backend_pid).expect("다른 사용자(superuser)의 세션이 보여야 해요");
    assert_eq!(
        (other.role.as_deref(), other.database.as_deref(), other.application_name.as_str(), other.state.as_deref()),
        (Some("postgres"), Some(scene.database.as_str()), "mm-live", Some("idle"))
    );
    assert!(other.client_addr.is_some() && other.backend_start.is_some() && other.query_start.is_some(), "{other:?}");
    assert!(seen.iter().any(|s| s.pid == monitor.backend_pid), "자기 세션도 있어요");

    drop(monitor);
    admin.client.batch_execute("DROP ROLE mm_monitor").await.expect("시험 역할을 지우지 못했어요");
}

async fn the_backend_pid_is_the_servers_own(server: Server) {
    let scene = seed(server).await;
    let conn = scene.connect().await;
    let reported: i32 = conn.client.query_one("SELECT pg_backend_pid()", &[]).await.expect("pid를 읽지 못했어요").get(0);
    assert_eq!(conn.backend_pid, reported);
}

/// 앱의 로그인 사용자는 superuser가 아니다. 카탈로그를 읽는 데 특별한 권한이 필요하지 않아야 한다
async fn the_catalog_is_readable_without_special_privileges(server: Server) {
    let scene = seed(server).await;
    let mut admin = scene.connect().await;
    // alice는 CONNECT를 직접 받지 않았다. app_write → app_read를 거쳐 상속한 것으로 들어온다
    let mut alice = connected(&scene.config_as("alice", "alice", "mm-live-alice")).await;

    let admin_cluster = cluster_snapshot(&mut admin, "iam_admin").await.expect("superuser의 클러스터 스냅숏");
    let alice_cluster = cluster_snapshot(&mut alice, "alice").await.expect("alice의 클러스터 스냅숏");
    assert_eq!(alice_cluster.login_user, "alice");
    assert_eq!(
        (&alice_cluster.roles, &alice_cluster.members, &alice_cluster.databases, &alice_cluster.settings),
        (&admin_cluster.roles, &admin_cluster.members, &admin_cluster.databases, &admin_cluster.settings)
    );
    assert_eq!((alice_cluster.version_num, &alice_cluster.version), (admin_cluster.version_num, &admin_cluster.version));
    // `pg_read_all_stats`가 없으면 서버는 다른 역할의 세션에서 `backend_type`, `state`, `client_addr`, `backend_start`, `query_start`, `wait_event`를
    // 비워 준다. 그래도 역할·데이터베이스·응용 이름이 있는 줄은 세션으로 읽는다(`pg_read_all_stats` 멤버가 보는 전체는 다음 시험에서 본다)
    let own = alice_cluster.sessions.iter().find(|s| s.pid == alice.backend_pid).expect("alice 자신의 세션이 없어요");
    assert_eq!((own.role.as_deref(), own.state.as_deref()), (Some("alice"), Some("active")));
    let seen = alice_cluster.sessions.iter().find(|s| s.pid == admin.backend_pid).expect("superuser의 세션도 목록에 있어야 해요");
    assert_eq!((seen.role.as_deref(), seen.database.as_deref(), seen.application_name.as_str()), (Some("postgres"), Some(scene.database.as_str()), "mm-live"));
    assert_eq!((&seen.state, &seen.client_addr, &seen.backend_start, &seen.query_start, &seen.wait_event), (&None, &None, &None, &None, &None));
    // 서버의 백그라운드 프로세스는 역할이나 데이터베이스가 없어 여전히 세션이 아니다
    assert!(alice_cluster.sessions.iter().all(|s| s.role.is_some() && s.database.is_some()), "{:?}", alice_cluster.sessions);
    assert!(admin_cluster.sessions.iter().any(|s| s.pid == admin.backend_pid), "superuser는 모든 세션을 모든 칸과 함께 봐요");

    let admin_db = db_snapshot(&mut admin, &scene.database).await.expect("superuser의 데이터베이스 스냅숏");
    let alice_db = db_snapshot(&mut alice, &scene.database).await.expect("alice의 데이터베이스 스냅숏");
    assert_eq!(DbSnapshot { fetched_at: admin_db.fetched_at.clone(), ..alice_db }, admin_db);
}

// ───────────────────────── 실효 권한을 서버와 맞대 보기 ─────────────────────────
//
// `eval`이 스냅숏만으로 계산한 권한을 서버가 `has_*_privilege`·`pg_has_role`로 답하는 것과 모든 역할 × 객체 × 권한에서 맞대 본다.
// 서버의 답이 정답이다. 다르면 역할·객체·권한과 양쪽의 답을 적어 시험이 실패한다.

/// 서버 규칙의 모서리를 건드리는 역할들(클러스터 전체의 것)을 심기 전에 지난 실행이 남긴 것을 지운다.
/// 이 역할 앞으로 부여된 ACL 항목은 어디에도 두지 않으므로 지울 수 있다
const COMPARISON_ROLES_DROP: &str = "DROP ROLE IF EXISTS mm_cmp_super, mm_cmp_in_super, mm_cmp_writer, mm_cmp_both, mm_cmp_ops, mm_cmp_ops_noinherit,
    mm_cmp_mid, mm_cmp_top, mm_cmp_altered, mm_cmp_inherit_off, mm_cmp_inherit_on, mm_cmp_no_set, mm_cmp_neither,
    mm_cmp_deep, mm_cmp_deep_a, mm_cmp_deep_b";

const COMPARISON_ROLES: &str = r#"
-- superuser 속성은 상속되지 않는다: 구성원인 mm_cmp_in_super는 superuser가 아니다
CREATE ROLE mm_cmp_super SUPERUSER NOLOGIN;
CREATE ROLE mm_cmp_in_super NOLOGIN;
GRANT mm_cmp_super TO mm_cmp_in_super;
-- 미리 정의된 데이터 역할
CREATE ROLE mm_cmp_writer NOLOGIN;
GRANT pg_write_all_data TO mm_cmp_writer;
CREATE ROLE mm_cmp_both NOLOGIN;
GRANT pg_read_all_data, pg_write_all_data TO mm_cmp_both;
-- 소유자 역할(데이터베이스와 객체의 소유자 app_owner)을 상속하는 역할과 상속하지 않는 역할
CREATE ROLE mm_cmp_ops NOLOGIN;
GRANT app_owner TO mm_cmp_ops;
CREATE ROLE mm_cmp_ops_noinherit NOLOGIN NOINHERIT;
GRANT app_owner TO mm_cmp_ops_noinherit;
-- 사슬 한가운데가 NOINHERIT: mm_cmp_top은 mm_cmp_mid까지만 닿고 app_read의 권한은 쓰지 못한다
CREATE ROLE mm_cmp_mid NOLOGIN NOINHERIT;
GRANT app_read TO mm_cmp_mid;
CREATE ROLE mm_cmp_top NOLOGIN;
GRANT mm_cmp_mid TO mm_cmp_top;
-- 상속하는 관계가 여러 단계 이어진다: mm_cmp_deep → mm_cmp_deep_a → mm_cmp_deep_b → app_read
CREATE ROLE mm_cmp_deep NOLOGIN;
CREATE ROLE mm_cmp_deep_a NOLOGIN;
CREATE ROLE mm_cmp_deep_b NOLOGIN;
GRANT app_read TO mm_cmp_deep_b;
GRANT mm_cmp_deep_b TO mm_cmp_deep_a;
GRANT mm_cmp_deep_a TO mm_cmp_deep;
-- 부여한 뒤에 NOINHERIT로 바꾼 역할: PG16의 부여는 INHERIT를 기억하니 여전히 상속하고, PG15 이하는 바뀐 속성을 따른다
CREATE ROLE mm_cmp_altered NOLOGIN;
GRANT app_read TO mm_cmp_altered;
ALTER ROLE mm_cmp_altered NOINHERIT;
-- 아래 넷의 부여는 서버 버전에 따라 따로 한다
CREATE ROLE mm_cmp_inherit_off NOLOGIN;
CREATE ROLE mm_cmp_inherit_on NOLOGIN NOINHERIT;
CREATE ROLE mm_cmp_no_set NOLOGIN;
CREATE ROLE mm_cmp_neither NOLOGIN;
"#;

/// PG16: 부여마다 INHERIT·SET 옵션을 고른다
const COMPARISON_GRANTS_16: &str = "GRANT app_read TO mm_cmp_inherit_off WITH INHERIT FALSE;
    GRANT app_read TO mm_cmp_inherit_on WITH INHERIT TRUE;
    GRANT app_read TO mm_cmp_no_set WITH INHERIT TRUE, SET FALSE;
    GRANT app_read TO mm_cmp_neither WITH INHERIT FALSE, SET FALSE;";

/// PG16 전: 옵션이 없고 구성원 역할의 속성이 정한다
const COMPARISON_GRANTS_OLD: &str = "GRANT app_read TO mm_cmp_inherit_off, mm_cmp_inherit_on, mm_cmp_no_set, mm_cmp_neither;";

/// 시험 데이터베이스에 더하는 객체. `{db}`는 데이터베이스 이름이다
const COMPARISON_OBJECTS: &str = r#"
SET ROLE app_owner;
-- PUBLIC이 받은 테이블
CREATE TABLE app.cmp_public (a integer);
GRANT SELECT, INSERT ON app.cmp_public TO PUBLIC;
-- 소유자도 app_read도 권한을 거뒀다. 데이터베이스 소유자(app_owner)만 pg_database_owner로 받는다
CREATE TABLE app.cmp_held (a integer);
REVOKE ALL ON app.cmp_held FROM app_owner, app_read;
GRANT SELECT ON app.cmp_held TO pg_database_owner;
-- 그룹 app_write가 받는 테이블
CREATE TABLE app.cmp_via_group (a integer);
GRANT SELECT, UPDATE ON app.cmp_via_group TO app_write;

-- 시퀀스와 함수
CREATE SEQUENCE app.cmp_seq;
GRANT SELECT ON SEQUENCE app.cmp_seq TO PUBLIC;
CREATE FUNCTION app.cmp_fn() RETURNS integer LANGUAGE sql AS 'SELECT 1';
REVOKE EXECUTE ON FUNCTION app.cmp_fn() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.cmp_fn() TO app_read;
CREATE FUNCTION app.cmp_fn_default() RETURNS integer LANGUAGE sql AS 'SELECT 1';
-- 외래 테이블에는 DELETE만, 파티션 테이블에는 UPDATE만: 쓰기는 INSERT·UPDATE·DELETE 가운데 하나면 된다
GRANT DELETE ON audit.remote_log TO app_read;
GRANT UPDATE ON audit.events TO app_write;
RESET ROLE;
-- 소유자가 그룹 역할(app_write)인 테이블
CREATE TABLE app.cmp_group_owned (a integer);
ALTER TABLE app.cmp_group_owned OWNER TO app_write;
-- superuser가 만든 테이블과 스키마(소유자가 postgres)
CREATE TABLE app.cmp_super_owned (a integer);
GRANT SELECT ON app.cmp_super_owned TO app_read;
CREATE SCHEMA cmp_super_schema;
GRANT USAGE ON SCHEMA cmp_super_schema TO app_read;
CREATE TABLE cmp_super_schema.t (a integer);
-- 스키마와 데이터베이스의 CREATE를 그룹에게
GRANT CREATE ON SCHEMA scratch TO app_write;
GRANT CREATE ON DATABASE {db} TO app_write;
"#;

/// 데이터베이스 소유자가 NOINHERIT인 장면의 역할. 데이터베이스를 소유하니 지우지 않고, 있으면 속성만 맞춘다
const NOINHERIT_OWNER_ROLE: &str = r#"
DO $seed$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mm_cmp_noinherit_owner') THEN CREATE ROLE mm_cmp_noinherit_owner NOLOGIN NOINHERIT; END IF;
END
$seed$;
ALTER ROLE mm_cmp_noinherit_owner NOINHERIT;
"#;

/// 그 데이터베이스 안: 소유자는 자기 권한을 거뒀고 pg_database_owner만 받는다
const NOINHERIT_OWNER_SEED: &str = r#"
CREATE SCHEMA owned;
CREATE TABLE owned.held (a integer);
ALTER TABLE owned.held OWNER TO mm_cmp_noinherit_owner;
REVOKE ALL ON owned.held FROM mm_cmp_noinherit_owner;
GRANT SELECT ON owned.held TO pg_database_owner;
GRANT USAGE, CREATE ON SCHEMA owned TO pg_database_owner;
"#;

fn unique_database_name(prefix: &str) -> String {
    let millis = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    format!("{prefix}_{millis}_{}", NEXT_DATABASE.fetch_add(1, Ordering::SeqCst))
}

/// 심은 장면에 비교용 역할과 객체를 더한다. `client`는 심은 데이터베이스에 superuser로 붙은 연결이다
async fn add_comparison_extras(client: &Client, server: Server, database: &str) {
    client.batch_execute(COMPARISON_ROLES_DROP).await.expect("지난 시험의 역할을 지우지 못했어요");
    client.batch_execute(COMPARISON_ROLES).await.expect("역할을 만들지 못했어요");
    let grants = if server.has_membership_options() { COMPARISON_GRANTS_16 } else { COMPARISON_GRANTS_OLD };
    client.batch_execute(grants).await.expect("부여하지 못했어요");
    client.batch_execute(&COMPARISON_OBJECTS.replace("{db}", database)).await.expect("객체를 만들지 못했어요");
}

/// 맞대는 객체를 가리키는 열쇠
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum Target {
    Database(String),
    Schema(String),
    Relation { schema: String, name: String },
    Function { schema: String, name: String, signature: String },
}

impl Target {
    fn label(&self) -> String {
        match self {
            Target::Database(name) => format!("데이터베이스 {name}"),
            Target::Schema(name) => format!("스키마 {name}"),
            Target::Relation { schema, name } => format!("관계 {schema}.{name}"),
            Target::Function { schema, name, signature } => format!("함수 {schema}.{name}({signature})"),
        }
    }
}

/// 서버의 `has_*_privilege`가 답한 것: (역할, 객체, 권한) → 있는가
type Answers = HashMap<(String, Target, Privilege), bool>;

/// 시스템 스키마(`pg_catalog`, `information_schema`, `pg_toast`, 임시 스키마)를 거르는 조건. `n`은 `pg_namespace`의 별칭이다
const USER_SCHEMAS: &str =
    r"n.nspname NOT IN ('pg_catalog','information_schema','pg_toast') AND n.nspname NOT LIKE 'pg\_temp\_%' AND n.nspname NOT LIKE 'pg\_toast\_temp\_%'";

fn privilege(name: &str) -> Privilege {
    Privilege::from_pg(name).unwrap_or_else(|| panic!("모르는 권한 이름이에요: {name}"))
}

/// 서버에 모든 역할 × 객체 × 권한을 묻는다. 스냅숏이 담는 객체만 묻는다(파티션 자식, 시스템 스키마, 템플릿과 rdsadmin은 뺀다)
async fn ask_postgres(client: &Client) -> Answers {
    let mut answers = Answers::new();
    let asks = [
        // 테이블, 뷰, 구체화 뷰, 파티션 테이블, 외부 테이블
        format!(
            "SELECT r.rolname, n.nspname, c.relname, p.priv, has_table_privilege(r.oid, c.oid, p.priv)
             FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv)
             WHERE c.relkind IN ('r','v','m','p','f') AND NOT c.relispartition AND {USER_SCHEMAS}"
        ),
        // 시퀀스
        format!(
            "SELECT r.rolname, n.nspname, c.relname, p.priv, has_sequence_privilege(r.oid, c.oid, p.priv)
             FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             CROSS JOIN (VALUES ('USAGE'), ('SELECT'), ('UPDATE')) p(priv)
             WHERE c.relkind = 'S' AND {USER_SCHEMAS}"
        ),
    ];
    for sql in &asks {
        for row in client.query(sql.as_str(), &[]).await.expect("관계의 권한을 묻지 못했어요") {
            let target = Target::Relation { schema: row.get(1), name: row.get(2) };
            answers.insert((row.get(0), target, privilege(row.get(3))), row.get(4));
        }
    }
    let schemas = format!(
        "SELECT r.rolname, n.nspname, p.priv, has_schema_privilege(r.oid, n.oid, p.priv)
         FROM pg_roles r CROSS JOIN pg_namespace n CROSS JOIN (VALUES ('USAGE'), ('CREATE')) p(priv)
         WHERE {USER_SCHEMAS}"
    );
    for row in client.query(schemas.as_str(), &[]).await.expect("스키마의 권한을 묻지 못했어요") {
        answers.insert((row.get(0), Target::Schema(row.get(1)), privilege(row.get(2))), row.get(3));
    }
    let databases = "SELECT r.rolname, d.datname, p.priv, has_database_privilege(r.oid, d.oid, p.priv)
         FROM pg_roles r CROSS JOIN pg_database d CROSS JOIN (VALUES ('CONNECT'), ('CREATE'), ('TEMPORARY')) p(priv)
         WHERE NOT d.datistemplate AND d.datname <> 'rdsadmin'";
    for row in client.query(databases, &[]).await.expect("데이터베이스의 권한을 묻지 못했어요") {
        answers.insert((row.get(0), Target::Database(row.get(1)), privilege(row.get(2))), row.get(3));
    }
    let functions = format!(
        "SELECT r.rolname, n.nspname, f.proname, pg_get_function_identity_arguments(f.oid), has_function_privilege(r.oid, f.oid, 'EXECUTE')
         FROM pg_roles r CROSS JOIN pg_proc f JOIN pg_namespace n ON n.oid = f.pronamespace
         WHERE f.prokind IN ('f','p') AND {USER_SCHEMAS}"
    );
    for row in client.query(functions.as_str(), &[]).await.expect("함수의 권한을 묻지 못했어요") {
        let target = Target::Function { schema: row.get(1), name: row.get(2), signature: row.get(3) };
        answers.insert((row.get(0), target, Privilege::Execute), row.get(4));
    }
    answers
}

/// 스냅숏의 객체를 열쇠로 찾게 한다
fn objects<'a>(ctx: &Ctx<'a>) -> HashMap<Target, Obj<'a>> {
    let mut objects = HashMap::new();
    for d in &ctx.cluster.databases {
        objects.insert(Target::Database(d.name.clone()), Obj::Database(d));
    }
    for s in &ctx.db.schemas {
        objects.insert(Target::Schema(s.name.clone()), Obj::Schema(s));
    }
    for r in &ctx.db.relations {
        objects.insert(Target::Relation { schema: r.schema.clone(), name: r.name.clone() }, Obj::Relation(r));
    }
    for f in &ctx.db.functions {
        objects.insert(Target::Function { schema: f.schema.clone(), name: f.name.clone(), signature: f.signature.clone() }, Obj::Function(f));
    }
    objects
}

/// 앱의 계산과 서버의 답을 맞댄 결과
struct Report {
    /// 서버에 물은 (역할, 객체, 권한)의 수와 그 가운데 서버가 "있다"고 답한 수
    asked: usize,
    allowed: usize,
    /// 다른 곳. 사람이 읽을 줄이다
    mismatches: Vec<String>,
}

impl Report {
    fn assert_clean(&self) {
        assert!(self.asked > 0, "서버에 아무것도 묻지 않았어요");
        if !self.mismatches.is_empty() {
            let shown = self.mismatches.iter().take(40).cloned().collect::<Vec<_>>().join("\n  ");
            panic!("앱의 계산이 PostgreSQL의 답과 다른 곳이 {}곳이에요(서버에 {}번 물었어요):\n  {shown}", self.mismatches.len(), self.asked);
        }
    }
}

/// 앱의 계산을 서버와 맞댄다:
/// - `sources`가 있다/없다: 모든 역할 × 객체 × 권한(`has_table_privilege` 등)
/// - `who_can`이 고른 역할들: 객체 × 권한마다 서버가 "있다"고 한 역할들과 같은가
/// - `schema_cells`의 사용·만들기·읽기·쓰기와 못 쓰는 이유: 서버의 답으로 다시 센 것과 같은가
/// - `inherited`와 `set_role_only`: 모든 역할 쌍의 `pg_has_role`(USAGE는 상속, PG16은 SET, 그 전은 MEMBER가 SET ROLE)
async fn compare_with_postgres(client: &Client, ctx: &Ctx<'_>, server: Server) -> Report {
    let answers = ask_postgres(client).await;
    let objects = objects(ctx);
    let mut mismatches = Vec::new();
    let verdict = |yes: bool| if yes { "있음" } else { "없음" };

    // 스냅숏과 서버가 같은 객체·역할을 본다
    let answered: HashSet<&Target> = answers.keys().map(|(_, target, _)| target).collect();
    for target in objects.keys().filter(|t| !answered.contains(t)) {
        mismatches.push(format!("스냅숏의 {}을(를) 서버에 묻지 못했어요", target.label()));
    }
    let answered_roles: BTreeSet<&str> = answers.keys().map(|(role, _, _)| role.as_str()).collect();
    let snapshot_roles: BTreeSet<&str> = ctx.cluster.roles.iter().map(|r| r.name.as_str()).collect();
    if answered_roles != snapshot_roles {
        mismatches.push(format!("역할이 달라요: 서버 {answered_roles:?}, 스냅숏 {snapshot_roles:?}"));
    }

    // 1. 있다/없다
    for ((role, target, p), &expected) in &answers {
        let Some(&obj) = objects.get(target) else {
            mismatches.push(format!("서버가 답한 {}이(가) 스냅숏에 없어요", target.label()));
            continue;
        };
        let sources = ctx.sources(role, obj, *p);
        if sources.is_empty() == expected {
            mismatches.push(format!(
                "{role} · {} · {}: PostgreSQL {}, 앱 {} {sources:?}",
                target.label(),
                p.as_str(),
                verdict(expected),
                verdict(!sources.is_empty())
            ));
        }
    }

    // 2. 누가 할 수 있나
    let mut holders: HashMap<(&Target, Privilege), BTreeSet<&str>> = HashMap::new();
    for ((role, target, p), &yes) in &answers {
        let roles = holders.entry((target, *p)).or_default();
        if yes {
            roles.insert(role.as_str());
        }
    }
    for ((target, p), expected) in &holders {
        let Some(&obj) = objects.get(*target) else { continue };
        let rows = who_can(ctx, obj, *p);
        let got: BTreeSet<&str> = rows.iter().map(|row| row.role.as_str()).collect();
        if &got != expected {
            mismatches.push(format!("누가 할 수 있나 · {} · {}: PostgreSQL {expected:?}, 앱 {got:?}", target.label(), p.as_str()));
        }
    }

    // 3. 스키마 칸
    let said = |role: &str, target: Target, p: Privilege| -> bool {
        *answers.get(&(role.to_string(), target, p)).unwrap_or_else(|| panic!("서버의 답이 없어요: {role} {p:?}"))
    };
    let coverage = |have: usize, total: usize| match (have, total) {
        (0, _) => Coverage::None,
        (have, total) if have == total => Coverage::All,
        _ => Coverage::Some,
    };
    let role_names: Vec<&str> = ctx.cluster.roles.iter().map(|r| r.name.as_str()).collect();
    for cell in schema_cells(ctx, &role_names) {
        let (role, schema) = (cell.role.as_str(), cell.schema.as_str());
        let usage = said(role, Target::Schema(schema.to_string()), Privilege::Usage);
        let create = said(role, Target::Schema(schema.to_string()), Privilege::Create);
        let (mut read_have, mut read_total, mut write_have, mut write_total) = (0, 0, 0, 0);
        for rel in ctx.db.relations.iter().filter(|r| r.schema == schema) {
            let on = |p: Privilege| said(role, Target::Relation { schema: rel.schema.clone(), name: rel.name.clone() }, p);
            if matches!(rel.kind, RelKind::Table | RelKind::View | RelKind::MatView | RelKind::Partitioned | RelKind::Foreign) {
                read_total += 1;
                read_have += usize::from(on(Privilege::Select));
            }
            if matches!(rel.kind, RelKind::Table | RelKind::Partitioned | RelKind::Foreign) {
                write_total += 1;
                write_have += usize::from([Privilege::Insert, Privilege::Update, Privilege::Delete].into_iter().any(on));
            }
        }
        let expected = (usage, create, coverage(read_have, read_total), coverage(write_have, write_total));
        let got = (cell.usage, cell.create, cell.read, cell.write);
        if got != expected {
            mismatches.push(format!("칸 {role}/{schema} (사용, 만들기, 읽기, 쓰기): PostgreSQL {expected:?}, 앱 {got:?}"));
        }
        // 잃을 것이 있는 칸에만, CONNECT가 먼저고 스키마 USAGE가 다음이다
        let shown = usage || create || expected.2 != Coverage::None || expected.3 != Coverage::None;
        let connect = said(role, Target::Database(ctx.db.database.clone()), Privilege::Connect);
        let unusable = if !shown {
            None
        } else if !connect {
            Some("CONNECT 없음")
        } else if !usage {
            Some("USAGE 없음")
        } else {
            None
        };
        if cell.unusable != unusable {
            mismatches.push(format!("칸 {role}/{schema}의 못 쓰는 이유: PostgreSQL {unusable:?}, 앱 {:?}", cell.unusable));
        }
    }

    // 4. 상속과 SET ROLE. superuser는 모든 역할의 구성원으로 답하니 구성원 쪽에서 뺀다
    let settable = if server.has_membership_options() { "SET" } else { "MEMBER" };
    let roles_sql = format!(
        "SELECT m.rolname, g.rolname, pg_has_role(m.oid, g.oid, 'USAGE'), pg_has_role(m.oid, g.oid, '{settable}')
         FROM pg_roles m CROSS JOIN pg_roles g WHERE NOT m.rolsuper AND m.oid <> g.oid"
    );
    let mut inherited: HashMap<String, HashSet<String>> = HashMap::new();
    let mut set_only: HashMap<String, HashSet<String>> = HashMap::new();
    let pairs = client.query(roles_sql.as_str(), &[]).await.expect("역할 관계를 묻지 못했어요");
    assert!(!pairs.is_empty(), "역할 쌍이 없어요");
    for row in &pairs {
        let (member, group): (String, String) = (row.get(0), row.get(1));
        let (uses, can_set): (bool, bool) = (row.get(2), row.get(3));
        let inherits = inherited.entry(member.clone()).or_insert_with(|| ctx.inherited(&member).into_iter().map(|i| i.role).collect());
        if inherits.contains(&group) != uses {
            mismatches.push(format!("{member} → {group}: pg_has_role USAGE(상속) {}, 앱 {}", verdict(uses), verdict(!uses)));
        }
        let sets = set_only.entry(member.clone()).or_insert_with(|| ctx.set_role_only(&member).into_iter().collect());
        if sets.contains(&group) != (can_set && !uses) {
            mismatches.push(format!(
                "{member} → {group}: SET ROLE로만 닿는가 — PostgreSQL {}({settable} {can_set}, USAGE {uses}), 앱 {}",
                verdict(can_set && !uses),
                verdict(sets.contains(&group))
            ));
        }
    }

    mismatches.sort();
    mismatches.dedup();
    Report { asked: answers.len() + pairs.len(), allowed: answers.values().filter(|&&yes| yes).count(), mismatches }
}

fn relation_of<'a>(db: &'a DbSnapshot, schema: &str, name: &str) -> Obj<'a> {
    Obj::Relation(db.relations.iter().find(|r| r.schema == schema && r.name == name).unwrap_or_else(|| panic!("{schema}.{name} 관계가 없어요")))
}

/// 심은 장면에 서버 규칙의 모서리를 건드리는 역할과 객체를 더하고, 앱의 계산을 서버의 `has_*_privilege`·`pg_has_role`과 맞댄다.
/// 모서리: superuser 속성은 상속되지 않는다, pg_write_all_data는 모든 종류의 관계에 쓰기를 준다, 소유자 역할·NOINHERIT 중간 역할·부여한 뒤에
/// 바뀐 INHERIT 속성(PG16은 부여가 기억한다), 부여마다의 INHERIT·SET 옵션, 소유자가 거둔 자기 권한,
/// pg_database_owner(PG15+의 `public` 스키마, 명시한 부여), 소유자가 그룹 역할인 테이블, PUBLIC의 부여
async fn effective_privileges_match_postgres(server: Server) {
    let scene = seed(server).await;
    let mut conn = scene.connect().await;
    add_comparison_extras(&conn.client, server, &scene.database).await;
    let cluster = cluster_snapshot(&mut conn, "iam_admin").await.expect("클러스터 스냅숏을 읽지 못했어요");
    let db = db_snapshot(&mut conn, &scene.database).await.expect("데이터베이스 스냅숏을 읽지 못했어요");
    let ctx = Ctx { cluster: &cluster, db: &db };

    let report = compare_with_postgres(&conn.client, &ctx, server).await;
    eprintln!("PG{}: 서버에 {}번 물었고 {}번이 있다였어요(역할 {}개)", server.major(), report.asked, report.allowed, cluster.roles.len());
    report.assert_clean();
    // 비교가 비어 있지 않았다: 서버가 "있다"와 "없다"를 모두 많이 답했다
    assert!(report.allowed > 300 && report.asked > report.allowed + 1000, "물은 {}번 가운데 {}번이 있다예요", report.asked, report.allowed);

    // 이 시험이 만든 경우가 정말 생겼는지: 위에서 서버와 같다고 확인했으니, 앱의 답이 이렇다는 것은 서버도 그렇다는 뜻이다
    let kinds = |role: &str, obj: Obj, p: Privilege| -> Vec<SourceKind> { ctx.sources(role, obj, p).iter().map(|s| s.kind).collect() };
    let orders = relation_of(&db, "app", "orders");
    assert_eq!(kinds("alice", orders, Privilege::Select), [SourceKind::Group]);
    assert_eq!(kinds("carol", orders, Privilege::Select), [SourceKind::Predefined]);
    assert!(kinds("bob", orders, Privilege::Select).is_empty(), "bob은 NOINHERIT예요");
    assert_eq!(kinds("mm_cmp_super", orders, Privilege::Select), [SourceKind::Superuser]);
    assert!(kinds("mm_cmp_in_super", orders, Privilege::Select).is_empty(), "superuser 속성은 상속되지 않아요");
    assert_eq!(kinds("mm_cmp_ops", orders, Privilege::Select), [SourceKind::Owner]);
    assert!(kinds("mm_cmp_ops_noinherit", orders, Privilege::Select).is_empty());
    assert!(kinds("mm_cmp_top", orders, Privilege::Select).is_empty(), "가운데 역할이 상속하지 않으면 그 뒤는 닿지 않아요");
    // pg_write_all_data는 시퀀스의 UPDATE와 구체화 뷰의 INSERT도 준다
    assert_eq!(kinds("mm_cmp_writer", relation_of(&db, "app", "ticket_seq"), Privilege::Update), [SourceKind::Predefined]);
    assert_eq!(kinds("mm_cmp_writer", relation_of(&db, "app", "order_summary"), Privilege::Insert), [SourceKind::Predefined]);
    // 상속이 여러 단계 이어진다: mm_cmp_deep → a → b → app_read
    assert_eq!(ctx.sources("mm_cmp_deep", orders, Privilege::Select)[0].via, ["mm_cmp_deep_a", "mm_cmp_deep_b", "app_read"]);
    // audit의 외래 테이블에는 app_read가 DELETE만, 파티션 테이블에는 app_write가 UPDATE만 받았다. 쓰기는 셋 가운데 하나면 되고,
    // app_read는 외래 테이블만 쓰니 일부, app_write는 app_read를 상속해서 둘 다 쓰니 모두다
    let write = |role: &str| schema_cells(&ctx, &[role]).into_iter().find(|c| c.schema == "audit").map(|c| c.write);
    assert_eq!((write("app_read"), write("app_write")), (Some(Coverage::Some), Some(Coverage::All)));
    // 소유자가 그룹 역할인 테이블: 그 그룹을 상속하는 alice는 소유자 출처로 받는다
    let group_owned = relation_of(&db, "app", "cmp_group_owned");
    assert_eq!(ctx.sources("alice", group_owned, Privilege::Select)[0].via, ["app_write"]);
    assert_eq!(kinds("alice", group_owned, Privilege::Select), [SourceKind::Owner]);
    // 부여마다의 옵션은 PG16부터, 그 전에는 구성원 역할의 속성이 정한다
    let (altered, inherit_off, inherit_on) =
        (kinds("mm_cmp_altered", orders, Privilege::Select), kinds("mm_cmp_inherit_off", orders, Privilege::Select), kinds("mm_cmp_inherit_on", orders, Privilege::Select));
    if server.has_membership_options() {
        assert_eq!((altered, inherit_off, inherit_on), (vec![SourceKind::Group], vec![], vec![SourceKind::Group]));
    } else {
        assert_eq!((altered, inherit_off, inherit_on), (vec![], vec![SourceKind::Group], vec![]));
    }
    // 데이터베이스 소유자는 pg_database_owner로 받는다. 소유자 역할을 상속하는 역할도 받고, 상속하지 않는 역할은 못 받는다
    let held = relation_of(&db, "app", "cmp_held");
    assert_eq!(kinds("app_owner", held, Privilege::Select), [SourceKind::Group]);
    assert_eq!(ctx.sources("mm_cmp_ops", held, Privilege::Select)[0].via, ["app_owner", "pg_database_owner"]);
    assert!(kinds("mm_cmp_ops_noinherit", held, Privilege::Select).is_empty());
    // PG15부터 public 스키마의 소유자는 pg_database_owner고 CREATE는 데이터베이스 소유자만 한다. PG14는 PUBLIC이 CREATE한다
    let public_schema = db.schemas.iter().find(|s| s.name == "public").expect("public 스키마가 없어요");
    let public = Obj::Schema(public_schema);
    if public_schema.owner == "pg_database_owner" {
        assert_eq!(kinds("app_owner", public, Privilege::Create), [SourceKind::Owner]);
        assert_eq!(ctx.sources("app_owner", public, Privilege::Create)[0].via, ["pg_database_owner"]);
        assert!(kinds("alice", public, Privilege::Create).is_empty());
    } else {
        assert_eq!(public_schema.owner, "postgres");
        assert_eq!(kinds("app_owner", public, Privilege::Create), [SourceKind::Public]);
        assert_eq!(kinds("alice", public, Privilege::Create), [SourceKind::Public]);
    }

    conn.client.batch_execute(COMPARISON_ROLES_DROP).await.expect("시험 역할을 지우지 못했어요");
}

/// 데이터베이스 소유자가 NOINHERIT일 때: PG16은 소유자가 pg_database_owner를 늘 상속하고, PG15 이하는 다른 구성원 관계처럼
/// 소유자의 INHERIT 속성을 따라 상속하지 않는다. 서버와 같게 계산해야 한다
async fn a_noinherit_database_owner_matches_postgres(server: Server) {
    let mut config: Config = server.url().parse().expect("접속 URL이 올바르지 않아요");
    config.application_name("mm-live");
    let admin = connect_to(&config).await;
    admin.batch_execute(ROLES_SEED).await.expect("역할을 심지 못했어요");
    admin.batch_execute(NOINHERIT_OWNER_ROLE).await.expect("역할을 심지 못했어요");
    let database = unique_database_name("mm_live_noinherit");
    admin.batch_execute(&format!("CREATE DATABASE {database} OWNER mm_cmp_noinherit_owner")).await.expect("데이터베이스를 만들지 못했어요");
    config.dbname(&database);
    connect_to(&config).await.batch_execute(NOINHERIT_OWNER_SEED).await.expect("장면을 심지 못했어요");
    let scene = Scene { database, config };
    let mut conn = scene.connect().await;
    let cluster = cluster_snapshot(&mut conn, "iam_admin").await.expect("클러스터 스냅숏을 읽지 못했어요");
    let db = db_snapshot(&mut conn, &scene.database).await.expect("데이터베이스 스냅숏을 읽지 못했어요");
    assert_eq!(db.owner, "mm_cmp_noinherit_owner");
    let ctx = Ctx { cluster: &cluster, db: &db };

    compare_with_postgres(&conn.client, &ctx, server).await.assert_clean();

    // 서버의 답이 버전마다 다르다는 것을 눈으로도 확인한다
    let held = relation_of(&db, "owned", "held");
    let owner = ctx.sources("mm_cmp_noinherit_owner", held, Privilege::Select);
    if server.has_membership_options() {
        assert_eq!(owner.iter().map(|s| (s.kind, s.via.clone())).collect::<Vec<_>>(), [(SourceKind::Group, vec!["pg_database_owner".to_string()])]);
    } else {
        assert!(owner.is_empty(), "{owner:?}");
        assert_eq!(ctx.set_role_only("mm_cmp_noinherit_owner"), ["pg_database_owner"]);
    }
}
