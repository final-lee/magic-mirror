use super::*;
use crate::pg::change::model::{AttributesSet, GrantItem, PresetChoice, PresetKind};
use crate::pg::model::{DefaultObjType, Privilege};

fn relation(schema: &str, name: &str) -> GrantTarget {
    GrantTarget::Relation { schema: schema.into(), name: name.into() }
}

fn item(target: GrantTarget, privileges: &[Privilege]) -> GrantItem {
    GrantItem { target, privileges: privileges.to_vec() }
}

fn grant(grantee: &str, add: bool, items: Vec<GrantItem>) -> PgChange {
    PgChange::Grant { database: "appdb".into(), grantee: grantee.into(), add, items }
}

fn membership(add: bool, admin: bool) -> PgChange {
    PgChange::Membership { group: "app_read".into(), member: "alice".into(), add, admin }
}

fn default_privilege(grantee: &str, add: bool) -> PgChange {
    PgChange::DefaultPrivilege {
        database: "appdb".into(),
        creator: "app_owner".into(),
        schema: Some("app".into()),
        object_type: DefaultObjType::Tables,
        grantee: grantee.into(),
        privileges: vec![Privilege::Select],
        add,
    }
}

// ───────────────────────── 요약 ─────────────────────────

#[test]
fn creating_a_role_names_it() {
    let plain = PgChange::CreateRole { name: "alice".into(), login: true, groups: vec![], connection_limit: -1, valid_until: None, preset: None };
    assert_eq!(summary(&plain), "역할 만들기: alice");
    // 프리셋이 있어도 같은 요약이다
    let preset = PresetChoice { preset: PresetKind::ReadOnly, database: Some("appdb".into()), schemas: vec!["app".into()], creators: vec![], group: None, create_group: false };
    let with_preset = PgChange::CreateRole { name: "alice".into(), login: true, groups: vec!["app_read".into()], connection_limit: 5, valid_until: None, preset: Some(preset) };
    assert_eq!(summary(&with_preset), "역할 만들기: alice");
}

#[test]
fn a_membership_change_reads_member_arrow_group() {
    assert_eq!(summary(&membership(true, false)), "그룹에 넣기: alice → app_read");
    assert_eq!(summary(&membership(false, false)), "그룹에서 빼기: alice → app_read");
}

#[test]
fn a_membership_change_that_is_about_the_admin_option_says_so() {
    assert_eq!(summary(&membership(true, true)), "ADMIN OPTION 주기: alice → app_read");
    assert_eq!(summary(&membership(false, true)), "ADMIN OPTION 빼기: alice → app_read");
}

#[test]
fn attributes_a_password_and_a_drop_name_the_role() {
    let set = AttributesSet { login: true, create_db: false, create_role: false, inherit: true, connection_limit: -1, valid_until: None };
    assert_eq!(summary(&PgChange::Attributes { role: "alice".into(), set }), "속성 바꾸기: alice");
    assert_eq!(summary(&PgChange::Password { role: "alice".into() }), "비밀번호 재설정: alice");
    assert_eq!(summary(&PgChange::DropRole { role: "alice".into() }), "역할 삭제: alice");
}

#[test]
fn a_grant_of_one_item_names_the_object_and_its_privileges() {
    let all_tables = grant("app_read", true, vec![item(GrantTarget::AllTables { schema: "app".into() }, &[Privilege::Select])]);
    assert_eq!(summary(&all_tables), "권한 주기: app_read · app 스키마의 모든 테이블 SELECT");
    let connect = grant("PUBLIC", false, vec![item(GrantTarget::Database { name: "orders".into() }, &[Privilege::Connect])]);
    assert_eq!(summary(&connect), "권한 빼기: 모든 역할(PUBLIC) · 데이터베이스 orders CONNECT");
}

#[test]
fn the_privileges_of_a_grant_are_joined_in_the_order_of_the_enum_once_each() {
    let both = grant("app_read", true, vec![item(relation("app", "orders"), &[Privilege::Insert, Privilege::Select, Privilege::Insert])]);
    assert_eq!(summary(&both), "권한 주기: app_read · app.orders SELECT, INSERT");
}

#[test]
fn a_grant_of_several_items_counts_the_objects() {
    let three = grant(
        "app_read",
        true,
        vec![
            item(relation("app", "orders"), &[Privilege::Select]),
            item(GrantTarget::Schema { name: "app".into() }, &[Privilege::Usage]),
            item(GrantTarget::Database { name: "appdb".into() }, &[Privilege::Connect]),
        ],
    );
    assert_eq!(summary(&three), "권한 주기: app_read · 객체 3개");
    let two = grant("PUBLIC", false, vec![item(relation("app", "a"), &[Privilege::Select]), item(relation("app", "b"), &[Privilege::Select])]);
    assert_eq!(summary(&two), "권한 빼기: 모든 역할(PUBLIC) · 객체 2개");
}

#[test]
fn a_default_privilege_reads_creator_arrow_grantee() {
    assert_eq!(summary(&default_privilege("app_read", true)), "기본 권한 주기: app_owner → app_read");
    assert_eq!(summary(&default_privilege("PUBLIC", false)), "기본 권한 빼기: app_owner → 모든 역할(PUBLIC)");
}

#[test]
fn ending_a_session_names_the_role_and_the_pid() {
    let change = PgChange::Terminate { pid: 4242, role: "bob".into(), backend_start: Some("2026-10-28T12:00:00Z".into()) };
    assert_eq!(summary(&change), "세션 끊기: bob (pid 4242)");
    let unknown_start = PgChange::Terminate { pid: 7, role: "bob".into(), backend_start: None };
    assert_eq!(summary(&unknown_start), "세션 끊기: bob (pid 7)");
}

// ───────────────────────── 이름표 ─────────────────────────

#[test]
fn every_kind_of_target_has_its_label() {
    let all = [
        (GrantTarget::Database { name: "orders".into() }, "데이터베이스 orders"),
        (GrantTarget::Schema { name: "app".into() }, "스키마 app"),
        (relation("app", "orders"), "app.orders"),
        (GrantTarget::Sequence { schema: "app".into(), name: "orders_id_seq".into() }, "app.orders_id_seq"),
        (GrantTarget::Function { schema: "app".into(), name: "touch".into(), signature: "order_id integer".into() }, "app.touch(order_id integer)"),
        (GrantTarget::Function { schema: "app".into(), name: "cleanup".into(), signature: String::new() }, "app.cleanup()"),
        (GrantTarget::AllTables { schema: "app".into() }, "app 스키마의 모든 테이블"),
        (GrantTarget::AllSequences { schema: "app".into() }, "app 스키마의 모든 시퀀스"),
    ];
    for (target, label) in all {
        assert_eq!(target_label(&target), label);
    }
}

#[test]
fn public_reads_as_every_role_and_other_names_stay() {
    assert_eq!(grantee_label("PUBLIC"), "모든 역할(PUBLIC)");
    assert_eq!(grantee_label("app_read"), "app_read");
    // 글자 그대로 PUBLIC일 때만이다
    assert_eq!(grantee_label("public"), "public");
}
