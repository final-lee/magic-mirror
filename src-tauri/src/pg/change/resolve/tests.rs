use super::*;
use crate::pg::change::model::{GrantTarget::*, PresetKind};
use crate::pg::fixtures::*;
use crate::pg::model::Privilege::{Connect, Create, Delete, Execute, Insert, Select, Temporary, Trigger, Truncate, Update, Usage};
use crate::pg::model::{DefaultAclRec, RelKind, SessionRec};

/// 앱이 `mm`으로 로그인한 장면. `mm`은 CREATEROLE이 있고 `app_owner`의 권한을 물려받는다(그래서 `app_owner`의 객체에 권한을 줄 수 있다)
fn admin(version: i32) -> Scene {
    let mm = RoleRec { create_role: true, ..login("mm") };
    let owner = if version >= PG16 { member_grants("mm", "app_owner", &[(BOOTSTRAP, false, Some(true), Some(true))]) } else { member("mm", "app_owner") };
    app_scene(version).add_role(mm).login_as("mm").add_member(owner)
}

/// 아무 권한도 없는 `mm`
fn plain(version: i32) -> Scene {
    app_scene(version).add_role(login("mm")).login_as("mm")
}

fn run(scene: &Scene, change: &PgChange) -> Resolved {
    resolve(&ResolveCtx { cluster: &scene.cluster, db: &scene.db, own_pids: &[], read_replica: false }, change)
}

fn sql(resolved: &Resolved) -> Vec<String> {
    resolved.statements.iter().map(Statement::shown).collect()
}

fn blocks(scene: &Scene, change: &PgChange) -> Vec<String> {
    run(scene, change).blocks
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

fn create(name: &str, login: bool, groups: &[&str], preset: Option<PresetChoice>) -> PgChange {
    PgChange::CreateRole { name: name.into(), login, groups: strings(groups), connection_limit: -1, valid_until: None, preset }
}

fn choice(preset: PresetKind, group: Option<&str>, create_group: bool) -> PresetChoice {
    PresetChoice {
        preset,
        database: Some("appdb".into()),
        schemas: strings(&["app"]),
        creators: strings(&["app_owner"]),
        group: group.map(Into::into),
        create_group,
    }
}

fn grant_change(grantee: &str, add: bool, items: Vec<GrantItem>) -> PgChange {
    PgChange::Grant { database: "appdb".into(), grantee: grantee.into(), add, items }
}

fn item(target: GrantTarget, privileges: &[Privilege]) -> GrantItem {
    GrantItem { target, privileges: privileges.to_vec() }
}

fn orders() -> GrantTarget {
    Relation { schema: "app".into(), name: "orders".into() }
}

fn membership(group: &str, member: &str, add: bool, admin: bool) -> PgChange {
    PgChange::Membership { group: group.into(), member: member.into(), add, admin }
}

fn default_change(creator: &str, schema: Option<&str>, object_type: DefaultObjType, grantee: &str, privileges: &[Privilege], add: bool) -> PgChange {
    PgChange::DefaultPrivilege {
        database: "appdb".into(),
        creator: creator.into(),
        schema: schema.map(Into::into),
        object_type,
        grantee: grantee.into(),
        privileges: privileges.to_vec(),
        add,
    }
}

// ───────────────────────── 7. 문장과 순서 ─────────────────────────

#[test]
fn a_read_only_preset_with_a_new_group_runs_in_the_documented_order() {
    for version in [PG15, PG16] {
        let s = admin(version).add_member(member_grants("mm", "app_write", &[(BOOTSTRAP, true, Some(false), Some(true))]));
        let change = create("alice2", true, &["app_write"], Some(choice(PresetKind::ReadOnly, Some("app_ro"), true)));
        let resolved = run(&s, &change);
        assert_eq!(resolved.blocks, Vec::<String>::new(), "{version}");
        assert_eq!(
            sql(&resolved),
            strings(&[
                r#"CREATE ROLE "app_ro" NOLOGIN"#,
                r#"CREATE ROLE "alice2" LOGIN PASSWORD '••••••••'"#,
                r#"GRANT CONNECT ON DATABASE "appdb" TO "app_ro""#,
                r#"GRANT USAGE ON SCHEMA "app" TO "app_ro""#,
                r#"GRANT SELECT ON ALL TABLES IN SCHEMA "app" TO "app_ro""#,
                r#"GRANT SELECT ON ALL SEQUENCES IN SCHEMA "app" TO "app_ro""#,
                r#"ALTER DEFAULT PRIVILEGES FOR ROLE "app_owner" IN SCHEMA "app" GRANT SELECT ON TABLES TO "app_ro""#,
                r#"ALTER DEFAULT PRIVILEGES FOR ROLE "app_owner" IN SCHEMA "app" GRANT SELECT ON SEQUENCES TO "app_ro""#,
                r#"GRANT "app_ro" TO "alice2""#,
                r#"GRANT "app_write" TO "alice2""#,
            ])
        );
        assert_eq!(resolved.ops.len(), resolved.statements.len());
    }
}

#[test]
fn a_read_write_preset_grants_writes_and_sequence_usage() {
    let resolved = run(&admin(PG16), &create("app_rw", false, &[], Some(choice(PresetKind::ReadWrite, None, false))));
    assert_eq!(resolved.blocks, Vec::<String>::new());
    assert_eq!(
        sql(&resolved),
        strings(&[
            r#"CREATE ROLE "app_rw" NOLOGIN"#,
            r#"GRANT CONNECT ON DATABASE "appdb" TO "app_rw""#,
            r#"GRANT USAGE ON SCHEMA "app" TO "app_rw""#,
            r#"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "app" TO "app_rw""#,
            r#"GRANT SELECT, USAGE ON ALL SEQUENCES IN SCHEMA "app" TO "app_rw""#,
            r#"ALTER DEFAULT PRIVILEGES FOR ROLE "app_owner" IN SCHEMA "app" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "app_rw""#,
            r#"ALTER DEFAULT PRIVILEGES FOR ROLE "app_owner" IN SCHEMA "app" GRANT SELECT, USAGE ON SEQUENCES TO "app_rw""#,
        ])
    );
}

#[test]
fn an_owner_preset_grants_connect_and_usage_create_with_no_defaults() {
    let resolved = run(&admin(PG16), &create("app_boss", false, &[], Some(choice(PresetKind::Owner, None, false))));
    assert_eq!(
        sql(&resolved),
        strings(&[r#"CREATE ROLE "app_boss" NOLOGIN"#, r#"GRANT CONNECT ON DATABASE "appdb" TO "app_boss""#, r#"GRANT USAGE, CREATE ON SCHEMA "app" TO "app_boss""#])
    );
    assert_eq!(resolved.blocks, Vec::<String>::new());
}

#[test]
fn an_admin_preset_only_joins_rds_superuser() {
    let s = admin(PG16).add_role(role("rds_superuser"));
    // rds_superuser에 구성원을 넣으려면 ADMIN OPTION이 있어야 한다
    let s = s.add_member(member_grants("mm", "rds_superuser", &[(BOOTSTRAP, true, Some(false), Some(true))]));
    let preset = PresetChoice { preset: PresetKind::Admin, database: None, schemas: vec![], creators: vec![], group: None, create_group: false };
    let resolved = run(&s, &create("dba2", true, &[], Some(preset)));
    assert_eq!(resolved.blocks, Vec::<String>::new());
    assert_eq!(sql(&resolved), strings(&[r#"CREATE ROLE "dba2" LOGIN PASSWORD '••••••••'"#, r#"GRANT "rds_superuser" TO "dba2""#]));
}

#[test]
fn a_group_with_a_preset_takes_the_grants_itself_and_an_existing_group_only_gets_the_membership() {
    let resolved = run(&admin(PG16), &create("app_ro2", false, &[], Some(choice(PresetKind::ReadOnly, None, false))));
    assert_eq!(sql(&resolved)[1], r#"GRANT CONNECT ON DATABASE "appdb" TO "app_ro2""#);
    let existing = run(&admin(PG16), &create("alice2", true, &[], Some(choice(PresetKind::ReadOnly, Some("app_read"), false))));
    // 구성원 관계를 만들려면 app_read의 ADMIN이 필요하다. 이 장면의 mm에는 없다
    assert_eq!(sql(&existing), strings(&[r#"CREATE ROLE "alice2" LOGIN PASSWORD '••••••••'"#, r#"GRANT "app_read" TO "alice2""#]));
    assert_eq!(existing.blocks.len(), 1);
}

#[test]
fn attributes_emit_only_the_clauses_that_differ() {
    let mut s = plain(PG15);
    s.role_mut("mm").create_role = true;
    let set = |login: bool, db: bool, limit: i32| PgChange::Attributes {
        role: "alice".into(),
        set: AttributesSet { login, create_db: db, create_role: false, inherit: true, connection_limit: limit, valid_until: None },
    };
    let resolved = run(&s, &set(true, true, 5));
    assert_eq!(sql(&resolved), strings(&[r#"ALTER ROLE "alice" CREATEDB CONNECTION LIMIT 5"#]));
    assert_eq!(resolved.blocks, Vec::<String>::new());
    let nothing = run(&s, &set(true, false, -1));
    assert!(nothing.statements.is_empty() && nothing.ops.is_empty() && nothing.blocks.is_empty());
}

#[test]
fn an_expiry_equal_to_the_snapshots_is_not_a_difference() {
    let mut s = plain(PG15);
    s.role_mut("mm").create_role = true;
    s.role_mut("alice").valid_until = Some("2027-01-01T00:00:00Z".into());
    let set = |until: Option<&str>| PgChange::Attributes {
        role: "alice".into(),
        set: AttributesSet { login: true, create_db: false, create_role: false, inherit: true, connection_limit: -1, valid_until: until.map(Into::into) },
    };
    assert!(run(&s, &set(Some("2027-01-01T00:00:00.000Z"))).statements.is_empty());
    assert_eq!(sql(&run(&s, &set(None))), strings(&[r#"ALTER ROLE "alice" VALID UNTIL 'infinity'"#]));
}

/// 앱이 `mm`으로 로그인했고 `app_read`와 `app_write`의 ADMIN OPTION이 있다
fn group_admin(version: i32) -> Scene {
    let mut s = plain(version);
    for group in ["app_read", "app_write"] {
        s = s.add_member(if version >= PG16 {
            member_grants("mm", group, &[(BOOTSTRAP, true, Some(false), Some(true))])
        } else {
            member_grants("mm", group, &[(BOOTSTRAP, true, None, None)])
        });
    }
    s
}

#[test]
fn membership_statements_follow_add_and_admin() {
    for version in [PG15, PG16] {
        let s = group_admin(version);
        let add = run(&s, &membership("app_read", "carol", true, false));
        assert_eq!(sql(&add), strings(&[r#"GRANT "app_read" TO "carol""#]), "{version}");
        assert_eq!(add.blocks, Vec::<String>::new());
        let admin_grant = run(&s, &membership("app_read", "bob", true, true));
        assert_eq!(sql(&admin_grant), strings(&[r#"GRANT "app_read" TO "bob" WITH ADMIN OPTION"#]));
        // 이미 있는 구성원 관계를 또 넣는 것은 할 일이 없다. 160000부터는 부여자마다 줄이 따로라서 내가 준 줄이 있을 때만 그렇다
        let granted = s.clone().add_member(if version >= PG16 {
            member_grants("bob", "app_read", &[(BOOTSTRAP, false, Some(false), Some(true)), ("mm", false, Some(false), Some(true))])
        } else {
            member("bob", "app_read")
        });
        assert!(run(&granted, &membership("app_read", "bob", true, false)).statements.is_empty(), "{version}");
        if version >= PG16 {
            assert_eq!(sql(&run(&s, &membership("app_read", "bob", true, false))), strings(&[r#"GRANT "app_read" TO "bob""#]));
        }
    }
}

#[test]
fn membership_revokes_name_their_rows_from_160000_and_are_plain_before() {
    let old = group_admin(PG15);
    let r = run(&old, &membership("app_read", "bob", false, false));
    assert_eq!(sql(&r), strings(&[r#"REVOKE "app_read" FROM "bob""#]));
    let r = run(&old.clone().add_member(member_grants("bob", "app_read", &[("mm", true, None, None)])), &membership("app_read", "bob", false, true));
    assert_eq!(sql(&r), strings(&[r#"REVOKE ADMIN OPTION FOR "app_read" FROM "bob""#]));

    // 160000: mm이 ADMIN을 가졌지만 bob의 부여는 부트스트랩이 한 것이라 mm이 그 부여자의 권한을 갖지 못하면 거둘 수 없다
    let s = group_admin(PG16);
    let r = run(&s, &membership("app_read", "bob", false, false));
    assert_eq!(r.statements.len(), 0);
    assert_eq!(r.blocks, strings(&["bob 역할을 app_read 역할에서 뺄 수 없어요. 이 구성원 관계는 rdsadmin 역할이 줬어요"]));
    // mm이 직접 준 부여는 GRANTED BY로 거둔다. 다른 부여자의 줄은 남는다
    let s = s.add_member(member_grants("bob", "app_read", &[(BOOTSTRAP, false, Some(false), Some(true)), ("mm", false, Some(false), Some(true))]));
    let r = run(&s, &membership("app_read", "bob", false, false));
    assert_eq!(sql(&r), strings(&[r#"REVOKE "app_read" FROM "bob" GRANTED BY "mm""#]));
    assert_eq!(r.blocks, Vec::<String>::new());
    assert_eq!(r.memberships_stay, strings(&["rdsadmin"]));
    // ADMIN만 거두는 요청은 ADMIN이 있는 줄만 본다
    let s = s.add_member(member_grants("bob", "app_read", &[(BOOTSTRAP, true, Some(false), Some(true)), ("mm", false, Some(false), Some(true))]));
    let r = run(&s, &membership("app_read", "bob", false, true));
    assert_eq!(r.statements.len(), 0);
    assert_eq!(r.blocks.len(), 1);
}

#[test]
fn a_superuser_login_names_the_row_grantor_of_every_revoke() {
    let mut s = plain(PG16).add_member(member_grants("bob", "app_read", &[(BOOTSTRAP, false, Some(false), Some(true))]));
    s.role_mut("mm").superuser = true;
    let r = run(&s, &membership("app_read", "bob", false, false));
    assert_eq!(sql(&r), strings(&[r#"REVOKE "app_read" FROM "bob" GRANTED BY "rdsadmin""#]));
}

#[test]
fn removing_a_dependent_admin_membership_is_blocked() {
    // mgr는 app_read에 ADMIN을 갖고 mm이 줬다. mgr가 bob에게 app_read를 줬다. mgr의 ADMIN을 거두면 bob의 부여가 근거를 잃는다
    let s = plain(PG16)
        .add_role(role("mgr"))
        .add_member(member_grants("mm", "app_read", &[(BOOTSTRAP, true, Some(true), Some(true))]))
        .add_member(member_grants("mgr", "app_read", &[("mm", true, Some(false), Some(true))]))
        .add_member(member_grants("bob", "app_read", &[("mgr", false, Some(false), Some(true))]));
    let text = "mgr 역할이 app_read 역할을 다른 역할에 줬어요. 그 구성원 관계부터 빼야 해요";
    assert_eq!(blocks(&s, &membership("app_read", "mgr", false, true)), strings(&[text]));
    assert_eq!(blocks(&s, &membership("app_read", "mgr", false, false)), strings(&[text]));
    // mgr에게 다른 ADMIN 줄이 남으면 괜찮다
    let s = s.add_member(member_grants("mgr", "app_read", &[("mm", true, Some(false), Some(true)), (BOOTSTRAP, true, Some(false), Some(true))]));
    // mm은 부트스트랩의 부여자 권한이 없어 그 줄을 못 거둔다: 거둘 줄은 mm의 것 하나뿐이고 mgr의 ADMIN은 부트스트랩 줄이 남는다
    assert_eq!(blocks(&s, &membership("app_read", "mgr", false, true)), Vec::<String>::new());
}

#[test]
fn a_grant_statement_per_item_uses_the_items_target() {
    let s = admin(PG16);
    let items = vec![
        item(Database { name: "appdb".into() }, &[Connect]),
        item(Schema { name: "app".into() }, &[Create, Usage]),
        item(orders(), &[Update, Select]),
        item(Sequence { schema: "app".into(), name: "ticket_seq".into() }, &[Usage]),
        item(Function { schema: "app".into(), name: "touch".into(), signature: "order_id integer".into() }, &[Execute]),
        item(AllTables { schema: "app".into() }, &[Select]),
        item(AllSequences { schema: "app".into() }, &[Select]),
    ];
    let r = run(&s, &grant_change("alice", true, items));
    assert_eq!(r.blocks, Vec::<String>::new());
    assert_eq!(
        sql(&r),
        strings(&[
            r#"GRANT CONNECT ON DATABASE "appdb" TO "alice""#,
            r#"GRANT USAGE, CREATE ON SCHEMA "app" TO "alice""#,
            r#"GRANT SELECT, UPDATE ON TABLE "app"."orders" TO "alice""#,
            r#"GRANT USAGE ON SEQUENCE "app"."ticket_seq" TO "alice""#,
            r#"GRANT EXECUTE ON ROUTINE "app"."touch"(order_id integer) TO "alice""#,
            r#"GRANT SELECT ON ALL TABLES IN SCHEMA "app" TO "alice""#,
            r#"GRANT SELECT ON ALL SEQUENCES IN SCHEMA "app" TO "alice""#,
        ])
    );
}

#[test]
fn all_tables_expands_to_every_table_like_relation_and_all_sequences_to_sequences() {
    let mut s = admin(PG16);
    s.db.relations.push(crate::pg::fixtures::relation(RelKind::Sequence, "app", "other_seq", "app_owner"));
    let r = run(&s, &grant_change("alice", true, vec![item(AllTables { schema: "app".into() }, &[Select]), item(AllSequences { schema: "app".into() }, &[Usage])]));
    let effect_objects: Vec<Vec<String>> = r
        .ops
        .iter()
        .map(|op| match op {
            Op::Privileges { effects, .. } => effects.iter().map(|e| e.object.label()).collect(),
            _ => unreachable!(),
        })
        .collect();
    // 테이블 둘, 뷰, 구체화 뷰(시퀀스는 아니다)
    assert_eq!(effect_objects[0], strings(&["app.customers", "app.order_summary", "app.order_totals", "app.orders"]));
    assert_eq!(effect_objects[1], strings(&["app.other_seq", "app.ticket_seq"]));
    let Op::Privileges { effects, .. } = &r.ops[0] else { unreachable!() };
    assert!(effects.iter().all(|e| e.grantor == "app_owner" && e.privilege == Select));
}

#[test]
fn a_revoke_effect_lists_only_entries_of_the_predicted_grantor() {
    let s = admin(PG16);
    let r = run(&s, &grant_change("app_write", false, vec![item(orders(), &[Insert, Update, Delete])]));
    assert_eq!(sql(&r), strings(&[r#"REVOKE INSERT, UPDATE, DELETE ON TABLE "app"."orders" FROM "app_write""#]));
    let Op::Privileges { effects, add, .. } = &r.ops[0] else { unreachable!() };
    assert!(!add);
    let got: Vec<(String, Privilege, String)> = effects.iter().map(|e| (e.object.label(), e.privilege, e.grantor.clone())).collect();
    assert_eq!(got, vec![("app.orders".to_string(), Insert, "app_owner".to_string()), ("app.orders".to_string(), Update, "app_owner".to_string())]);
}

// ───────────────────────── 8. 막힘 ─────────────────────────

#[test]
fn a_read_replica_blocks_every_change_but_the_sql_is_still_built() {
    let s = admin(PG16);
    let r = resolve(&ResolveCtx { cluster: &s.cluster, db: &s.db, own_pids: &[], read_replica: true }, &membership("app_read", "carol", true, false));
    assert!(r.blocks.contains(&"읽기 전용 복제본이라 바꿀 수 없어요".to_string()));
    assert_eq!(sql(&r), strings(&[r#"GRANT "app_read" TO "carol""#]));
}

#[test]
fn system_roles_are_not_changed_and_system_groups_outside_the_list_get_no_members() {
    let s = admin(PG16).add_role(role("rds_superuser")).add_role(role("rds_ad")).add_role(role("pg_execute_server_program")).add_role(role("rdsadmin"));
    let attributes = |role: &str| PgChange::Attributes {
        role: role.into(),
        set: AttributesSet { login: true, create_db: false, create_role: false, inherit: true, connection_limit: 3, valid_until: None },
    };
    assert_eq!(blocks(&s, &attributes("rds_superuser")), strings(&["시스템 역할이라 바꿀 수 없어요: rds_superuser"]));
    assert_eq!(blocks(&s, &PgChange::Password { role: "rdsadmin".into() }), strings(&["시스템 역할이라 바꿀 수 없어요: rdsadmin"]));
    assert_eq!(blocks(&s, &PgChange::DropRole { role: "rds_ad".into() })[0], "시스템 역할이라 바꿀 수 없어요: rds_ad");
    assert!(blocks(&s, &membership("pg_execute_server_program", "alice", true, false)).contains(&"이 시스템 역할에는 구성원을 넣거나 뺄 수 없어요: pg_execute_server_program".to_string()));
    assert!(blocks(&s, &membership("rds_ad", "alice", true, false)).contains(&"이 시스템 역할에는 구성원을 넣거나 뺄 수 없어요: rds_ad".to_string()));
    // 목록에 있는 시스템 그룹은 열려 있다(권한은 따로 본다)
    assert!(!blocks(&s, &membership("rds_superuser", "alice", true, false)).iter().any(|b| b.contains("시스템 역할에는")));
    // 시스템 역할을 구성원으로 넣는 것도 막는다
    assert!(blocks(&s, &membership("app_read", "rds_ad", true, false)).contains(&"시스템 역할이라 바꿀 수 없어요: rds_ad".to_string()));
}

#[test]
fn membership_rights_block_with_the_documented_text() {
    for (version, text) in [
        (PG15, "app_read 역할의 구성원을 바꿀 권한이 없어요. CREATEROLE이나 app_read 역할에 대한 ADMIN OPTION이 있어야 해요"),
        (PG16, "app_read 역할의 구성원을 바꿀 권한이 없어요. app_read 역할에 대한 ADMIN OPTION이 있어야 해요"),
    ] {
        let r = run(&plain(version), &membership("app_read", "carol", true, false));
        assert_eq!(r.blocks, strings(&[text]));
        // 막혀도 문장은 보여 준다
        assert_eq!(sql(&r), strings(&[r#"GRANT "app_read" TO "carol""#]));
    }
}

#[test]
fn alter_password_create_and_terminate_rights_block() {
    let alter = PgChange::Attributes {
        role: "alice".into(),
        set: AttributesSet { login: false, create_db: false, create_role: false, inherit: true, connection_limit: -1, valid_until: None },
    };
    assert_eq!(blocks(&plain(PG15), &alter), strings(&["alice 역할을 바꿀 권한이 없어요. CREATEROLE이 있어야 해요"]));
    assert_eq!(blocks(&plain(PG16), &alter), strings(&["alice 역할을 바꿀 권한이 없어요. CREATEROLE과 이 역할에 대한 ADMIN OPTION이 있어야 해요"]));
    assert_eq!(blocks(&plain(PG16), &PgChange::Password { role: "alice".into() }), strings(&["alice 역할을 바꿀 권한이 없어요. CREATEROLE과 이 역할에 대한 ADMIN OPTION이 있어야 해요"]));
    assert_eq!(blocks(&plain(PG16), &create("zed", false, &[], None)), strings(&["역할을 만들 권한이 없어요. CREATEROLE이 있어야 해요"]));
    let terminate = PgChange::Terminate { pid: 77, role: "alice".into(), backend_start: None };
    assert_eq!(blocks(&plain(PG16), &terminate), strings(&["이 세션을 끊을 권한이 없어요. pg_signal_backend 권한이 있어야 해요"]));
}

#[test]
fn restricted_password_commands_block_a_login_create_a_password_and_an_expiry() {
    let text = "비밀번호나 만료일을 바꾸려면 로그인한 역할이 rds_password 구성원이어야 해요(rds.restrict_password_commands가 켜져 있어요)";
    let mut s = admin(PG16);
    s.cluster.restrict_password_commands = true;
    assert_eq!(blocks(&s, &create("zed", true, &[], None)), strings(&[text]));
    assert!(blocks(&s, &create("zed", false, &[], None)).is_empty());
    let mut with_expiry = create("zed", false, &[], None);
    if let PgChange::CreateRole { valid_until, .. } = &mut with_expiry {
        *valid_until = Some("2027-01-01T00:00:00Z".into());
    }
    assert_eq!(blocks(&s, &with_expiry), strings(&[text]));
    let s = s.add_member(member_grants("mm", "alice", &[(BOOTSTRAP, true, Some(false), Some(true))]));
    assert!(blocks(&s, &PgChange::Password { role: "alice".into() }).contains(&text.to_string()));
}

#[test]
fn terminate_blocks_the_apps_own_pid_and_superuser_sessions() {
    let mut s = admin(PG16).add_role(RoleRec { superuser: true, ..role("boss") });
    s.cluster.sessions.push(SessionRec {
        pid: 9,
        role: Some("boss".into()),
        database: Some("appdb".into()),
        client_addr: None,
        application_name: String::new(),
        state: None,
        backend_start: None,
        query_start: None,
        wait_event: None,
    });
    let change = |pid, role: &str| PgChange::Terminate { pid, role: role.into(), backend_start: None };
    let own = resolve(&ResolveCtx { cluster: &s.cluster, db: &s.db, own_pids: &[5], read_replica: false }, &change(5, "alice"));
    assert_eq!(own.blocks, strings(&["이 앱의 세션은 끊을 수 없어요"]));
    assert_eq!(blocks(&s, &change(9, "boss")), strings(&["superuser 세션은 끊을 수 없어요: boss"]));
    let ok = run(&s.clone().add_member(member("mm", "alice")), &change(7, "alice"));
    assert_eq!(ok.blocks, Vec::<String>::new());
    assert_eq!(sql(&ok), strings(&["SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = 7 AND usename = 'alice'"]));
}

#[test]
fn unknown_roles_objects_and_wrong_privileges_block() {
    let s = admin(PG16);
    assert_eq!(blocks(&s, &membership("app_read", "nobody", true, false)), strings(&["역할을 찾을 수 없어요: nobody"]));
    assert_eq!(blocks(&s, &PgChange::Password { role: "nobody".into() }), strings(&["역할을 찾을 수 없어요: nobody"]));
    let missing = run(&s, &grant_change("alice", true, vec![item(Relation { schema: "app".into(), name: "nope".into() }, &[Select])]));
    assert_eq!(missing.blocks, strings(&["객체를 찾을 수 없어요: app.nope"]));
    // 시퀀스를 테이블로, 함수를 다른 인자 목록으로 가리키면 없는 객체다
    let wrong_kind = run(&s, &grant_change("alice", true, vec![item(Relation { schema: "app".into(), name: "ticket_seq".into() }, &[Select])]));
    assert_eq!(wrong_kind.blocks, strings(&["객체를 찾을 수 없어요: app.ticket_seq"]));
    let wrong_signature = run(&s, &grant_change("alice", true, vec![item(Function { schema: "app".into(), name: "touch".into(), signature: "x text".into() }, &[Execute])]));
    assert_eq!(wrong_signature.blocks, strings(&["객체를 찾을 수 없어요: app.touch(x text)"]));
    let unknown_schema = run(&s, &grant_change("alice", true, vec![item(AllTables { schema: "nope".into() }, &[Select])]));
    assert_eq!(unknown_schema.blocks, strings(&["객체를 찾을 수 없어요: nope 스키마의 모든 테이블"]));
    assert_eq!(blocks(&s, &grant_change("nobody", true, vec![item(orders(), &[Select])])), strings(&["역할을 찾을 수 없어요: nobody"]));
}

#[test]
fn each_object_kind_rejects_the_privileges_it_does_not_have() {
    let s = admin(PG16);
    let cases: Vec<(GrantTarget, Privilege, &str)> = vec![
        (orders(), Usage, "app.orders에는 USAGE 권한이 없어요"),
        (Sequence { schema: "app".into(), name: "ticket_seq".into() }, Insert, "app.ticket_seq에는 INSERT 권한이 없어요"),
        (Function { schema: "app".into(), name: "touch".into(), signature: "order_id integer".into() }, Select, "app.touch(order_id integer)에는 SELECT 권한이 없어요"),
        (Schema { name: "app".into() }, Select, "스키마 app에는 SELECT 권한이 없어요"),
        (Database { name: "appdb".into() }, Usage, "데이터베이스 appdb에는 USAGE 권한이 없어요"),
        (Database { name: "appdb".into() }, Truncate, "데이터베이스 appdb에는 TRUNCATE 권한이 없어요"),
    ];
    for (target, privilege, text) in cases {
        assert_eq!(blocks(&s, &grant_change("alice", true, vec![item(target, &[privilege])])), strings(&[text]));
    }
    // 있는 권한은 통과한다
    for (target, privileges) in [
        (orders(), vec![Select, Insert, Update, Delete, Truncate, Privilege::References, Trigger]),
        (Sequence { schema: "app".into(), name: "ticket_seq".into() }, vec![Usage, Select, Update]),
        (Database { name: "appdb".into() }, vec![Connect, Create, Temporary]),
    ] {
        assert_eq!(blocks(&s, &grant_change("alice", true, vec![item(target, &privileges)])), Vec::<String>::new());
    }
    // 기본 권한: 종류에 맞는 권한만
    let bad = default_change("app_owner", Some("app"), DefaultObjType::Functions, "alice", &[Select], true);
    assert_eq!(blocks(&s, &bad), strings(&["함수에는 SELECT 권한이 없어요"]));
}

#[test]
fn empty_inputs_block() {
    let s = admin(PG16);
    assert_eq!(blocks(&s, &grant_change("alice", true, vec![])), strings(&["바꿀 객체가 없어요"]));
    assert_eq!(blocks(&s, &grant_change("alice", true, vec![item(orders(), &[])])), strings(&["권한을 하나 이상 골라야 해요"]));
    assert_eq!(blocks(&s, &default_change("app_owner", None, DefaultObjType::Tables, "alice", &[], true)), strings(&["권한을 하나 이상 골라야 해요"]));
}

#[test]
fn a_schemas_default_privilege_cannot_name_a_schema() {
    let s = admin(PG16);
    let change = default_change("app_owner", Some("app"), DefaultObjType::Schemas, "alice", &[Usage], true);
    assert_eq!(blocks(&s, &change), strings(&["스키마의 기본 권한은 모든 스키마에만 줄 수 있어요"]));
    assert_eq!(blocks(&s, &default_change("app_owner", None, DefaultObjType::Schemas, "alice", &[Usage], true)), Vec::<String>::new());
}

#[test]
fn role_names_must_be_valid_unreserved_and_free() {
    let s = admin(PG16);
    let bad = "역할 이름이 올바르지 않아요. 1~63바이트이고 pg_로 시작하지 않아야 해요";
    for name in ["", "pg_thing", "a\nb", &"x".repeat(64)] {
        assert_eq!(blocks(&s, &create(name, false, &[], None)), strings(&[bad]), "{name:?}");
    }
    assert!(blocks(&s, &create(&"x".repeat(63), false, &[], None)).is_empty());
    // 63바이트가 아니라 글자 수가 63이어도 바이트가 넘으면 막는다
    assert_eq!(blocks(&s, &create(&"가".repeat(22), false, &[], None)), strings(&[bad]));
    let reserved = "이 이름은 PostgreSQL이 예약해 둬서 쓸 수 없어요";
    for name in ["public", "PUBLIC", "None", "current_role", "CURRENT_USER", "session_user"] {
        assert_eq!(blocks(&s, &create(name, false, &[], None)), strings(&[reserved]), "{name}");
    }
    assert_eq!(blocks(&s, &create("alice", false, &[], None)), strings(&["이미 있는 역할이에요: alice"]));
}

#[test]
fn the_group_to_create_is_checked_for_a_taken_name_too() {
    let s = admin(PG16);
    let change = create("alice2", true, &[], Some(choice(PresetKind::ReadOnly, Some("app_read"), true)));
    assert!(blocks(&s, &change).contains(&"이미 있는 역할이에요: app_read".to_string()));
    let same = create("twin", true, &[], Some(choice(PresetKind::ReadOnly, Some("twin"), true)));
    assert!(blocks(&s, &same).contains(&"이미 있는 역할이에요: twin".to_string()));
}

#[test]
fn grants_to_public_are_the_pseudo_role_and_other_spellings_are_unknown_roles() {
    let s = admin(PG16);
    let ok = run(&s, &grant_change("PUBLIC", true, vec![item(Schema { name: "app".into() }, &[Usage])]));
    assert_eq!(ok.blocks, Vec::<String>::new());
    assert_eq!(sql(&ok), strings(&[r#"GRANT USAGE ON SCHEMA "app" TO PUBLIC"#]));
    for spelling in ["public", "Public"] {
        let r = run(&s, &grant_change(spelling, true, vec![item(Schema { name: "app".into() }, &[Usage])]));
        assert_eq!(r.blocks, strings(&[&format!("역할을 찾을 수 없어요: {spelling}")]));
        assert!(r.statements.is_empty());
    }
}

#[test]
fn a_role_named_public_blocks_changes_that_name_it_but_not_a_public_grantee() {
    let s = admin(PG16).add_role(role("PUBLIC"));
    let text = "PUBLIC이라는 이름의 역할은 이 앱에서 바꿀 수 없어요".to_string();
    assert!(blocks(&s, &membership("PUBLIC", "alice", true, false)).contains(&text));
    assert!(blocks(&s, &membership("app_read", "PUBLIC", true, false)).contains(&text));
    assert!(blocks(&s, &PgChange::Password { role: "PUBLIC".into() }).contains(&text));
    assert!(blocks(&s, &default_change("PUBLIC", None, DefaultObjType::Tables, "alice", &[Select], true)).contains(&text));
    assert!(!blocks(&s, &grant_change("PUBLIC", true, vec![item(Schema { name: "app".into() }, &[Usage])])).contains(&text));
}

#[test]
fn the_execution_database_must_be_known_connectable_and_not_a_template() {
    let s = admin(PG16);
    let text = |name: &str| strings(&[&format!("이 데이터베이스에서는 바꿀 수 없어요: {name}")]);
    let elsewhere = PgChange::Grant { database: "other".into(), grantee: "alice".into(), add: true, items: vec![item(orders(), &[Select])] };
    assert!(blocks(&s, &elsewhere).starts_with(&text("other")));
    let mut closed = s.clone();
    closed.cluster.databases[0].allow_conn = false;
    assert_eq!(blocks(&closed, &membership("app_read", "carol", true, false)).first(), text("appdb").first());
    for name in ["template0", "template1", "rdsadmin"] {
        let mut s = s.clone();
        s.cluster.databases[0].name = name.into();
        s.db.database = name.into();
        assert_eq!(blocks(&s, &membership("app_read", "carol", true, false)).first(), text(name).first(), "{name}");
    }
    let missing = Scene { cluster: ClusterSnapshot { databases: vec![], ..s.cluster.clone() }, db: s.db.clone() };
    assert_eq!(blocks(&missing, &membership("app_read", "carol", true, false)).first(), text("appdb").first());
}

#[test]
fn grant_rights_name_the_object_the_owner_and_the_missing_option() {
    let s = plain(PG16);
    let one = blocks(&s, &grant_change("alice", true, vec![item(orders(), &[Select, Insert])]));
    assert_eq!(one, strings(&["app.orders에 SELECT, INSERT 권한을 줄 수 없어요. 소유자 app_owner 역할의 권한을 물려받거나 GRANT OPTION이 있어야 해요"]));
    let revoke = blocks(&s, &grant_change("alice", false, vec![item(orders(), &[Select])]));
    assert_eq!(revoke, strings(&["app.orders에서 SELECT 권한을 뺄 수 없어요. 소유자 app_owner 역할의 권한을 물려받거나 GRANT OPTION이 있어야 해요"]));
    let several = blocks(&s, &grant_change("alice", true, vec![item(AllTables { schema: "app".into() }, &[Select])]));
    assert_eq!(
        several,
        strings(&["객체 4개에 SELECT 권한을 줄 수 없어요(예: app.customers, app.order_summary, app.order_totals). 소유자(app_owner) 역할의 권한을 물려받거나 GRANT OPTION이 있어야 해요"])
    );
    let several_revoke = blocks(&s, &grant_change("alice", false, vec![item(AllTables { schema: "app".into() }, &[Select])]));
    assert!(several_revoke[0].starts_with("객체 4개에서 SELECT 권한을 뺄 수 없어요(예: "));
    // 소유자가 여럿이면 이름순으로 모두 적는다
    let mut s = plain(PG16);
    s.db.relations.iter_mut().find(|r| r.name == "orders").unwrap().owner = "alice".into();
    let owners = blocks(&s, &grant_change("carol", true, vec![item(AllTables { schema: "app".into() }, &[Select])]));
    assert!(owners[0].contains("소유자(alice, app_owner) 역할의"), "{}", owners[0]);
}

#[test]
fn default_privilege_rights_block_with_the_version_text() {
    let change = default_change("app_owner", Some("app"), DefaultObjType::Tables, "alice", &[Select], true);
    assert_eq!(blocks(&plain(PG15), &change), strings(&["app_owner 역할의 기본 권한을 바꿀 수 없어요. 로그인한 역할이 app_owner 역할의 구성원이어야 해요"]));
    assert_eq!(blocks(&plain(PG16), &change), strings(&["app_owner 역할의 기본 권한을 바꿀 수 없어요. 로그인한 역할이 app_owner 역할의 권한을 물려받아야 해요"]));
    assert_eq!(blocks(&admin(PG16), &change), Vec::<String>::new());
}

#[test]
fn dependent_grants_block_a_revoke_unless_the_grantee_keeps_a_grant_option() {
    let text = "alice 역할이 app.orders의 SELECT 권한을 다른 역할에 다시 줬어요. 그 권한부터 빼야 해요";
    let grantable = |grantor: &str, grantee: &str, grantable: bool| AclEntry { grantor: grantor.into(), grantee: Some(grantee.into()), privilege: Select, grantable };
    let base = || {
        let mut s = app_scene(PG16).login_as("app_owner");
        s.db.relations.iter_mut().find(|r| r.name == "orders").unwrap().acl.extend([grantable("app_owner", "alice", true), grantable("alice", "bob", false)]);
        s
    };
    let revoke = grant_change("alice", false, vec![item(orders(), &[Select])]);
    assert_eq!(blocks(&base(), &revoke), strings(&[text]));
    // 받은 쪽이 다른 줄로 GRANT OPTION을 더 갖고 있으면 괜찮다
    let mut other = base();
    other.db.relations.iter_mut().find(|r| r.name == "orders").unwrap().acl.push(grantable("carol", "alice", true));
    assert!(blocks(&other, &revoke).is_empty());
    // 상속한 역할이 GRANT OPTION을 갖고 있어도 괜찮다
    let mut inherited = base().add_member(member_grants("alice", "app_write", &[(BOOTSTRAP, false, Some(true), Some(true))]));
    inherited.db.relations.iter_mut().find(|r| r.name == "orders").unwrap().acl.push(grantable("app_owner", "app_write", true));
    assert!(blocks(&inherited, &revoke).is_empty());
    // 다시 준 적이 없으면 괜찮다
    let mut nothing = base();
    nothing.db.relations.iter_mut().find(|r| r.name == "orders").unwrap().acl.retain(|e| e.grantor != "alice");
    assert!(blocks(&nothing, &revoke).is_empty());
    // 소유자는 GRANT OPTION을 잃지 않는다
    let mut owner = app_scene(PG16).login_as("app_owner");
    owner.db.relations.iter_mut().find(|r| r.name == "orders").unwrap().acl.push(grantable("app_owner", "app_owner", true));
    assert!(blocks(&owner, &grant_change("app_owner", false, vec![item(orders(), &[Select])])).is_empty());
}

#[test]
fn dropping_a_role_is_judged_on_what_it_owns_holds_or_granted() {
    let text = "만든 뒤에 객체나 권한이 생겨서 되돌릴 수 없어요";
    let drop = PgChange::DropRole { role: "newbie".into() };
    let base = || {
        let mut s = admin(PG16).add_role(login("newbie"));
        s = s.add_member(member_grants("mm", "newbie", &[(BOOTSTRAP, true, Some(false), Some(false))]));
        s
    };
    let r = run(&base(), &drop);
    assert_eq!(r.blocks, Vec::<String>::new());
    assert_eq!(sql(&r), strings(&[r#"DROP ROLE "newbie""#]));
    let mut owns = base();
    owns.db.relations.iter_mut().find(|r| r.name == "orders").unwrap().owner = "newbie".into();
    assert_eq!(blocks(&owns, &drop), strings(&[text]));
    let mut holds = base();
    holds.db.schemas.iter_mut().find(|s| s.name == "app").unwrap().acl.push(AclEntry { grantor: "app_owner".into(), grantee: Some("newbie".into()), privilege: Usage, grantable: false });
    assert_eq!(blocks(&holds, &drop), strings(&[text]));
    let mut in_defaults = base();
    in_defaults.db.default_acls.push(DefaultAclRec {
        creator: "app_owner".into(),
        schema: Some("app".into()),
        obj_type: DefaultObjType::Tables,
        acl: vec![AclEntry { grantor: "app_owner".into(), grantee: Some("newbie".into()), privilege: Select, grantable: false }],
    });
    assert_eq!(blocks(&in_defaults, &drop), strings(&[text]));
    let granted = base().add_member(member_grants("carol", "app_read", &[("newbie", false, Some(true), Some(true))]));
    assert_eq!(blocks(&granted, &drop), strings(&[text]));
    // 다른 사람이 가진 것은 상관없다
    assert!(blocks(&base().add_member(member_grants("carol", "app_read", &[("mm", false, Some(true), Some(true))])), &drop).is_empty());
}

#[test]
fn the_apps_own_login_cannot_be_dropped() {
    assert!(blocks(&admin(PG16), &PgChange::DropRole { role: "mm".into() }).contains(&"앱이 로그인한 역할은 삭제할 수 없어요".to_string()));
}

#[test]
fn a_truncated_snapshot_asks_for_a_confirmation_on_bulk_grants_and_presets() {
    let mut s = admin(PG16);
    s.db.truncated = true;
    let bulk = run(&s, &grant_change("alice", true, vec![item(AllTables { schema: "app".into() }, &[Select])]));
    assert_eq!(bulk.confirms, strings(&["객체가 많아 일부만 읽었어요. 영향에 없는 객체에도 적용돼요"]));
    let seqs = run(&s, &grant_change("alice", true, vec![item(AllSequences { schema: "app".into() }, &[Select])]));
    assert_eq!(seqs.confirms.len(), 1);
    let preset = run(&s, &create("zed", false, &[], Some(choice(PresetKind::ReadOnly, None, false))));
    assert_eq!(preset.confirms.len(), 1);
    assert!(run(&s, &grant_change("alice", true, vec![item(orders(), &[Select])])).confirms.is_empty());
    assert!(run(&admin(PG16), &grant_change("alice", true, vec![item(AllTables { schema: "app".into() }, &[Select])])).confirms.is_empty());
}

// ───────────────────────── 9. 남는 권한 ─────────────────────────

#[test]
fn a_revoke_lists_the_entries_other_grantors_keep() {
    let mut s = admin(PG16);
    let rel = s.db.relations.iter_mut().find(|r| r.name == "orders").unwrap();
    rel.acl.push(AclEntry { grantor: "zeta".into(), grantee: Some("app_write".into()), privilege: Insert, grantable: false });
    rel.acl.push(AclEntry { grantor: "carol".into(), grantee: Some("app_write".into()), privilege: Insert, grantable: false });
    rel.acl.push(AclEntry { grantor: "carol".into(), grantee: Some("app_write".into()), privilege: Delete, grantable: false });
    let r = run(&s, &grant_change("app_write", false, vec![item(orders(), &[Insert, Update])]));
    assert_eq!(r.stays, strings(&["carol → app.orders INSERT", "zeta → app.orders INSERT"]));
    // 주는 변경에는 남는 것이 없다
    assert!(run(&s, &grant_change("app_write", true, vec![item(orders(), &[Insert])])).stays.is_empty());
}

// ───────────────────────── 기본 권한 문장 ─────────────────────────

#[test]
fn default_privilege_statements_follow_the_scope() {
    let s = admin(PG16);
    let global = run(&s, &default_change("app_owner", None, DefaultObjType::Tables, "alice", &[Select, Insert], true));
    assert_eq!(sql(&global), strings(&[r#"ALTER DEFAULT PRIVILEGES FOR ROLE "app_owner" GRANT SELECT, INSERT ON TABLES TO "alice""#]));
    let scoped = run(&s, &default_change("app_owner", Some("app"), DefaultObjType::Sequences, "PUBLIC", &[Usage], false));
    assert_eq!(sql(&scoped), strings(&[r#"ALTER DEFAULT PRIVILEGES FOR ROLE "app_owner" IN SCHEMA "app" REVOKE USAGE ON SEQUENCES FROM PUBLIC"#]));
    assert_eq!(scoped.blocks, Vec::<String>::new());
    let unknown_schema = run(&s, &default_change("app_owner", Some("nope"), DefaultObjType::Tables, "alice", &[Select], true));
    assert_eq!(unknown_schema.blocks, strings(&["객체를 찾을 수 없어요: 스키마 nope"]));
}
