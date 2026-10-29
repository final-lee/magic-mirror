use super::inverse;
use crate::pg::change::model::{GrantTarget::*, PgChange, PresetChoice, PresetKind};
use crate::pg::change::support::*;
use crate::pg::fixtures::*;
use crate::pg::model::DefaultObjType;
use crate::pg::model::Privilege::{Connect, Delete, Insert, Select, Update, Usage};

fn inv(scene: &Scene, change: &PgChange) -> Option<Vec<PgChange>> {
    inverse(&ctx(scene), change)
}

fn create(name: &str, login: bool, groups: &[&str], preset: Option<PresetChoice>) -> PgChange {
    PgChange::CreateRole { name: name.into(), login, groups: strings(groups), connection_limit: -1, valid_until: None, preset }
}

fn read_only(group: Option<&str>, create_group: bool) -> PresetChoice {
    PresetChoice {
        preset: PresetKind::ReadOnly,
        database: Some("appdb".into()),
        schemas: strings(&["app"]),
        creators: strings(&["app_owner"]),
        group: group.map(Into::into),
        create_group,
    }
}

fn drop_role(role: &str) -> PgChange {
    PgChange::DropRole { role: role.into() }
}

fn revoke_all(grantee: &str) -> PgChange {
    grant(
        grantee,
        false,
        vec![
            item(Database { name: "appdb".into() }, &[Connect]),
            item(Schema { name: "app".into() }, &[Usage]),
            item(all_tables("app"), &[Select]),
            item(AllSequences { schema: "app".into() }, &[Select]),
        ],
    )
}

fn default_remove(grantee: &str, object_type: DefaultObjType) -> PgChange {
    default_change("app_owner", Some("app"), object_type, grantee, &[Select], false)
}

// ───────────────────────── 역할 만들기 ─────────────────────────

#[test]
fn creating_a_role_with_a_new_group_is_undone_by_revoking_the_presets_items_and_dropping_both() {
    for version in [PG15, PG16] {
        let s = admin(version);
        let change = create("dave", true, &[], Some(read_only(Some("app_ro"), true)));
        assert_eq!(
            inv(&s, &change),
            Some(vec![revoke_all("app_ro"), default_remove("app_ro", DefaultObjType::Tables), default_remove("app_ro", DefaultObjType::Sequences), drop_role("dave"), drop_role("app_ro")]),
            "{version}"
        );
    }
}

#[test]
fn a_role_holding_its_own_preset_is_undone_by_its_revokes_then_the_drop() {
    let s = admin(PG16);
    let change = create("dave", false, &[], Some(read_only(None, false)));
    assert_eq!(inv(&s, &change), Some(vec![revoke_all("dave"), default_remove("dave", DefaultObjType::Tables), default_remove("dave", DefaultObjType::Sequences), drop_role("dave")]));
}

#[test]
fn an_existing_group_or_no_preset_is_undone_by_the_drop_alone() {
    let s = admin(PG16);
    assert_eq!(inv(&s, &create("dave", false, &["app_read"], None)), Some(vec![drop_role("dave")]));
    assert_eq!(inv(&s, &create("dave", true, &[], Some(read_only(Some("app_read"), false)))), Some(vec![drop_role("dave")]));
    let admin_preset = PresetChoice { preset: PresetKind::Admin, database: None, schemas: Vec::new(), creators: Vec::new(), group: None, create_group: false };
    assert_eq!(inv(&s, &create("dave", true, &[], Some(admin_preset))), Some(vec![drop_role("dave")]));
    // 만들어지지 않는 변경(이름이 이미 있다)은 아무것도 바꾸지 않는다
    assert_eq!(inv(&s, &create("alice", false, &[], None)), Some(Vec::new()));
}

// ───────────────────────── 구성원 관계 ─────────────────────────

fn leave() -> Vec<PgChange> {
    vec![membership("app_read", "carol", false, false)]
}

#[test]
fn adding_a_member_is_undone_by_removing_the_row_it_created() {
    for version in [PG15, PG16] {
        let s = admin_of(version, &["app_read"]);
        assert_eq!(inv(&s, &membership("app_read", "carol", true, false)), Some(leave()), "{version}");
    }
    // 160000부터 그 부여자의 줄이 이미 있으면 바뀌는 게 없다
    let done = admin_of(PG16, &["app_read"]).add_member(member_grants("carol", "app_read", &[("mm", false, Some(true), Some(true))]));
    assert_eq!(inv(&done, &membership("app_read", "carol", true, false)), Some(Vec::new()));
    // 160000 전에는 쌍이 있으면 바뀌는 게 없다
    let done = admin(PG15).add_member(member("carol", "app_read"));
    assert_eq!(inv(&done, &membership("app_read", "carol", true, false)), Some(Vec::new()));
}

#[test]
fn adding_beside_other_grantors_rows_cannot_be_undone_from_160000() {
    // bob의 줄은 부트스트랩이 줬다. GRANT는 mm의 새 줄을 더하지만, 거두기는 그 줄만 짚을 수 없다
    let s = admin_of(PG16, &["app_read"]);
    assert_eq!(inv(&s, &membership("app_read", "bob", true, false)), None);
    assert_eq!(inv(&s, &membership("app_read", "bob", true, true)), None);
}

#[test]
fn granting_admin_is_undone_by_a_full_or_an_admin_only_remove() {
    for version in [PG15, PG16] {
        // 쌍이 없었다: 모두 거둔다
        let s = admin_of(version, &["app_read"]);
        assert_eq!(inv(&s, &membership("app_read", "carol", true, true)), Some(leave()), "{version}");
    }
    // 쌍이 있었다: ADMIN만 거둔다
    let s15 = admin(PG15);
    assert_eq!(inv(&s15, &membership("app_read", "bob", true, true)), Some(vec![membership("app_read", "bob", false, true)]));
    let s16 = admin_of(PG16, &["app_read"]).add_member(member_grants("bob", "app_read", &[("mm", false, Some(false), Some(true))]));
    assert_eq!(inv(&s16, &membership("app_read", "bob", true, true)), Some(vec![membership("app_read", "bob", false, true)]));
    // 다른 부여자의 ADMIN 줄이 있으면 ADMIN만 거두기가 그 줄에서도 ADMIN을 빼 버린다
    let other = admin_of(PG16, &["app_read"]).add_member(member_grants("bob", "app_read", &[("mm", false, Some(false), Some(true)), ("app_owner", true, Some(false), Some(true))]));
    assert_eq!(inv(&other, &membership("app_read", "bob", true, true)), None);
}

fn with_row(grants: &[(&str, bool, Option<bool>, Option<bool>)]) -> Scene {
    admin_of(PG16, &["app_read"]).add_member(member_grants("bob", "app_read", grants))
}

#[test]
fn removing_a_member_is_undone_by_a_grant_when_one_row_can_be_restored_exactly() {
    // bob은 NOINHERIT라 새 부여의 INHERIT가 꺼진다: 줄의 옵션과 같으면 되살릴 수 있다
    let s = with_row(&[("mm", false, Some(false), Some(true))]);
    assert_eq!(inv(&s, &membership("app_read", "bob", false, false)), Some(vec![membership("app_read", "bob", true, false)]));
    // ADMIN이 있던 줄이면 ADMIN까지 되살린다
    let s = with_row(&[("mm", true, Some(false), Some(true))]);
    assert_eq!(inv(&s, &membership("app_read", "bob", false, false)), Some(vec![membership("app_read", "bob", true, true)]));
    // ADMIN만 거두면 ADMIN만 되살린다(줄은 남는다)
    assert_eq!(inv(&s, &membership("app_read", "bob", false, true)), Some(vec![membership("app_read", "bob", true, true)]));
}

#[test]
fn removing_a_member_whose_row_a_regrant_cannot_restore_cannot_be_undone() {
    // INHERIT 옵션이 구성원의 속성과 다르다(bob은 NOINHERIT인데 줄은 INHERIT)
    assert_eq!(inv(&with_row(&[("mm", false, Some(true), Some(true))]), &membership("app_read", "bob", false, false)), None);
    // SET이 꺼져 있다
    assert_eq!(inv(&with_row(&[("mm", false, Some(false), Some(false))]), &membership("app_read", "bob", false, false)), None);
    // 거두는 줄이 둘이다(다시 줄 부여자는 하나다)
    let two = with_row(&[("mm", false, Some(false), Some(true)), ("app_owner", false, Some(false), Some(true))]);
    assert_eq!(inv(&two, &membership("app_read", "bob", false, false)), None);
    // 다시 주면 부여자가 달라진다(줄은 app_owner가 줬는데 다시 주는 쪽은 mm이다)
    let other = with_row(&[("app_owner", false, Some(false), Some(true))]);
    assert_eq!(inv(&other, &membership("app_read", "bob", false, false)), None);
}

#[test]
fn removing_a_member_before_160000_is_undone_by_the_opposite_add() {
    let s = admin(PG15);
    assert_eq!(inv(&s, &membership("app_read", "bob", false, false)), Some(vec![membership("app_read", "bob", true, false)]));
    let mut with_admin = s.clone();
    with_admin.member_mut("bob", "app_read").admin = true;
    with_admin.member_mut("bob", "app_read").grants[0].admin = true;
    assert_eq!(inv(&with_admin, &membership("app_read", "bob", false, false)), Some(vec![membership("app_read", "bob", true, true)]));
    assert_eq!(inv(&with_admin, &membership("app_read", "bob", false, true)), Some(vec![membership("app_read", "bob", true, true)]));
    // 없는 구성원 관계를 거두는 것은 바꾸는 게 없다
    assert_eq!(inv(&s, &membership("app_read", "carol", false, false)), Some(Vec::new()));
}

// ───────────────────────── 속성, 권한, 기본 권한 ─────────────────────────

#[test]
fn attributes_are_undone_by_the_before_set() {
    let s = admin_of(PG16, &["alice"]);
    let change = attributes(&s, "alice", |set| {
        set.login = false;
        set.connection_limit = 4;
        set.valid_until = Some("2030-01-01T00:00:00Z".into());
    });
    let back = attributes(&s, "alice", |_| {});
    assert_eq!(inv(&s, &change), Some(vec![back.clone()]));
    // 달라지는 게 없으면 바꾸지 않는다
    assert_eq!(inv(&s, &back), Some(Vec::new()));
}

#[test]
fn a_grant_is_undone_by_revoking_exactly_the_entries_it_added() {
    let s = admin(PG16);
    // ALL TABLES는 객체마다로 펼쳐지고, 되돌림도 객체마다다(allTables는 쓰지 않는다)
    let change = grant("app_read", true, vec![item(all_tables("audit"), &[Select])]);
    let expected = grant("app_read", false, vec![item(rel("audit", "events"), &[Select]), item(rel("audit", "remote_log"), &[Select])]);
    assert_eq!(inv(&s, &change), Some(vec![expected]));
    // 이미 있는 항목은 되돌림에 넣지 않는다: customers는 app_read가 이미 읽는다
    let mixed = grant("app_read", true, vec![item(rel("app", "customers"), &[Select, Update]), item(rel("audit", "events"), &[Select])]);
    let expected = grant("app_read", false, vec![item(rel("app", "customers"), &[Update]), item(rel("audit", "events"), &[Select])]);
    assert_eq!(inv(&s, &mixed), Some(vec![expected]));
    // 같은 객체는 하나의 항목이다
    let split = grant("app_read", true, vec![item(rel("audit", "events"), &[Select]), item(rel("audit", "events"), &[Insert, Delete])]);
    assert_eq!(inv(&s, &split), Some(vec![grant("app_read", false, vec![item(rel("audit", "events"), &[Select, Insert, Delete])])]));
    // 이미 다 있으면 바뀌는 게 없다
    assert_eq!(inv(&s, &grant("app_read", true, vec![item(rel("app", "customers"), &[Select])])), Some(Vec::new()));
}

#[test]
fn a_revoke_is_undone_by_granting_exactly_the_removed_entries() {
    let s = admin(PG16);
    let change = grant("app_read", false, vec![item(rel("app", "customers"), &[Select]), item(rel("app", "orders"), &[Select, Update])]);
    // orders의 UPDATE는 app_read에게 없다: 실제로 거둔 SELECT만 되돌린다
    let expected = grant("app_read", true, vec![item(rel("app", "customers"), &[Select]), item(rel("app", "orders"), &[Select])]);
    assert_eq!(inv(&s, &change), Some(vec![expected]));
    // 시퀀스는 시퀀스 대상으로 돌려준다
    let seq = grant("app_write", false, vec![item(Sequence { schema: "app".into(), name: "ticket_seq".into() }, &[Usage])]);
    assert_eq!(inv(&s, &seq), Some(vec![grant("app_write", true, vec![item(Sequence { schema: "app".into(), name: "ticket_seq".into() }, &[Usage])])]));
    // 거둘 게 없으면 바뀌는 게 없다
    assert_eq!(inv(&s, &grant("app_read", false, vec![item(rel("audit", "events"), &[Select])])), Some(Vec::new()));
}

#[test]
fn revoking_a_grant_option_cannot_be_undone() {
    let mut s = admin(PG16);
    s.db.relations.iter_mut().find(|r| r.name == "customers").unwrap().acl.iter_mut().find(|e| e.grantee.as_deref() == Some("app_read")).unwrap().grantable = true;
    assert_eq!(inv(&s, &grant("app_read", false, vec![item(rel("app", "customers"), &[Select])])), None);
}

#[test]
fn a_default_privilege_is_undone_by_the_opposite_for_what_changed() {
    let mut s = admin(PG16);
    s.db.default_acls.push(crate::pg::model::DefaultAclRec {
        creator: "app_owner".into(),
        schema: Some("app".into()),
        obj_type: DefaultObjType::Tables,
        acl: vec![entry("app_owner", Some("app_read"), Select)],
    });
    // 이미 있는 SELECT는 되돌림에 넣지 않는다
    let add = default_change("app_owner", Some("app"), DefaultObjType::Tables, "app_read", &[Select, Update], true);
    assert_eq!(inv(&s, &add), Some(vec![default_change("app_owner", Some("app"), DefaultObjType::Tables, "app_read", &[Update], false)]));
    let remove = default_change("app_owner", Some("app"), DefaultObjType::Tables, "app_read", &[Select, Update], false);
    assert_eq!(inv(&s, &remove), Some(vec![default_change("app_owner", Some("app"), DefaultObjType::Tables, "app_read", &[Select], true)]));
    // 바뀌는 게 없다
    assert_eq!(inv(&s, &default_change("app_owner", Some("app"), DefaultObjType::Tables, "app_read", &[Select], true)), Some(Vec::new()));
    assert_eq!(inv(&s, &default_change("app_owner", Some("app"), DefaultObjType::Tables, "app_write", &[Select], false)), Some(Vec::new()));
}

#[test]
fn a_global_default_starts_from_the_built_in_one() {
    let s = admin(PG16);
    // 소유자 자신의 내장 SELECT를 모든 스키마에서 빼면 그만큼 되돌린다
    let remove = default_change("app_owner", None, DefaultObjType::Tables, "app_owner", &[Select], false);
    assert_eq!(inv(&s, &remove), Some(vec![default_change("app_owner", None, DefaultObjType::Tables, "app_owner", &[Select], true)]));
}

#[test]
fn password_drop_and_terminate_cannot_be_undone() {
    let s = admin_of(PG16, &["alice"]);
    assert_eq!(inv(&s, &PgChange::Password { role: "alice".into() }), None);
    assert_eq!(inv(&s, &drop_role("alice")), None);
    assert_eq!(inv(&s, &PgChange::Terminate { pid: 1, role: "alice".into(), backend_start: None }), None);
}
