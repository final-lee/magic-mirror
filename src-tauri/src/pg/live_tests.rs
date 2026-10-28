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

use std::collections::HashSet;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio_postgres::{Client, Config, NoTls};

use super::catalog::{self, cluster_snapshot, db_snapshot, db_snapshot_capped, read, sessions};
use super::connect::Connected;
use super::model::{AclEntry, ClusterSnapshot, DbSnapshot, DefaultAclRec, DefaultObjType, FunctionRec, MemberGrant, MemberRec, Privilege, RelKind, RelationRec, SchemaRec};
use crate::error::AppError;
use crate::iam::clock;

#[cfg(test)]
mod comparison;
use comparison::{a_noinherit_database_owner_matches_postgres, effective_privileges_match_postgres};
#[cfg(test)]
mod views;
use views::{a_statement_timeout_reads_as_the_read_timeout_text, the_builders_read_the_seeded_database, the_sessions_command_marks_the_connection_the_app_holds};
#[cfg(test)]
mod statements;
use statements::{
    membership_statements_grant_and_revoke, ownership_and_session_statements, privilege_statements_change_the_acls, role_statements_create_alter_and_reset_roles,
};

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
    Connected { client, backend_pid, broken: false }
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
    a_membership_keeps_one_grant_per_grantor,
    the_oids_the_bootstrap_superuser_and_the_server_settings_are_read,
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
    the_builders_read_the_seeded_database,
    a_statement_timeout_reads_as_the_read_timeout_text,
    the_sessions_command_marks_the_connection_the_app_holds,
    role_statements_create_alter_and_reset_roles,
    membership_statements_grant_and_revoke,
    privilege_statements_change_the_acls,
    ownership_and_session_statements,
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

/// 구성원 관계는 부여자마다 부여를 하나씩 들고 있다. 심어 둔 `alice → app_write`는 `postgres`가 준 부여 하나다(PG15 이하에도 부여자는 있다).
/// PG16에서는 다른 역할이 같은 쌍에 부여를 더하면 그 부여가 따로 늘어선다: 부여자 이름순이고 각자의 옵션을 그대로 가진다.
/// 합친 값(`admin`·`inherit`·`set`)은 부여가 하나일 때와 같이 하나라도 허용하면 허용이다
async fn a_membership_keeps_one_grant_per_grantor(server: Server) {
    let scene = seed(server).await;
    let mut conn = scene.connect().await;
    let pair = |snap: &ClusterSnapshot, member: &str, group: &str| -> MemberRec {
        let found: Vec<&MemberRec> = snap.members.iter().filter(|m| m.member == member && m.group == group).collect();
        assert_eq!(found.len(), 1, "{member} → {group}는 쌍마다 하나여야 해요: {found:?}");
        found[0].clone()
    };
    let grant = |grantor: &str, admin: bool, inherit: Option<bool>, set: Option<bool>| MemberGrant { grantor: grantor.into(), admin, inherit, set };
    let option = |value: bool| server.has_membership_options().then_some(value);

    // 심어 둔 구성원 관계는 모두 `postgres`가 준 부여 하나다. bob의 INHERIT은 부여할 때 구성원의 속성을 따라 false다
    let snap = cluster_snapshot(&mut conn, "iam_admin").await.expect("클러스터 스냅숏을 읽지 못했어요");
    assert_eq!(pair(&snap, "alice", "app_write").grants, vec![grant("postgres", false, option(true), option(true))]);
    assert_eq!(pair(&snap, "app_write", "app_read").grants, vec![grant("postgres", false, option(true), option(true))]);
    assert_eq!(pair(&snap, "bob", "app_read").grants, vec![grant("postgres", false, option(false), option(true))]);
    assert_eq!(pair(&snap, "carol", "pg_read_all_data").grants, vec![grant("postgres", false, option(true), option(true))]);

    // 다른 부여자의 부여를 더하는 것은 PG16부터 된다(그 전에는 쌍마다 부여가 하나뿐이다)
    if !server.has_membership_options() {
        return;
    }
    let cleanup = "DO $cleanup$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mm_admin') THEN
            REVOKE app_write FROM alice GRANTED BY mm_admin;
            DROP ROLE mm_admin;
          END IF;
        END
        $cleanup$";
    conn.client.batch_execute(cleanup).await.expect("지난 시험의 역할을 지우지 못했어요");
    conn.client
        .batch_execute(
            "CREATE ROLE mm_admin NOLOGIN;
             GRANT app_write TO mm_admin WITH ADMIN OPTION;
             GRANT app_write TO alice WITH INHERIT FALSE, SET FALSE GRANTED BY mm_admin;",
        )
        .await
        .expect("부여하지 못했어요");

    let snap = cluster_snapshot(&mut conn, "iam_admin").await.expect("클러스터 스냅숏을 읽지 못했어요");
    let alice = pair(&snap, "alice", "app_write");
    // 쌍은 하나이고, 부여는 둘이 부여자 이름순으로 늘어서며 각자의 옵션을 그대로 가진다
    assert_eq!(alice.grants, vec![grant("mm_admin", false, Some(false), Some(false)), grant("postgres", false, Some(true), Some(true))]);
    // 합친 값은 부여가 하나일 때와 같다: 하나라도 허용하면 허용
    assert_eq!((alice.admin, alice.inherit, alice.set), (false, Some(true), Some(true)));
    // mm_admin 자신의 구성원 관계는 ADMIN OPTION이 있는 부여 하나다(superuser가 한 부여는 부트스트랩 superuser인 postgres가 준 것으로 남는다)
    assert_eq!(pair(&snap, "mm_admin", "app_write").grants, vec![grant("postgres", true, Some(true), Some(true))]);

    conn.client.batch_execute(cleanup).await.expect("시험 역할을 지우지 못했어요");
    let snap = cluster_snapshot(&mut conn, "iam_admin").await.expect("클러스터 스냅숏을 읽지 못했어요");
    assert_eq!(pair(&snap, "alice", "app_write").grants, vec![grant("postgres", false, Some(true), Some(true))], "시험이 더한 부여를 거뒀어야 해요");
    assert!(snap.roles.iter().all(|r| r.name != "mm_admin"));
}

/// 역할의 OID, 부트스트랩 superuser(OID가 10인 역할), 서버에 없을 수 있는 설정 둘(`createrole_self_grant`는 PG16부터,
/// `rds.restrict_password_commands`는 RDS에만 있다)
async fn the_oids_the_bootstrap_superuser_and_the_server_settings_are_read(server: Server) {
    let scene = seed(server).await;
    let mut conn = scene.connect().await;
    conn.client.batch_execute("DROP ROLE IF EXISTS mm_settings").await.expect("지난 시험의 역할을 지우지 못했어요");

    let snap = cluster_snapshot(&mut conn, "iam_admin").await.expect("클러스터 스냅숏을 읽지 못했어요");
    // 도커 서버의 부트스트랩 superuser는 postgres다(RDS에서는 rdsadmin이다)
    assert_eq!(snap.bootstrap_superuser, "postgres");
    let oid = |name: &str| snap.roles.iter().find(|r| r.name == name).unwrap_or_else(|| panic!("역할 {name}가 없어요")).oid;
    assert_eq!(oid(&snap.bootstrap_superuser), 10, "부트스트랩 superuser의 OID는 10이에요");
    // 역할마다 OID가 다르다. 사용자가 만든 역할은 16384부터고, 서버가 직접 만든 미리 정의된 역할은 그보다 작다
    let all: HashSet<u32> = snap.roles.iter().map(|r| r.oid).collect();
    assert_eq!(all.len(), snap.roles.len(), "OID가 겹치는 역할이 있어요");
    for name in ["app_owner", "app_read", "app_write", "alice", "bob", "carol"] {
        assert!(oid(name) >= 16_384, "{name}: {}", oid(name));
    }
    assert!(oid("pg_read_all_data") < 16_384);
    // 설정을 하지 않았으니 PG16은 빈 문자열이고, PG14는 설정 자체가 없어 빈 문자열이다. RDS 설정이 없는 서버는 꺼진 것으로 읽는다
    assert_eq!(snap.createrole_self_grant, "");
    assert!(!snap.restrict_password_commands);

    // 설정은 읽는 연결의 것이다. 로그인할 때 설정이 켜지는 역할로 읽으면 값이 보인다
    conn.client
        .batch_execute("CREATE ROLE mm_settings LOGIN PASSWORD 'settings'; ALTER ROLE mm_settings SET rds.restrict_password_commands = 'on';")
        .await
        .expect("역할을 만들지 못했어요");
    if server.has_membership_options() {
        conn.client.batch_execute("ALTER ROLE mm_settings SET createrole_self_grant = 'inherit, set'").await.expect("설정하지 못했어요");
    }
    // 시험 데이터베이스는 PUBLIC의 CONNECT를 거뒀으니 `postgres`에 붙는다
    let mut config = scene.config_as("mm_settings", "settings", "mm-live-settings");
    config.dbname("postgres");
    let mut as_role = connected(&config).await;
    let snap = cluster_snapshot(&mut as_role, "mm_settings").await.expect("mm_settings의 클러스터 스냅숏");
    assert!(snap.restrict_password_commands, "켜 둔 설정을 읽어야 해요");
    assert_eq!(snap.createrole_self_grant, if server.has_membership_options() { "inherit, set" } else { "" });
    assert_eq!(snap.bootstrap_superuser, "postgres", "부트스트랩 superuser는 읽는 쪽과 상관없어요");

    drop(as_role);
    conn.client.batch_execute("DROP ROLE mm_settings").await.expect("시험 역할을 지우지 못했어요");
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
