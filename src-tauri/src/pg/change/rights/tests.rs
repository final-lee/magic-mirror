use super::*;
use crate::pg::fixtures::*;
use crate::pg::model::Privilege::{Insert, Select};
use crate::pg::model::{AclEntry, RoleRec};

/// 앱이 `mm`으로 로그인한 장면. `mm`은 속성이 없는 LOGIN 역할이다
fn scene(version: i32) -> Scene {
    app_scene(version).add_role(login("mm")).login_as("mm")
}

fn rights(scene: &Scene) -> Rights<'_> {
    Rights::new(&scene.cluster, &scene.db)
}

/// 가입 한 줄을 버전에 맞게: 160000부터는 옵션이 있는 부여, 그 전에는 옵션이 없는 부여
fn joined(version: i32, who: &str, group: &str, inherit: bool) -> MemberRec {
    if version >= PG16 {
        member_grants(who, group, &[(BOOTSTRAP, false, Some(inherit), Some(true))])
    } else {
        member(who, group)
    }
}

/// `grantee`의 `privilege` 항목을 GRANT OPTION이 있는 것으로 바꾼다
fn make_grantable(entries: &mut [AclEntry], grantee: &str, privilege: Privilege) {
    for e in entries.iter_mut().filter(|e| e.grantee.as_deref() == Some(grantee) && e.privilege == privilege) {
        e.grantable = true;
    }
}

fn orders(scene: &mut Scene) -> &mut crate::pg::model::RelationRec {
    scene.db.relations.iter_mut().find(|r| r.name == "orders").unwrap()
}

fn obj_grantor(scene: &Scene, privileges: &[Privilege]) -> Option<String> {
    rights(scene).object_grantor(Obj::Relation(scene.relation("app.orders")), privileges)
}

// ───────────────────────── 1. 객체 부여자 ─────────────────────────

#[test]
fn the_owner_and_a_superuser_grant_as_the_owner() {
    for version in [PG15, PG16] {
        let owner = app_scene(version).login_as("app_owner");
        assert_eq!(obj_grantor(&owner, &[Select]), Some("app_owner".into()));
        let mut root = scene(version);
        root.role_mut("mm").superuser = true;
        assert_eq!(obj_grantor(&root, &[Select, Insert]), Some("app_owner".into()));
    }
}

#[test]
fn a_login_that_inherits_the_owner_grants_as_the_owner() {
    for version in [PG15, PG16] {
        let s = scene(version).add_member(joined(version, "mm", "app_owner", true));
        assert_eq!(obj_grantor(&s, &[Select, Insert]), Some("app_owner".into()), "{version}");
    }
}

#[test]
fn a_login_without_grant_options_cannot_grant() {
    for version in [PG15, PG16] {
        assert_eq!(obj_grantor(&scene(version), &[Select]), None);
    }
}

#[test]
fn the_login_holding_the_grant_option_itself_is_the_grantor() {
    for version in [PG15, PG16] {
        let mut s = scene(version);
        let rel = orders(&mut s);
        rel.acl.push(AclEntry { grantor: "app_owner".into(), grantee: Some("mm".into()), privilege: Select, grantable: true });
        assert_eq!(obj_grantor(&s, &[Select]), Some("mm".into()));
        // 다른 권한의 GRANT OPTION은 없다
        assert_eq!(obj_grantor(&s, &[Select, Insert]), None);
    }
}

#[test]
fn an_inherited_group_holding_the_grant_option_is_the_grantor() {
    for version in [PG15, PG16] {
        let mut s = scene(version).add_member(joined(version, "mm", "app_read", true));
        make_grantable(&mut orders(&mut s).acl, "app_read", Select);
        assert_eq!(obj_grantor(&s, &[Select]), Some("app_read".into()), "{version}");
    }
}

#[test]
fn only_half_the_privileges_being_grantable_gives_none() {
    for version in [PG15, PG16] {
        let mut s = scene(version).add_member(joined(version, "mm", "app_write", true));
        // app_write는 orders에 INSERT·UPDATE를 받았다: INSERT만 GRANT OPTION이 있다
        make_grantable(&mut orders(&mut s).acl, "app_write", Insert);
        assert_eq!(obj_grantor(&s, &[Insert]), Some("app_write".into()));
        assert_eq!(obj_grantor(&s, &[Insert, Privilege::Update]), None);
        // 두 그룹이 반씩 가져도 한 역할이 다 가진 게 아니라서 None이다
        make_grantable(&mut orders(&mut s).acl, "app_read", Select);
        let s = s.add_member(joined(version, "mm", "app_read", true));
        assert_eq!(obj_grantor(&s, &[Select, Insert]), None);
    }
}

#[test]
fn a_noinherit_path_does_not_count() {
    for version in [PG15, PG16] {
        let mut s = scene(version);
        if version >= PG16 {
            s = s.add_member(member_grants("mm", "app_owner", &[(BOOTSTRAP, false, Some(false), Some(true))]));
        } else {
            s.role_mut("mm").inherit = false;
            s = s.add_member(member("mm", "app_owner"));
        }
        assert_eq!(obj_grantor(&s, &[Select]), None, "{version}");
    }
}

#[test]
fn ties_at_one_depth_go_to_the_lower_oid() {
    for version in [PG15, PG16] {
        let mut s = scene(version).add_role(role("g_late")).add_role(role("g_early"));
        s = s.add_member(joined(version, "mm", "g_late", true)).add_member(joined(version, "mm", "g_early", true));
        for group in ["g_late", "g_early"] {
            orders(&mut s).acl.push(AclEntry { grantor: "app_owner".into(), grantee: Some(group.into()), privilege: Select, grantable: true });
        }
        let s = s.oid("g_late", 20_000).oid("g_early", 19_000);
        assert_eq!(obj_grantor(&s, &[Select]), Some("g_early".into()));
        let s = s.oid("g_late", 18_000);
        assert_eq!(obj_grantor(&s, &[Select]), Some("g_late".into()));
    }
}

#[test]
fn a_closer_holder_beats_a_farther_one() {
    let mut s = scene(PG16).add_role(role("mid")).add_role(role("far"));
    s = s.add_member(joined(PG16, "mm", "mid", true)).add_member(joined(PG16, "mid", "far", true));
    orders(&mut s).acl.push(AclEntry { grantor: "app_owner".into(), grantee: Some("far".into()), privilege: Select, grantable: true });
    orders(&mut s).acl.push(AclEntry { grantor: "app_owner".into(), grantee: Some("mid".into()), privilege: Select, grantable: true });
    let s = s.oid("far", 17_000).oid("mid", 19_000);
    assert_eq!(obj_grantor(&s, &[Select]), Some("mid".into()));
}

// ───────────────────────── 2. 구성원 관계의 권한 ─────────────────────────

const NOT_ALLOWED_16: &str = "app_read 역할의 구성원을 바꿀 권한이 없어요. app_read 역할에 대한 ADMIN OPTION이 있어야 해요";
const NOT_ALLOWED_15: &str = "app_read 역할의 구성원을 바꿀 권한이 없어요. CREATEROLE이나 app_read 역할에 대한 ADMIN OPTION이 있어야 해요";
const NOT_INHERITED: &str = "app_read 역할의 구성원을 바꿀 수 없어요. ADMIN OPTION을 가진 역할의 권한을 물려받아야 해요";

/// `who`가 `group`에 ADMIN을 가진 구성원 관계(부여자는 `grantor`)
fn admin_of(version: i32, who: &str, group: &str, grantor: &str, inherit: bool) -> MemberRec {
    if version >= PG16 {
        member_grants(who, group, &[(grantor, true, Some(inherit), Some(true))])
    } else {
        member_grants(who, group, &[(grantor, true, None, None)])
    }
}

#[test]
fn from_160000_membership_needs_admin_option_not_createrole() {
    let mut s = scene(PG16);
    s.role_mut("mm").create_role = true;
    assert_eq!(rights(&s).membership_grantor("app_read"), Err(NOT_ALLOWED_16.into()));
}

#[test]
fn from_160000_a_superuser_login_grants_as_the_bootstrap_superuser() {
    let mut s = scene(PG16);
    s.role_mut("mm").superuser = true;
    assert_eq!(rights(&s).membership_grantor("app_read"), Ok(BOOTSTRAP.into()));
}

#[test]
fn from_160000_the_login_with_admin_on_its_own_row_grants_as_itself() {
    // 부여자가 부트스트랩이어도 로그인한 역할 자신의 줄에 ADMIN이 있으면 자기 자신이다
    let s = scene(PG16).add_member(admin_of(PG16, "mm", "app_read", BOOTSTRAP, false));
    assert_eq!(rights(&s).membership_grantor("app_read"), Ok("mm".into()));
}

#[test]
fn from_160000_admin_held_by_an_inherited_role_names_that_role_as_the_grantor() {
    let s = scene(PG16)
        .add_role(role("mgr"))
        .add_member(joined(PG16, "mm", "mgr", true))
        .add_member(admin_of(PG16, "mgr", "app_read", BOOTSTRAP, true));
    assert_eq!(rights(&s).membership_grantor("app_read"), Ok("mgr".into()));
}

#[test]
fn from_160000_the_closest_admin_in_oid_order_is_the_grantor() {
    let mut s = scene(PG16).add_role(role("mgr_b")).add_role(role("mgr_a"));
    for mgr in ["mgr_b", "mgr_a"] {
        s = s.add_member(joined(PG16, "mm", mgr, true)).add_member(admin_of(PG16, mgr, "app_read", BOOTSTRAP, true));
    }
    let s = s.oid("mgr_b", 20_000).oid("mgr_a", 21_000);
    assert_eq!(rights(&s).membership_grantor("app_read"), Ok("mgr_b".into()));
}

#[test]
fn from_160000_admin_reachable_only_without_inheriting_passes_the_check_but_finds_no_grantor() {
    let s = scene(PG16)
        .add_role(role("mgr"))
        .add_member(joined(PG16, "mm", "mgr", false))
        .add_member(admin_of(PG16, "mgr", "app_read", BOOTSTRAP, true));
    assert!(rights(&s).admin_reachable("app_read"));
    assert_eq!(rights(&s).membership_grantor("app_read"), Err(NOT_INHERITED.into()));
}

#[test]
fn from_160000_a_group_is_never_its_own_admin_and_pg_database_owner_gets_no_members() {
    // 로그인한 역할이 그룹 자신이면 ADMIN이 있어도 세지 않는다
    let s = scene(PG16).login_as("app_read").add_member(admin_of(PG16, "app_read", "app_read", BOOTSTRAP, true));
    assert_eq!(rights(&s).membership_grantor("app_read"), Err(NOT_ALLOWED_16.into()));
    let mut s = scene(PG16);
    s.role_mut("mm").superuser = true;
    assert_eq!(
        rights(&s).membership_grantor("pg_database_owner"),
        Err("pg_database_owner 역할의 구성원을 바꿀 권한이 없어요. pg_database_owner 역할에 대한 ADMIN OPTION이 있어야 해요".into())
    );
}

#[test]
fn before_160000_createrole_or_admin_through_any_chain_grants_as_the_login() {
    let mut s = scene(PG15);
    assert_eq!(rights(&s).membership_grantor("app_read"), Err(NOT_ALLOWED_15.into()));
    s.role_mut("mm").create_role = true;
    assert_eq!(rights(&s).membership_grantor("app_read"), Ok("mm".into()));

    // CREATEROLE가 없어도 NOINHERIT 사슬 끝의 ADMIN으로 된다
    let mut s = scene(PG15).add_role(role("mgr")).add_member(member("mm", "mgr")).add_member(admin_of(PG15, "mgr", "app_read", BOOTSTRAP, true));
    s.role_mut("mm").inherit = false;
    assert_eq!(rights(&s).membership_grantor("app_read"), Ok("mm".into()));
}

#[test]
fn a_superuser_group_needs_a_superuser_login_on_every_version() {
    for version in [PG15, PG16] {
        let mut s = scene(version).add_role(RoleRec { superuser: true, ..role("boss") });
        s.role_mut("mm").create_role = true;
        let text = "superuser나 REPLICATION 역할은 바꿀 수 없어요: boss";
        assert_eq!(rights(&s).membership_grantor("boss"), Err(text.into()), "{version}");
        s.role_mut("mm").superuser = true;
        assert!(rights(&s).membership_grantor("boss").is_ok());
    }
}

// ───────────────────────── 3. 구성원 관계 거두기 ─────────────────────────

fn rows(rev: &Revocations) -> (Vec<&str>, Vec<&str>) {
    (rev.rows.iter().map(String::as_str).collect(), rev.remaining.iter().map(String::as_str).collect())
}

#[test]
fn before_160000_one_plain_revoke_covers_the_pair() {
    let s = scene(PG15);
    assert_eq!(rows(&rights(&s).membership_revocations("app_read", "bob")), (vec![""], vec![]));
    assert_eq!(rows(&rights(&s).membership_revocations("app_read", "nobody")), (vec![], vec![]));
}

#[test]
fn from_160000_rows_the_login_has_privs_of_can_be_revoked_and_others_remain() {
    let s = scene(PG16)
        .add_role(role("mgr"))
        .add_member(joined(PG16, "mm", "mgr", true))
        .add_member(member_grants("bob", "app_read", &[(BOOTSTRAP, false, Some(false), Some(true)), ("mgr", false, Some(true), Some(true)), ("mm", true, Some(true), Some(true))]));
    let rev = rights(&s).membership_revocations("app_read", "bob");
    assert_eq!(rows(&rev), (vec!["mgr", "mm"], vec![BOOTSTRAP]));
    // ADMIN만 거둘 때는 ADMIN이 있는 줄만 대상이다
    let rev = rights(&s).revocations("app_read", "bob", true);
    assert_eq!(rows(&rev), (vec!["mm"], vec![]));
}

#[test]
fn a_noinherit_membership_does_not_give_the_privs_to_revoke_its_rows() {
    let s = scene(PG16)
        .add_role(role("mgr"))
        .add_member(joined(PG16, "mm", "mgr", false))
        .add_member(member_grants("bob", "app_read", &[("mgr", false, Some(true), Some(true))]));
    assert_eq!(rows(&rights(&s).membership_revocations("app_read", "bob")), (vec![], vec!["mgr"]));
}

#[test]
fn a_superuser_login_can_revoke_every_row() {
    let mut s = scene(PG16).add_member(member_grants("bob", "app_read", &[(BOOTSTRAP, false, Some(true), Some(true)), ("other", false, Some(true), Some(true))]));
    s.role_mut("mm").superuser = true;
    assert_eq!(rows(&rights(&s).membership_revocations("app_read", "bob")), (vec!["other", BOOTSTRAP], vec![]));
}

// ───────────────────────── 4. 기본 권한 ─────────────────────────

#[test]
fn before_160000_membership_in_the_creator_passes_even_without_inheriting() {
    let mut s = scene(PG15).add_member(member("mm", "app_owner"));
    s.role_mut("mm").inherit = false;
    assert!(rights(&s).defaults_for("app_owner").is_ok());
    assert!(rights(&scene(PG15)).defaults_for("app_owner").is_err());
}

#[test]
fn from_160000_the_login_must_inherit_the_creator() {
    let text = "app_owner 역할의 기본 권한을 바꿀 수 없어요. 로그인한 역할이 app_owner 역할의 권한을 물려받아야 해요";
    let s = scene(PG16).add_member(joined(PG16, "mm", "app_owner", false));
    assert_eq!(rights(&s).defaults_for("app_owner"), Err(text.into()));
    let s = scene(PG16).add_member(joined(PG16, "mm", "app_owner", true));
    assert!(rights(&s).defaults_for("app_owner").is_ok());
    let before = "app_owner 역할의 기본 권한을 바꿀 수 없어요. 로그인한 역할이 app_owner 역할의 구성원이어야 해요";
    assert_eq!(rights(&scene(PG15)).defaults_for("app_owner"), Err(before.into()));
}

#[test]
fn a_superuser_and_the_creator_itself_always_pass() {
    for version in [PG15, PG16] {
        let mut s = scene(version);
        assert!(rights(&s).defaults_for("mm").is_ok());
        s.role_mut("mm").superuser = true;
        assert!(rights(&s).defaults_for("app_owner").is_ok());
    }
}

// ───────────────────────── 5. 바꾸기와 지우기 ─────────────────────────

fn target(scene: &Scene, name: &str) -> RoleRec {
    scene.cluster.roles.iter().find(|r| r.name == name).unwrap().clone()
}

const ALTER_15: &str = "alice 역할을 바꿀 권한이 없어요. CREATEROLE이 있어야 해요";
const ALTER_16: &str = "alice 역할을 바꿀 권한이 없어요. CREATEROLE과 이 역할에 대한 ADMIN OPTION이 있어야 해요";

#[test]
fn a_superuser_login_may_alter_and_drop_anything() {
    let mut s = scene(PG16).add_role(RoleRec { superuser: true, ..role("boss") });
    s.role_mut("mm").superuser = true;
    let t = target(&s, "boss");
    assert!(rights(&s).alter(&t, &[AttrClause::CreateDb(true)]).is_ok());
    assert!(rights(&s).drop(&t).is_ok());
}

#[test]
fn before_160000_alter_needs_the_logins_own_createrole_and_inheriting_manage_is_not_enough() {
    let mut s = scene(PG15).add_role(role("rds_superuser")).add_member(member("mm", "rds_superuser"));
    let alice = target(&s, "alice");
    assert!(rights(&s).can_manage());
    assert_eq!(rights(&s).alter(&alice, &[]), Err(ALTER_15.into()));
    assert_eq!(rights(&s).drop(&alice), Err("alice 역할을 삭제할 권한이 없어요. CREATEROLE이 있어야 해요".into()));
    s.role_mut("mm").create_role = true;
    assert!(rights(&s).alter(&alice, &[AttrClause::Login(false)]).is_ok());
    assert!(rights(&s).drop(&alice).is_ok());
}

#[test]
fn from_160000_alter_and_drop_need_createrole_plus_admin_option() {
    let mut s = scene(PG16);
    s.role_mut("mm").create_role = true;
    let alice = target(&s, "alice");
    assert_eq!(rights(&s).alter(&alice, &[]), Err(ALTER_16.into()));
    assert_eq!(rights(&s).drop(&alice), Err("alice 역할을 삭제할 권한이 없어요. CREATEROLE과 이 역할에 대한 ADMIN OPTION이 있어야 해요".into()));
    // ADMIN OPTION만 있고 CREATEROLE이 없어도 안 된다
    let s2 = scene(PG16).add_member(admin_of(PG16, "mm", "alice", BOOTSTRAP, false));
    assert_eq!(rights(&s2).alter(&alice, &[]), Err(ALTER_16.into()));
    // 둘 다 있으면 된다. ADMIN은 상속하지 않는 사슬로 닿아도 된다
    let mut s3 = scene(PG16).add_role(role("mgr")).add_member(joined(PG16, "mm", "mgr", false)).add_member(admin_of(PG16, "mgr", "alice", BOOTSTRAP, true));
    s3.role_mut("mm").create_role = true;
    assert!(rights(&s3).alter(&alice, &[AttrClause::Login(false)]).is_ok());
    assert!(rights(&s3).drop(&alice).is_ok());
}

#[test]
fn a_superuser_or_replication_target_is_blocked_for_a_non_superuser_on_every_version() {
    for version in [PG15, PG16] {
        let mut s = scene(version).add_role(RoleRec { superuser: true, ..role("boss") }).add_role(RoleRec { replication: true, ..role("repl") });
        s.role_mut("mm").create_role = true;
        s = s.add_member(admin_of(version, "mm", "boss", BOOTSTRAP, true)).add_member(admin_of(version, "mm", "repl", BOOTSTRAP, true));
        for name in ["boss", "repl"] {
            let t = target(&s, name);
            let text = format!("superuser나 REPLICATION 역할은 바꿀 수 없어요: {name}");
            assert_eq!(rights(&s).alter(&t, &[]), Err(text.clone()), "{version} {name}");
            assert_eq!(rights(&s).drop(&t), Err(text));
        }
    }
}

#[test]
fn from_160000_createdb_needs_createdb_on_the_login() {
    let mut s = scene(PG16).add_member(admin_of(PG16, "mm", "alice", BOOTSTRAP, false));
    s.role_mut("mm").create_role = true;
    let alice = target(&s, "alice");
    let text = "CREATEDB를 주거나 빼려면 로그인한 역할에도 CREATEDB가 있어야 해요";
    assert_eq!(rights(&s).alter(&alice, &[AttrClause::CreateDb(true)]), Err(text.into()));
    assert!(rights(&s).alter(&alice, &[AttrClause::CreateDb(false)]).is_err());
    assert!(rights(&s).alter(&alice, &[AttrClause::Login(false)]).is_ok());
    s.role_mut("mm").create_db = true;
    assert!(rights(&s).alter(&alice, &[AttrClause::CreateDb(true)]).is_ok());
    // 160000 전에는 이 제약이 없다
    let mut old = scene(PG15);
    old.role_mut("mm").create_role = true;
    let alice = target(&old, "alice");
    assert!(rights(&old).alter(&alice, &[AttrClause::CreateDb(true)]).is_ok());
}

#[test]
fn creating_a_role_needs_the_logins_own_createrole_or_superuser() {
    for version in [PG15, PG16] {
        let mut s = scene(version).add_role(role("rds_superuser")).add_member(joined(version, "mm", "rds_superuser", true));
        assert_eq!(rights(&s).create_role(), Err("역할을 만들 권한이 없어요. CREATEROLE이 있어야 해요".into()));
        s.role_mut("mm").create_role = true;
        assert!(rights(&s).create_role().is_ok());
        s.role_mut("mm").create_role = false;
        s.role_mut("mm").superuser = true;
        assert!(rights(&s).create_role().is_ok());
    }
}

const RESTRICTED: &str = "비밀번호나 만료일을 바꾸려면 로그인한 역할이 rds_password 구성원이어야 해요(rds.restrict_password_commands가 켜져 있어요)";

#[test]
fn restricted_password_commands_need_rds_password_in_any_chain() {
    let mut s = scene(PG16).add_member(admin_of(PG16, "mm", "alice", BOOTSTRAP, false));
    s.role_mut("mm").create_role = true;
    let alice = target(&s, "alice");
    let until = [AttrClause::ValidUntil(Some("2027-01-01T00:00:00Z".into()))];
    // 설정이 꺼져 있으면 상관없다
    assert!(rights(&s).alter(&alice, &until).is_ok());
    assert!(rights(&s).password_commands().is_ok());
    s.cluster.restrict_password_commands = true;
    assert_eq!(rights(&s).alter(&alice, &until), Err(RESTRICTED.into()));
    assert_eq!(rights(&s).password_commands(), Err(RESTRICTED.into()));
    // 다른 속성은 막지 않는다
    assert!(rights(&s).alter(&alice, &[AttrClause::Login(false)]).is_ok());
    // 상속하지 않는 사슬이어도 된다
    let mut s = s.add_role(role("pw_chain")).add_role(role("rds_password")).add_member(joined(PG16, "mm", "pw_chain", false)).add_member(joined(PG16, "pw_chain", "rds_password", true));
    s.cluster.restrict_password_commands = true;
    assert!(rights(&s).password_commands().is_ok());
}

// ───────────────────────── 6. 세션 끊기 ─────────────────────────

fn session(pid: i32, role: Option<&str>) -> SessionRec {
    SessionRec {
        pid,
        role: role.map(Into::into),
        database: Some("appdb".into()),
        client_addr: None,
        application_name: String::new(),
        state: None,
        backend_start: None,
        query_start: None,
        wait_event: None,
    }
}

#[test]
fn the_apps_own_sessions_are_never_terminated() {
    let mut s = scene(PG16);
    s.role_mut("mm").superuser = true;
    assert_eq!(rights(&s).terminate(&session(7, Some("alice")), &[7, 8]), Err("이 앱의 세션은 끊을 수 없어요".into()));
    assert!(rights(&s).terminate(&session(9, Some("alice")), &[7, 8]).is_ok());
}

#[test]
fn a_superusers_session_needs_a_superuser_login() {
    let s = scene(PG16).add_role(RoleRec { superuser: true, ..role("boss") }).add_member(joined(PG16, "mm", "boss", true));
    assert_eq!(rights(&s).terminate(&session(5, Some("boss")), &[]), Err("superuser 세션은 끊을 수 없어요: boss".into()));
    let mut s = s;
    s.role_mut("mm").superuser = true;
    assert!(rights(&s).terminate(&session(5, Some("boss")), &[]).is_ok());
}

#[test]
fn a_session_can_be_ended_by_privs_of_its_role_or_pg_signal_backend() {
    let text = "이 세션을 끊을 권한이 없어요. pg_signal_backend 권한이 있어야 해요";
    for version in [PG15, PG16] {
        let s = scene(version).add_role(role("pg_signal_backend"));
        assert_eq!(rights(&s).terminate(&session(5, Some("alice")), &[]), Err(text.into()));
        let by_role = s.clone().add_member(joined(version, "mm", "alice", true));
        assert!(rights(&by_role).terminate(&session(5, Some("alice")), &[]).is_ok());
        let by_signal = s.clone().add_member(joined(version, "mm", "pg_signal_backend", true));
        assert!(rights(&by_signal).terminate(&session(5, Some("alice")), &[]).is_ok());
        // 상속하지 않으면 권한이 아니다
        let weak = s.add_member(joined(version, "mm", "pg_signal_backend", false));
        let weak = if version >= PG16 {
            weak
        } else {
            let mut w = weak;
            w.role_mut("mm").inherit = false;
            w
        };
        assert_eq!(rights(&weak).terminate(&session(5, Some("alice")), &[]), Err(text.into()));
    }
}

#[test]
fn can_manage_is_inheriting_rds_superuser_or_own_createrole_or_superuser() {
    let s = scene(PG16);
    assert!(!rights(&s).can_manage());
    let mut a = scene(PG16);
    a.role_mut("mm").create_role = true;
    assert!(rights(&a).can_manage());
    let b = scene(PG16).add_role(role("rds_superuser")).add_member(joined(PG16, "mm", "rds_superuser", true));
    assert!(rights(&b).can_manage());
    let c = scene(PG16).add_role(role("rds_superuser")).add_member(joined(PG16, "mm", "rds_superuser", false));
    assert!(!rights(&c).can_manage());
}

#[test]
fn has_privs_of_and_member_of_differ_on_inheriting() {
    let s = scene(PG16).add_member(joined(PG16, "mm", "app_read", false));
    assert!(rights(&s).member_of("app_read"));
    assert!(!rights(&s).has_privs_of("app_read"));
    assert!(rights(&s).has_privs_of("mm"));
    let s = s.add_member(joined(PG16, "mm", "app_read", true));
    assert!(rights(&s).has_privs_of("app_read"));
    let mut root = scene(PG16);
    root.role_mut("mm").superuser = true;
    assert!(rights(&root).has_privs_of("anyone") && rights(&root).member_of("anyone"));
}
