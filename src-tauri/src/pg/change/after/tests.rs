use super::*;
use crate::pg::change::model::{GrantItem, GrantTarget, PgChange, PresetChoice, PresetKind};
use crate::pg::change::resolve::{resolve, AclEffect, OnTarget, ResolveCtx};
use crate::pg::fixtures::*;
use crate::pg::model::Privilege::{Delete, Execute, Insert, Select, Update, Usage};
use crate::pg::model::{DefaultAclRec, RelationRec, SessionRec};

fn admin(version: i32) -> Scene {
    let mm = RoleRec { create_role: true, ..login("mm") };
    let owner = if version >= PG16 { member_grants("mm", "app_owner", &[(BOOTSTRAP, false, Some(true), Some(true))]) } else { member("mm", "app_owner") };
    app_scene(version).add_role(mm).login_as("mm").add_member(owner)
}

/// 변경을 풀고 연산을 복제한 스냅숏에 적용한 결과
fn after(scene: &Scene, change: &PgChange) -> (ClusterSnapshot, DbSnapshot) {
    let resolved = resolve(&ResolveCtx { cluster: &scene.cluster, db: &scene.db, own_pids: &[], read_replica: false }, change);
    let (mut cluster, mut db) = (scene.cluster.clone(), scene.db.clone());
    apply(&mut cluster, &mut db, &resolved.ops);
    (cluster, db)
}

/// 부여 한 줄: (부여자, ADMIN, INHERIT, SET)
type Row = (String, bool, Option<bool>, Option<bool>);

fn grants_of(cluster: &ClusterSnapshot, member: &str, group: &str) -> Option<Vec<Row>> {
    cluster.members.iter().find(|m| m.member == member && m.group == group).map(|m| m.grants.iter().map(|g| (g.grantor.clone(), g.admin, g.inherit, g.set)).collect())
}

fn entry(grantor: &str, grantee: Option<&str>, privilege: Privilege) -> AclEntry {
    AclEntry { grantor: grantor.into(), grantee: grantee.map(Into::into), privilege, grantable: false }
}

fn orders(scene: &Scene) -> &RelationRec {
    scene.relation("app.orders")
}

fn grant_orders(grantee: &str, add: bool, privileges: &[Privilege]) -> PgChange {
    PgChange::Grant {
        database: "appdb".into(),
        grantee: grantee.into(),
        add,
        items: vec![GrantItem { target: GrantTarget::Relation { schema: "app".into(), name: "orders".into() }, privileges: privileges.to_vec() }],
    }
}

// ───────────────────────── 권한 ─────────────────────────

#[test]
fn a_grant_adds_the_entry_for_the_predicted_grantor_unless_it_exists() {
    let s = admin(PG16);
    let (_, db) = after(&s, &grant_orders("alice", true, &[Select, Insert]));
    let rel = db.relations.iter().find(|r| r.name == "orders").unwrap();
    assert!(rel.acl.contains(&entry("app_owner", Some("alice"), Select)));
    assert!(rel.acl.contains(&entry("app_owner", Some("alice"), Insert)));
    // 이미 있는 항목을 또 주면 그대로다
    let (_, again) = after(&s, &grant_orders("app_read", true, &[Select]));
    assert_eq!(again.relations.iter().find(|r| r.name == "orders").unwrap().acl, orders(&s).acl);
}

#[test]
fn a_revoke_removes_only_the_predicted_grantors_entries() {
    let mut s = admin(PG16);
    s.db.relations.iter_mut().find(|r| r.name == "orders").unwrap().acl.push(entry("other", Some("app_write"), Insert));
    let (_, db) = after(&s, &grant_orders("app_write", false, &[Insert, Update]));
    let acl = &db.relations.iter().find(|r| r.name == "orders").unwrap().acl;
    assert!(!acl.contains(&entry("app_owner", Some("app_write"), Insert)));
    assert!(!acl.contains(&entry("app_owner", Some("app_write"), Update)));
    assert!(acl.contains(&entry("other", Some("app_write"), Insert)));
}

#[test]
fn privileges_on_a_database_a_function_and_a_public_grantee_land_in_their_acls() {
    let s = admin(PG16);
    let ops = [
        Op::Privileges {
            add: true,
            on: OnTarget::Database("appdb".into()),
            privileges: vec![Privilege::Create],
            grantee: "alice".into(),
            effects: vec![AclEffect { object: ObjKey::Database("appdb".into()), privilege: Privilege::Create, grantor: "app_owner".into() }],
        },
        Op::Privileges {
            add: true,
            on: OnTarget::Function("app".into(), "plain".into(), "a integer, b text".into()),
            privileges: vec![Execute],
            grantee: "PUBLIC".into(),
            effects: vec![AclEffect { object: ObjKey::Function("app".into(), "plain".into(), "a integer, b text".into()), privilege: Execute, grantor: "app_owner".into() }],
        },
        Op::Privileges {
            add: false,
            on: OnTarget::Function("app".into(), "touch".into(), "order_id integer".into()),
            privileges: vec![Execute],
            grantee: "app_write".into(),
            effects: vec![AclEffect { object: ObjKey::Function("app".into(), "touch".into(), "order_id integer".into()), privilege: Execute, grantor: "app_owner".into() }],
        },
    ];
    let (mut cluster, mut db) = (s.cluster.clone(), s.db.clone());
    apply(&mut cluster, &mut db, &ops);
    assert!(cluster.databases[0].acl.contains(&entry("app_owner", Some("alice"), Privilege::Create)));
    // plain은 이미 PUBLIC EXECUTE가 있어서 늘지 않는다
    assert_eq!(db.functions.iter().find(|f| f.name == "plain").unwrap().acl.iter().filter(|e| e.grantee.is_none()).count(), 1);
    assert!(!db.functions.iter().find(|f| f.name == "touch").unwrap().acl.iter().any(|e| e.grantee.as_deref() == Some("app_write")));
}

// ───────────────────────── 구성원 관계 ─────────────────────────

fn membership(group: &str, member: &str, add: bool, admin: bool) -> PgChange {
    PgChange::Membership { group: group.into(), member: member.into(), add, admin }
}

fn managing(version: i32) -> Scene {
    let mut s = admin(version);
    let row = if version >= PG16 { member_grants("mm", "app_read", &[(BOOTSTRAP, true, Some(false), Some(true))]) } else { member_grants("mm", "app_read", &[(BOOTSTRAP, true, None, None)]) };
    s = s.add_member(row);
    s
}

#[test]
fn from_160000_a_new_grant_row_copies_the_members_inherit_attribute_and_sets_set() {
    let s = managing(PG16);
    let (cluster, _) = after(&s, &membership("app_read", "carol", true, false));
    assert_eq!(grants_of(&cluster, "carol", "app_read"), Some(vec![("mm".into(), false, Some(true), Some(true))]));
    // NOINHERIT인 구성원이면 INHERIT가 꺼진다
    let (cluster, _) = after(&s, &membership("app_read", "bob", true, true));
    let rows = grants_of(&cluster, "bob", "app_read").unwrap();
    assert_eq!(rows, vec![("mm".to_string(), true, Some(false), Some(true)), (BOOTSTRAP.to_string(), false, Some(false), Some(true))]);
    let merged = cluster.members.iter().find(|m| m.member == "bob" && m.group == "app_read").unwrap();
    assert!(merged.admin && merged.inherit == Some(false) && merged.set == Some(true));
}

#[test]
fn before_160000_a_new_pair_has_no_options_and_adding_admin_rewrites_the_grantor() {
    let s = managing(PG15);
    let (cluster, _) = after(&s, &membership("app_read", "carol", true, true));
    assert_eq!(grants_of(&cluster, "carol", "app_read"), Some(vec![("mm".into(), true, None, None)]));
    let carol = cluster.members.iter().find(|m| m.member == "carol" && m.group == "app_read").unwrap();
    assert!(carol.admin && carol.inherit.is_none() && carol.set.is_none());
    // 이미 있는 쌍에 ADMIN OPTION을 더하면 부여자가 로그인한 역할이 된다
    let (cluster, _) = after(&s, &membership("app_read", "bob", true, true));
    assert_eq!(grants_of(&cluster, "bob", "app_read"), Some(vec![("mm".into(), true, None, None)]));
}

#[test]
fn a_revoke_removes_the_row_or_clears_admin_and_a_pair_without_rows_disappears() {
    let s = managing(PG16).add_member(member_grants("bob", "app_read", &[(BOOTSTRAP, true, Some(false), Some(true)), ("mm", true, Some(true), Some(true))]));
    // mm의 줄만 거두면 부트스트랩의 줄이 남고 합친 값이 다시 계산된다
    let (cluster, _) = after(&s, &membership("app_read", "bob", false, false));
    assert_eq!(grants_of(&cluster, "bob", "app_read"), Some(vec![(BOOTSTRAP.to_string(), true, Some(false), Some(true))]));
    let bob = cluster.members.iter().find(|m| m.member == "bob" && m.group == "app_read").unwrap();
    assert_eq!((bob.admin, bob.inherit, bob.set), (true, Some(false), Some(true)));
    // ADMIN만 거두면 줄은 남고 ADMIN만 꺼진다
    let (cluster, _) = after(&s, &membership("app_read", "bob", false, true));
    assert_eq!(grants_of(&cluster, "bob", "app_read"), Some(vec![("mm".to_string(), false, Some(true), Some(true)), (BOOTSTRAP.to_string(), true, Some(false), Some(true))]));
    // 줄이 하나뿐이면 쌍이 없어진다
    let one = managing(PG16).add_member(member_grants("bob", "app_read", &[("mm", false, Some(true), Some(true))]));
    let (cluster, _) = after(&one, &membership("app_read", "bob", false, false));
    assert_eq!(grants_of(&cluster, "bob", "app_read"), None);
}

#[test]
fn before_160000_a_revoke_removes_the_pair_and_an_admin_revoke_clears_admin() {
    let s = managing(PG15).add_member(member_grants("carol", "app_read", &[("mm", true, None, None)]));
    let (cluster, _) = after(&s, &membership("app_read", "carol", false, true));
    assert_eq!(grants_of(&cluster, "carol", "app_read"), Some(vec![("mm".into(), false, None, None)]));
    let (cluster, _) = after(&s, &membership("app_read", "carol", false, false));
    assert_eq!(grants_of(&cluster, "carol", "app_read"), None);
}

// ───────────────────────── 역할 ─────────────────────────

fn create_zed(login: bool) -> PgChange {
    PgChange::CreateRole { name: "zed".into(), login, groups: vec![], connection_limit: 7, valid_until: Some("2027-01-01T00:00:00.000Z".into()), preset: None }
}

#[test]
fn a_created_role_has_inherit_and_nothing_else_and_the_next_free_oid() {
    let s = admin(PG15);
    let max = s.cluster.roles.iter().map(|r| r.oid).max().unwrap();
    let (cluster, _) = after(&s, &create_zed(true));
    let zed = cluster.roles.iter().find(|r| r.name == "zed").unwrap();
    assert_eq!(zed.oid, max + 1);
    assert_eq!(
        *zed,
        RoleRec { login: true, conn_limit: 7, valid_until: Some("2027-01-01T00:00:00Z".into()), oid: max + 1, ..role("zed") }
    );
    assert!(cluster.members.iter().all(|m| m.group != "zed"), "160000 전에는 암묵 부여가 없다");
}

#[test]
fn from_160000_a_createrole_login_gets_an_admin_row_from_the_bootstrap_superuser() {
    let s = admin(PG16);
    let (cluster, _) = after(&s, &create_zed(false));
    assert_eq!(grants_of(&cluster, "mm", "zed"), Some(vec![(BOOTSTRAP.to_string(), true, Some(false), Some(false))]));
    let mut root = admin(PG16);
    root.role_mut("mm").superuser = true;
    let (cluster, _) = after(&root, &create_zed(false));
    assert_eq!(grants_of(&cluster, "mm", "zed"), None);
}

#[test]
fn createrole_self_grant_adds_a_row_from_the_login_with_the_listed_options() {
    for (setting, inherit, set) in [("inherit, set", true, true), ("set", false, true), ("INHERIT", true, false)] {
        let mut s = admin(PG16);
        s.cluster.createrole_self_grant = setting.into();
        let (cluster, _) = after(&s, &create_zed(false));
        assert_eq!(
            grants_of(&cluster, "mm", "zed"),
            Some(vec![("mm".to_string(), false, Some(inherit), Some(set)), (BOOTSTRAP.to_string(), true, Some(false), Some(false))]),
            "{setting}"
        );
        let merged = cluster.members.iter().find(|m| m.member == "mm" && m.group == "zed").unwrap();
        assert_eq!((merged.admin, merged.inherit, merged.set), (true, Some(inherit), Some(set)));
    }
}

#[test]
fn the_read_only_preset_with_a_new_group_is_not_blocked_and_leaves_both_rows() {
    let mut s = admin(PG16);
    s.cluster.createrole_self_grant = "inherit, set".into();
    let preset = PresetChoice {
        preset: PresetKind::ReadOnly,
        database: Some("appdb".into()),
        schemas: vec!["app".into()],
        creators: vec!["app_owner".into()],
        group: Some("app_ro".into()),
        create_group: true,
    };
    let change = PgChange::CreateRole { name: "alice2".into(), login: true, groups: vec![], connection_limit: -1, valid_until: None, preset: Some(preset) };
    let resolved = resolve(&ResolveCtx { cluster: &s.cluster, db: &s.db, own_pids: &[], read_replica: false }, &change);
    assert_eq!(resolved.blocks, Vec::<String>::new());
    let (cluster, db) = after(&s, &change);
    // 그룹: 암묵적인 ADMIN 줄과 createrole_self_grant의 줄
    assert_eq!(
        grants_of(&cluster, "mm", "app_ro"),
        Some(vec![("mm".to_string(), false, Some(true), Some(true)), (BOOTSTRAP.to_string(), true, Some(false), Some(false))])
    );
    // 새 사용자는 로그인한 역할이 그룹에 넣었다
    assert_eq!(grants_of(&cluster, "alice2", "app_ro"), Some(vec![("mm".to_string(), false, Some(true), Some(true))]));
    // 권한과 기본 권한은 그룹이 받았다
    assert!(db.schemas.iter().find(|s| s.name == "app").unwrap().acl.contains(&entry("app_owner", Some("app_ro"), Usage)));
    let default = db.default_acls.iter().find(|d| d.creator == "app_owner" && d.schema.as_deref() == Some("app") && d.obj_type == DefaultObjType::Tables).unwrap();
    assert!(default.acl.contains(&entry("app_owner", Some("app_ro"), Select)));
}

#[test]
fn alter_drop_and_terminate_change_what_they_name() {
    let mut s = admin(PG16).add_member(member_grants("mm", "alice", &[(BOOTSTRAP, true, Some(false), Some(true))]));
    s.cluster.sessions.push(SessionRec {
        pid: 41,
        role: Some("alice".into()),
        database: None,
        client_addr: None,
        application_name: String::new(),
        state: None,
        backend_start: None,
        query_start: None,
        wait_event: None,
    });
    let alter = PgChange::Attributes {
        role: "alice".into(),
        set: crate::pg::change::model::AttributesSet { login: false, create_db: false, create_role: true, inherit: false, connection_limit: 3, valid_until: Some("2027-05-05T05:05:05Z".into()) },
    };
    let (cluster, _) = after(&s, &alter);
    let alice = cluster.roles.iter().find(|r| r.name == "alice").unwrap();
    assert_eq!((alice.login, alice.create_role, alice.inherit, alice.conn_limit, alice.valid_until.as_deref()), (false, true, false, 3, Some("2027-05-05T05:05:05Z")));

    let (cluster, _) = after(&s, &PgChange::Terminate { pid: 41, role: "alice".into(), backend_start: None });
    assert!(cluster.sessions.is_empty());

    // 삭제는 그 역할의 모든 구성원 관계를 지운다(구성원으로도 그룹으로도)
    let mut s = admin(PG16).add_role(login("newbie"));
    s = s.add_member(member_grants("mm", "newbie", &[(BOOTSTRAP, true, Some(false), Some(false))])).add_member(member_grants("newbie", "app_read", &[("mm", false, Some(true), Some(true))]));
    let (cluster, _) = after(&s, &PgChange::DropRole { role: "newbie".into() });
    assert!(cluster.roles.iter().all(|r| r.name != "newbie"));
    assert!(cluster.members.iter().all(|m| m.member != "newbie" && m.group != "newbie"));
    // 다른 쌍은 그대로다
    assert_eq!(cluster.members.len(), s.cluster.members.len() - 2);
}

// ───────────────────────── 기본 권한 ─────────────────────────

fn default_change(schema: Option<&str>, object_type: DefaultObjType, grantee: &str, privileges: &[Privilege], add: bool) -> PgChange {
    PgChange::DefaultPrivilege {
        database: "appdb".into(),
        creator: "app_owner".into(),
        schema: schema.map(Into::into),
        object_type,
        grantee: grantee.into(),
        privileges: privileges.to_vec(),
        add,
    }
}

fn record<'a>(db: &'a DbSnapshot, schema: Option<&str>, object_type: DefaultObjType) -> Option<&'a DefaultAclRec> {
    db.default_acls.iter().find(|d| d.creator == "app_owner" && d.schema.as_deref() == schema && d.obj_type == object_type)
}

fn pairs(rec: &DefaultAclRec) -> Vec<(Option<String>, Privilege)> {
    let mut all: Vec<_> = rec.acl.iter().map(|e| (e.grantee.clone(), e.privilege)).collect();
    all.sort();
    all
}

#[test]
fn a_global_grant_starts_from_the_built_in_default_with_the_creator_as_grantor() {
    let s = admin(PG16);
    let (_, db) = after(&s, &default_change(None, DefaultObjType::Tables, "alice", &[Select], true));
    let rec = record(&db, None, DefaultObjType::Tables).unwrap();
    assert!(rec.acl.iter().all(|e| e.grantor == "app_owner" && !e.grantable));
    assert_eq!(rec.acl.len(), 8, "소유자의 일곱 권한과 alice의 SELECT");
    assert!(rec.acl.contains(&entry("app_owner", Some("alice"), Select)));
    assert!(rec.acl.contains(&entry("app_owner", Some("app_owner"), Update)));
    // 17부터는 테이블의 소유자 기본값에 MAINTAIN이 들어 있다
    let s17 = admin(PG17);
    let (_, db) = after(&s17, &default_change(None, DefaultObjType::Tables, "alice", &[Select], true));
    assert!(record(&db, None, DefaultObjType::Tables).unwrap().acl.contains(&entry("app_owner", Some("app_owner"), Privilege::Maintain)));
}

#[test]
fn functions_and_types_start_with_public_and_a_record_equal_to_the_default_is_removed() {
    let s = admin(PG16);
    let (_, db) = after(&s, &default_change(None, DefaultObjType::Functions, "alice", &[Execute], true));
    let rec = record(&db, None, DefaultObjType::Functions).unwrap();
    assert_eq!(pairs(rec), vec![(None, Execute), (Some("alice".into()), Execute), (Some("app_owner".into()), Execute)]);
    // PUBLIC의 EXECUTE를 거두면 내장 기본값과 달라진다
    let (_, db) = after(&s, &default_change(None, DefaultObjType::Functions, "PUBLIC", &[Execute], false));
    assert_eq!(pairs(record(&db, None, DefaultObjType::Functions).unwrap()), vec![(Some("app_owner".into()), Execute)]);
    // 다시 주면 내장 기본값과 같아져서 기록이 없어진다
    let mut s2 = s.clone();
    s2.db = db;
    let (_, db) = after(&s2, &default_change(None, DefaultObjType::Functions, "PUBLIC", &[Execute], true));
    assert!(record(&db, None, DefaultObjType::Functions).is_none());
    // 주고 바로 거두면 기록이 남지 않는다
    let (_, db) = after(&s, &default_change(None, DefaultObjType::Tables, "alice", &[Select], true));
    let mut s3 = s.clone();
    s3.db = db;
    let (_, db) = after(&s3, &default_change(None, DefaultObjType::Tables, "alice", &[Select], false));
    assert!(record(&db, None, DefaultObjType::Tables).is_none());
}

#[test]
fn a_per_schema_record_starts_empty_and_is_removed_when_empty() {
    let s = admin(PG16);
    let (_, db) = after(&s, &default_change(Some("app"), DefaultObjType::Tables, "alice", &[Select, Delete], true));
    assert_eq!(pairs(record(&db, Some("app"), DefaultObjType::Tables).unwrap()), vec![(Some("alice".into()), Select), (Some("alice".into()), Delete)]);
    assert!(record(&db, None, DefaultObjType::Tables).is_none());
    let mut s2 = s.clone();
    s2.db = db;
    let (_, db) = after(&s2, &default_change(Some("app"), DefaultObjType::Tables, "alice", &[Select, Delete], false));
    assert!(record(&db, Some("app"), DefaultObjType::Tables).is_none());
}

#[test]
fn a_per_schema_revoke_does_not_touch_what_only_the_global_record_or_the_built_in_default_holds() {
    let mut s = admin(PG16);
    s.db.default_acls.push(DefaultAclRec {
        creator: "app_owner".into(),
        schema: None,
        obj_type: DefaultObjType::Tables,
        acl: vec![entry("app_owner", Some("alice"), Select), entry("app_owner", Some("app_owner"), Select)],
    });
    let before = s.db.default_acls.clone();
    let (_, db) = after(&s, &default_change(Some("app"), DefaultObjType::Tables, "alice", &[Select], false));
    assert_eq!(db.default_acls, before, "전역 기록의 항목은 스키마별 REVOKE로 안 지워진다");
    // 내장 기본값(기록 없음)에만 있는 항목도 마찬가지다
    let s = admin(PG16);
    let (_, db) = after(&s, &default_change(Some("app"), DefaultObjType::Functions, "PUBLIC", &[Execute], false));
    assert!(db.default_acls.is_empty());
    // 전역 REVOKE는 전역 항목을 지운다
    let mut g = admin(PG16);
    g.db.default_acls = before;
    let (_, db) = after(&g, &default_change(None, DefaultObjType::Tables, "alice", &[Select], false));
    assert!(!record(&db, None, DefaultObjType::Tables).unwrap().acl.iter().any(|e| e.grantee.as_deref() == Some("alice")));
}

#[test]
fn applying_nothing_changes_nothing() {
    let s = admin(PG16);
    let (cluster, db) = (s.cluster.clone(), s.db.clone());
    let (mut c, mut d) = (cluster.clone(), db.clone());
    apply(&mut c, &mut d, &[]);
    assert_eq!((c, d), (cluster, db));
}
