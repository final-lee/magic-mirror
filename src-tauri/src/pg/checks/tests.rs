//! 점검 시험: 종류마다 걸리는 스냅숏과 걸리지 않는 스냅숏을 함께 본다. 글은 프런트엔드가 그대로 보이는 것이라 한 글자씩 맞춘다.

use std::time::{Duration, Instant};

use super::*;
use crate::iam::clock::{iso, parse_iso, DAY_SECS};
use crate::pg::fixtures::*;
use crate::pg::model::Privilege::{Create, Delete, Execute, Insert, References, Select, Trigger, Truncate, Update, Usage};
use crate::pg::model::{AclEntry, DatabaseRec, DefaultAclRec, DefaultObjType, FunctionRec, RelKind, RelationRec, RoleRec, SchemaRec};
use crate::pg::view::{PgFinding, PgFindingGroup, PgFindingKind, PgFindingLevel, PgObjectKind, PgObjectRef};

fn now() -> i64 {
    parse_iso("2026-10-28T12:00:00Z").expect("now")
}

fn run(scene: &Scene) -> PgFindings {
    findings(&scene.cluster, &[&scene.db], Vec::new(), now())
}

fn group(found: &PgFindings, kind: PgFindingKind) -> Option<&PgFindingGroup> {
    found.groups.iter().find(|g| g.kind == kind)
}

fn items(found: &PgFindings, kind: PgFindingKind) -> Vec<&PgFinding> {
    group(found, kind).map(|g| g.items.iter().collect()).unwrap_or_default()
}

fn details(found: &PgFindings, kind: PgFindingKind) -> Vec<&str> {
    items(found, kind).into_iter().map(|i| i.detail.as_str()).collect()
}

fn roles_of(found: &PgFindings, kind: PgFindingKind) -> Vec<&str> {
    items(found, kind).into_iter().map(|i| i.role.as_deref().expect("role")).collect()
}

fn kinds(found: &PgFindings) -> Vec<PgFindingKind> {
    found.groups.iter().map(|g| g.kind).collect()
}

fn schema_ref(name: &str) -> PgObjectRef {
    PgObjectRef::schema(name)
}

fn table_ref(schema_name: &str, name: &str) -> PgObjectRef {
    PgObjectRef { kind: PgObjectKind::Table, schema: Some(schema_name.into()), name: name.into(), signature: None }
}

use PgFindingKind::*;

// ───────────────────────── 걸리지 않는 기본 장면 ─────────────────────────

#[test]
fn the_app_scene_has_only_the_gap_finding_and_its_groups_are_empty_otherwise() {
    // 앱 장면에는 기본 권한이 없다: 읽는 역할들이 새 테이블을 못 읽는다는 것 하나뿐이다. 다른 종류는 모두 걸리지 않는다
    let found = run(&app_scene(PG16));
    assert_eq!(kinds(&found), [DefaultPrivilegeGap]);
    assert!(found.skipped.is_empty());
    assert_eq!(found.fetched_at, iso(now()));
}

// ───────────────────────── 종류마다 ─────────────────────────

#[test]
fn public_schema_create_finds_a_schema_where_public_can_create() {
    let mut scene = app_scene(PG16);
    scene.db.schemas.iter_mut().find(|s| s.name == "scratch").expect("scratch").acl.push(entry("app_owner", None, Create));
    // PG14 이하의 public 스키마 기본값: PUBLIC이 USAGE와 CREATE를 가진다
    scene.db.schemas.push(schema("public", "postgres").grant_public(&[Usage, Create]));
    let found = run(&scene);

    let group = group(&found, PublicSchemaCreate).expect("group");
    assert_eq!((group.title.as_str(), group.level), ("PUBLIC이 스키마에 객체를 만들 수 있어요", PgFindingLevel::High));
    assert_eq!(group.items.len(), 2);
    // 이름순이다(스냅숏의 순서가 아니라)
    assert_eq!(
        group.items,
        [
            PgFinding { database: Some("appdb".into()), role: None, object: Some(schema_ref("public")), detail: "모든 역할(PUBLIC)이 이 스키마에 객체를 만들 수 있어요".into() },
            PgFinding { database: Some("appdb".into()), role: None, object: Some(schema_ref("scratch")), detail: "모든 역할(PUBLIC)이 이 스키마에 객체를 만들 수 있어요".into() },
        ]
    );
}

#[test]
fn public_schema_create_ignores_what_public_cannot_create_with() {
    let mut scene = app_scene(PG16);
    // PG15 이후의 public 스키마: PUBLIC은 USAGE뿐이고 CREATE는 소유자(pg_database_owner)다
    scene.db.schemas.push(schema("public", "pg_database_owner").grant_public(&[Usage]));
    // 특정 역할에 준 CREATE는 PUBLIC이 아니다
    scene.db.schemas.iter_mut().find(|s| s.name == "scratch").expect("scratch").acl.push(entry("app_owner", Some("alice"), Create));
    assert!(group(&run(&scene), PublicSchemaCreate).is_none());
}

#[test]
fn public_object_grant_finds_a_relation_with_a_public_privilege() {
    let mut scene = app_scene(PG16);
    scene.db.relations.push(table("app", "open_data", "app_owner").grant_public(&[Select, Insert]));
    scene.db.relations.push(relation(RelKind::Sequence, "app", "open_seq", "app_owner").grant_public(&[Usage, Select]));
    scene.db.relations.push(relation(RelKind::View, "app", "open_view", "app_owner").grant_public(&[Select]));
    let found = run(&scene);

    let group = group(&found, PublicObjectGrant).expect("group");
    assert_eq!((group.title.as_str(), group.level), ("PUBLIC에 테이블·시퀀스 권한이 있어요", PgFindingLevel::Medium));
    assert_eq!(
        group.items,
        [
            PgFinding { database: Some("appdb".into()), role: None, object: Some(table_ref("app", "open_data")), detail: "모든 역할(PUBLIC)이 SELECT, INSERT 권한을 받아요".into() },
            PgFinding {
                database: Some("appdb".into()),
                role: None,
                object: Some(PgObjectRef { kind: PgObjectKind::Sequence, schema: Some("app".into()), name: "open_seq".into(), signature: None }),
                detail: "모든 역할(PUBLIC)이 SELECT, USAGE 권한을 받아요".into()
            },
            PgFinding {
                database: Some("appdb".into()),
                role: None,
                object: Some(PgObjectRef { kind: PgObjectKind::View, schema: Some("app".into()), name: "open_view".into(), signature: None }),
                detail: "모든 역할(PUBLIC)이 SELECT 권한을 받아요".into()
            },
        ]
    );
}

#[test]
fn public_object_grant_lists_the_privileges_in_the_contract_order() {
    let mut scene = app_scene(PG16);
    scene.db.relations.push(table("app", "wide_open", "app_owner").grant_public(&[Trigger, Delete, Select, Truncate, References, Update, Insert]));
    scene.db.relations.push(relation(RelKind::Sequence, "app", "seq_open", "app_owner").grant_public(&[Usage, Update, Select]));
    let found = run(&scene);
    assert_eq!(
        details(&found, PublicObjectGrant),
        // seq_open이 wide_open보다 이름순으로 앞이다
        ["모든 역할(PUBLIC)이 SELECT, UPDATE, USAGE 권한을 받아요", "모든 역할(PUBLIC)이 SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER 권한을 받아요"]
    );
}

#[test]
fn public_object_grant_ignores_grants_to_roles_and_the_default_function_execute() {
    let scene = app_scene(PG16);
    // 장면의 함수 `plain`은 PUBLIC EXECUTE(서버 기본값)를 가지지만 관계가 아니다. 관계의 권한은 역할에만 줬다
    assert!(scene.function("app.plain").acl.iter().any(|e| e.grantee.is_none()));
    assert!(group(&run(&scene), PublicObjectGrant).is_none());
}

fn with_rds_superusers() -> Scene {
    let mut scene = app_scene(PG16);
    scene.cluster.roles.extend([
        role("rds_superuser"),
        role("rdsadmin"),
        login("postgres"),
        login("etl"),
        role("admins"),
        role("ops"),
        login("deep"),
        RoleRec { inherit: false, ..login("noinherit_direct") },
        RoleRec { inherit: false, ..login("blocked") },
    ]);
    scene.cluster.members.extend([
        member("postgres", "rds_superuser"),
        member("rdsadmin", "rds_superuser"),
        member("admins", "rds_superuser"),
        member("etl", "admins"),
        member("ops", "admins"),
        member("deep", "ops"),
        member("noinherit_direct", "rds_superuser"),
        member("blocked", "admins"),
    ]);
    scene
}

#[test]
fn rds_superuser_finds_direct_inherited_and_set_role_members_and_says_how() {
    let found = run(&with_rds_superusers());
    let group = group(&found, RdsSuperuser).expect("group");
    assert_eq!((group.title.as_str(), group.level), ("rds_superuser 멤버", PgFindingLevel::High));
    let shown: Vec<(&str, &str)> = group.items.iter().map(|i| (i.role.as_deref().expect("role"), i.detail.as_str())).collect();
    assert_eq!(
        shown,
        [
            ("admins", "rds_superuser의 직접 구성원이에요"),
            // 상속하지 않는 구성원이 그룹을 거치면 SET ROLE로 쓴다
            ("blocked", "SET ROLE로 rds_superuser 권한을 쓸 수 있어요"),
            ("deep", "ops → admins 역할을 거쳐 rds_superuser 권한을 받아요"),
            ("etl", "admins 역할을 거쳐 rds_superuser 권한을 받아요"),
            // 상속하지 않는 직접 구성원도 SET ROLE로 쓸 수 있다
            ("noinherit_direct", "rds_superuser의 직접 구성원이에요"),
            ("ops", "admins 역할을 거쳐 rds_superuser 권한을 받아요"),
            ("postgres", "rds_superuser의 직접 구성원이에요"),
        ]
    );
    // 역할만 채우고 나머지는 비운다
    assert!(group.items.iter().all(|i| i.database.is_none() && i.object.is_none()));
}

#[test]
fn rds_superuser_skips_system_roles_and_roles_that_cannot_reach_the_privilege() {
    let found = run(&with_rds_superusers());
    let roles = roles_of(&found, RdsSuperuser);
    // rdsadmin(시스템 역할)과 rds_superuser 자신은 빠진다. 상속하지 않는 구성원이 그룹을 거쳐서는 SET ROLE로 닿으니 빠지지 않는다(blocked)
    for name in ["rdsadmin", "rds_superuser", "alice", "app_owner"] {
        assert!(!roles.contains(&name), "{name}");
    }
    assert!(roles.contains(&"blocked"));
    // 이 역할이 없는 클러스터에는 그룹이 없다
    assert!(group(&run(&app_scene(PG16)), RdsSuperuser).is_none());
}

#[test]
fn from_pg16_a_set_role_member_needs_the_set_option_and_what_the_new_role_inherits_counts() {
    let setup = |version: i32| {
        let mut scene = with_rds_superusers();
        scene.cluster.version_num = version;
        scene.cluster.roles.extend([
            RoleRec { inherit: false, ..login("first_off") },
            RoleRec { inherit: false, ..login("last_off") },
            RoleRec { inherit: false, ..login("sudoer") },
            role("sealed"),
            role("dba"),
        ]);
        let link = |who: &str, group: &str, inherit: bool, set: bool| if version >= 160_000 { member_with(who, group, inherit, set) } else { member(who, group) };
        scene.cluster.members.extend([
            // 첫 관계에 SET 옵션이 없다
            link("first_off", "admins", false, false),
            // 마지막 관계에 INHERIT도 SET도 없다
            link("sealed", "rds_superuser", false, false),
            link("last_off", "sealed", false, true),
            // dba는 rds_superuser를 상속하지만 SET ROLE을 할 수는 없다. sudoer는 dba로 SET ROLE을 할 수 있다
            link("dba", "rds_superuser", true, false),
            link("sudoer", "dba", false, true),
        ]);
        scene
    };
    let reached = |version: i32| {
        let found = run(&setup(version));
        let all: Vec<(String, String)> = items(&found, RdsSuperuser).into_iter().map(|i| (i.role.clone().expect("role"), i.detail.clone())).collect();
        all
    };
    let has = |all: &[(String, String)], name: &str| all.iter().any(|(role, _)| role == name);
    // PG16: blocked의 관계에는 옵션이 없어 SET이 허용된다. SET 옵션을 끈 관계를 지나는 first_off와 마지막 관계에 옵션이 없는 last_off는 닿지 못한다
    let pg16 = reached(PG16);
    assert!(has(&pg16, "blocked"));
    assert!(!has(&pg16, "first_off") && !has(&pg16, "last_off"), "{pg16:?}");
    // sudoer는 dba로 SET ROLE을 한 뒤 dba가 상속하는 rds_superuser의 권한을 쓴다
    assert!(pg16.contains(&("sudoer".to_string(), "SET ROLE로 rds_superuser 권한을 쓸 수 있어요".to_string())), "{pg16:?}");
    // PG15 이하에는 옵션이 없다
    let pg15 = reached(PG15);
    assert!(["blocked", "first_off", "last_off", "sudoer"].iter().all(|name| has(&pg15, name)), "{pg15:?}");
}

#[test]
fn create_role_finds_non_system_roles_with_createrole_and_warns_before_pg16() {
    let setup = |version: i32| {
        let mut scene = app_scene(version);
        scene.cluster.roles.extend([RoleRec { create_role: true, ..role("rds_superuser") }, RoleRec { create_role: true, ..login("postgres") }, RoleRec { create_role: true, ..role("provisioner") }]);
        scene
    };
    let found = run(&setup(PG16));
    let group = group(&found, CreateRole).expect("group");
    assert_eq!((group.title.as_str(), group.level), ("CREATEROLE을 가진 역할", PgFindingLevel::Medium));
    // 시스템 역할(rds_superuser)은 뺀다. 역할만 채운다
    assert_eq!(
        group.items,
        [
            PgFinding { database: None, role: Some("postgres".into()), object: None, detail: "역할을 만들고 바꿀 수 있어요".into() },
            PgFinding { database: None, role: Some("provisioner".into()), object: None, detail: "역할을 만들고 바꿀 수 있어요".into() },
        ]
    );
    // PG15 이하에서는 거의 관리자급이라는 설명이 붙는다(경계는 160000)
    for version in [PG15, 159_999, PG13] {
        assert_eq!(
            details(&run(&setup(version)), CreateRole),
            ["역할을 만들고 바꿀 수 있어요 PG15 이하에서는 거의 관리자급이에요"; 2],
            "{version}"
        );
    }
    assert_eq!(details(&run(&setup(160_000)), CreateRole), ["역할을 만들고 바꿀 수 있어요"; 2]);
    // CREATEROLE이 없으면 걸리지 않는다
    assert!(group_is_missing(&app_scene(PG15), CreateRole));
}

fn group_is_missing(scene: &Scene, kind: PgFindingKind) -> bool {
    group(&run(scene), kind).is_none()
}

#[test]
fn bypass_rls_finds_non_system_roles_with_bypassrls() {
    let mut scene = app_scene(PG16);
    scene.cluster.roles.extend([RoleRec { bypass_rls: true, ..role("rds_superuser") }, RoleRec { bypass_rls: true, ..login("reporter") }, RoleRec { bypass_rls: true, ..role("auditors") }]);
    let found = run(&scene);
    let group = group(&found, BypassRls).expect("group");
    assert_eq!((group.title.as_str(), group.level), ("BYPASSRLS를 가진 역할", PgFindingLevel::Medium));
    assert_eq!(
        group.items,
        [
            PgFinding { database: None, role: Some("auditors".into()), object: None, detail: "행 수준 보안 정책을 건너뛰고 모든 행을 읽고 쓸 수 있어요".into() },
            PgFinding { database: None, role: Some("reporter".into()), object: None, detail: "행 수준 보안 정책을 건너뛰고 모든 행을 읽고 쓸 수 있어요".into() },
        ]
    );
    assert!(group_is_missing(&app_scene(PG16), BypassRls));
}

#[test]
fn expiring_login_finds_login_roles_that_expired_or_expire_within_30_days() {
    let mut scene = app_scene(PG16);
    let at = |secs: i64| Some(iso(secs));
    scene.cluster.roles.extend([
        RoleRec { valid_until: Some("2026-10-27T08:00:00Z".into()), ..login("expired_user") },
        RoleRec { valid_until: Some("2026-11-05T23:30:00Z".into()), ..login("soon_user") },
        RoleRec { valid_until: at(now() + 30 * DAY_SECS), ..login("last_day") },
        RoleRec { valid_until: at(now() + 30 * DAY_SECS + 1), ..login("later_user") },
        RoleRec { valid_until: Some("1970-01-01T00:00:00Z".into()), ..login("minus_infinity") },
        // 로그인하지 못하는 역할과 시스템 역할은 점검하지 않는다
        RoleRec { valid_until: Some("2026-10-01T00:00:00Z".into()), ..role("old_group") },
        RoleRec { valid_until: Some("2026-10-01T00:00:00Z".into()), ..login("rdsadmin") },
    ]);
    let found = run(&scene);
    let group = group(&found, ExpiringLogin).expect("group");
    assert_eq!((group.title.as_str(), group.level), ("만료됐거나 곧 만료되는 사용자", PgFindingLevel::Low));
    let shown: Vec<(&str, &str)> = group.items.iter().map(|i| (i.role.as_deref().expect("role"), i.detail.as_str())).collect();
    assert_eq!(
        shown,
        [
            ("expired_user", "2026-10-27에 만료됐어요"),
            ("last_day", "2026-11-27에 만료돼요"),
            ("minus_infinity", "1970-01-01에 만료됐어요"),
            ("soon_user", "2026-11-05에 만료돼요"),
        ]
    );
    assert!(group.items.iter().all(|i| i.database.is_none() && i.object.is_none()));
    assert!(group_is_missing(&app_scene(PG16), ExpiringLogin));
}

#[test]
fn expiring_login_reads_the_date_in_utc() {
    let mut scene = app_scene(PG16);
    scene.cluster.roles.extend([RoleRec { valid_until: Some("2026-11-05T00:00:00Z".into()), ..login("midnight") }, RoleRec { valid_until: Some("2026-11-04T23:59:59Z".into()), ..login("before_midnight") }]);
    let found = run(&scene);
    assert_eq!(details(&found, ExpiringLogin), ["2026-11-04에 만료돼요", "2026-11-05에 만료돼요"]);
    assert_eq!(roles_of(&found, ExpiringLogin), ["before_midnight", "midnight"]);
}

fn ghost_scene() -> Scene {
    let mut scene = app_scene(PG16);
    scene.cluster.roles.extend([login("ghost"), login("iam_only"), role("rds_iam"), login("rdsadmin")]);
    scene.cluster.members.push(member("iam_only", "rds_iam"));
    scene
}

#[test]
fn empty_login_finds_a_login_role_with_no_group_no_privilege_and_nothing_owned() {
    let found = run(&ghost_scene());
    let group = group(&found, EmptyLogin).expect("group");
    assert_eq!((group.title.as_str(), group.level), ("그룹도 권한도 없는 사용자", PgFindingLevel::Low));
    // rds_iam만 있는 사용자도 그룹이 없는 것으로 친다. 시스템 역할(rdsadmin)은 점검하지 않는다
    assert_eq!(
        group.items,
        [
            PgFinding { database: None, role: Some("ghost".into()), object: None, detail: "로그인할 수 있지만 속한 그룹도, 받은 권한도, 가진 객체도 없어요".into() },
            PgFinding { database: None, role: Some("iam_only".into()), object: None, detail: "로그인할 수 있지만 속한 그룹도, 받은 권한도, 가진 객체도 없어요".into() },
        ]
    );
}

#[test]
fn empty_login_is_not_triggered_by_a_group_a_privilege_or_an_owned_object() {
    // 앱 장면의 로그인 역할은 모두 무언가 있다: alice(그룹), app_owner(소유), bob(그룹), carol(그룹)
    assert!(group_is_missing(&app_scene(PG16), EmptyLogin));

    type Tweak = fn(&mut Scene);
    let cases: [(&str, Tweak); 12] = [
        ("다른 그룹의 구성원", |s| s.cluster.members.push(member("ghost", "app_read"))),
        ("rds_iam과 다른 그룹의 구성원", |s| s.cluster.members.extend([member("ghost", "rds_iam"), member("ghost", "app_write")])),
        ("테이블 권한을 직접 받았다", |s| s.db.relations.iter_mut().find(|r| r.name == "orders").expect("orders").acl.push(entry("app_owner", Some("ghost"), Select))),
        ("스키마 권한을 받았다", |s| s.db.schemas.iter_mut().find(|x| x.name == "scratch").expect("scratch").acl.push(entry("app_owner", Some("ghost"), Usage))),
        ("함수 권한을 받았다", |s| s.db.functions.iter_mut().find(|f| f.name == "touch").expect("touch").acl.push(entry("app_owner", Some("ghost"), Execute))),
        ("데이터베이스 권한을 받았다", |s| s.cluster.databases[0].acl.push(entry("app_owner", Some("ghost"), Create))),
        ("기본 권한을 받는 쪽이다", |s| s.db.default_acls.push(DefaultAclRec { creator: "app_owner".into(), schema: None, obj_type: DefaultObjType::Tables, acl: vec![entry("app_owner", Some("ghost"), Select)] })),
        ("기본 권한을 정한 쪽이다", |s| s.db.default_acls.push(DefaultAclRec { creator: "ghost".into(), schema: Some("app".into()), obj_type: DefaultObjType::Tables, acl: vec![] })),
        // 가진 객체는 ACL에 이름이 없어도(소유자가 자기 권한을 거둬도) 소유자라는 것만으로 이름이 오른다
        ("테이블을 가졌다", |s| s.db.relations.push(RelationRec { acl: Vec::new(), ..table("scratch", "mine", "ghost") })),
        ("스키마를 가졌다", |s| s.db.schemas.push(SchemaRec { acl: Vec::new(), ..schema("ghost_schema", "ghost") })),
        ("함수를 가졌다", |s| s.db.functions.push(FunctionRec { acl: Vec::new(), ..function("app", "mine", "", "ghost") })),
        ("읽은 데이터베이스를 가졌다", |s| s.db.owner = "ghost".into()),
    ];
    for (name, tweak) in cases {
        let mut scene = ghost_scene();
        tweak(&mut scene);
        assert!(!roles_of(&run(&scene), EmptyLogin).contains(&"ghost"), "{name}");
    }

    // 데이터베이스를 가졌다(ACL에 이름이 없어도 소유자다)
    let mut scene = ghost_scene();
    scene.cluster.databases.push(DatabaseRec { acl: Vec::new(), ..database("ghost_db", "ghost") });
    assert!(!roles_of(&run(&scene), EmptyLogin).contains(&"ghost"));
    // 로그인하지 못하는 역할은 점검하지 않는다
    let mut scene = ghost_scene();
    scene.cluster.roles.push(role("idle_group"));
    assert!(!roles_of(&run(&scene), EmptyLogin).contains(&"idle_group"));
}

#[test]
fn empty_login_looks_at_the_databases_that_were_read() {
    // ghost는 두 번째 데이터베이스에서만 권한이 있다: 두 곳을 다 읽으면 비어 있지 않고, 첫 곳만 읽었다면 비어 보인다
    let scene = ghost_scene();
    let second = db("analytics", "app_owner", vec![schema("stats", "app_owner").grant("ghost", &[Usage])], vec![], vec![]);
    let both = findings(&scene.cluster, &[&scene.db, &second], Vec::new(), now());
    assert!(!roles_of(&both, EmptyLogin).contains(&"ghost"));
    assert!(roles_of(&run(&scene), EmptyLogin).contains(&"ghost"));
}

fn gap_details(found: &PgFindings) -> Vec<&str> {
    details(found, DefaultPrivilegeGap)
}

fn tables_acl(creator: &str, schema_name: Option<&str>, grants: Vec<AclEntry>) -> DefaultAclRec {
    DefaultAclRec { creator: creator.into(), schema: schema_name.map(str::to_string), obj_type: DefaultObjType::Tables, acl: grants }
}

#[test]
fn default_privilege_gap_finds_roles_that_read_every_table_but_not_the_new_ones() {
    let found = run(&app_scene(PG16));
    let group = group(&found, DefaultPrivilegeGap).expect("group");
    assert_eq!((group.title.as_str(), group.level), ("새 테이블에는 권한이 없는 역할", PgFindingLevel::Medium));
    // app_read는 직접, app_write와 alice는 그룹으로 읽는다. 소유자(app_owner)·NOINHERIT인 bob·미리 정의된 역할로 읽는 carol은 걸리지 않는다
    assert_eq!(
        group.items,
        [
            PgFinding {
                database: Some("appdb".into()),
                role: Some("alice".into()),
                object: Some(schema_ref("app")),
                detail: "alice 역할은 app의 지금 테이블은 읽지만 app_owner 역할이 새로 만드는 테이블은 못 읽어요".into()
            },
            PgFinding {
                database: Some("appdb".into()),
                role: Some("app_read".into()),
                object: Some(schema_ref("app")),
                detail: "app_read 역할은 app의 지금 테이블은 읽지만 app_owner 역할이 새로 만드는 테이블은 못 읽어요".into()
            },
            PgFinding {
                database: Some("appdb".into()),
                role: Some("app_write".into()),
                object: Some(schema_ref("app")),
                detail: "app_write 역할은 app의 지금 테이블은 읽지만 app_owner 역할이 새로 만드는 테이블은 못 읽어요".into()
            },
        ]
    );
}

#[test]
fn a_default_acl_of_the_creator_that_grants_select_on_tables_closes_the_gap() {
    // 그 스키마의 기본 권한: app_read가 받으니 app_read도, app_read를 상속하는 app_write와 alice도 걸리지 않는다
    let mut scene = app_scene(PG16);
    scene.db.default_acls.push(tables_acl("app_owner", Some("app"), vec![entry("app_owner", Some("app_read"), Select)]));
    assert!(gap_details(&run(&scene)).is_empty());

    // 모든 스키마에 걸린 기본 권한도 같다
    let mut scene = app_scene(PG16);
    scene.db.default_acls.push(tables_acl("app_owner", None, vec![entry("app_owner", Some("app_read"), Select)]));
    assert!(gap_details(&run(&scene)).is_empty());

    // 상속하는 그룹이 받아도 된다: app_write가 받으면 app_write와 그 구성원 alice는 괜찮지만 app_read는 아니다
    let mut scene = app_scene(PG16);
    scene.db.default_acls.push(tables_acl("app_owner", Some("app"), vec![entry("app_owner", Some("app_write"), Select)]));
    assert_eq!(gap_details(&run(&scene)), ["app_read 역할은 app의 지금 테이블은 읽지만 app_owner 역할이 새로 만드는 테이블은 못 읽어요"]);

    // PUBLIC이 받으면 모두 읽는다
    let mut scene = app_scene(PG16);
    scene.db.default_acls.push(tables_acl("app_owner", Some("app"), vec![entry("app_owner", None, Select)]));
    assert!(gap_details(&run(&scene)).is_empty());
}

#[test]
fn a_default_acl_that_does_not_cover_select_on_tables_of_that_creator_and_schema_leaves_the_gap() {
    let still_a_gap = |acl: DefaultAclRec| {
        let mut scene = app_scene(PG16);
        scene.db.default_acls.push(acl);
        gap_details(&run(&scene)).len()
    };
    // SELECT가 아닌 권한
    assert_eq!(still_a_gap(tables_acl("app_owner", Some("app"), vec![entry("app_owner", Some("app_read"), Insert)])), 3);
    // 다른 만드는 역할의 기본 권한
    assert_eq!(still_a_gap(tables_acl("migrator", Some("app"), vec![entry("migrator", Some("app_read"), Select)])), 3);
    // 다른 스키마의 기본 권한
    assert_eq!(still_a_gap(tables_acl("app_owner", Some("audit"), vec![entry("app_owner", Some("app_read"), Select)])), 3);
    // 테이블이 아닌 객체의 기본 권한
    let on_sequences = DefaultAclRec { obj_type: DefaultObjType::Sequences, ..tables_acl("app_owner", Some("app"), vec![entry("app_owner", Some("app_read"), Select)]) };
    assert_eq!(still_a_gap(on_sequences), 3);
    // 받는 쪽이 이 역할도, 이 역할이 상속하는 역할도 아니다
    assert_eq!(still_a_gap(tables_acl("app_owner", Some("app"), vec![entry("app_owner", Some("bob"), Select)])), 3);
    // 기본 권한이 있어도 아무에게도 주지 않는 행이다
    assert_eq!(still_a_gap(tables_acl("app_owner", Some("app"), vec![])), 3);
}

#[test]
fn the_gap_needs_select_on_every_table_through_a_direct_or_group_source() {
    // app_read가 customers를 못 읽으면 "모든 테이블"이 아니다: app_read도 그 그룹을 상속하는 역할도 걸리지 않는다
    let mut scene = app_scene(PG16);
    scene.db.relations.iter_mut().find(|r| r.name == "customers").expect("customers").acl.retain(|e| e.grantee.as_deref() != Some("app_read"));
    assert!(gap_details(&run(&scene)).is_empty());

    // 소유자인 역할, 소유자를 상속하는 역할은 새 테이블을 어차피 읽는다: alice가 app_owner를 상속하면 alice는 빠진다
    let mut scene = app_scene(PG16);
    scene.cluster.members.push(member("alice", "app_owner"));
    let found = run(&scene);
    assert_eq!(roles_of(&found, DefaultPrivilegeGap), ["app_read", "app_write"]);

    // PUBLIC이나 미리 정의된 역할로만 읽는 역할은 걸리지 않는다
    let mut scene = app_scene(PG16);
    scene.cluster.roles.push(login("tourist"));
    for rel in scene.db.relations.iter_mut().filter(|r| r.schema == "app") {
        rel.acl.push(entry("app_owner", None, Select));
    }
    assert!(!roles_of(&run(&scene), DefaultPrivilegeGap).contains(&"tourist"));
    assert!(!roles_of(&run(&scene), DefaultPrivilegeGap).contains(&"carol"));
}

#[test]
fn a_role_that_also_reads_through_a_predefined_role_or_as_a_superuser_has_no_gap() {
    // carol은 pg_read_all_data의 구성원이다: 그 역할이 새 테이블의 SELECT도 준다. app의 테이블을 직접 받았어도 빈틈이 아니다.
    // superuser인 root도 새 테이블을 읽는다. 직접 받은 것뿐인 dave는 빈틈이 있다
    let mut scene = app_scene(PG16);
    scene.cluster.roles.extend([login("dave"), RoleRec { superuser: true, ..login("root") }]);
    for rel in scene.db.relations.iter_mut().filter(|r| r.schema == "app" && r.kind == RelKind::Table) {
        for who in ["carol", "dave", "root"] {
            rel.acl.push(entry("app_owner", Some(who), Select));
        }
    }
    let roles = roles_of(&run(&scene), DefaultPrivilegeGap).into_iter().map(str::to_string).collect::<Vec<_>>();
    assert!(roles.contains(&"dave".to_string()), "{roles:?}");
    assert!(!roles.contains(&"carol".to_string()) && !roles.contains(&"root".to_string()), "{roles:?}");

    // 모든 테이블에서 그런 것이 아니면 빈틈이다: 테이블 하나의 SELECT가 직접 받은 것뿐이면(미리 정의된 역할이 없는 PG13) 걸린다
    let mut scene = app_scene(PG13);
    for rel in scene.db.relations.iter_mut().filter(|r| r.schema == "app" && r.kind == RelKind::Table) {
        rel.acl.push(entry("app_owner", Some("carol"), Select));
    }
    assert!(roles_of(&run(&scene), DefaultPrivilegeGap).contains(&"carol"), "PG13에는 pg_read_all_data가 없어요");
}

#[test]
fn the_gap_is_found_for_each_creator_of_a_table_in_the_schema_and_only_for_tables() {
    let mut scene = app_scene(PG16);
    // migrator도 이 스키마에 테이블을 만든다. app_read는 그것도 읽는다
    scene.cluster.roles.push(login("migrator"));
    scene.db.relations.push(table("app", "staging", "migrator").grant("app_read", &[Select]));
    // 뷰와 시퀀스의 소유자는 "테이블을 만드는 역할"이 아니다
    scene.cluster.roles.push(login("view_owner"));
    scene.db.relations.push(relation(RelKind::View, "app", "extra_view", "view_owner").grant("app_read", &[Select]));
    scene.db.relations.push(relation(RelKind::Sequence, "app", "extra_seq", "view_owner"));
    let found = run(&scene);
    assert_eq!(
        gap_details(&found).into_iter().filter(|d| d.starts_with("app_read ")).collect::<Vec<_>>(),
        [
            "app_read 역할은 app의 지금 테이블은 읽지만 app_owner 역할이 새로 만드는 테이블은 못 읽어요",
            "app_read 역할은 app의 지금 테이블은 읽지만 migrator 역할이 새로 만드는 테이블은 못 읽어요",
        ]
    );
    assert!(!gap_details(&found).iter().any(|d| d.contains("view_owner")));

    // migrator의 기본 권한만 있으면 app_owner 쪽이 남는다
    scene.db.default_acls.push(tables_acl("migrator", Some("app"), vec![entry("migrator", Some("app_read"), Select)]));
    assert_eq!(
        gap_details(&run(&scene)).into_iter().filter(|d| d.starts_with("app_read ")).collect::<Vec<_>>(),
        ["app_read 역할은 app의 지금 테이블은 읽지만 app_owner 역할이 새로 만드는 테이블은 못 읽어요"]
    );
}

#[test]
fn partitioned_tables_count_as_tables_but_foreign_tables_and_empty_schemas_do_not() {
    let mut scene = app_scene(PG16);
    scene.db.default_acls.push(tables_acl("app_owner", Some("app"), vec![entry("app_owner", None, Select)]));
    // audit에는 파티션 테이블 events와 외부 테이블 remote_log가 있다. 외부 테이블은 "테이블"로 세지 않는다
    scene.db.relations.iter_mut().find(|r| r.name == "events").expect("events").acl.push(entry("app_owner", Some("app_read"), Select));
    let found = run(&scene);
    let audit: Vec<&PgFinding> = items(&found, DefaultPrivilegeGap).into_iter().filter(|i| i.object == Some(schema_ref("audit"))).collect();
    // remote_log를 못 읽어도 events를 읽으면 걸린다. app_read를 상속하는 app_write와 alice도 events를 그룹으로 읽는다
    assert_eq!(audit.iter().map(|i| i.role.as_deref().expect("role")).collect::<Vec<_>>(), ["alice", "app_read", "app_write"]);
    assert_eq!(audit[1].detail, "app_read 역할은 audit의 지금 테이블은 읽지만 app_owner 역할이 새로 만드는 테이블은 못 읽어요");
    // 테이블이 하나도 없는 스키마(scratch)는 걸리지 않는다
    assert!(items(&found, DefaultPrivilegeGap).iter().all(|i| i.object != Some(schema_ref("scratch"))));
}

#[test]
fn security_definer_path_finds_functions_that_do_not_pin_the_search_path() {
    let mut scene = app_scene(PG16);
    for f in &mut scene.db.functions {
        f.security_definer = f.name == "touch";
    }
    scene.db.functions.push(FunctionRec { security_definer: true, search_path_set: true, ..function("app", "safe_touch", "order_id integer", "app_owner") });
    let found = run(&scene);
    let group = group(&found, SecurityDefinerPath).expect("group");
    assert_eq!((group.title.as_str(), group.level), ("search_path를 고정하지 않은 SECURITY DEFINER 함수", PgFindingLevel::High));
    assert_eq!(
        group.items,
        [PgFinding {
            database: Some("appdb".into()),
            role: None,
            object: Some(PgObjectRef { kind: PgObjectKind::Function, schema: Some("app".into()), name: "touch".into(), signature: Some("order_id integer".into()) }),
            detail: "SECURITY DEFINER 함수인데 search_path를 고정하지 않았어요".into(),
        }]
    );
    // search_path를 고정했거나 SECURITY DEFINER가 아니면 걸리지 않는다
    assert!(group_is_missing(&app_scene(PG16), SecurityDefinerPath));
}


#[test]
fn md5_encryption_finds_the_cluster_setting() {
    let mut scene = app_scene(PG16);
    scene.cluster.password_encryption = "md5".into();
    let found = run(&scene);
    let group = group(&found, Md5Encryption).expect("group");
    assert_eq!((group.title.as_str(), group.level), ("password_encryption이 md5예요", PgFindingLevel::Medium));
    assert_eq!(
        group.items,
        [PgFinding {
            database: None,
            role: None,
            object: None,
            detail: "새 비밀번호가 md5 해시로 저장돼요. 파라미터 그룹에서 password_encryption을 scram-sha-256으로 바꾸세요".into(),
        }]
    );
    scene.cluster.password_encryption = "scram-sha-256".into();
    assert!(group_is_missing(&scene, Md5Encryption));
}

// ───────────────────────── 묶음 ─────────────────────────

/// 열 가지가 모두 걸리는 장면
fn noisy_scene() -> Scene {
    let mut scene = with_rds_superusers();
    scene.cluster.password_encryption = "md5".into();
    scene.cluster.roles.extend([
        RoleRec { create_role: true, ..login("provisioner") },
        RoleRec { bypass_rls: true, ..login("reporter") },
        RoleRec { valid_until: Some("2026-10-27T00:00:00Z".into()), ..login("expired_user") },
        login("ghost"),
    ]);
    scene.db.schemas.iter_mut().find(|s| s.name == "scratch").expect("scratch").acl.push(entry("app_owner", None, Create));
    scene.db.relations.iter_mut().find(|r| r.name == "orders").expect("orders").acl.push(entry("app_owner", None, Select));
    scene.db.functions.iter_mut().find(|f| f.name == "touch").expect("touch").security_definer = true;
    scene
}

#[test]
fn only_groups_with_items_come_back_highest_level_first_and_kinds_keep_their_order_within_a_level() {
    let found = run(&noisy_scene());
    let shown: Vec<(PgFindingKind, &str, PgFindingLevel)> = found.groups.iter().map(|g| (g.kind, g.title.as_str(), g.level)).collect();
    use PgFindingLevel::*;
    assert_eq!(
        shown,
        [
            (PublicSchemaCreate, "PUBLIC이 스키마에 객체를 만들 수 있어요", High),
            (RdsSuperuser, "rds_superuser 멤버", High),
            (SecurityDefinerPath, "search_path를 고정하지 않은 SECURITY DEFINER 함수", High),
            (PublicObjectGrant, "PUBLIC에 테이블·시퀀스 권한이 있어요", Medium),
            (CreateRole, "CREATEROLE을 가진 역할", Medium),
            (BypassRls, "BYPASSRLS를 가진 역할", Medium),
            (DefaultPrivilegeGap, "새 테이블에는 권한이 없는 역할", Medium),
            (Md5Encryption, "password_encryption이 md5예요", Medium),
            (ExpiringLogin, "만료됐거나 곧 만료되는 사용자", Low),
            (EmptyLogin, "그룹도 권한도 없는 사용자", Low),
        ]
    );
    assert!(found.groups.iter().all(|g| !g.items.is_empty()));
    // 아무것도 걸리지 않는 클러스터에는 그룹이 없다
    let mut quiet = app_scene(PG16);
    quiet.db.default_acls.push(tables_acl("app_owner", Some("app"), vec![entry("app_owner", Some("app_read"), Select)]));
    assert!(run(&quiet).groups.is_empty());
}

#[test]
fn public_is_never_a_role_of_a_finding() {
    let found = run(&noisy_scene());
    for g in &found.groups {
        for item in &g.items {
            assert_ne!(item.role.as_deref(), Some("PUBLIC"), "{:?}", g.kind);
        }
    }
    assert!(!roles_of(&found, DefaultPrivilegeGap).contains(&"PUBLIC"));
}

#[test]
fn the_fields_of_each_kind_are_filled_as_the_contract_says_and_the_others_stay_empty() {
    let found = run(&noisy_scene());
    // (데이터베이스, 역할, 객체)가 채워졌는지
    let filled = |kind: PgFindingKind| -> Vec<(bool, bool, bool)> {
        items(&found, kind).iter().map(|i| (i.database.is_some(), i.role.is_some(), i.object.is_some())).collect()
    };
    for kind in [PublicSchemaCreate, PublicObjectGrant, SecurityDefinerPath] {
        assert!(filled(kind).iter().all(|f| *f == (true, false, true)), "{kind:?}");
    }
    for kind in [RdsSuperuser, CreateRole, BypassRls, ExpiringLogin, EmptyLogin] {
        assert!(filled(kind).iter().all(|f| *f == (false, true, false)), "{kind:?}");
    }
    assert!(filled(DefaultPrivilegeGap).iter().all(|f| *f == (true, true, true)));
    assert_eq!(filled(Md5Encryption), [(false, false, false)]);
}

#[test]
fn several_databases_are_checked_in_the_given_order_and_the_skipped_ones_pass_through() {
    let mut scene = app_scene(PG16);
    scene.db.functions.iter_mut().find(|f| f.name == "touch").expect("touch").security_definer = true;
    let mut other = db("orders", "app_owner", vec![schema("sales", "app_owner").grant_public(&[Create])], vec![], vec![function("sales", "audit_it", "", "app_owner")]);
    other.functions[0].security_definer = true;
    let skipped = vec![PgSkippedDatabase { database: "analytics".into(), reason: "analytics에 연결하지 못했어요: permission denied for database \"analytics\"".into() }];
    let found = findings(&scene.cluster, &[&scene.db, &other], skipped.clone(), now());

    let shown: Vec<(&str, &str)> = items(&found, SecurityDefinerPath).iter().map(|i| (i.database.as_deref().expect("database"), i.object.as_ref().expect("object").name.as_str())).collect();
    assert_eq!(shown, [("appdb", "touch"), ("orders", "audit_it")]);
    assert_eq!(items(&found, PublicSchemaCreate).iter().map(|i| i.database.as_deref()).collect::<Vec<_>>(), [Some("orders")]);
    assert_eq!(found.skipped, skipped);
}

#[test]
fn the_databases_that_were_read_only_in_part_are_named_in_byte_order() {
    let scene = app_scene(PG16);
    let cut = |name: &str| DbSnapshot { truncated: true, ..db(name, "app_owner", vec![], vec![], vec![]) };
    let whole = db("orders", "app_owner", vec![], vec![], vec![]);
    let (reports, analytics) = (cut("reports"), cut("analytics"));
    // 받은 순서가 아니라 이름순이다. 온전히 읽은 데이터베이스는 들어가지 않는다
    let found = findings(&scene.cluster, &[&reports, &whole, &analytics], Vec::new(), now());
    assert_eq!(found.truncated, ["analytics", "reports"]);
    // 읽지 못한 데이터베이스는 `skipped`가 알린다. 일부만 읽은 데이터베이스가 아니다
    let skipped = vec![PgSkippedDatabase { database: "legacy".into(), reason: "legacy에 연결하지 못했어요: permission denied".into() }];
    assert!(findings(&scene.cluster, &[&whole], skipped, now()).truncated.is_empty());
    // 모두 온전히 읽었으면 비어 있다
    assert!(run(&scene).truncated.is_empty());
}

// ───────────────────────── 속도 ─────────────────────────

/// 역할 200 × 관계 2만 개: 스키마 100개에 테이블 200개씩. 위의 역할들이 스키마의 모든 테이블을 읽는다
fn big_scene() -> Scene {
    let owners: Vec<String> = (0..5).map(|i| format!("owner{i}")).collect();
    let tops: Vec<String> = (0..10).map(|i| format!("top{i}")).collect();
    let mids: Vec<String> = (0..20).map(|i| format!("mid{i}")).collect();
    let users: Vec<String> = (0..200).map(|i| format!("user{i:03}")).collect();
    let roles: Vec<RoleRec> = owners.iter().chain(&tops).chain(&mids).map(|n| role(n)).chain(users.iter().map(|n| login(n))).collect();
    let mut members = Vec::new();
    for (i, mid) in mids.iter().enumerate() {
        members.push(member(mid, &tops[i % 10]));
    }
    for (i, user) in users.iter().enumerate() {
        members.push(member(user, &mids[i % 20]));
        members.push(member(user, &mids[(i * 7 + 3) % 20]));
        if i % 5 == 0 {
            members.push(member(user, &tops[(i / 5) % 10]));
        }
    }
    let schemas: Vec<_> = (0..100)
        .map(|i| schema(&format!("s{i:03}"), &owners[i % 5]).grant(&tops[i % 10], &[Usage]).grant(&mids[i % 20], &[Usage]).grant(&mids[(i + 1) % 20], &[Usage]))
        .collect();
    let mut relations = Vec::with_capacity(20_000);
    for (i, s) in schemas.iter().enumerate() {
        for n in 0..200 {
            let kind = if n % 25 == 0 { RelKind::View } else { RelKind::Table };
            // 스키마마다 위 둘과 아래 둘이 모든 테이블을 읽는다. 스키마 몇 개는 기본 권한이 없다
            let mut rel = relation(kind, &s.name, &format!("t{n:04}"), &owners[i % 5]).grant(&tops[i % 10], &[Select]).grant(&mids[i % 20], &[Select]).grant(&mids[(i + 1) % 20], &[Select]);
            if n % 50 == 0 {
                rel = rel.grant_public(&[Select]);
            }
            relations.push(rel);
        }
    }
    let functions = (0..50).map(|n| FunctionRec { security_definer: true, ..function("s000", &format!("f{n:02}"), "", &owners[0]) }).collect();
    let mut scene = Scene { cluster: cluster(PG16, roles, members, vec![database("appdb", &owners[0])]), db: db("appdb", &owners[0], schemas, relations, functions) };
    // 기본 권한: 짝수 스키마는 mids가 새 테이블도 읽는다
    for i in (0..100).step_by(2) {
        scene.db.default_acls.push(tables_acl(&owners[i % 5], Some(&format!("s{i:03}")), vec![entry(&owners[i % 5], Some(&mids[i % 20]), Select), entry(&owners[i % 5], Some(&mids[(i + 1) % 20]), Select)]));
    }
    scene
}

#[test]
#[ignore = "큰 스냅숏(역할 200 × 관계 2만 개)으로 속도를 재요: cargo test --release pg::checks -- --ignored"]
fn findings_for_200_roles_and_20000_relations_stay_within_three_seconds() {
    let scene = big_scene();
    assert_eq!((scene.cluster.roles.iter().filter(|r| r.login).count(), scene.db.relations.len()), (200, 20_000));

    let started = Instant::now();
    let found = run(&scene);
    let elapsed = started.elapsed();
    let gaps = items(&found, DefaultPrivilegeGap).len();
    eprintln!("findings: 역할 {} × 관계 {}, 기본 권한 빈틈 {gaps}건, {elapsed:?}", scene.cluster.roles.len(), scene.db.relations.len());

    // 계산이 비어 있지 않은지 본다
    assert!(gaps > 100, "{gaps}");
    assert_eq!(items(&found, SecurityDefinerPath).len(), 50);
    assert_eq!(items(&found, PublicObjectGrant).len(), 100 * 4);
    // 디버그 빌드는 최적화가 없어 수십 배 느리다: 예산은 릴리스에서만 3초다
    let budget = if cfg!(debug_assertions) { Duration::from_secs(180) } else { Duration::from_secs(3) };
    assert!(elapsed < budget, "{elapsed:?}이(가) 예산 {budget:?}을(를) 넘었어요");
}
