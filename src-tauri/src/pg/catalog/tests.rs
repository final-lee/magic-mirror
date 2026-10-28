use std::collections::HashSet;
use std::time::Duration;

use super::*;
use crate::pg::fake_server::{FakeServer, Script, FAKE_PID};

// ───────────────────────── 모델의 한 글자 코드와 이름 ─────────────────────────

#[test]
fn every_privilege_round_trips_through_its_pg_name() {
    let all = [
        (Privilege::Select, "SELECT"),
        (Privilege::Insert, "INSERT"),
        (Privilege::Update, "UPDATE"),
        (Privilege::Delete, "DELETE"),
        (Privilege::Truncate, "TRUNCATE"),
        (Privilege::References, "REFERENCES"),
        (Privilege::Trigger, "TRIGGER"),
        (Privilege::Maintain, "MAINTAIN"),
        (Privilege::Execute, "EXECUTE"),
        (Privilege::Usage, "USAGE"),
        (Privilege::Create, "CREATE"),
        (Privilege::Connect, "CONNECT"),
        (Privilege::Temporary, "TEMPORARY"),
    ];
    assert_eq!(all.len(), 13, "권한 종류가 늘면 이 표도 늘려야 해요");
    assert_eq!(all.iter().map(|(_, name)| *name).collect::<HashSet<_>>().len(), 13, "이름이 겹치면 안 돼요");
    for (privilege, name) in all {
        assert_eq!(privilege.as_str(), name);
        assert_eq!(Privilege::from_pg(name), Some(privilege), "{name}");
    }
}

#[test]
fn an_unknown_privilege_name_is_none() {
    // `aclexplode`는 TEMP가 아니라 TEMPORARY라고 쓴다. SET·ALTER SYSTEM은 설정 값의 권한이라 이 앱이 다루지 않는다
    for name in ["", "select", "Select", " SELECT", "SELECT ", "TEMP", "SET", "ALTER SYSTEM", "ALL", "FROBNICATE"] {
        assert_eq!(Privilege::from_pg(name), None, "{name:?}");
    }
}

#[test]
fn relation_kinds_parse_from_their_one_letter_codes() {
    let all = [
        ("r", RelKind::Table),
        ("v", RelKind::View),
        ("m", RelKind::MatView),
        ("p", RelKind::Partitioned),
        ("f", RelKind::Foreign),
        ("S", RelKind::Sequence),
    ];
    for (code, kind) in all {
        assert_eq!(RelKind::from_pg(code), Some(kind), "{code}");
    }
    // 인덱스(i, I), TOAST(t), 복합 타입(c)은 이 앱이 읽지 않는다. 대소문자도 구분한다
    for code in ["i", "I", "t", "c", "s", "R", "V", "", "rr", "table"] {
        assert_eq!(RelKind::from_pg(code), None, "{code:?}");
    }
}

#[test]
fn default_object_types_parse_from_their_one_letter_codes() {
    let all = [
        ("r", DefaultObjType::Tables),
        ("S", DefaultObjType::Sequences),
        ("f", DefaultObjType::Functions),
        ("T", DefaultObjType::Types),
        ("n", DefaultObjType::Schemas),
    ];
    for (code, kind) in all {
        assert_eq!(DefaultObjType::from_pg(code), Some(kind), "{code}");
    }
    for code in ["s", "t", "N", "L", "R", "", "rS"] {
        assert_eq!(DefaultObjType::from_pg(code), None, "{code:?}");
    }
}

// ───────────────────────── group_acl ─────────────────────────

/// ACL 항목이 있는 줄
fn row(key: &'static str, grantor: &str, grantee: Option<&str>, privilege: &str, grantable: bool) -> AclRow<&'static str> {
    AclRow { key, grantor: Some(grantor.into()), grantee: grantee.map(String::from), privilege: Some(privilege.into()), grantable: Some(grantable) }
}

/// ACL이 빈 객체의 줄(`LEFT JOIN LATERAL`이 칸을 NULL로 채운다)
fn bare(key: &'static str) -> AclRow<&'static str> {
    AclRow { key, grantor: None, grantee: None, privilege: None, grantable: None }
}

fn entry(grantor: &str, grantee: Option<&str>, privilege: Privilege, grantable: bool) -> AclEntry {
    AclEntry { grantor: grantor.into(), grantee: grantee.map(String::from), privilege, grantable }
}

#[test]
fn group_acl_keeps_the_order_of_the_objects() {
    // 열쇠 순서가 아니라 처음 나온 순서다
    let grouped = group_acl(vec![
        row("b", "o", Some("x"), "SELECT", false),
        row("a", "o", Some("x"), "SELECT", false),
        row("c", "o", Some("x"), "SELECT", false),
    ]);
    assert_eq!(grouped.iter().map(|(key, _)| *key).collect::<Vec<_>>(), ["b", "a", "c"]);
}

#[test]
fn group_acl_merges_the_rows_of_one_object_in_order() {
    let grouped = group_acl(vec![
        row("orders", "app_owner", Some("app_owner"), "SELECT", true),
        row("orders", "app_owner", Some("app_owner"), "INSERT", true),
        row("orders", "app_owner", Some("app_read"), "SELECT", false),
        row("items", "app_owner", Some("app_read"), "SELECT", false),
    ]);
    assert_eq!(
        grouped,
        vec![
            (
                "orders",
                vec![
                    entry("app_owner", Some("app_owner"), Privilege::Select, true),
                    entry("app_owner", Some("app_owner"), Privilege::Insert, true),
                    entry("app_owner", Some("app_read"), Privilege::Select, false),
                ]
            ),
            ("items", vec![entry("app_owner", Some("app_read"), Privilege::Select, false)]),
        ]
    );
}

#[test]
fn group_acl_reads_a_missing_grantee_as_public() {
    // `grantee`가 비면 PUBLIC이다. 이름이 있는 항목과 섞여도 PUBLIC은 None으로 남는다
    let grouped = group_acl(vec![row("fn", "app_owner", None, "EXECUTE", false), row("fn", "app_owner", Some("app_write"), "EXECUTE", false)]);
    let acl = &grouped[0].1;
    assert_eq!(acl[0], entry("app_owner", None, Privilege::Execute, false));
    assert_eq!(acl[1].grantee.as_deref(), Some("app_write"));
}

#[test]
fn group_acl_keeps_objects_that_have_no_acl_rows() {
    // ACL이 비어(`{}`) 아무도 권한이 없는 객체도 목록에는 남아야 한다. 위치도 그대로다
    let grouped = group_acl(vec![
        row("a", "o", Some("x"), "SELECT", false),
        bare("locked"),
        row("b", "o", Some("x"), "SELECT", false),
        bare("last"),
    ]);
    assert_eq!(
        grouped,
        vec![
            ("a", vec![entry("o", Some("x"), Privilege::Select, false)]),
            ("locked", vec![]),
            ("b", vec![entry("o", Some("x"), Privilege::Select, false)]),
            ("last", vec![]),
        ]
    );
}

#[test]
fn group_acl_of_nothing_is_nothing() {
    assert_eq!(group_acl::<&str>(vec![]), vec![]);
}

#[test]
fn group_acl_leaves_out_only_the_privileges_it_does_not_know() {
    // 새 서버가 더한 권한은 그 항목만 빠지고, 객체와 나머지 항목은 남는다
    let grouped = group_acl(vec![
        row("t", "o", Some("x"), "SELECT", false),
        row("t", "o", Some("x"), "FROBNICATE", false),
        row("t", "o", Some("x"), "INSERT", false),
        row("only_unknown", "o", Some("x"), "FROBNICATE", false),
    ]);
    assert_eq!(
        grouped,
        vec![
            ("t", vec![entry("o", Some("x"), Privilege::Select, false), entry("o", Some("x"), Privilege::Insert, false)]),
            ("only_unknown", vec![]),
        ]
    );
}

#[test]
fn group_acl_carries_the_grantor_and_the_grant_option() {
    let grouped = group_acl(vec![row("s", "app_owner", Some("app_write"), "USAGE", true)]);
    let AclEntry { grantor, grantee, privilege, grantable } = grouped[0].1[0].clone();
    assert_eq!((grantor.as_str(), grantee.as_deref(), privilege, grantable), ("app_owner", Some("app_write"), Privilege::Usage, true));
}

#[test]
fn group_acl_does_not_invent_an_entry_from_a_half_filled_row() {
    // 서버는 이런 줄을 주지 않는다. 그래도 칸이 빠진 줄에서 항목을 지어내지 않고 객체만 남긴다
    let half = AclRow { key: "t", grantor: None, grantee: Some("x".into()), privilege: Some("SELECT".into()), grantable: Some(false) };
    let no_option = AclRow { key: "u", grantor: Some("o".into()), grantee: None, privilege: Some("SELECT".into()), grantable: None };
    assert_eq!(group_acl(vec![half, no_option]), vec![("t", vec![]), ("u", vec![])]);
}

// ───────────────────────── 구성원 관계 합치기 ─────────────────────────

fn member(member: &str, group: &str, admin: bool, inherit: Option<bool>, set: Option<bool>) -> MemberRec {
    MemberRec { member: member.into(), group: group.into(), admin, inherit, set }
}

#[test]
fn members_without_duplicates_are_left_alone() {
    let rows = vec![
        member("alice", "app_read", false, Some(true), Some(true)),
        member("alice", "app_write", true, Some(false), Some(false)),
        member("bob", "app_read", false, None, None),
    ];
    assert_eq!(merge_members(rows.clone()), rows);
}

#[test]
fn several_grantors_of_one_membership_become_one_pair() {
    // PG16: 부여자마다 한 줄. 하나라도 허용하면 허용이다
    let merged = merge_members(vec![
        member("alice", "app_read", false, Some(false), Some(false)),
        member("alice", "app_read", true, Some(true), Some(true)),
        member("bob", "app_read", false, Some(false), Some(false)),
        member("bob", "app_read", false, Some(false), Some(false)),
    ]);
    assert_eq!(
        merged,
        vec![member("alice", "app_read", true, Some(true), Some(true)), member("bob", "app_read", false, Some(false), Some(false))]
    );
}

#[test]
fn each_option_of_a_merged_pair_comes_from_any_grant_that_allows_it() {
    // 옵션마다 허용한 부여가 서로 다르다: INHERIT은 첫째, ADMIN은 둘째, SET은 셋째 부여만 허용한다
    let merged = merge_members(vec![
        member("a", "g", false, Some(true), Some(false)),
        member("a", "g", true, Some(false), Some(false)),
        member("a", "g", false, Some(false), Some(true)),
    ]);
    assert_eq!(merged, vec![member("a", "g", true, Some(true), Some(true))]);
}

#[test]
fn the_options_of_a_merged_pair_do_not_depend_on_the_order_of_the_rows() {
    let rows = [
        member("a", "g", false, Some(true), Some(false)),
        member("a", "g", true, Some(false), Some(false)),
        member("a", "g", false, Some(false), Some(true)),
    ];
    for order in [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]] {
        let merged = merge_members(order.iter().map(|&i| rows[i].clone()).collect());
        assert_eq!(merged, vec![member("a", "g", true, Some(true), Some(true))], "{order:?}");
    }
}

#[test]
fn a_pair_cannot_set_role_only_when_every_grant_says_so() {
    // PG16에서 CREATEROLE 사용자가 만든 역할의 자동 부여(ADMIN만 있고 INHERIT도 SET도 없다)가 부여자만 달리 두 줄이어도 SET은 false로 남는다
    let auto_grant = member("creator", "created", true, Some(false), Some(false));
    assert_eq!(merge_members(vec![auto_grant.clone(), auto_grant.clone()]), vec![auto_grant]);
}

#[test]
fn memberships_before_pg16_keep_missing_options() {
    // 옵션이 없는 서버에서는 합쳐도 없는 채로다. "없음"을 "허용 안 함"으로 바꾸면 안 된다(INHERIT도 SET도)
    assert_eq!(
        merge_members(vec![member("a", "g", false, None, None), member("a", "g", false, None, None)]),
        vec![member("a", "g", false, None, None)]
    );
    // 한쪽만 값이 있으면 그 값이 쓰인다
    assert_eq!(
        merge_members(vec![member("a", "g", false, None, None), member("a", "g", false, Some(false), Some(false))]),
        vec![member("a", "g", false, Some(false), Some(false))]
    );
}

#[test]
fn only_the_same_pair_is_merged() {
    let rows = vec![
        member("alice", "app_read", false, Some(true), Some(true)),
        member("alice", "app_write", false, Some(true), Some(true)),
        member("bob", "app_write", false, Some(true), Some(true)),
    ];
    assert_eq!(merge_members(rows.clone()), rows);
}

// ───────────────────────── 객체 수 상한 ─────────────────────────

#[test]
fn relations_get_what_the_functions_left_plus_one() {
    assert_eq!(MAX_OBJECTS, 20_000, "데이터베이스 하나에서 읽는 객체는 관계와 함수를 합쳐 2만 개까지다");
    assert_eq!(relation_limit(0, MAX_OBJECTS), Some(20_001));
    assert_eq!(relation_limit(100, MAX_OBJECTS), Some(19_901));
    assert_eq!(relation_limit(19_999, MAX_OBJECTS), Some(2));
    assert_eq!(relation_limit(20_000, MAX_OBJECTS), Some(1));
}

#[test]
fn no_relations_are_read_when_the_functions_alone_exceed_the_cap() {
    // 함수를 상한보다 하나 더(20 001개) 읽었다: 관계를 읽을 자리가 없다
    assert_eq!(relation_limit(20_001, MAX_OBJECTS), None);
    assert_eq!(relation_limit(5, 4), None);
}

#[test]
fn objects_under_or_at_the_cap_are_not_cut() {
    let (mut functions, mut relations) = (vec![0; 3], vec![0; 7]);
    assert!(!cap_objects(&mut functions, &mut relations, 10));
    assert_eq!((functions.len(), relations.len()), (3, 7));
    let (mut functions, mut relations) = (vec![0; 0], vec![0; 10]);
    assert!(!cap_objects(&mut functions, &mut relations, 10));
    assert_eq!((functions.len(), relations.len()), (0, 10));
}

#[test]
fn relations_are_cut_to_what_the_cap_leaves_after_the_functions() {
    // 관계는 `max + 1 - 함수 수`개까지 읽으므로, 그만큼 읽혔다면 상한을 넘은 것이다
    let mut functions = vec!['f'; 3];
    let mut relations: Vec<usize> = (0..relation_limit(3, 10).unwrap()).collect();
    assert_eq!(relations.len(), 8);
    assert!(cap_objects(&mut functions, &mut relations, 10));
    assert_eq!(functions.len(), 3, "함수는 그대로예요");
    assert_eq!(relations, (0..7).collect::<Vec<_>>(), "이름순으로 앞의 관계가 남아요");
}

#[test]
fn functions_over_the_cap_are_cut_and_leave_no_room_for_relations() {
    let mut functions: Vec<usize> = (0..10 + 1).collect();
    let mut relations: Vec<usize> = Vec::new();
    assert!(relation_limit(functions.len(), 10).is_none());
    assert!(cap_objects(&mut functions, &mut relations, 10));
    assert_eq!(functions, (0..10).collect::<Vec<_>>());
    assert!(relations.is_empty());
}

#[test]
fn a_cap_full_of_functions_leaves_no_relation() {
    // 함수가 상한과 같으면 관계는 1개만 읽는다. 그 하나가 있으면 상한을 넘는 것이다
    let mut functions = vec![0; 10];
    let mut relations = vec![0; relation_limit(10, 10).unwrap()];
    assert_eq!(relations.len(), 1);
    assert!(cap_objects(&mut functions, &mut relations, 10));
    assert_eq!((functions.len(), relations.len()), (10, 0));
    // 하나도 없으면 딱 상한이라 자르지 않는다
    let (mut functions, mut relations) = (vec![0; 10], Vec::<usize>::new());
    assert!(!cap_objects(&mut functions, &mut relations, 10));
}

#[test]
fn the_real_cap_is_applied_to_relations_and_functions_together() {
    let mut functions = vec![0u8; 12_000];
    let mut relations = vec![0u8; relation_limit(12_000, MAX_OBJECTS).unwrap()];
    assert_eq!(relations.len(), 8_001);
    assert!(cap_objects(&mut functions, &mut relations, MAX_OBJECTS));
    assert_eq!(functions.len() + relations.len(), MAX_OBJECTS);
}

// ───────────────────────── 열쇠 만들기 ─────────────────────────

#[test]
fn keys_skip_the_kinds_the_app_does_not_model() {
    assert_eq!(
        relation_key("app".into(), "orders".into(), "r", "app_owner".into(), true),
        Some(RelationRec { schema: "app".into(), name: "orders".into(), kind: RelKind::Table, owner: "app_owner".into(), rls: true, acl: vec![] })
    );
    assert_eq!(relation_key("app".into(), "orders_pkey".into(), "i", "app_owner".into(), false), None);
    assert_eq!(
        default_acl_key("app_owner".into(), Some("app".into()), "r"),
        Some(DefaultAclRec { creator: "app_owner".into(), schema: Some("app".into()), obj_type: DefaultObjType::Tables, acl: vec![] })
    );
    assert_eq!(
        default_acl_key("app_owner".into(), None, "S"),
        Some(DefaultAclRec { creator: "app_owner".into(), schema: None, obj_type: DefaultObjType::Sequences, acl: vec![] })
    );
    assert_eq!(default_acl_key("app_owner".into(), None, "L"), None);
}

// ───────────────────────── SQL 문장 ─────────────────────────

const ALL_SQL: [(&str, &str); 13] = [
    ("BACKEND_PID_SQL", BACKEND_PID_SQL),
    ("SERVER_SQL", SERVER_SQL),
    ("ROLES_SQL", ROLES_SQL),
    ("MEMBERS_SQL_16", MEMBERS_SQL_16),
    ("MEMBERS_SQL_OLD", MEMBERS_SQL_OLD),
    ("DATABASES_SQL", DATABASES_SQL),
    ("SETTINGS_SQL", SETTINGS_SQL),
    ("SESSIONS_SQL", SESSIONS_SQL),
    ("DB_OWNER_SQL", DB_OWNER_SQL),
    ("SCHEMAS_SQL", SCHEMAS_SQL),
    ("RELATIONS_SQL", RELATIONS_SQL),
    ("FUNCTIONS_SQL", FUNCTIONS_SQL),
    ("DEFAULT_ACLS_SQL", DEFAULT_ACLS_SQL),
];

#[test]
fn every_statement_only_reads() {
    // 서버가 읽기 전용 트랜잭션에서 쓰기를 거절하지만, 문장 자체도 읽기여야 한다
    let writes = ["INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "GRANT", "REVOKE", "TRUNCATE", "COPY", "COMMENT", "VACUUM", "SET", "DO"];
    for (name, sql) in ALL_SQL {
        let first = sql.split_whitespace().next().unwrap_or_default().to_uppercase();
        assert!(first == "SELECT" || first == "WITH", "{name}은 SELECT나 WITH로 시작해야 해요: {first}");
        for word in sql.split(|c: char| !(c.is_alphanumeric() || c == '_')).filter(|w| !w.is_empty()) {
            assert!(!writes.contains(&word.to_uppercase().as_str()), "{name}에 쓰기 낱말 {word}가 있어요");
        }
    }
}

#[test]
fn no_statement_has_an_unfilled_placeholder() {
    for (name, sql) in ALL_SQL {
        assert!(!sql.contains('{') && !sql.contains('}') && !sql.contains("SYS"), "{name}에 채워지지 않은 자리가 있어요");
    }
}

#[test]
fn the_statements_of_one_database_leave_out_the_system_schemas() {
    for (name, sql) in [("SCHEMAS_SQL", SCHEMAS_SQL), ("RELATIONS_SQL", RELATIONS_SQL), ("FUNCTIONS_SQL", FUNCTIONS_SQL)] {
        for part in [
            "n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')",
            r"n.nspname NOT LIKE 'pg\_temp\_%'",
            r"n.nspname NOT LIKE 'pg\_toast\_temp\_%'",
        ] {
            assert!(sql.contains(part), "{name}에 {part}가 없어요");
        }
    }
}

#[test]
fn relations_and_functions_are_limited_and_partitions_are_left_out() {
    assert!(RELATIONS_SQL.contains("LIMIT $1") && FUNCTIONS_SQL.contains("LIMIT $1"));
    assert!(RELATIONS_SQL.contains("NOT c.relispartition"), "파티션 자식은 읽지 않아요");
    assert!(RELATIONS_SQL.contains("c.relkind IN ('r','v','m','p','f','S')"));
    assert!(FUNCTIONS_SQL.contains("p.prokind IN ('f','p')"), "집계와 윈도 함수는 읽지 않아요");
}

#[test]
fn templates_and_rdsadmin_are_left_out_of_the_databases() {
    assert!(DATABASES_SQL.contains("NOT d.datistemplate") && DATABASES_SQL.contains("d.datname <> 'rdsadmin'"));
}

#[test]
fn the_pg16_members_query_reads_the_set_option_and_the_older_one_has_none() {
    // 열 순서는 `read_members`가 읽는 순서다: 구성원, 그룹, ADMIN, INHERIT, SET
    assert!(MEMBERS_SQL_16.contains("SELECT m.rolname, g.rolname, am.admin_option, am.inherit_option, am.set_option"), "{MEMBERS_SQL_16}");
    assert!(MEMBERS_SQL_OLD.contains("SELECT m.rolname, g.rolname, am.admin_option, NULL::bool, NULL::bool"), "{MEMBERS_SQL_OLD}");
}

#[test]
fn the_sessions_query_also_keeps_the_rows_of_other_roles_that_the_server_blanks() {
    // 권한이 없는 로그인 사용자에게는 다른 역할의 세션에서 `backend_type`이 비어 온다. 역할과 데이터베이스가 있는 줄은 세션이다
    assert!(SESSIONS_SQL.contains("backend_type = 'client backend'"));
    assert!(SESSIONS_SQL.contains("(backend_type IS NULL AND usename IS NOT NULL AND datname IS NOT NULL)"), "{SESSIONS_SQL}");
}

#[test]
fn a_role_that_expired_forever_reads_as_the_oldest_time() {
    // `to_char`는 -infinity에 NULL을 주므로 따로 받지 않으면 "만료 없음"으로 읽힌다
    assert!(ROLES_SQL.contains("WHEN r.rolvaliduntil = '-infinity' THEN '1970-01-01T00:00:00Z'"), "{ROLES_SQL}");
}

#[test]
fn the_statement_timeout_is_30_seconds_and_local_to_the_transaction() {
    assert_eq!(STATEMENT_TIMEOUT, "SET LOCAL statement_timeout = '30s'");
}

// ───────────────────────── 읽기 전용 트랜잭션 (가짜 서버) ─────────────────────────

const OPEN_READ_ONLY: [&str; 2] = ["START TRANSACTION READ ONLY", "SET LOCAL statement_timeout = '30s'"];

/// 클라이언트가 연결이 닫힌 것을 알아챌 때까지 기다린다
async fn wait_until_closed(conn: &Connected) {
    for _ in 0..200 {
        if conn.client.is_closed() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("연결이 닫힌 것을 알아채지 못했어요");
}

#[tokio::test]
async fn a_read_runs_in_one_read_only_transaction_with_a_statement_timeout() {
    let server = FakeServer::start(Script::Ready).await;
    let mut conn = server.connected(1).await;
    let pid = read(&mut conn, async |tx| tx.query_one(BACKEND_PID_SQL, &[]).await?.try_get::<_, i32>(0)).await;
    assert_eq!(pid, Ok(FAKE_PID));
    // 시작 → 시간 제한 → 작업 → 커밋. 작업은 그 사이에서만 돈다
    assert_eq!(server.simple_queries(), [OPEN_READ_ONLY[0], OPEN_READ_ONLY[1], "COMMIT"]);
}

#[tokio::test]
async fn two_reads_are_two_transactions() {
    let server = FakeServer::start(Script::Ready).await;
    let mut conn = server.connected(1).await;
    for _ in 0..2 {
        read(&mut conn, async |tx| tx.query_one(BACKEND_PID_SQL, &[]).await.map(|_| ())).await.unwrap();
    }
    assert_eq!(
        server.simple_queries(),
        [OPEN_READ_ONLY[0], OPEN_READ_ONLY[1], "COMMIT", OPEN_READ_ONLY[0], OPEN_READ_ONLY[1], "COMMIT"]
    );
}

#[tokio::test]
async fn a_server_error_in_a_read_is_the_servers_own_message_and_the_transaction_is_dropped() {
    let server = FakeServer::start(Script::RejectsQueries { code: "42501", message: "permission denied for table pg_authid" }).await;
    let mut conn = server.connected(1).await;
    let failed = read(&mut conn, async |tx| tx.query_one("SELECT 1", &[]).await.map(|_| ())).await;
    assert_eq!(failed, Err(AppError::other("permission denied for table pg_authid")));
    assert!(!format!("{failed:?}").contains("42501"), "SQLSTATE는 문구에 넣지 않아요: {failed:?}");
    // 같은 연결로 다음 읽기가 된다. 앞의 롤백이 먼저 처리됐다는 증거이기도 하다
    assert_eq!(read(&mut conn, async |tx| tx.batch_execute("SELECT 1").await).await, Ok(()));
    assert_eq!(
        server.simple_queries(),
        // 실패한 읽기는 커밋하지 않고 롤백한다
        [OPEN_READ_ONLY[0], OPEN_READ_ONLY[1], "ROLLBACK", OPEN_READ_ONLY[0], OPEN_READ_ONLY[1], "SELECT 1", "COMMIT"]
    );
}

#[tokio::test]
async fn a_lost_connection_is_a_network_error() {
    let server = FakeServer::start(Script::Ready).await;
    let mut conn = server.connected(1).await;
    server.close_connections();
    wait_until_closed(&conn).await;
    let failed = read(&mut conn, async |tx| tx.batch_execute("SELECT 1").await).await;
    assert!(matches!(failed, Err(AppError::Network { .. })), "{failed:?}");
}

#[tokio::test]
async fn a_failure_that_is_not_the_network_is_not_reported_as_one() {
    // 없는 열을 읽는 프로그래밍 오류다. 네트워크 탓으로 보이면 안 된다
    let server = FakeServer::start(Script::Ready).await;
    let mut conn = server.connected(1).await;
    let failed = read(&mut conn, async |tx| tx.query_one(BACKEND_PID_SQL, &[]).await?.try_get::<_, i32>(7)).await;
    assert!(matches!(failed, Err(AppError::Other { .. })), "{failed:?}");
}

#[tokio::test]
async fn backend_pid_reads_the_pid_inside_a_read_only_transaction() {
    let server = FakeServer::start(Script::Ready).await;
    let mut conn = server.connected(0).await;
    assert_eq!(backend_pid(&mut conn.client).await.unwrap(), FAKE_PID);
    assert_eq!(server.simple_queries(), [OPEN_READ_ONLY[0], OPEN_READ_ONLY[1], "COMMIT"]);
}

#[tokio::test]
async fn backend_pid_fails_with_the_drivers_error_so_the_connect_step_can_classify_it() {
    let server = FakeServer::start(Script::Ready).await;
    let mut conn = server.connected(0).await;
    server.close_connections();
    wait_until_closed(&conn).await;
    let failed: Error = backend_pid(&mut conn.client).await.unwrap_err();
    assert!(failed.is_closed(), "{failed:?}");
}

fn assert_send<T: Send>(_: &T) {}

#[tokio::test]
async fn the_catalog_futures_can_be_held_by_a_command_across_threads() {
    // 퓨처를 만들기만 하고 돌리지 않는다. Tauri 명령은 이 퓨처를 쥔 채 기다리므로 `Send`여야 한다
    let server = FakeServer::start(Script::Ready).await;
    let mut conn = server.connected(1).await;
    assert_send(&read(&mut conn, async |tx| tx.batch_execute("SELECT 1").await));
    assert_send(&cluster_snapshot(&mut conn, "iam_admin"));
    assert_send(&db_snapshot(&mut conn, "app"));
    assert_send(&sessions(&mut conn));
    assert_send(&backend_pid(&mut conn.client));
}
