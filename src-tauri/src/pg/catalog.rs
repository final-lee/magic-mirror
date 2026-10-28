//! 카탈로그 읽기. 앱이 PostgreSQL에 보내는 질의는 모두 이 파일에 있고, 하나도 빠짐없이 읽기 전용 트랜잭션 안에서 돈다.
//! 다른 파일에는 질의도 트랜잭션도 두지 않는다(이 규칙을 지키는 검사 테스트는 명령을 붙일 때 들어간다).
//!
//! - `read`: 읽기 전용 트랜잭션 하나를 열고 `statement_timeout`을 30초로 건 뒤 주어진 작업을 돌리고 커밋한다.
//! - `cluster_snapshot`, `db_snapshot`, `sessions`: 질의 결과를 `model`의 레코드로 바꾼다. 호출 하나가 트랜잭션 하나다.
//! - 접근 권한은 `aclexplode`가 풀어 준 줄을 `group_acl`이 객체별로 묶는다. ACL이 빈 객체는 권한 칸이 NULL인 줄 하나로 온다.
//!
//! 이 앱이 모르는 값은 그것만 건너뛴다(새 서버가 더한 권한, 관계·기본 권한 종류). 아는 값의 해석에는 영향이 없다.

use std::error::Error as StdError;

use tokio_postgres::{Client, Error, IsolationLevel, Row, Transaction};

use super::connect::Connected;
use super::model::{
    AclEntry, ClusterSnapshot, DatabaseRec, DbSnapshot, DefaultAclRec, DefaultObjType, FunctionRec, MemberRec, Privilege, RelKind, RelationRec,
    RoleRec, RoleSettingRec, SchemaRec, SessionRec, MEMBERSHIP_OPTIONS_SINCE,
};
use crate::error::AppError;
use crate::iam::clock;

/// 읽기 하나가 쓸 수 있는 시간. 읽기 전용 트랜잭션 안에서 가장 먼저 건다. 넘기면 서버가 그 문장을 취소한다
const STATEMENT_TIMEOUT: &str = "SET LOCAL statement_timeout = '30s'";

/// 데이터베이스 하나에서 읽는 객체(관계와 함수를 합쳐)의 상한. 관계가 먼저 자리를 잡고 함수는 남는 만큼만 든다
const MAX_OBJECTS: usize = 20_000;

/// 시스템 스키마(`pg_catalog`, `information_schema`, `pg_toast`, 임시 스키마)를 거르는 조건. `n`은 `pg_namespace`의 별칭이다.
/// `LIKE`에서 `_`는 한 글자를 뜻하므로 `\_`로 막는다
macro_rules! user_schemas {
    () => {
        r"n.nspname NOT IN ('pg_catalog','information_schema','pg_toast') AND n.nspname NOT LIKE 'pg\_temp\_%' AND n.nspname NOT LIKE 'pg\_toast\_temp\_%'"
    };
}

/// 로그인 직후 이 연결의 서버 쪽 프로세스 번호
const BACKEND_PID_SQL: &str = "SELECT pg_backend_pid()";

const SERVER_SQL: &str =
    "SELECT current_setting('server_version_num')::int, current_setting('server_version'), current_setting('password_encryption')";

const ROLES_SQL: &str = r#"SELECT r.rolname, r.rolcanlogin, r.rolinherit, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls, r.rolsuper, r.rolconnlimit,
       CASE WHEN r.rolvaliduntil IS NULL OR r.rolvaliduntil = 'infinity' THEN NULL
            WHEN r.rolvaliduntil = '-infinity' THEN '1970-01-01T00:00:00Z'
            ELSE to_char(r.rolvaliduntil AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
       shobj_description(r.oid, 'pg_authid')
FROM pg_roles r ORDER BY r.rolname"#;

/// 구성원 관계, PG16 이상(`server_version_num >= 160000`): 부여마다 INHERIT·SET 옵션이 있다
const MEMBERS_SQL_16: &str = r#"SELECT m.rolname, g.rolname, am.admin_option, am.inherit_option, am.set_option
FROM pg_auth_members am JOIN pg_roles m ON m.oid = am.member JOIN pg_roles g ON g.oid = am.roleid ORDER BY 1, 2"#;

/// 구성원 관계, PG16 미만: INHERIT·SET 옵션이 없다(INHERIT은 구성원 역할의 속성이 정하고, 구성원이면 언제나 `SET ROLE`을 할 수 있다)
const MEMBERS_SQL_OLD: &str = r#"SELECT m.rolname, g.rolname, am.admin_option, NULL::bool, NULL::bool
FROM pg_auth_members am JOIN pg_roles m ON m.oid = am.member JOIN pg_roles g ON g.oid = am.roleid ORDER BY 1, 2"#;

const DATABASES_SQL: &str = r#"SELECT d.datname, pg_get_userbyid(d.datdba), d.datallowconn,
       pg_get_userbyid(a.grantor), CASE WHEN a.grantee = 0 THEN NULL ELSE pg_get_userbyid(a.grantee) END, a.privilege_type, a.is_grantable
FROM pg_database d LEFT JOIN LATERAL aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a ON true
WHERE NOT d.datistemplate AND d.datname <> 'rdsadmin' ORDER BY d.datname"#;

const SETTINGS_SQL: &str = r#"SELECT CASE WHEN s.setrole = 0 THEN NULL ELSE pg_get_userbyid(s.setrole) END, d.datname, c.setting
FROM pg_db_role_setting s LEFT JOIN pg_database d ON d.oid = s.setdatabase, LATERAL unnest(s.setconfig) AS c(setting)"#;

/// 클라이언트 세션들. 로그인 사용자가 superuser도 `pg_read_all_stats` 멤버도 아니면 서버는 다른 역할의 세션에서
/// `backend_type`, `state`, `client_addr`, `backend_start`, `query_start`, `wait_event`를 비우고 `pid`, `usename`, `datname`, `application_name`만 준다.
/// 그래서 둘째 조건이 있다: 역할과 데이터베이스가 있는 줄은 `backend_type`이 비어도 세션으로 읽는다. 자세한 칸이 없는 줄이 뒤(`backend_start`가 NULL)에 온다.
/// 그런 로그인 사용자에게는 다른 역할의 병렬 작업자와 데이터베이스에 붙은 백그라운드 작업자(논리 복제 등)도 세션처럼 섞여 들어온다.
/// 서버가 둘을 가를 칸을 주지 않는다. 그 역할이 그 데이터베이스에서 일하고 있다는 뜻이라 없는 연결을 지어내는 것은 아니다.
/// superuser나 `pg_read_all_stats` 멤버에게는 모든 줄이 `backend_type`과 함께 오므로 둘째 조건에 걸리는 줄이 없다.
const SESSIONS_SQL: &str = r#"SELECT pid, usename, datname, host(client_addr), coalesce(application_name, ''), state,
       to_char(backend_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), to_char(query_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), wait_event
FROM pg_stat_activity
WHERE backend_type = 'client backend' OR (backend_type IS NULL AND usename IS NOT NULL AND datname IS NOT NULL)
ORDER BY backend_start"#;

/// 연결한 데이터베이스의 이름(서버가 말하는 것)과 소유자
const DB_IDENTITY_SQL: &str = "SELECT current_database(), pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()";

const SCHEMAS_SQL: &str = concat!(
    r#"SELECT n.nspname, pg_get_userbyid(n.nspowner),
       pg_get_userbyid(a.grantor), CASE WHEN a.grantee = 0 THEN NULL ELSE pg_get_userbyid(a.grantee) END, a.privilege_type, a.is_grantable
FROM pg_namespace n LEFT JOIN LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a ON true
WHERE "#,
    user_schemas!(),
    " ORDER BY n.nspname"
);

/// 관계: `$1`개까지만 읽는다. 상한보다 하나 더 읽어서 잘렸는지 알아본다(관계를 먼저 읽는다)
const RELATIONS_SQL: &str = concat!(
    r#"WITH o AS (
  SELECT c.oid, n.nspname, c.relname, c.relkind, c.relowner, c.relrowsecurity, c.relacl
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r','v','m','p','f','S') AND NOT c.relispartition AND "#,
    user_schemas!(),
    r#"
  ORDER BY n.nspname, c.relname LIMIT $1)
SELECT o.nspname, o.relname, o.relkind::text, pg_get_userbyid(o.relowner), o.relrowsecurity,
       pg_get_userbyid(a.grantor), CASE WHEN a.grantee = 0 THEN NULL ELSE pg_get_userbyid(a.grantee) END, a.privilege_type, a.is_grantable
FROM o LEFT JOIN LATERAL aclexplode(coalesce(o.relacl, acldefault(CASE WHEN o.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, o.relowner))) a ON true
ORDER BY o.nspname, o.relname"#
);

/// 함수와 프로시저: `$1`개까지만 읽는다(관계가 남긴 자리만큼)
const FUNCTIONS_SQL: &str = concat!(
    r#"WITH o AS (
  SELECT p.oid, n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args, p.proowner, p.prosecdef, p.proconfig, p.proacl
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.prokind IN ('f','p') AND "#,
    user_schemas!(),
    r#"
  ORDER BY n.nspname, p.proname, args LIMIT $1)
SELECT o.nspname, o.proname, o.args, pg_get_userbyid(o.proowner), o.prosecdef,
       coalesce(EXISTS (SELECT 1 FROM unnest(o.proconfig) c WHERE c LIKE 'search\_path=%'), false),
       pg_get_userbyid(a.grantor), CASE WHEN a.grantee = 0 THEN NULL ELSE pg_get_userbyid(a.grantee) END, a.privilege_type, a.is_grantable
FROM o LEFT JOIN LATERAL aclexplode(coalesce(o.proacl, acldefault('f', o.proowner))) a ON true
ORDER BY o.nspname, o.proname, o.args"#
);

const DEFAULT_ACLS_SQL: &str = r#"SELECT pg_get_userbyid(d.defaclrole), n.nspname, d.defaclobjtype::text,
       pg_get_userbyid(a.grantor), CASE WHEN a.grantee = 0 THEN NULL ELSE pg_get_userbyid(a.grantee) END, a.privilege_type, a.is_grantable
FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
LEFT JOIN LATERAL aclexplode(d.defaclacl) a ON true ORDER BY 1, 2, 3"#;

// ───────────────────────── 읽기 전용 트랜잭션 ─────────────────────────

/// 읽기 전용 트랜잭션 하나에서 `job`을 돌리고 커밋한다. 이 앱에서 트랜잭션을 여는 곳은 여기 하나뿐이다.
/// REPEATABLE READ라서 `job`의 모든 문장이 한 시점(첫 문장이 정한다)을 본다. 읽는 도중 역할이 바뀌어도 역할 목록과 구성원 관계가 서로 다른 상태에서 오지 않는다.
/// `job`이 실패하면 트랜잭션은 커밋되지 않고 버려진다(드라이버가 롤백을 보낸다). 연결은 이어서 쓸 수 있다.
async fn transact<T, F>(client: &mut Client, job: F) -> Result<T, Error>
where
    F: AsyncFnOnce(&Transaction<'_>) -> Result<T, Error>,
{
    let tx = client.build_transaction().read_only(true).isolation_level(IsolationLevel::RepeatableRead).start().await?;
    tx.batch_execute(STATEMENT_TIMEOUT).await?;
    let out = job(&tx).await?;
    tx.commit().await?;
    Ok(out)
}

/// 읽기 전용 REPEATABLE READ 트랜잭션 하나에서 `job`을 돌린다: 시작하고, 문장 시간 제한(30초)을 걸고, `job`을 돌리고, 커밋한다.
/// READ ONLY는 데이터 변경(INSERT·UPDATE·DELETE), DDL, GRANT, `nextval`을 거절한다(SQLSTATE `25006`).
/// 하지만 세션 `SET`·`SET ROLE`(연결을 보관하면 트랜잭션이 끝나도 남는다)이나 부작용이 있는 함수(`pg_terminate_backend`, 권고 잠금 등)는 막지 못한다.
/// 그래서 "아무것도 쓰지 않는다"는 보장은 서버가 아니라 이 파일의 고정된 SELECT들과, 다른 파일이 질의를 보내지 못하게 하는 검사 테스트(PB4)에 기댄다.
/// 오류는 사용자에게 보일 오류로 바꾼다: 서버가 보낸 오류는 서버 문구 그대로, 서버에 닿지 못한 오류는 네트워크 오류.
pub async fn read<T, F>(conn: &mut Connected, job: F) -> Result<T, AppError>
where
    F: AsyncFnOnce(&Transaction<'_>) -> Result<T, Error>,
{
    transact(&mut conn.client, job).await.map_err(|e| app_error(&e))
}

/// 로그인 직후 이 연결의 서버 쪽 프로세스 번호. `Connected`를 만들기 전에 부르므로 클라이언트를 직접 받는다.
/// 오류는 드라이버의 것 그대로 돌려준다: 접속 단계가 접속 실패의 종류로 가른다.
pub(super) async fn backend_pid(client: &mut Client) -> Result<i32, Error> {
    transact(client, async |tx| tx.query_one(BACKEND_PID_SQL, &[]).await?.try_get::<_, i32>(0)).await
}

/// 질의 오류를 사용자에게 보일 오류로 바꾼다. 서버가 보낸 오류는 서버 문구 그대로(SQLSTATE는 넣지 않는다).
/// 서버에 닿지 못한 오류(닫힌 연결, 입출력 오류)는 네트워크 오류. 그 밖에는 드라이버의 문구.
fn app_error(e: &Error) -> AppError {
    if let Some(db) = e.as_db_error() {
        return AppError::other(db.message());
    }
    let mut unreachable = e.is_closed();
    let mut cause: Option<&(dyn StdError + 'static)> = Some(e);
    while let Some(err) = cause {
        unreachable |= err.is::<std::io::Error>();
        cause = err.source();
    }
    if unreachable {
        AppError::Network { message: e.to_string() }
    } else {
        AppError::other(e.to_string())
    }
}

// ───────────────────────── ACL 묶기 ─────────────────────────

/// `aclexplode`를 `LEFT JOIN LATERAL`로 붙인 질의의 한 줄. `key`는 객체를 가리키는 값이다.
/// 나머지 넷은 ACL 항목이고, ACL이 빈 객체는 `privilege`가 None인 줄 하나로 온다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AclRow<K> {
    pub key: K,
    pub grantor: Option<String>,
    /// None이면 PUBLIC
    pub grantee: Option<String>,
    pub privilege: Option<String>,
    pub grantable: Option<bool>,
}

/// 줄들을 객체별로 묶는다. 객체는 처음 나온 순서를 지키고, 같은 객체의 줄은 서로 이웃해 있어야 한다(질의가 객체 열쇠로 정렬한다).
/// ACL이 빈 객체(`privilege`가 None)는 빈 ACL로 남는다. 이 앱이 모르는 권한 이름은 그 항목만 뺀다.
pub fn group_acl<K: PartialEq>(rows: Vec<AclRow<K>>) -> Vec<(K, Vec<AclEntry>)> {
    let mut grouped: Vec<(K, Vec<AclEntry>)> = Vec::new();
    for AclRow { key, grantor, grantee, privilege, grantable } in rows {
        // 항목이 되려면 네 칸이 다 있어야 한다. 비었으면 ACL이 빈 객체의 줄이고, 모르는 권한이면 그 항목만 빠진다
        let entry = match (grantor, privilege.as_deref().and_then(Privilege::from_pg), grantable) {
            (Some(grantor), Some(privilege), Some(grantable)) => Some(AclEntry { grantor, grantee, privilege, grantable }),
            _ => None,
        };
        match grouped.last_mut() {
            Some((last, acl)) if *last == key => acl.extend(entry),
            _ => grouped.push((key, entry.into_iter().collect())),
        }
    }
    grouped
}

/// 한 줄 끝의 ACL 네 칸(grantor, grantee, privilege_type, is_grantable)을 읽는다. `first`는 그 첫 칸의 위치다.
fn acl_row<K>(row: &Row, key: K, first: usize) -> Result<AclRow<K>, Error> {
    Ok(AclRow {
        key,
        grantor: row.try_get(first)?,
        grantee: row.try_get(first + 1)?,
        privilege: row.try_get(first + 2)?,
        grantable: row.try_get(first + 3)?,
    })
}

/// PG16부터 `pg_auth_members`는 부여자마다 한 줄이라 같은 (구성원, 그룹) 쌍이 여러 줄일 수 있다.
/// 질의가 쌍 순서로 정렬해 주므로 이웃한 줄을 합친다. 서버는 부여 가운데 하나라도 허용하면 허용으로 본다(ADMIN도 INHERIT도 SET도).
fn merge_members(rows: Vec<MemberRec>) -> Vec<MemberRec> {
    let mut merged: Vec<MemberRec> = Vec::new();
    for row in rows {
        match merged.last_mut() {
            Some(last) if last.member == row.member && last.group == row.group => {
                last.admin |= row.admin;
                last.inherit = any_grant_allows(last.inherit, row.inherit);
                last.set = any_grant_allows(last.set, row.set);
            }
            _ => merged.push(row),
        }
    }
    merged
}

/// 부여 옵션 하나(INHERIT이나 SET)를 두 부여에서 합친다. 하나라도 허용하면 허용이다.
/// 옵션이 없는 서버(둘 다 None)에서는 없는 채로 두고, 한쪽에만 값이 있으면 그 값이다.
fn any_grant_allows(a: Option<bool>, b: Option<bool>) -> Option<bool> {
    match (a, b) {
        (None, None) => None,
        (a, b) => Some(a.unwrap_or(false) || b.unwrap_or(false)),
    }
}

// ───────────────────────── 객체 수 상한 ─────────────────────────
// 관계를 먼저 읽는다: 권한 격자와 점검이 다루는 것은 주로 테이블이다. 확장이 만드는 함수가 수백 개씩 있어도 테이블이 밀려나지 않는다.

/// 관계를 `relations`개 읽은 뒤 함수를 몇 개까지 읽을지. 상한을 넘는지 알아보려고 하나 더 읽는다.
/// 관계만으로 상한을 넘었으면 함수는 읽지 않는다(None).
fn function_limit(relations: usize, max: usize) -> Option<usize> {
    (relations <= max).then(|| max + 1 - relations)
}

/// 읽은 관계와 함수를 상한(`max`) 안으로 자른다. 관계를 먼저 두고 남는 만큼만 함수를 둔다. 잘랐으면 true.
fn cap_objects<R, F>(relations: &mut Vec<R>, functions: &mut Vec<F>, max: usize) -> bool {
    let truncated = relations.len() + functions.len() > max;
    relations.truncate(max);
    functions.truncate(max - relations.len());
    truncated
}

/// 관계 한 줄의 열쇠(ACL은 비어 있다). 이 앱이 다루지 않는 `relkind`면 None.
fn relation_key(schema: String, name: String, kind: &str, owner: String, rls: bool) -> Option<RelationRec> {
    Some(RelationRec { schema, name, kind: RelKind::from_pg(kind)?, owner, rls, acl: Vec::new() })
}

/// 기본 권한 한 줄의 열쇠(ACL은 비어 있다). 이 앱이 다루지 않는 객체 종류면 None.
fn default_acl_key(creator: String, schema: Option<String>, obj_type: &str) -> Option<DefaultAclRec> {
    Some(DefaultAclRec { creator, schema, obj_type: DefaultObjType::from_pg(obj_type)?, acl: Vec::new() })
}

// ───────────────────────── 스냅숏 ─────────────────────────

fn now_iso() -> String {
    clock::iso(clock::now_secs())
}

/// 클러스터 전체의 스냅숏: 서버 버전, 역할, 구성원 관계, 데이터베이스, 역할별 설정, 세션. 읽기 전용 트랜잭션 하나에서 읽는다.
/// `login_user`는 이 연결로 로그인한 DB 사용자로, 스냅숏에 그대로 담는다.
pub async fn cluster_snapshot(conn: &mut Connected, login_user: &str) -> Result<ClusterSnapshot, AppError> {
    read(conn, async |tx| {
        let (version_num, version, password_encryption) = read_server(tx).await?;
        let roles = read_roles(tx).await?;
        let members = read_members(tx, version_num).await?;
        let databases = read_databases(tx).await?;
        let settings = read_settings(tx).await?;
        let sessions = read_sessions(tx).await?;
        Ok(ClusterSnapshot {
            version_num,
            version,
            password_encryption,
            login_user: login_user.to_string(),
            roles,
            members,
            databases,
            settings,
            sessions,
            fetched_at: now_iso(),
        })
    })
    .await
}

/// 연결한 데이터베이스 하나의 스냅숏: 스키마, 관계, 함수, 기본 권한. 읽기 전용 트랜잭션 하나에서 읽는다.
/// 관계와 함수는 합쳐서 2만 개까지만 읽고(관계가 먼저, 함수는 남는 만큼), 넘으면 `truncated`를 켠다.
/// 스냅숏의 이름은 서버가 말하는 연결한 데이터베이스의 이름이다. `database`와 다르면 읽지 않고 오류를 돌려준다.
pub async fn db_snapshot(conn: &mut Connected, database: &str) -> Result<DbSnapshot, AppError> {
    db_snapshot_capped(conn, database, MAX_OBJECTS).await
}

/// `db_snapshot`에 객체 상한을 넘기는 꼴: 시험이 작은 상한으로 잘림을 본다
pub(super) async fn db_snapshot_capped(conn: &mut Connected, database: &str, max_objects: usize) -> Result<DbSnapshot, AppError> {
    let snapshot = read(conn, async |tx| {
        let (actual, owner) = read_db_identity(tx).await?;
        if actual != database {
            // 요청한 이름을 붙여 돌려주지 않는다. 그 데이터베이스의 객체는 읽지 않고 멈춘다
            return Ok(Err(actual));
        }
        let schemas = read_schemas(tx).await?;
        // 관계를 먼저 읽는다. 상한보다 하나 더 읽어서 넘었는지 알아본다
        let mut relations = read_relations(tx, max_objects + 1).await?;
        // 함수는 관계가 남긴 자리만큼 읽는다. 관계만으로 상한을 넘었으면 읽지 않는다
        let mut functions = match function_limit(relations.len(), max_objects) {
            Some(limit) => read_functions(tx, limit).await?,
            None => Vec::new(),
        };
        let truncated = cap_objects(&mut relations, &mut functions, max_objects);
        let default_acls = read_default_acls(tx).await?;
        Ok(Ok(DbSnapshot { database: actual, owner, schemas, relations, functions, default_acls, truncated, fetched_at: now_iso() }))
    })
    .await?;
    snapshot.map_err(|actual| AppError::other(format!("연결한 데이터베이스가 요청과 달라요: {database} / {actual}")))
}

/// 지금 접속해 있는 세션들(오래된 순, 자세한 칸이 없는 줄은 뒤). 매번 새로 읽는다.
/// 로그인 사용자가 superuser도 `pg_read_all_stats` 멤버도 아니면 다른 역할의 세션은 역할·데이터베이스·응용 이름만 있고
/// `state`, `client_addr`, `backend_start`, `query_start`, `wait_event`는 None이다(`SESSIONS_SQL`의 설명 참고).
pub async fn sessions(conn: &mut Connected) -> Result<Vec<SessionRec>, AppError> {
    read(conn, read_sessions).await
}

async fn read_server(tx: &Transaction<'_>) -> Result<(i32, String, String), Error> {
    let row = tx.query_one(SERVER_SQL, &[]).await?;
    Ok((row.try_get(0)?, row.try_get(1)?, row.try_get(2)?))
}

async fn read_roles(tx: &Transaction<'_>) -> Result<Vec<RoleRec>, Error> {
    let rows = tx.query(ROLES_SQL, &[]).await?;
    rows.iter()
        .map(|row| -> Result<RoleRec, Error> {
            Ok(RoleRec {
                name: row.try_get(0)?,
                login: row.try_get(1)?,
                inherit: row.try_get(2)?,
                create_role: row.try_get(3)?,
                create_db: row.try_get(4)?,
                replication: row.try_get(5)?,
                bypass_rls: row.try_get(6)?,
                superuser: row.try_get(7)?,
                conn_limit: row.try_get(8)?,
                valid_until: row.try_get(9)?,
                comment: row.try_get(10)?,
            })
        })
        .collect()
}

async fn read_members(tx: &Transaction<'_>, version_num: i32) -> Result<Vec<MemberRec>, Error> {
    let sql = if version_num >= MEMBERSHIP_OPTIONS_SINCE { MEMBERS_SQL_16 } else { MEMBERS_SQL_OLD };
    let rows = tx.query(sql, &[]).await?;
    let members = rows
        .iter()
        .map(|row| -> Result<MemberRec, Error> {
            Ok(MemberRec { member: row.try_get(0)?, group: row.try_get(1)?, admin: row.try_get(2)?, inherit: row.try_get(3)?, set: row.try_get(4)? })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(merge_members(members))
}

async fn read_databases(tx: &Transaction<'_>) -> Result<Vec<DatabaseRec>, Error> {
    let rows = tx.query(DATABASES_SQL, &[]).await?;
    let acl_rows = rows
        .iter()
        .map(|row| -> Result<AclRow<DatabaseRec>, Error> {
            let key = DatabaseRec { name: row.try_get(0)?, owner: row.try_get(1)?, allow_conn: row.try_get(2)?, acl: Vec::new() };
            acl_row(row, key, 3)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(group_acl(acl_rows).into_iter().map(|(database, acl)| DatabaseRec { acl, ..database }).collect())
}

async fn read_settings(tx: &Transaction<'_>) -> Result<Vec<RoleSettingRec>, Error> {
    let rows = tx.query(SETTINGS_SQL, &[]).await?;
    rows.iter()
        .map(|row| -> Result<RoleSettingRec, Error> {
            Ok(RoleSettingRec { role: row.try_get(0)?, database: row.try_get(1)?, setting: row.try_get(2)? })
        })
        .collect()
}

async fn read_sessions(tx: &Transaction<'_>) -> Result<Vec<SessionRec>, Error> {
    let rows = tx.query(SESSIONS_SQL, &[]).await?;
    rows.iter()
        .map(|row| -> Result<SessionRec, Error> {
            Ok(SessionRec {
                pid: row.try_get(0)?,
                role: row.try_get(1)?,
                database: row.try_get(2)?,
                client_addr: row.try_get(3)?,
                application_name: row.try_get(4)?,
                state: row.try_get(5)?,
                backend_start: row.try_get(6)?,
                query_start: row.try_get(7)?,
                wait_event: row.try_get(8)?,
            })
        })
        .collect()
}

/// 연결한 데이터베이스의 이름과 소유자
async fn read_db_identity(tx: &Transaction<'_>) -> Result<(String, String), Error> {
    let row = tx.query_one(DB_IDENTITY_SQL, &[]).await?;
    Ok((row.try_get(0)?, row.try_get(1)?))
}

async fn read_schemas(tx: &Transaction<'_>) -> Result<Vec<SchemaRec>, Error> {
    let rows = tx.query(SCHEMAS_SQL, &[]).await?;
    let acl_rows = rows
        .iter()
        .map(|row| -> Result<AclRow<SchemaRec>, Error> {
            let key = SchemaRec { name: row.try_get(0)?, owner: row.try_get(1)?, acl: Vec::new() };
            acl_row(row, key, 2)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(group_acl(acl_rows).into_iter().map(|(schema, acl)| SchemaRec { acl, ..schema }).collect())
}

/// 관계를 `limit`개까지 읽는다(스키마, 이름 순)
async fn read_relations(tx: &Transaction<'_>, limit: usize) -> Result<Vec<RelationRec>, Error> {
    let limit = i64::try_from(limit).unwrap_or(i64::MAX);
    let rows = tx.query(RELATIONS_SQL, &[&limit]).await?;
    let mut acl_rows = Vec::with_capacity(rows.len());
    for row in &rows {
        let kind: String = row.try_get(2)?;
        let Some(key) = relation_key(row.try_get(0)?, row.try_get(1)?, &kind, row.try_get(3)?, row.try_get(4)?) else {
            continue;
        };
        acl_rows.push(acl_row(row, key, 5)?);
    }
    Ok(group_acl(acl_rows).into_iter().map(|(relation, acl)| RelationRec { acl, ..relation }).collect())
}

/// 함수와 프로시저를 `limit`개까지 읽는다(스키마, 이름, 인자 순)
async fn read_functions(tx: &Transaction<'_>, limit: usize) -> Result<Vec<FunctionRec>, Error> {
    let limit = i64::try_from(limit).unwrap_or(i64::MAX);
    let rows = tx.query(FUNCTIONS_SQL, &[&limit]).await?;
    let acl_rows = rows
        .iter()
        .map(|row| -> Result<AclRow<FunctionRec>, Error> {
            let key = FunctionRec {
                schema: row.try_get(0)?,
                name: row.try_get(1)?,
                signature: row.try_get(2)?,
                owner: row.try_get(3)?,
                security_definer: row.try_get(4)?,
                search_path_set: row.try_get(5)?,
                acl: Vec::new(),
            };
            acl_row(row, key, 6)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(group_acl(acl_rows).into_iter().map(|(function, acl)| FunctionRec { acl, ..function }).collect())
}

async fn read_default_acls(tx: &Transaction<'_>) -> Result<Vec<DefaultAclRec>, Error> {
    let rows = tx.query(DEFAULT_ACLS_SQL, &[]).await?;
    let mut acl_rows = Vec::with_capacity(rows.len());
    for row in &rows {
        let obj_type: String = row.try_get(2)?;
        let Some(key) = default_acl_key(row.try_get(0)?, row.try_get(1)?, &obj_type) else {
            continue;
        };
        acl_rows.push(acl_row(row, key, 3)?);
    }
    Ok(group_acl(acl_rows).into_iter().map(|(default, acl)| DefaultAclRec { acl, ..default }).collect())
}

#[cfg(test)]
mod tests;
