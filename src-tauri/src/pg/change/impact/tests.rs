use crate::pg::change::model::PgChange;
use crate::pg::change::preview::preview;
use crate::pg::change::support::*;
use crate::pg::fixtures::*;
use crate::pg::model::DefaultObjType;
use crate::pg::model::Privilege::Select;
use crate::pg::view::PgPreview;

fn roles_of(preview: &PgPreview) -> Vec<&str> {
    preview.impacts.iter().map(|i| i.role.as_str()).collect()
}

fn run(scene: &Scene, change: &PgChange) -> PgPreview {
    preview(&ctx(scene), change)
}

#[test]
fn a_grant_reaches_the_grantee_and_everyone_who_inherits_it() {
    for version in [PG15, PG16] {
        let s = admin(version);
        let p = run(&s, &grant("app_read", true, vec![item(rel("audit", "events"), &[Select])]));
        assert_eq!(p.warnings.iter().filter(|w| w.level == crate::pg::view::PgWarnLevel::Block).count(), 0, "{version}");
        // bob는 NOINHERIT라 app_read의 권한을 쓰지 않는다
        assert_eq!(roles_of(&p), vec!["alice", "app_read", "app_write"], "{version}");
        let delta = &p.impacts[1].gained;
        assert_eq!(delta.len(), 1);
        assert_eq!(
            (delta[0].database.as_str(), delta[0].schema.as_deref(), delta[0].object_kind, delta[0].privilege.as_str(), delta[0].count, delta[0].sample.clone()),
            ("appdb", Some("audit"), PgObjectKind::Partitioned, "SELECT", 1, strings(&["events"]))
        );
        assert!(p.impacts.iter().all(|i| i.lost.is_empty()));
    }
}

#[test]
fn leaving_a_group_shows_what_the_member_loses_through_it() {
    for version in [PG15, PG16] {
        // alice의 구성원 관계를 mm이 줬다고 둔다(160000부터는 부여자가 거둘 수 있는 역할이어야 한다)
        let s = admin_of(version, &["app_write"]).add_member(member_grants("alice", "app_write", &[("mm", false, Some(true), Some(true))]));
        let p = run(&s, &membership("app_write", "alice", false, false));
        assert_eq!(p.warnings.iter().filter(|w| w.level == crate::pg::view::PgWarnLevel::Block).count(), 0, "{version}: {:?}", p.warnings);
        assert_eq!(roles_of(&p), vec!["alice"], "{version}");
        let lost = &p.impacts[0].lost;
        assert!(p.impacts[0].gained.is_empty());
        let find = |schema: Option<&str>, kind, privilege: &str| lost.iter().find(|d| d.schema.as_deref() == schema && d.object_kind == kind && d.privilege == privilege);
        // app_read가 준 읽기와 app_write가 준 쓰기, 시퀀스, 함수, 스키마와 데이터베이스
        let tables = find(Some("app"), PgObjectKind::Table, "SELECT").expect("테이블 읽기");
        assert_eq!((tables.count, tables.sample.clone()), (2, strings(&["customers", "orders"])));
        assert_eq!(find(Some("app"), PgObjectKind::Table, "UPDATE").map(|d| d.sample.clone()), Some(strings(&["orders"])));
        assert_eq!(find(Some("app"), PgObjectKind::Sequence, "USAGE").map(|d| d.sample.clone()), Some(strings(&["ticket_seq"])));
        assert_eq!(find(Some("app"), PgObjectKind::Function, "EXECUTE").map(|d| d.sample.clone()), Some(strings(&["touch(order_id integer)"])));
        let schemas = find(None, PgObjectKind::Schema, "USAGE").expect("스키마");
        assert_eq!((schemas.count, schemas.sample.clone()), (2, strings(&["app", "audit"])));
        let database = find(None, PgObjectKind::Database, "CONNECT").expect("데이터베이스");
        assert_eq!((database.database.as_str(), database.sample.clone()), ("appdb", strings(&["appdb"])));
        // 묶음은 (데이터베이스, 스키마, 종류, 권한) 순서다
        let keys: Vec<_> = lost.iter().map(|d| (d.database.clone(), d.schema.clone(), d.object_kind, d.privilege.clone())).collect();
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(keys.len(), sorted.len());
    }
}

#[test]
fn a_public_grant_reaches_every_role_that_lacks_the_privilege() {
    let s = admin(PG16);
    let p = run(&s, &grant("PUBLIC", true, vec![item(rel("audit", "events"), &[Select])]));
    // 소유자는 이미 갖고, carol은 pg_read_all_data로 이미 읽는다
    assert_eq!(roles_of(&p), vec!["alice", "app_read", "app_write", "bob"]);
    assert!(p.impacts.iter().all(|i| i.gained.len() == 1 && i.gained[0].count == 1));
    // app_read가 이미 읽는 테이블은 NOINHERIT인 bob만 얻는다(app_read의 권한을 쓰지 않으니)
    let again = run(&s, &grant("PUBLIC", true, vec![item(rel("app", "customers"), &[Select])]));
    assert_eq!(roles_of(&again), vec!["bob"]);
}

#[test]
fn at_most_thirty_roles_are_listed_and_the_rest_are_counted() {
    let mut s = admin(PG16);
    for n in 0..40 {
        s = s.add_role(role(&format!("extra{n:02}")));
    }
    let p = run(&s, &grant("PUBLIC", true, vec![item(rel("audit", "events"), &[Select])]));
    assert_eq!(p.impacts.len(), 30);
    assert_eq!(p.impacts_omitted, 44 - 30);
    let names = roles_of(&p);
    let mut sorted = names.clone();
    sorted.sort();
    assert_eq!(names, sorted);
    assert_eq!(names[0], "alice");
}

#[test]
fn joining_a_group_that_reads_everything_shows_gains_on_every_table() {
    let s = admin_of(PG16, &["reader_grp"])
        .add_role(role("reader_grp"))
        .add_role(role("newbie"))
        .add_member(member_with("reader_grp", "pg_read_all_data", true, true));
    let p = run(&s, &membership("reader_grp", "newbie", true, false));
    assert_eq!(p.warnings.iter().filter(|w| w.level == crate::pg::view::PgWarnLevel::Block).count(), 0, "{:?}", p.warnings);
    assert_eq!(roles_of(&p), vec!["newbie"]);
    let gained = &p.impacts[0].gained;
    let selected: usize = gained.iter().filter(|d| d.privilege == "SELECT").map(|d| d.count).sum();
    assert_eq!(selected, 7, "{gained:?}");
    let schemas = gained.iter().find(|d| d.object_kind == PgObjectKind::Schema).expect("스키마 USAGE");
    assert_eq!((schemas.privilege.as_str(), schemas.count, schemas.sample.clone()), ("USAGE", 3, strings(&["app", "audit", "scratch"])));
}

#[test]
fn only_candidate_objects_are_compared() {
    // 구성원 관계 변경: 그룹의 ACL에 이름이 없는 객체(audit.events)는 후보가 아니다
    let s = admin_of(PG16, &["app_read"]).add_role(role("newbie"));
    let p = run(&s, &membership("app_read", "newbie", true, false));
    let gained = &p.impacts[0].gained;
    assert!(gained.iter().all(|d| d.sample.iter().all(|n| n != "events" && n != "remote_log")), "{gained:?}");
    assert!(gained.iter().any(|d| d.privilege == "SELECT"));
}

#[test]
fn role_deltas_list_created_dropped_attribute_and_group_changes() {
    let s = admin_of(PG16, &["app_read"]).add_member(member_grants("mm", "alice", &[(BOOTSTRAP, true, Some(true), Some(true))]));
    // 만들기
    let create = PgChange::CreateRole { name: "dave".into(), login: false, groups: strings(&["app_read"]), connection_limit: -1, valid_until: None, preset: None };
    let p = run(&s, &create);
    // 160000부터는 만든 CREATEROLE 사용자가 새 역할의 구성원이 되기도 한다(ADMIN만 있는 부여)
    let dave = p.roles.iter().find(|r| r.role == "dave").expect("dave");
    assert_eq!((dave.created, dave.dropped, dave.groups_added.clone()), (true, false, strings(&["app_read"])));
    assert_eq!(p.roles.iter().find(|r| r.role == "mm").map(|r| r.groups_added.clone()), Some(strings(&["dave"])));
    // 속성
    let change = attributes(&s, "alice", |set| {
        set.login = false;
        set.connection_limit = 5;
        set.valid_until = Some("2030-01-01T00:00:00Z".into());
    });
    let p = run(&s, &change);
    assert_eq!(p.roles.len(), 1);
    let attrs: Vec<(&str, &str, &str)> = p.roles[0].attributes.iter().map(|a| (a.name.as_str(), a.before.as_str(), a.after.as_str())).collect();
    assert_eq!(attrs, vec![("LOGIN", "예", "아니요"), ("연결 수 제한", "제한 없음", "5"), ("만료일", "없음", "2030-01-01T00:00:00Z")]);
    // 그룹 빼기
    let s2 = s.clone().add_member(member_grants("alice", "app_read", &[("mm", false, Some(true), Some(true))]));
    let p = run(&s2, &membership("app_read", "alice", false, false));
    assert_eq!((p.roles[0].role.as_str(), p.roles[0].groups_removed.clone(), p.roles[0].groups_added.clone()), ("alice", strings(&["app_read"]), Vec::<String>::new()));
    // 아무것도 안 바꾸면 비어 있다
    let same = run(&s, &attributes(&s, "alice", |_| {}));
    assert!(same.roles.is_empty());
}

#[test]
fn a_dropped_role_is_listed_with_its_groups() {
    let s = admin_of(PG16, &["app_read"]).add_role(role("tmp")).add_member(member_grants("mm", "tmp", &[(BOOTSTRAP, true, Some(true), Some(true))]));
    let s = s.add_member(member_grants("tmp", "app_read", &[("mm", false, Some(true), Some(true))]));
    let p = run(&s, &PgChange::DropRole { role: "tmp".into() });
    assert_eq!(p.warnings.iter().filter(|w| w.level == crate::pg::view::PgWarnLevel::Block).count(), 0, "{:?}", p.warnings);
    let tmp = p.roles.iter().find(|r| r.role == "tmp").expect("tmp");
    assert_eq!((tmp.dropped, tmp.groups_removed.clone()), (true, strings(&["app_read"])));
    // 지운 역할의 구성원이던 mm도 그룹이 줄었다
    assert_eq!(p.roles.iter().find(|r| r.role == "mm").map(|r| r.groups_removed.clone()), Some(strings(&["tmp"])));
}

#[test]
fn default_deltas_show_the_touched_record_before_and_after() {
    let s = admin(PG16);
    let change = default_change("app_owner", Some("app"), DefaultObjType::Tables, "app_read", &[Select], true);
    let p = run(&s, &change);
    assert_eq!(p.defaults.len(), 1);
    assert!(p.defaults[0].before.is_none());
    let after = p.defaults[0].after.as_ref().expect("후");
    assert_eq!((after.creator.as_str(), after.schema.clone()), ("app_owner", Some("app".to_string())));
    assert_eq!(after.grants.iter().map(|g| (g.grantee.as_str(), g.privileges.clone())).collect::<Vec<_>>(), vec![("app_read", strings(&["SELECT"]))]);
    // 기본 권한은 이미 있는 객체의 권한을 바꾸지 않는다
    assert!(p.impacts.is_empty());
    // 지우면 후가 없다
    let mut s2 = s.clone();
    s2.db.default_acls.push(crate::pg::model::DefaultAclRec {
        creator: "app_owner".into(),
        schema: Some("app".into()),
        obj_type: DefaultObjType::Tables,
        acl: vec![entry("app_owner", Some("app_read"), Select)],
    });
    let p = run(&s2, &default_change("app_owner", Some("app"), DefaultObjType::Tables, "app_read", &[Select], false));
    assert!(p.defaults[0].before.is_some() && p.defaults[0].after.is_none());
    // 달라지지 않는 기록은 올리지 않는다
    let p = run(&s, &default_change("app_owner", Some("app"), DefaultObjType::Tables, "app_read", &[Select], false));
    assert!(p.defaults.is_empty());
}

#[test]
fn an_inherit_change_reaches_the_role_and_its_inheritors() {
    let s = admin(PG16).add_member(member_grants("mm", "app_write", &[(BOOTSTRAP, true, Some(true), Some(true))]));
    // app_write를 NOINHERIT로 바꾸면 app_write와 alice가 app_read의 권한을 잃는다
    let change = attributes(&s, "app_write", |set| set.inherit = false);
    let p = run(&s, &change);
    // 16부터는 구성원 관계마다의 INHERIT 옵션이 정한다: 옵션이 적혀 있는 관계는 속성을 따르지 않는다
    assert!(p.impacts.is_empty(), "{:?}", p.impacts);
    let s15 = admin(PG15);
    let p = run(&s15, &attributes(&s15, "app_write", |set| set.inherit = false));
    assert_eq!(roles_of(&p), vec!["alice", "app_write"]);
    assert!(p.impacts.iter().all(|i| i.gained.is_empty() && !i.lost.is_empty()));
}

#[test]
fn a_new_roles_creator_inherits_it_under_createrole_self_grant() {
    // 권한을 줄 수 없는 로그인이라 막히지만, 미리보기는 연산이 하는 일을 그대로 견준다
    let mut s = app_scene(PG16).add_role(RoleRec { create_role: true, ..login("ops") }).login_as("ops");
    s.cluster.createrole_self_grant = "inherit, set".into();
    let preset = crate::pg::change::model::PresetChoice {
        preset: crate::pg::change::model::PresetKind::ReadOnly,
        database: Some("appdb".into()),
        schemas: strings(&["app"]),
        creators: Vec::new(),
        group: None,
        create_group: false,
    };
    let create = PgChange::CreateRole { name: "dave".into(), login: false, groups: Vec::new(), connection_limit: -1, valid_until: None, preset: Some(preset) };
    let p = run(&s, &create);
    assert_eq!(roles_of(&p), vec!["dave", "ops"]);
}

// ───────────────────────── 속도 ─────────────────────────

/// 역할 200개 × 관계 2만 개. 관계마다 `group0`이 SELECT를 받았고, 스키마 20개에 천 개씩 둔다
fn big_scene() -> Scene {
    let mut roles = vec![login("mm"), role("group0")];
    roles.extend((0..198).map(|n| role(&format!("r{n:03}"))));
    let schemas: Vec<_> = (0..20).map(|n| schema(&format!("s{n:02}"), "app_owner").grant("group0", &[crate::pg::model::Privilege::Usage])).collect();
    let relations: Vec<_> =
        (0..20_000).map(|n| table(&format!("s{:02}", n % 20), &format!("t{n:05}"), "app_owner").grant("group0", &[Select])).collect();
    let mut roles_all = roles;
    roles_all.push(RoleRec { create_role: true, ..login("app_owner") });
    let cluster = cluster(PG16, roles_all, vec![member_grants("mm", "app_owner", &[(BOOTSTRAP, false, Some(true), Some(true))])], vec![database("appdb", "app_owner")]);
    Scene { cluster: ClusterSnapshot { login_user: "mm".into(), ..cluster }, db: db("appdb", "app_owner", schemas, relations, Vec::new()) }
}

use crate::pg::model::{ClusterSnapshot, RoleRec};
use crate::pg::view::PgObjectKind;

#[test]
#[ignore = "릴리스로 재야 한다: cargo test --release -- --ignored impact_benchmark"]
fn impact_benchmark_membership_into_a_group_with_privileges_on_every_relation() {
    let s = big_scene().add_member(member_grants("mm", "group0", &[(BOOTSTRAP, true, Some(true), Some(true))]));
    let change = membership("group0", "r000", true, false);
    let started = std::time::Instant::now();
    let p = run(&s, &change);
    let elapsed = started.elapsed();
    assert_eq!(p.impacts.len(), 1, "{:?}", p.warnings);
    assert_eq!(p.impacts[0].gained.iter().map(|d| d.count).sum::<usize>(), 20_000 + 20);
    assert!(elapsed.as_secs_f64() < 2.0, "{elapsed:?}");
}

#[test]
#[ignore = "릴리스로 재야 한다: cargo test --release -- --ignored impact_benchmark"]
fn impact_benchmark_public_select_on_one_schema_of_five_thousand_tables() {
    let mut s = big_scene();
    // 한 스키마에 5천 개를 둔다
    for (n, rel) in s.db.relations.iter_mut().enumerate() {
        rel.schema = if n < 5_000 { "s00".into() } else { format!("s{:02}", 1 + n % 19) };
        rel.acl.retain(|e| e.grantee.as_deref() != Some("group0"));
        rel.name = format!("t{n:05}");
    }
    let change = grant("PUBLIC", true, vec![item(all_tables("s00"), &[Select])]);
    let started = std::time::Instant::now();
    let p = run(&s, &change);
    let elapsed = started.elapsed();
    assert_eq!(p.impacts.len(), 30, "{:?}", p.warnings);
    // 201개 역할 가운데 이미 읽는 mm(app_owner를 물려받는다)과 app_owner를 뺀 199개가 얻는다
    assert_eq!(p.impacts_omitted, 199 - 30);
    assert!(elapsed.as_secs_f64() < 2.0, "{elapsed:?}");
}
