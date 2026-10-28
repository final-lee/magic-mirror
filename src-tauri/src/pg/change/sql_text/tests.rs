use super::*;
use crate::pg::model::Privilege::{Connect, Create, Delete, Execute, Insert, Select, Temporary, Update, Usage};
use crate::pg::password::NewPassword;

fn shown(statement: Statement) -> String {
    statement.shown()
}

/// 이름과 값이 문장을 깨려고 만든 글. 이 글이 따옴표 밖으로 나오면 문장이 둘로 갈라진다
const NASTY_NAME: &str = "x\"; DROP ROLE y; --";
const NASTY_VALUE: &str = "x'; DROP ROLE y; --";

// ───────────────────────── 역할 ─────────────────────────

#[test]
fn creating_a_user_names_the_password_slot_and_the_limits() {
    assert_eq!(
        shown(create_role("alice", true, true, 5, Some("2027-01-01T00:00:00Z"))),
        r#"CREATE ROLE "alice" LOGIN PASSWORD '••••••••' CONNECTION LIMIT 5 VALID UNTIL '2027-01-01T00:00:00Z'"#
    );
}

#[test]
fn creating_a_group_is_nologin_and_a_limit_of_minus_one_and_no_expiry_add_nothing() {
    assert_eq!(shown(create_role("app_read", false, false, -1, None)), r#"CREATE ROLE "app_read" NOLOGIN"#);
}

#[test]
fn each_part_of_a_create_role_is_added_only_when_given() {
    assert_eq!(shown(create_role("alice", true, true, -1, None)), r#"CREATE ROLE "alice" LOGIN PASSWORD '••••••••'"#);
    assert_eq!(shown(create_role("alice", true, false, 5, None)), r#"CREATE ROLE "alice" LOGIN CONNECTION LIMIT 5"#);
    assert_eq!(shown(create_role("alice", false, false, -1, Some("2027-01-01T00:00:00Z"))), r#"CREATE ROLE "alice" NOLOGIN VALID UNTIL '2027-01-01T00:00:00Z'"#);
    // 0은 "접속 불가"라서 제한 없음(-1)과 다르다
    assert_eq!(shown(create_role("alice", true, false, 0, None)), r#"CREATE ROLE "alice" LOGIN CONNECTION LIMIT 0"#);
}

#[test]
fn altering_attributes_writes_all_six_clauses_in_a_fixed_order() {
    let clauses = [
        AttrClause::Login(false),
        AttrClause::CreateDb(true),
        AttrClause::CreateRole(false),
        AttrClause::Inherit(true),
        AttrClause::ConnectionLimit(-1),
        AttrClause::ValidUntil(None),
    ];
    assert_eq!(
        shown(alter_role("alice", &clauses)),
        r#"ALTER ROLE "alice" NOLOGIN CREATEDB NOCREATEROLE INHERIT CONNECTION LIMIT -1 VALID UNTIL 'infinity'"#
    );
}

#[test]
fn the_order_of_the_clauses_does_not_depend_on_the_order_they_are_passed_in() {
    let reversed = [
        AttrClause::ValidUntil(None),
        AttrClause::ConnectionLimit(-1),
        AttrClause::Inherit(true),
        AttrClause::CreateRole(false),
        AttrClause::CreateDb(true),
        AttrClause::Login(false),
    ];
    assert_eq!(
        shown(alter_role("alice", &reversed)),
        r#"ALTER ROLE "alice" NOLOGIN CREATEDB NOCREATEROLE INHERIT CONNECTION LIMIT -1 VALID UNTIL 'infinity'"#
    );
    let some = [AttrClause::ConnectionLimit(3), AttrClause::Login(true)];
    assert_eq!(shown(alter_role("alice", &some)), r#"ALTER ROLE "alice" LOGIN CONNECTION LIMIT 3"#);
}

#[test]
fn each_attribute_clause_has_its_keyword_for_on_and_off() {
    let each = [
        (AttrClause::Login(true), "LOGIN"),
        (AttrClause::Login(false), "NOLOGIN"),
        (AttrClause::CreateDb(true), "CREATEDB"),
        (AttrClause::CreateDb(false), "NOCREATEDB"),
        (AttrClause::CreateRole(true), "CREATEROLE"),
        (AttrClause::CreateRole(false), "NOCREATEROLE"),
        (AttrClause::Inherit(true), "INHERIT"),
        (AttrClause::Inherit(false), "NOINHERIT"),
        (AttrClause::ConnectionLimit(5), "CONNECTION LIMIT 5"),
        (AttrClause::ValidUntil(Some("2027-01-01T00:00:00Z".into())), "VALID UNTIL '2027-01-01T00:00:00Z'"),
        (AttrClause::ValidUntil(None), "VALID UNTIL 'infinity'"),
    ];
    for (clause, keyword) in each {
        assert_eq!(shown(alter_role("alice", &[clause])), format!("ALTER ROLE \"alice\" {keyword}"));
    }
}

#[test]
fn resetting_a_password_and_dropping_a_role() {
    assert_eq!(shown(alter_role_password("alice")), r#"ALTER ROLE "alice" PASSWORD '••••••••'"#);
    assert_eq!(shown(drop_role("alice")), r#"DROP ROLE "alice""#);
}

// ───────────────────────── 구성원 관계 ─────────────────────────

#[test]
fn granting_a_role_with_and_without_options() {
    assert_eq!(shown(grant_role("app_read", "alice", false, false)), r#"GRANT "app_read" TO "alice""#);
    assert_eq!(shown(grant_role("app_read", "alice", true, false)), r#"GRANT "app_read" TO "alice" WITH ADMIN OPTION"#);
    assert_eq!(shown(grant_role("alice", "iam_admin", false, true)), r#"GRANT "alice" TO "iam_admin" WITH INHERIT TRUE"#);
    // 옵션이 둘이면 PG16 문법대로 쉼표로 잇는다
    assert_eq!(shown(grant_role("app_read", "alice", true, true)), r#"GRANT "app_read" TO "alice" WITH ADMIN OPTION, INHERIT TRUE"#);
}

#[test]
fn revoking_a_role_with_and_without_options() {
    assert_eq!(shown(revoke_role("app_read", "alice", false, None)), r#"REVOKE "app_read" FROM "alice""#);
    assert_eq!(shown(revoke_role("app_read", "alice", true, None)), r#"REVOKE ADMIN OPTION FOR "app_read" FROM "alice""#);
    assert_eq!(shown(revoke_role("app_read", "alice", false, Some("ops_admin"))), r#"REVOKE "app_read" FROM "alice" GRANTED BY "ops_admin""#);
    assert_eq!(
        shown(revoke_role("app_read", "alice", true, Some("ops_admin"))),
        r#"REVOKE ADMIN OPTION FOR "app_read" FROM "alice" GRANTED BY "ops_admin""#
    );
}

// ───────────────────────── 객체 권한 ─────────────────────────

#[test]
fn granting_on_each_kind_of_object() {
    let cases = [
        (vec![Select, Insert], OnClause::Table("app", "orders"), r#"GRANT SELECT, INSERT ON TABLE "app"."orders" TO "app_read""#),
        // 목록은 `Privilege`의 선언 순서다(SELECT가 USAGE보다 앞). 브리프는 이 줄을 `USAGE, SELECT`로 적었지만 같은 브리프의 순서 규칙과 맞지 않아 규칙을 따랐다
        (vec![Usage, Select], OnClause::Sequence("app", "orders_id_seq"), r#"GRANT SELECT, USAGE ON SEQUENCE "app"."orders_id_seq" TO "app_read""#),
        (vec![Execute], OnClause::Routine("app", "touch_order", "integer"), r#"GRANT EXECUTE ON ROUTINE "app"."touch_order"(integer) TO "app_read""#),
        (vec![Usage], OnClause::Schema("app"), r#"GRANT USAGE ON SCHEMA "app" TO "app_read""#),
        (vec![Connect, Temporary], OnClause::Database("orders"), r#"GRANT CONNECT, TEMPORARY ON DATABASE "orders" TO "app_read""#),
        (vec![Select], OnClause::AllTables("app"), r#"GRANT SELECT ON ALL TABLES IN SCHEMA "app" TO "app_read""#),
        (vec![Select, Usage], OnClause::AllSequences("app"), r#"GRANT SELECT, USAGE ON ALL SEQUENCES IN SCHEMA "app" TO "app_read""#),
    ];
    for (privileges, on, expected) in cases {
        assert_eq!(shown(grant_privileges(&privileges, &on, "app_read")), expected);
    }
}

#[test]
fn revoking_from_a_role_and_from_public() {
    assert_eq!(
        shown(revoke_privileges(&[Select, Insert], &OnClause::Table("app", "orders"), "app_read")),
        r#"REVOKE SELECT, INSERT ON TABLE "app"."orders" FROM "app_read""#
    );
    assert_eq!(shown(revoke_privileges(&[Select], &OnClause::AllSequences("app"), "PUBLIC")), r#"REVOKE SELECT ON ALL SEQUENCES IN SCHEMA "app" FROM PUBLIC"#);
    assert_eq!(shown(grant_privileges(&[Connect], &OnClause::Database("orders"), "PUBLIC")), r#"GRANT CONNECT ON DATABASE "orders" TO PUBLIC"#);
}

#[test]
fn a_privilege_list_is_in_the_order_of_the_enum_whatever_order_it_is_passed_in() {
    let on = OnClause::Table("app", "orders");
    let wanted = r#"GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "app"."orders" TO "app_read""#;
    for order in [[Select, Insert, Update, Delete], [Delete, Update, Insert, Select], [Update, Select, Delete, Insert]] {
        assert_eq!(shown(grant_privileges(&order, &on, "app_read")), wanted, "{order:?}");
    }
    // 같은 권한을 두 번 적어도 한 번만 나온다
    assert_eq!(shown(grant_privileges(&[Insert, Select, Insert], &on, "app_read")), r#"GRANT SELECT, INSERT ON TABLE "app"."orders" TO "app_read""#);
    // 객체 종류가 섞인 권한은 선언 순서대로 늘어선다: ... EXECUTE, USAGE, CREATE, CONNECT, TEMPORARY
    assert_eq!(
        shown(grant_privileges(&[Temporary, Connect, Create, Usage, Execute, Select], &OnClause::Schema("app"), "g")),
        r#"GRANT SELECT, EXECUTE, USAGE, CREATE, CONNECT, TEMPORARY ON SCHEMA "app" TO "g""#
    );
}

#[test]
fn a_function_signature_is_written_as_the_server_printed_it() {
    let touch = |signature: &str| shown(grant_privileges(&[Execute], &OnClause::Routine("app", "touch", signature), "app_read"));
    assert_eq!(touch("order_id integer"), r#"GRANT EXECUTE ON ROUTINE "app"."touch"(order_id integer) TO "app_read""#);
    assert_eq!(touch("a integer, b text"), r#"GRANT EXECUTE ON ROUTINE "app"."touch"(a integer, b text) TO "app_read""#);
    assert_eq!(touch(""), r#"GRANT EXECUTE ON ROUTINE "app"."touch"() TO "app_read""#);
}

// ───────────────────────── 기본 권한 ─────────────────────────

#[test]
fn altering_default_privileges() {
    assert_eq!(
        shown(alter_default_privileges("app_owner", Some("app"), true, &[Select], DefaultObjType::Tables, "app_read")),
        r#"ALTER DEFAULT PRIVILEGES FOR ROLE "app_owner" IN SCHEMA "app" GRANT SELECT ON TABLES TO "app_read""#
    );
    assert_eq!(
        shown(alter_default_privileges("app_owner", None, false, &[Execute], DefaultObjType::Functions, "PUBLIC")),
        r#"ALTER DEFAULT PRIVILEGES FOR ROLE "app_owner" REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC"#
    );
}

#[test]
fn each_object_type_of_a_default_privilege_has_its_keyword() {
    let each = [
        (DefaultObjType::Tables, Select, "TABLES"),
        (DefaultObjType::Sequences, Usage, "SEQUENCES"),
        (DefaultObjType::Functions, Execute, "FUNCTIONS"),
        (DefaultObjType::Types, Usage, "TYPES"),
        (DefaultObjType::Schemas, Create, "SCHEMAS"),
    ];
    for (object_type, privilege, keyword) in each {
        let grant = alter_default_privileges("app_owner", None, true, &[privilege], object_type, "app_read");
        assert_eq!(shown(grant), format!("ALTER DEFAULT PRIVILEGES FOR ROLE \"app_owner\" GRANT {} ON {keyword} TO \"app_read\"", privilege.as_str()));
        let revoke = alter_default_privileges("app_owner", None, false, &[privilege], object_type, "app_read");
        assert_eq!(shown(revoke), format!("ALTER DEFAULT PRIVILEGES FOR ROLE \"app_owner\" REVOKE {} ON {keyword} FROM \"app_read\"", privilege.as_str()));
    }
}

#[test]
fn default_privileges_list_their_privileges_in_the_order_of_the_enum() {
    assert_eq!(
        shown(alter_default_privileges("app_owner", Some("app"), true, &[Delete, Select, Update, Insert], DefaultObjType::Tables, "app_rw")),
        r#"ALTER DEFAULT PRIVILEGES FOR ROLE "app_owner" IN SCHEMA "app" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "app_rw""#
    );
}

// ───────────────────────── 세션, 소유권 ─────────────────────────

#[test]
fn ending_a_session_checks_the_pid_the_role_and_the_start_second() {
    let with_start = terminate(12345, "bob", Some("2026-10-28T12:00:00Z"));
    assert_eq!(
        with_start.shown(),
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = 12345 AND usename = 'bob' AND date_trunc('second', backend_start) = '2026-10-28T12:00:00Z'::timestamptz"
    );
    assert_eq!(terminate(12345, "bob", None).shown(), "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = 12345 AND usename = 'bob'");
}

#[test]
fn a_session_statement_that_finds_no_row_has_its_own_error_text() {
    assert_eq!(terminate(1, "bob", None).expect, Some("세션이 이미 끝났어요"));
    assert_eq!(terminate(1, "bob", Some("2026-10-28T12:00:00Z")).expect, Some("세션이 이미 끝났어요"));
}

#[test]
fn only_ending_a_session_expects_a_row() {
    let others = [
        create_role("a", true, true, -1, None),
        alter_role("a", &[AttrClause::Login(true)]),
        alter_role_password("a"),
        drop_role("a"),
        grant_role("g", "m", false, false),
        revoke_role("g", "m", false, None),
        grant_privileges(&[Select], &OnClause::AllTables("s"), "g"),
        revoke_privileges(&[Select], &OnClause::AllTables("s"), "g"),
        alter_default_privileges("c", None, true, &[Select], DefaultObjType::Tables, "g"),
        reassign_owned("a", "b"),
        drop_owned("a"),
    ];
    for statement in others {
        assert_eq!(statement.expect, None, "{}", statement.shown());
    }
}

#[test]
fn handing_over_and_dropping_what_a_role_owns() {
    assert_eq!(shown(reassign_owned("alice", "iam_admin")), r#"REASSIGN OWNED BY "alice" TO "iam_admin""#);
    assert_eq!(shown(drop_owned("alice")), r#"DROP OWNED BY "alice""#);
}

// ───────────────────────── 비밀번호 자리 ─────────────────────────

#[test]
fn running_a_statement_puts_the_hash_where_the_slot_was() {
    let hash = NewPassword::generate().scram();
    let create = create_role("alice", true, true, 5, Some("2027-01-01T00:00:00Z"));
    assert_eq!(create.run(Some(&hash)), format!(r#"CREATE ROLE "alice" LOGIN PASSWORD {} CONNECTION LIMIT 5 VALID UNTIL '2027-01-01T00:00:00Z'"#, hash.sql_literal()));
    assert_eq!(alter_role_password("alice").run(Some(&hash)), format!(r#"ALTER ROLE "alice" PASSWORD {}"#, hash.sql_literal()));
    // 보여 주는 글에는 검증값이 없다
    assert!(!create.shown().contains("SCRAM-SHA-256"));
}

#[test]
fn a_role_named_like_the_mask_keeps_its_name_when_shown_and_when_run() {
    let name = "x PASSWORD '••••••••'";
    let hash = NewPassword::generate().scram();
    let create = create_role(name, true, true, -1, None);
    assert_eq!(create.shown(), r#"CREATE ROLE "x PASSWORD '••••••••'" LOGIN PASSWORD '••••••••'"#);
    assert_eq!(create.run(Some(&hash)), format!(r#"CREATE ROLE "x PASSWORD '••••••••'" LOGIN PASSWORD {}"#, hash.sql_literal()));
    let alter = alter_role_password(name);
    assert_eq!(alter.shown(), r#"ALTER ROLE "x PASSWORD '••••••••'" PASSWORD '••••••••'"#);
    assert_eq!(alter.run(Some(&hash)), format!(r#"ALTER ROLE "x PASSWORD '••••••••'" PASSWORD {}"#, hash.sql_literal()));
}

#[test]
fn a_statement_without_a_password_slot_runs_as_it_is_shown_with_or_without_a_hash() {
    let hash = NewPassword::generate().scram();
    for statement in [drop_role("alice"), create_role("g", false, false, -1, None), terminate(7, "bob", None)] {
        assert_eq!(statement.run(None), statement.shown());
        assert_eq!(statement.run(Some(&hash)), statement.shown());
    }
}

#[test]
#[should_panic(expected = "검증값")]
fn running_a_password_slot_without_a_hash_is_a_bug_and_panics() {
    let _ = alter_role_password("alice").run(None);
}

#[test]
fn a_statement_is_cut_into_parts_around_the_password_slot_and_never_into_empty_ones() {
    assert_eq!(alter_role_password("alice").parts, [Part::Text(r#"ALTER ROLE "alice" "#.into()), Part::Password]);
    assert_eq!(
        create_role("alice", true, true, 5, None).parts,
        [Part::Text(r#"CREATE ROLE "alice" LOGIN "#.into()), Part::Password, Part::Text(" CONNECTION LIMIT 5".into())]
    );
    assert_eq!(create_role("alice", true, true, -1, None).parts, [Part::Text(r#"CREATE ROLE "alice" LOGIN "#.into()), Part::Password]);
    assert_eq!(drop_role("alice").parts, [Part::Text(r#"DROP ROLE "alice""#.into())]);
}

// ───────────────────────── 하나뿐인 따옴표 길 ─────────────────────────

/// 이름 자리마다 `NASTY_NAME`을, 값 자리마다 `NASTY_VALUE`를 넣은 문장들
fn statements_with_nasty_input() -> Vec<Statement> {
    let (n, v) = (NASTY_NAME, NASTY_VALUE);
    vec![
        create_role(n, true, true, 5, Some(v)),
        alter_role(n, &[AttrClause::ValidUntil(Some(v.into()))]),
        alter_role_password(n),
        drop_role(n),
        grant_role(n, n, true, true),
        revoke_role(n, n, true, Some(n)),
        grant_privileges(&[Select], &OnClause::Table(n, n), n),
        grant_privileges(&[Usage], &OnClause::Sequence(n, n), n),
        grant_privileges(&[Execute], &OnClause::AllTables(n), n),
        grant_privileges(&[Usage], &OnClause::Schema(n), n),
        grant_privileges(&[Connect], &OnClause::Database(n), n),
        revoke_privileges(&[Usage], &OnClause::AllSequences(n), n),
        alter_default_privileges(n, Some(n), true, &[Select], DefaultObjType::Tables, n),
        terminate(1, v, Some(v)),
        reassign_owned(n, n),
        drop_owned(n),
    ]
}

#[test]
fn a_name_that_tries_to_break_out_of_its_quotes_stays_inside_them_in_every_statement() {
    let quoted = crate::pg::sql::ident(NASTY_NAME);
    for statement in statements_with_nasty_input() {
        let text = statement.shown();
        if statement.expect.is_none() {
            assert!(text.contains(&quoted), "{text}");
        }
        assert!(!text.contains(NASTY_NAME), "따옴표가 두 겹이 아니에요: {text}");
    }
}

#[test]
fn a_value_that_tries_to_break_out_of_its_quotes_stays_inside_them() {
    let quoted = crate::pg::sql::literal(NASTY_VALUE);
    for text in [
        create_role("a", true, false, -1, Some(NASTY_VALUE)).shown(),
        alter_role("a", &[AttrClause::ValidUntil(Some(NASTY_VALUE.into()))]).shown(),
        terminate(1, NASTY_VALUE, Some(NASTY_VALUE)).shown(),
    ] {
        assert!(text.contains(&quoted), "{text}");
        assert!(!text.contains(NASTY_VALUE), "{text}");
    }
}
