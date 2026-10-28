//! 실효 권한 비교 시험. 심는 장면과 접속 도구는 부모(`live_tests`)의 것을 쓴다.

use std::collections::{BTreeSet, HashMap, HashSet};

use super::*;
use crate::pg::eval::{schema_cells, who_can, Coverage, Ctx, Obj, SourceKind};

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
-- PUBLIC이 CREATE만 받은 스키마: USAGE는 아무도 받지 않았다. 서버는 USAGE 없이도 거기에 만들게 한다
CREATE SCHEMA cmp_create_only;
GRANT CREATE ON SCHEMA cmp_create_only TO PUBLIC;
-- 같은 부여에 읽을 수 있는 테이블이 있으면 그 테이블은 USAGE 없이 읽지 못한다
CREATE SCHEMA cmp_create_read;
GRANT CREATE ON SCHEMA cmp_create_read TO PUBLIC;
CREATE TABLE cmp_create_read.t (a integer);
GRANT SELECT ON cmp_create_read.t TO PUBLIC;
-- 쓰기가 함께 보이는 경우도 같다
CREATE SCHEMA cmp_create_write;
GRANT CREATE ON SCHEMA cmp_create_write TO PUBLIC;
CREATE TABLE cmp_create_write.t (a integer);
GRANT INSERT ON cmp_create_write.t TO PUBLIC;
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
/// - `who_can`이 고른 역할들과 그 못 쓰는 이유: 객체 × 권한마다 서버가 "있다"고 한 역할들과 같은가, 이유는 서버의 CONNECT·USAGE 답과 같은가
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

    let said = |role: &str, target: Target, p: Privilege| -> bool {
        *answers.get(&(role.to_string(), target, p)).unwrap_or_else(|| panic!("서버의 답이 없어요: {role} {p:?}"))
    };

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
        // 못 쓰는 이유: CONNECT가 먼저고 스키마 USAGE가 다음이다. CONNECT는 데이터베이스를 물었으면 그 데이터베이스에서, 아니면 스냅숏의
        // 데이터베이스에서 본다. 스키마의 CREATE는 USAGE 없이도 되니 USAGE는 보지 않는다
        let database = match *target {
            Target::Database(name) => name.as_str(),
            _ => ctx.db.database.as_str(),
        };
        let schema = match (*target, *p) {
            (Target::Database(_), _) | (Target::Schema(_), Privilege::Create) => None,
            (Target::Schema(name) | Target::Relation { schema: name, .. } | Target::Function { schema: name, .. }, _) => Some(name.as_str()),
        };
        for row in &rows {
            let unusable = if !said(&row.role, Target::Database(database.to_string()), Privilege::Connect) {
                Some("CONNECT 없음")
            } else if schema.is_some_and(|schema| !said(&row.role, Target::Schema(schema.to_string()), Privilege::Usage)) {
                Some("USAGE 없음")
            } else {
                None
            };
            if row.unusable != unusable {
                mismatches.push(format!(
                    "누가 할 수 있나 · {} · {} · {}의 못 쓰는 이유: PostgreSQL {unusable:?}, 앱 {:?}",
                    target.label(),
                    p.as_str(),
                    row.role,
                    row.unusable
                ));
            }
        }
    }

    // 3. 스키마 칸
    let coverage = |have: usize, total: usize| match (have, total) {
        (0, _) => Coverage::None,
        (have, total) if have == total => Coverage::All,
        _ => Coverage::Some,
    };
    let role_names: Vec<&str> = ctx.cluster.roles.iter().map(|r| r.name.as_str()).collect();
    let cells = schema_cells(ctx, &role_names);
    // 칸은 물은 역할 순서대로 나오고, 역할마다 스키마 이름순이다. 아래는 칸이 말하는 역할로 서버의 답을 찾으니 순서를 따로 본다
    let mut schema_names: Vec<&str> = ctx.db.schemas.iter().map(|s| s.name.as_str()).collect();
    schema_names.sort_unstable();
    let asked_order: Vec<(&str, &str)> = role_names.iter().flat_map(|&role| schema_names.iter().map(move |&schema| (role, schema))).collect();
    let cell_order: Vec<(&str, &str)> = cells.iter().map(|c| (c.role.as_str(), c.schema.as_str())).collect();
    if cell_order != asked_order {
        let first = cell_order.iter().zip(&asked_order).position(|(got, want)| got != want);
        mismatches.push(format!("칸의 순서가 달라요: 칸 {}개(물은 것은 {}개), 처음 다른 곳 {first:?}", cell_order.len(), asked_order.len()));
    }
    for cell in cells {
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
        // 잃을 것이 있는 칸에만, CONNECT가 먼저고 스키마 USAGE가 다음이다. 보이는 것이 CREATE뿐이면 USAGE 없이도 쓸 수 있으니 USAGE는 보지 않는다
        let shown = usage || create || expected.2 != Coverage::None || expected.3 != Coverage::None;
        let create_only = create && !usage && expected.2 == Coverage::None && expected.3 == Coverage::None;
        let connect = said(role, Target::Database(ctx.db.database.clone()), Privilege::Connect);
        let unusable = if !shown {
            None
        } else if !connect {
            Some("CONNECT 없음")
        } else if !usage && !create_only {
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
pub(super) async fn effective_privileges_match_postgres(server: Server) {
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
    // 스키마에 CREATE만 있는 칸은 USAGE가 없어도 못 쓰는 이유가 아니다(서버도 USAGE 없이 만들게 한다). CONNECT가 없으면 그것이 이유다
    let cell = |role: &str, schema: &str| schema_cells(&ctx, &[role]).into_iter().find(|c| c.schema == schema).expect("칸이 없어요");
    let shown = |c: &crate::pg::eval::SchemaCell| (c.usage, c.create, c.read, c.write, c.unusable);
    // alice는 app_write를 거쳐 scratch의 CREATE만 갖고, CONNECT는 app_read에서 받는다
    assert_eq!(shown(&cell("alice", "scratch")), (false, true, Coverage::None, Coverage::None, None));
    assert_eq!(shown(&cell("alice", "cmp_create_only")), (false, true, Coverage::None, Coverage::None, None));
    // 같은 부여라도 읽을 수 있는 테이블이나 쓸 수 있는 테이블이 함께 보이는 칸은 USAGE가 없다는 이유를 가진다
    assert_eq!(shown(&cell("alice", "cmp_create_read")), (false, true, Coverage::All, Coverage::None, Some("USAGE 없음")));
    assert_eq!(shown(&cell("alice", "cmp_create_write")), (false, true, Coverage::None, Coverage::All, Some("USAGE 없음")));
    // CONNECT가 없는 역할은 CONNECT가 이유다
    assert_eq!(shown(&cell("mm_cmp_in_super", "cmp_create_only")), (false, true, Coverage::None, Coverage::None, Some("CONNECT 없음")));
    // 서버 쪽: USAGE 없이 CREATE만 가진 alice가 scratch에 만들 수 있다
    let alice_has_usage: bool =
        conn.client.query_one("SELECT has_schema_privilege('alice', 'scratch', 'USAGE')", &[]).await.expect("USAGE를 묻지 못했어요").get(0);
    assert!(!alice_has_usage, "alice는 scratch의 USAGE가 없어야 해요");
    conn.client
        .batch_execute("SET ROLE alice; CREATE TABLE scratch.mm_cmp_made (a integer); RESET ROLE; DROP TABLE scratch.mm_cmp_made;")
        .await
        .expect("USAGE 없이 CREATE만 가진 역할이 스키마에 만들지 못했어요");
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
pub(super) async fn a_noinherit_database_owner_matches_postgres(server: Server) {
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
