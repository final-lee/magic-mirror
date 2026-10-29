use super::*;
use crate::pg::change::support::{admin, strings};
use crate::pg::fixtures::*;
use crate::pg::model::Privilege::{self, Connect, Delete, Insert, Select, Update, Usage};
use crate::pg::model::{DefaultAclRec, DefaultObjType, RelKind};

/// 장면을 고치는 함수가 딸린 경우 하나
type Case = (&'static str, fn(&mut Scene));

fn suggestion(scene: &Scene, preset: PresetKind, schemas: &[&str]) -> PgPresetSuggestion {
    suggest(&scene.cluster, &scene.db, preset, &strings(schemas))
}

fn matching(scene: &Scene, preset: PresetKind, schemas: &[&str]) -> Vec<String> {
    suggestion(scene, preset, schemas).matching
}

fn default_record(creator: &str, schema: Option<&str>, obj_type: DefaultObjType, grants: &[(&str, &[Privilege])]) -> DefaultAclRec {
    let mut acl = vec![entry(creator, Some(creator), Select)];
    for (grantee, privileges) in grants {
        acl.extend(privileges.iter().map(|&p| entry(creator, Some(grantee), p)));
    }
    DefaultAclRec { creator: creator.into(), schema: schema.map(Into::into), obj_type, acl }
}

/// `app_read`가 스키마 `app`을 읽기 프리셋 그대로 가진 장면: 시퀀스 SELECT와, 지금 소유자 `app_owner`의 새 테이블·시퀀스에 대한 기본 권한까지
fn read_only_scene(version: i32) -> Scene {
    let mut scene = app_scene(version);
    let sequence = scene.db.relations.iter_mut().find(|r| r.name == "ticket_seq").unwrap();
    sequence.acl.push(entry("app_owner", Some("app_read"), Select));
    scene.db.default_acls.push(default_record("app_owner", Some("app"), DefaultObjType::Tables, &[("app_read", &[Select])]));
    scene.db.default_acls.push(default_record("app_owner", Some("app"), DefaultObjType::Sequences, &[("app_read", &[Select])]));
    scene
}

/// 읽기쓰기 프리셋 그대로 가진 그룹 `app_rw`를 더한 장면(`app` 스키마만)
fn read_write_scene(version: i32) -> Scene {
    let mut scene = app_scene(version).add_role(role("app_rw"));
    scene.cluster.databases[0] = scene.cluster.databases[0].clone().grant("app_rw", &[Connect]);
    scene.db.schemas.iter_mut().find(|s| s.name == "app").unwrap().acl.push(entry("app_owner", Some("app_rw"), Usage));
    for rel in scene.db.relations.iter_mut().filter(|r| r.schema == "app") {
        let privileges: &[Privilege] = match rel.kind {
            RelKind::Sequence => &[Select, Usage],
            RelKind::Table => &[Select, Insert, Update, Delete],
            _ => &[Select],
        };
        rel.acl.extend(privileges.iter().map(|&p| entry("app_owner", Some("app_rw"), p)));
    }
    scene.db.default_acls.push(default_record("app_owner", Some("app"), DefaultObjType::Tables, &[("app_rw", &[Select, Insert, Update, Delete])]));
    scene.db.default_acls.push(default_record("app_owner", Some("app"), DefaultObjType::Sequences, &[("app_rw", &[Select, Usage])]));
    scene
}

// ───────────────────────── 같은 권한을 가진 그룹 ─────────────────────────

#[test]
fn a_group_with_exactly_the_read_only_privileges_matches_and_no_other_does() {
    for version in [PG14, PG16] {
        let scene = read_only_scene(version);
        // app_write는 app_read의 권한을 물려받고 쓰기까지 있어서 읽기 프리셋이 아니다. alice·bob·carol은 로그인 역할이라 그룹이 아니다
        assert_eq!(matching(&scene, PresetKind::ReadOnly, &["app"]), vec!["app_read"], "{version}");
    }
}

#[test]
fn each_missing_piece_of_the_read_only_preset_breaks_the_match() {
    let cases: [Case; 6] = [
        ("스키마 USAGE가 없다", |s| s.db.schemas.iter_mut().find(|x| x.name == "app").unwrap().acl.retain(|e| e.grantee.as_deref() != Some("app_read"))),
        ("데이터베이스 CONNECT가 없다", |s| s.cluster.databases[0].acl.retain(|e| e.grantee.as_deref() != Some("app_read"))),
        ("읽지 못하는 뷰가 있다", |s| s.db.relations.iter_mut().find(|r| r.name == "order_totals").unwrap().acl.retain(|e| e.grantee.as_deref() != Some("app_read"))),
        ("시퀀스 SELECT가 없다", |s| s.db.relations.iter_mut().find(|r| r.name == "ticket_seq").unwrap().acl.retain(|e| e.grantee.as_deref() != Some("app_read"))),
        ("테이블 기본 권한이 없다", |s| s.db.default_acls.retain(|d| d.obj_type != DefaultObjType::Tables)),
        ("시퀀스 기본 권한이 없다", |s| s.db.default_acls.retain(|d| d.obj_type != DefaultObjType::Sequences)),
    ];
    for (why, edit) in cases {
        let mut scene = read_only_scene(PG16);
        edit(&mut scene);
        assert!(matching(&scene, PresetKind::ReadOnly, &["app"]).is_empty(), "{why}");
    }
}

#[test]
fn a_group_that_can_also_write_or_create_is_not_read_only() {
    let mut writes = read_only_scene(PG16);
    writes.db.relations.iter_mut().find(|r| r.name == "customers").unwrap().acl.push(entry("app_owner", Some("app_read"), Insert));
    assert!(matching(&writes, PresetKind::ReadOnly, &["app"]).is_empty());

    let mut creates = read_only_scene(PG16);
    creates.db.schemas.iter_mut().find(|s| s.name == "app").unwrap().acl.push(entry("app_owner", Some("app_read"), Privilege::Create));
    assert!(matching(&creates, PresetKind::ReadOnly, &["app"]).is_empty());
}

#[test]
fn a_default_privilege_for_a_global_record_or_an_inherited_role_counts() {
    // 모든 스키마의 기록
    let mut global = read_only_scene(PG16);
    for record in &mut global.db.default_acls {
        record.schema = None;
    }
    assert_eq!(matching(&global, PresetKind::ReadOnly, &["app"]), vec!["app_read"]);

    // 기본 권한을 그룹이 아니라 그룹이 물려받는 역할에게 줬다: app_ro는 app_base의 권한을 물려받는다
    let mut inherited = read_only_scene(PG16);
    inherited = inherited.add_role(role("app_ro")).add_role(role("app_base")).add_member(member_with("app_ro", "app_base", true, true));
    for rel in inherited.db.relations.iter_mut().filter(|r| r.schema == "app") {
        rel.acl.extend([entry("app_owner", Some("app_base"), Select)]);
    }
    inherited.db.schemas.iter_mut().find(|s| s.name == "app").unwrap().acl.push(entry("app_owner", Some("app_base"), Usage));
    inherited.cluster.databases[0] = inherited.cluster.databases[0].clone().grant("app_base", &[Connect]);
    for record in &mut inherited.db.default_acls {
        record.acl.push(entry("app_owner", Some("app_base"), Select));
    }
    assert_eq!(matching(&inherited, PresetKind::ReadOnly, &["app"]), vec!["app_base", "app_read", "app_ro"]);
}

#[test]
fn the_group_itself_owning_tables_needs_no_default_privilege_for_itself() {
    // 테이블 소유자가 그룹 자신이면 그 소유자의 기본 권한은 따지지 않는다
    let mut scene = read_only_scene(PG16);
    scene.db.default_acls.clear();
    for rel in &mut scene.db.relations {
        if rel.schema == "app" {
            rel.owner = "app_read".into();
            rel.acl = vec![entry("app_read", Some("app_read"), Select)];
        }
    }
    assert_eq!(matching(&scene, PresetKind::ReadOnly, &["app"]), vec!["app_read"]);
}

#[test]
fn the_read_write_preset_needs_insert_update_delete_on_every_table_and_usage_on_sequences() {
    for version in [PG14, PG16] {
        let scene = read_write_scene(version);
        assert_eq!(matching(&scene, PresetKind::ReadWrite, &["app"]), vec!["app_rw"], "{version}");
        // 읽기 프리셋으로는 쓰기가 있는 그룹이 맞지 않는다
        assert!(!matching(&scene, PresetKind::ReadOnly, &["app"]).contains(&"app_rw".to_string()));
    }
    let cases: [Case; 4] = [
        ("DELETE가 없는 테이블이 있다", |s| s.db.relations.iter_mut().find(|r| r.name == "orders").unwrap().acl.retain(|e| !(e.grantee.as_deref() == Some("app_rw") && e.privilege == Delete))),
        ("시퀀스 USAGE가 없다", |s| s.db.relations.iter_mut().find(|r| r.name == "ticket_seq").unwrap().acl.retain(|e| !(e.grantee.as_deref() == Some("app_rw") && e.privilege == Usage))),
        ("테이블 기본 권한이 SELECT뿐이다", |s| {
            s.db.default_acls.iter_mut().filter(|d| d.obj_type == DefaultObjType::Tables).for_each(|d| d.acl.retain(|e| e.grantee.as_deref() != Some("app_rw") || e.privilege == Select))
        }),
        ("시퀀스 기본 권한에 USAGE가 없다", |s| {
            s.db.default_acls.iter_mut().filter(|d| d.obj_type == DefaultObjType::Sequences).for_each(|d| d.acl.retain(|e| !(e.grantee.as_deref() == Some("app_rw") && e.privilege == Usage)))
        }),
    ];
    for (why, edit) in cases {
        let mut scene = read_write_scene(PG16);
        edit(&mut scene);
        assert!(matching(&scene, PresetKind::ReadWrite, &["app"]).is_empty(), "{why}");
    }
}

#[test]
fn the_owner_preset_needs_usage_and_create_on_every_chosen_schema_and_connect() {
    let mut scene = app_scene(PG16).add_role(role("app_dev"));
    scene.cluster.databases[0] = scene.cluster.databases[0].clone().grant("app_dev", &[Connect]);
    for name in ["app", "audit"] {
        scene.db.schemas.iter_mut().find(|s| s.name == name).unwrap().acl.extend([entry("app_owner", Some("app_dev"), Usage), entry("app_owner", Some("app_dev"), Privilege::Create)]);
    }
    assert_eq!(matching(&scene, PresetKind::Owner, &["app", "audit"]), vec!["app_dev"]);
    // 고른 스키마 가운데 하나라도 모자라면 맞지 않는다
    assert!(matching(&scene, PresetKind::Owner, &["app", "scratch"]).is_empty());
    // CREATE 없이 USAGE만 있는 app_read는 맞지 않는다
    assert!(!matching(&scene, PresetKind::Owner, &["app"]).contains(&"app_read".to_string()));
}

#[test]
fn the_admin_preset_and_an_empty_schema_choice_match_nothing() {
    let scene = read_only_scene(PG16);
    assert!(matching(&scene, PresetKind::Admin, &[]).is_empty());
    assert!(matching(&scene, PresetKind::Admin, &["app"]).is_empty());
    assert!(matching(&scene, PresetKind::ReadOnly, &[]).is_empty());
}

#[test]
fn system_roles_and_login_roles_are_never_offered() {
    let mut scene = read_only_scene(PG16).add_role(role("rds_reader")).add_role(login("app_login_ro"));
    for name in ["rds_reader", "app_login_ro"] {
        scene.cluster.databases[0] = scene.cluster.databases[0].clone().grant(name, &[Connect]);
        scene.db.schemas.iter_mut().find(|s| s.name == "app").unwrap().acl.push(entry("app_owner", Some(name), Usage));
        for rel in scene.db.relations.iter_mut().filter(|r| r.schema == "app") {
            rel.acl.push(entry("app_owner", Some(name), Select));
        }
        scene.db.default_acls.iter_mut().for_each(|d| d.acl.push(entry("app_owner", Some(name), Select)));
    }
    assert_eq!(matching(&scene, PresetKind::ReadOnly, &["app"]), vec!["app_read"]);
}

#[test]
fn matching_groups_come_in_name_order() {
    let mut scene = read_only_scene(PG16);
    for name in ["zz_ro", "aa_ro"] {
        scene = scene.add_role(role(name));
        scene.cluster.databases[0] = scene.cluster.databases[0].clone().grant(name, &[Connect]);
        scene.db.schemas.iter_mut().find(|s| s.name == "app").unwrap().acl.push(entry("app_owner", Some(name), Usage));
        for rel in scene.db.relations.iter_mut().filter(|r| r.schema == "app") {
            rel.acl.push(entry("app_owner", Some(name), Select));
        }
        scene.db.default_acls.iter_mut().for_each(|d| d.acl.push(entry("app_owner", Some(name), Select)));
    }
    assert_eq!(matching(&scene, PresetKind::ReadOnly, &["app"]), vec!["aa_ro", "app_read", "zz_ro"]);
}

// ───────────────────────── 이름 ─────────────────────────

fn name_of(scene: &Scene, preset: PresetKind, schemas: &[&str]) -> String {
    suggestion(scene, preset, schemas).proposed_name
}

#[test]
fn the_proposed_name_is_schema_or_database_plus_the_preset_suffix() {
    let scene = app_scene(PG16);
    assert_eq!(name_of(&scene, PresetKind::ReadOnly, &["orders"]), "orders_read");
    assert_eq!(name_of(&scene, PresetKind::ReadWrite, &["orders"]), "orders_write");
    assert_eq!(name_of(&scene, PresetKind::Owner, &["orders"]), "orders_owner");
    assert_eq!(name_of(&scene, PresetKind::ReadOnly, &["orders", "audit"]), "appdb_read");
    assert_eq!(name_of(&scene, PresetKind::Owner, &["orders", "audit"]), "appdb_owner");
    assert_eq!(name_of(&scene, PresetKind::Admin, &[]), "");
}

#[test]
fn the_proposed_name_is_lowercase_ascii_word_characters_and_at_most_63_bytes() {
    let scene = app_scene(PG16);
    assert_eq!(name_of(&scene, PresetKind::ReadOnly, &["My-Schema.한글"]), "my_schema____read");
    let long = "x".repeat(80);
    let name = name_of(&scene, PresetKind::ReadOnly, &[&long]);
    assert_eq!(name.len(), 63);
    assert!(name.chars().all(|c| c == 'x'));
}

#[test]
fn a_taken_name_gets_a_number_that_still_fits_in_63_bytes() {
    // app_read는 이미 있다
    let scene = app_scene(PG16);
    assert_eq!(name_of(&scene, PresetKind::ReadOnly, &["app"]), "app_read_2");
    let scene = scene.add_role(role("app_read_2")).add_role(role("app_read_3"));
    assert_eq!(name_of(&scene, PresetKind::ReadOnly, &["app"]), "app_read_4");
    // 한도에 닿는 이름은 앞을 줄여 번호를 붙인다
    let long = "y".repeat(80);
    let first = name_of(&scene, PresetKind::ReadOnly, &[&long]);
    let scene = scene.add_role(role(&first));
    let second = name_of(&scene, PresetKind::ReadOnly, &[&long]);
    assert_eq!(second.len(), 63);
    assert!(second.ends_with("_2") && second != first, "{second}");
}

// ───────────────────────── 만드는 역할 ─────────────────────────

#[test]
fn creators_are_the_distinct_owners_of_relations_in_the_chosen_schemas_without_system_roles() {
    let mut scene = admin(PG16);
    scene = scene.add_role(role("zed")).add_role(role("rds_admin_x"));
    scene.db.relations.push(table("scratch", "z1", "zed"));
    scene.db.relations.push(relation(RelKind::Sequence, "scratch", "z1_seq", "zed"));
    scene.db.relations.push(table("scratch", "sys1", "rds_admin_x"));
    assert_eq!(suggestion(&scene, PresetKind::ReadOnly, &["scratch"]).creators, vec!["zed"]);
    assert_eq!(suggestion(&scene, PresetKind::ReadOnly, &["app", "scratch"]).creators, vec!["app_owner", "zed"]);
    assert!(suggestion(&scene, PresetKind::ReadOnly, &["audit"]).creators == vec!["app_owner"]);
    assert!(suggestion(&scene, PresetKind::Admin, &[]).creators.is_empty());
}

#[test]
fn creators_the_login_cannot_set_defaults_for_come_with_the_block_text() {
    for version in [PG14, PG16] {
        let mut scene = admin(version).add_role(role("zed"));
        scene.db.relations.push(table("scratch", "z1", "zed"));
        let result = suggestion(&scene, PresetKind::ReadOnly, &["app", "scratch"]);
        assert_eq!(result.creators, vec!["app_owner", "zed"]);
        // mm은 app_owner의 구성원이고 zed와는 이어져 있지 않다
        let expected_reason = if version >= PG16 {
            "zed 역할의 기본 권한을 바꿀 수 없어요. 로그인한 역할이 zed 역할의 권한을 물려받아야 해요"
        } else {
            "zed 역할의 기본 권한을 바꿀 수 없어요. 로그인한 역할이 zed 역할의 구성원이어야 해요"
        };
        assert_eq!(result.blocked_creators, vec![PgBlockedCreator { role: "zed".into(), reason: expected_reason.into() }], "{version}");
    }
}

#[test]
fn the_suggestion_serializes_in_camel_case() {
    let json = serde_json::to_value(suggestion(&app_scene(PG16), PresetKind::ReadOnly, &["app"])).unwrap();
    assert!(json.get("proposedName").is_some() && json.get("blockedCreators").is_some() && json.get("matching").is_some() && json.get("creators").is_some(), "{json}");
}
