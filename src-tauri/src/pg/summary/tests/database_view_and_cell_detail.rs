use super::*;

// ───────────────────────── 데이터베이스 하나의 권한 표 ─────────────────────────

fn cell_of<'a>(view: &'a PgDatabaseView, role: &str, schema: &str) -> &'a crate::pg::view::PgSchemaCell {
    view.cells.iter().find(|c| c.role == role && c.schema == schema).unwrap_or_else(|| panic!("{role}/{schema} 칸이 없어요"))
}

#[test]
fn the_cells_cover_all_roles_times_all_schemas_system_roles_included() {
    let mut scene = rds_scene(PG16);
    scene.cluster.roles.push(role("pg_read_all_data"));
    let view = database_view(&scene.cluster, &scene.db);
    let roles: Vec<&str> = scene.cluster.roles.iter().map(|r| r.name.as_str()).collect();
    assert_eq!(roles.len(), 9);
    // 역할은 스냅숏의 순서, 그 안에서 스키마는 이름순
    let expected: Vec<(&str, &str)> = roles.iter().flat_map(|r| ["app", "audit", "scratch"].map(|s| (*r, s))).collect();
    assert_eq!(view.cells.iter().map(|c| (c.role.as_str(), c.schema.as_str())).collect::<Vec<_>>(), expected);
    assert_eq!(view.cells.len(), 27);
    assert!(view.cells.iter().any(|c| c.role == "pg_read_all_data"), "시스템 역할의 칸도 있어요");
    assert!(view.cells.iter().any(|c| c.role == "rds_superuser"));
}

#[test]
fn the_cells_carry_what_the_evaluator_says_including_where_the_privilege_comes_from() {
    let scene = app_scene(PG16);
    let view = database_view(&scene.cluster, &scene.db);

    // alice는 모든 것을 그룹에서 받았다: 읽기 전부, 쓰기 일부, 출처가 그룹뿐이라 흐리게(inheritedOnly)
    let alice = cell_of(&view, "alice", "app");
    assert_eq!((alice.usage, alice.create, alice.read, alice.write), (true, false, PgCoverage::All, PgCoverage::Some));
    assert!(alice.inherited_only, "그룹에서만 받은 칸은 inheritedOnly여야 해요");
    assert_eq!(alice.unusable, None);
    // app_read는 읽기를 직접 받았다
    let reader = cell_of(&view, "app_read", "app");
    assert_eq!((reader.usage, reader.read, reader.write, reader.inherited_only), (true, PgCoverage::All, PgCoverage::None, false));
    // 소유자
    let owner = cell_of(&view, "app_owner", "audit");
    assert_eq!((owner.usage, owner.create, owner.read, owner.write, owner.inherited_only), (true, true, PgCoverage::All, PgCoverage::All, false));
    // carol은 pg_read_all_data로 읽지만 CONNECT가 없다
    let carol = cell_of(&view, "carol", "app");
    assert_eq!((carol.usage, carol.read, carol.inherited_only, carol.unusable.as_deref()), (true, PgCoverage::All, true, Some("CONNECT 없음")));
    // bob은 아무것도 없다: 비어 있는 칸은 흐리게도, 못 쓴다는 표시도 하지 않는다
    let bob = cell_of(&view, "bob", "app");
    assert_eq!((bob.usage, bob.create, bob.read, bob.write, bob.inherited_only, bob.unusable.as_deref()), (false, false, PgCoverage::None, PgCoverage::None, false, None));
}

#[test]
fn db_privileges_have_connect_create_and_temp_for_every_role() {
    let mut scene = rds_scene(PG16);
    scene.cluster.roles.push(role("pg_read_all_data"));
    let view = database_view(&scene.cluster, &scene.db);
    assert_eq!(view.db_privileges.len(), scene.cluster.roles.len());
    assert_eq!(view.db_privileges.iter().map(|p| p.role.as_str()).collect::<Vec<_>>(), scene.cluster.roles.iter().map(|r| r.name.as_str()).collect::<Vec<_>>());
    let row = |name: &str| {
        let p = view.db_privileges.iter().find(|p| p.role == name).unwrap_or_else(|| panic!("{name}"));
        (p.connect, p.create, p.temp)
    };
    // PUBLIC의 CONNECT를 거두고 app_read에 줬다. TEMPORARY는 PUBLIC에 남아 있어 모두가 가진다
    assert_eq!(row("app_owner"), (true, true, true));
    assert_eq!(row("app_read"), (true, false, true));
    assert_eq!(row("alice"), (true, false, true), "app_write → app_read를 거쳐 CONNECT를 받아요");
    assert_eq!(row("bob"), (false, false, true), "NOINHERIT라서 CONNECT가 없어요");
    assert_eq!(row("carol"), (false, false, true));
    assert_eq!(row("rds_superuser"), (false, false, true));
}

#[test]
fn db_privileges_split_the_direct_grants_from_the_owners() {
    let scene = app_scene(PG16);
    let view = database_view(&scene.cluster, &scene.db);
    let values = |name: &str| {
        let p = view.db_privileges.iter().find(|p| p.role == name).unwrap_or_else(|| panic!("{name}"));
        ((p.direct.connect, p.direct.create, p.direct.temp), (p.owned.connect, p.owned.create, p.owned.temp))
    };
    // app_read는 CONNECT를 직접 받았다. TEMPORARY는 PUBLIC이 줘서 직접 받은 것이 아니다
    assert_eq!(values("app_read"), ((true, false, false), (false, false, false)));
    // 소유자의 항목은 소유자 출처다: 직접 받은 것은 없다
    assert_eq!(values("app_owner"), ((false, false, false), (true, true, true)));
    // alice는 app_write → app_read를 거쳐 CONNECT를 받는다: 보이는 값은 있어도 직접 받은 것은 없다
    assert_eq!(values("alice"), ((false, false, false), (false, false, false)));
    let alice = view.db_privileges.iter().find(|p| p.role == "alice").expect("alice");
    assert!(alice.connect);
}

#[test]
fn schemas_count_tables_and_partitioned_tables_only() {
    let scene = app_scene(PG16);
    let view = database_view(&scene.cluster, &scene.db);
    // app: customers·orders(테이블). 뷰·구체화 뷰·시퀀스는 세지 않는다. audit: events(파티션 테이블). 외부 테이블은 세지 않는다
    assert_eq!(
        view.schemas.iter().map(|s| (s.name.as_str(), s.owner.as_str(), s.table_count)).collect::<Vec<_>>(),
        [("app", "app_owner", 2), ("audit", "app_owner", 1), ("scratch", "app_owner", 0)]
    );
    // 스냅숏의 스키마 순서와 상관없이 이름순이다(칸의 스키마 순서와 같다)
    let mut reversed = app_scene(PG16);
    reversed.db.schemas.reverse();
    assert_eq!(database_view(&reversed.cluster, &reversed.db).schemas, view.schemas);
}

fn default_acl(creator: &str, schema: Option<&str>, obj_type: DefaultObjType, acl: Vec<AclEntry>) -> DefaultAclRec {
    DefaultAclRec { creator: creator.into(), schema: schema.map(str::to_string), obj_type, acl }
}

#[test]
fn default_privileges_map_public_and_privileges_to_strings_in_a_stable_order() {
    let mut scene = app_scene(PG16);
    let grantable = |grantee: &str, privilege| AclEntry { grantable: true, ..entry("postgres", Some(grantee), privilege) };
    scene.db.default_acls = vec![
        // 서버가 주는 순서와 상관없이 (만드는 역할, 스키마(모든 스키마는 뒤), 객체 종류) 순으로 낸다
        default_acl("postgres", None, DefaultObjType::Tables, vec![grantable("iam_admin", Select)]),
        default_acl("app_owner", None, DefaultObjType::Types, vec![entry("app_owner", None, Usage)]),
        default_acl("app_owner", Some("audit"), DefaultObjType::Functions, vec![]),
        default_acl(
            "app_owner",
            Some("app"),
            DefaultObjType::Tables,
            vec![
                entry("app_owner", Some("app_write"), Delete),
                entry("app_owner", Some("app_read"), Select),
                entry("app_owner", Some("app_write"), Insert),
                entry("app_owner", Some("app_write"), Update),
                // 두 부여자가 같은 권한을 줬다: 한 번만 나온다
                entry("app_admin", Some("app_read"), Select),
            ],
        ),
        default_acl("app_owner", Some("app"), DefaultObjType::Sequences, vec![entry("app_owner", Some("app_write"), Usage), entry("app_owner", Some("app_write"), Select)]),
    ];
    let rows = database_view(&scene.cluster, &scene.db).default_privileges;
    let shown: Vec<(&str, Option<&str>, crate::pg::view::PgDefaultObjectType)> = rows.iter().map(|r| (r.creator.as_str(), r.schema.as_deref(), r.object_type)).collect();
    use crate::pg::view::PgDefaultObjectType::*;
    assert_eq!(
        shown,
        [("app_owner", Some("app"), Tables), ("app_owner", Some("app"), Sequences), ("app_owner", Some("audit"), Functions), ("app_owner", None, Types), ("postgres", None, Tables)]
    );
    let grants = |row: usize| rows[row].grants.iter().map(|g| (g.grantee.as_str(), g.privileges.iter().map(String::as_str).collect::<Vec<_>>(), g.grantable)).collect::<Vec<_>>();
    // 받는 쪽은 이름순, 권한은 SELECT, INSERT, UPDATE, DELETE … 순서
    assert_eq!(grants(0), [("app_read", vec!["SELECT"], false), ("app_write", vec!["INSERT", "UPDATE", "DELETE"], false)]);
    assert_eq!(grants(1), [("app_write", vec!["SELECT", "USAGE"], false)]);
    // 권한을 모두 거둔 행은 받는 쪽이 없다
    assert!(rows[2].grants.is_empty());
    // grantee가 None이면 "PUBLIC"
    assert_eq!(grants(3), [("PUBLIC", vec!["USAGE"], false)]);
    assert_eq!(grants(4), [("iam_admin", vec!["SELECT"], true)]);
}

#[test]
fn a_grantee_with_and_without_the_grant_option_is_two_entries_and_public_comes_first() {
    let mut scene = app_scene(PG16);
    let with_option = AclEntry { grantable: true, ..entry("app_owner", Some("app_read"), Insert) };
    scene.db.default_acls = vec![default_acl(
        "app_owner",
        Some("app"),
        DefaultObjType::Tables,
        vec![with_option, entry("app_owner", Some("app_read"), Select), entry("app_owner", Some("alice"), Select), entry("app_owner", None, Select)],
    )];
    let grants = &database_view(&scene.cluster, &scene.db).default_privileges[0].grants;
    assert_eq!(
        grants.iter().map(|g| (g.grantee.as_str(), g.privileges.iter().map(String::as_str).collect::<Vec<_>>(), g.grantable)).collect::<Vec<_>>(),
        [("PUBLIC", vec!["SELECT"], false), ("alice", vec!["SELECT"], false), ("app_read", vec!["SELECT"], false), ("app_read", vec!["INSERT"], true)]
    );
}

#[test]
fn the_database_view_carries_the_name_the_read_time_and_the_truncated_flag() {
    let mut scene = app_scene(PG16);
    let view = database_view(&scene.cluster, &scene.db);
    assert_eq!((view.database.as_str(), view.fetched_at.as_str(), view.truncated), ("appdb", "2026-10-28T00:00:00Z", false));
    scene.db.truncated = true;
    scene.db.fetched_at = "2026-10-28T09:30:00Z".into();
    let view = database_view(&scene.cluster, &scene.db);
    assert_eq!((view.fetched_at.as_str(), view.truncated), ("2026-10-28T09:30:00Z", true));
}

#[test]
fn a_database_that_the_cluster_does_not_list_still_gets_a_view() {
    // 클러스터 스냅숏에 없는 데이터베이스(그 사이 지워졌거나 템플릿)는 CONNECT를 판단하지 못한다: 만들어 낸 답 대신 모두 false
    let mut scene = app_scene(PG16);
    scene.cluster.databases.clear();
    let view = database_view(&scene.cluster, &scene.db);
    assert_eq!(view.db_privileges.len(), scene.cluster.roles.len());
    assert!(view.db_privileges.iter().all(|p| !p.connect && !p.create && !p.temp));
    assert_eq!(view.cells.len(), 18);
}

// ───────────────────────── 칸 상세 ─────────────────────────

fn detail(scene: &Scene, role: &str, schema: &str) -> crate::pg::view::PgCellDetail {
    cell_detail(&scene.cluster, &scene.db, role, schema).unwrap_or_else(|e| panic!("{role}/{schema}: {e:?}"))
}

fn grants_of(object: &crate::pg::view::PgCellObject) -> Vec<(&str, Vec<SourceKind>)> {
    object.privileges.iter().map(|p| (p.privilege.as_str(), p.sources.iter().map(|s| s.kind).collect())).collect()
}

#[test]
fn a_cell_detail_lists_only_the_privileges_the_role_has_with_their_sources_in_name_order() {
    let mut scene = app_scene(PG16);
    scene.db.relations.iter_mut().find(|r| r.name == "customers").expect("customers").rls = true;
    let result = detail(&scene, "alice", "app");
    assert_eq!((result.role.as_str(), result.schema.as_str(), result.truncated), ("alice", "app", false));

    // 이름순: 테이블, 뷰, 시퀀스, 함수를 가리지 않고 이름으로 한 줄이다
    let names: Vec<&str> = result.objects.iter().map(|o| o.object.name.as_str()).collect();
    assert_eq!(names, ["customers", "order_summary", "order_totals", "orders", "plain", "ticket_seq", "touch"]);
    let kinds: Vec<PgObjectKind> = result.objects.iter().map(|o| o.object.kind).collect();
    assert_eq!(
        kinds,
        [PgObjectKind::Table, PgObjectKind::Matview, PgObjectKind::View, PgObjectKind::Table, PgObjectKind::Function, PgObjectKind::Sequence, PgObjectKind::Function]
    );

    let object = |name: &str| result.objects.iter().find(|o| o.object.name == name).unwrap_or_else(|| panic!("{name}"));
    // 가진 권한만: orders는 SELECT(app_read에서), INSERT·UPDATE(app_write에서). DELETE는 없다
    assert_eq!(grants_of(object("orders")), [("SELECT", vec![SourceKind::Group]), ("INSERT", vec![SourceKind::Group]), ("UPDATE", vec![SourceKind::Group])]);
    assert_eq!(
        object("orders").privileges[0].sources,
        [source(SourceKind::Group, &["app_write", "app_read"], Some("app_owner"))],
        "출처는 경로와 부여한 역할을 함께 담아요"
    );
    assert_eq!(object("orders").privileges[1].sources, [source(SourceKind::Group, &["app_write"], Some("app_owner"))]);
    assert_eq!(grants_of(object("customers")), [("SELECT", vec![SourceKind::Group])]);
    assert_eq!((object("customers").owner.as_str(), object("customers").rls, object("orders").rls), ("app_owner", true, false));
    // 시퀀스: USAGE만 받았다. 함수: 기본값 PUBLIC EXECUTE와 그룹에서 받은 EXECUTE
    assert_eq!(grants_of(object("ticket_seq")), [("USAGE", vec![SourceKind::Group])]);
    assert_eq!(grants_of(object("plain")), [("EXECUTE", vec![SourceKind::Public])]);
    assert_eq!(object("plain").object.signature.as_deref(), Some("a integer, b text"));
    assert_eq!(grants_of(object("touch")), [("EXECUTE", vec![SourceKind::Group])]);
    assert_eq!(object("touch").object.schema.as_deref(), Some("app"));
    assert_eq!(object("orders").object.signature, None);
}

#[test]
fn the_privileges_of_an_object_come_in_the_order_of_its_kind() {
    let mut scene = app_scene(PG16);
    // 소유자는 테이블 권한 일곱 가지와 시퀀스 권한 셋을 모두 가진다
    let owner = detail(&scene, "app_owner", "app");
    let object = |name: &str| owner.objects.iter().find(|o| o.object.name == name).unwrap_or_else(|| panic!("{name}"));
    let names = |name: &str| object(name).privileges.iter().map(|p| p.privilege.as_str()).collect::<Vec<_>>();
    assert_eq!(names("orders"), ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]);
    assert_eq!(names("ticket_seq"), ["USAGE", "SELECT", "UPDATE"]);
    assert_eq!(names("touch"), ["EXECUTE"]);
    assert!(object("orders").privileges.iter().all(|p| p.sources.iter().all(|s| s.kind == SourceKind::Owner)));

    // PG17부터는 MAINTAIN도 있다(TRIGGER 다음). PG16에서는 ACL에 남아 있어도 없는 권한이다
    scene.db.relations.iter_mut().find(|r| r.name == "orders").expect("orders").acl.push(entry("app_owner", Some("alice"), Maintain));
    let alice = detail(&scene, "alice", "app");
    let orders = |d: &crate::pg::view::PgCellDetail| d.objects.iter().find(|o| o.object.name == "orders").map(|o| o.privileges.iter().map(|p| p.privilege.clone()).collect::<Vec<_>>());
    assert_eq!(orders(&alice), Some(vec!["SELECT".to_string(), "INSERT".into(), "UPDATE".into()]));
    let mut scene17 = app_scene(PG17);
    scene17.db.relations.iter_mut().find(|r| r.name == "orders").expect("orders").acl.push(entry("app_owner", Some("alice"), Maintain));
    assert_eq!(orders(&detail(&scene17, "alice", "app")), Some(vec!["SELECT".to_string(), "INSERT".into(), "UPDATE".into(), "MAINTAIN".into()]));
}

#[test]
fn an_object_the_role_has_no_privilege_on_is_left_out_and_an_empty_schema_has_no_objects() {
    let scene = app_scene(PG16);
    // bob은 NOINHERIT라서 그룹의 권한이 없다: 남는 것은 PUBLIC의 EXECUTE뿐이다
    let bob = detail(&scene, "bob", "app");
    assert_eq!(bob.objects.iter().map(|o| o.object.name.as_str()).collect::<Vec<_>>(), ["plain"]);
    assert!(detail(&scene, "bob", "scratch").objects.is_empty());
    assert!(detail(&scene, "app_owner", "scratch").objects.is_empty(), "scratch는 비어 있어요");
}

#[test]
fn a_cell_detail_stops_at_2000_objects_and_says_so() {
    let mut scene = app_scene(PG16);
    // 같은 이름 순서를 지키도록 번호를 채운다. 모두 alice에게 직접 SELECT를 준다
    scene.db.relations = (0..2_001).map(|i| table("app", &format!("t{i:05}"), "app_owner").grant("alice", &[Select])).collect();
    scene.db.functions.clear();
    let result = detail(&scene, "alice", "app");
    assert_eq!(result.objects.len(), 2_000);
    assert!(result.truncated);
    assert_eq!(result.objects.first().map(|o| o.object.name.as_str()), Some("t00000"));
    assert_eq!(result.objects.last().map(|o| o.object.name.as_str()), Some("t01999"), "이름순의 앞쪽 2000개만 남아요");

    // 정확히 2000개면 잘리지 않았다
    scene.db.relations.pop();
    let exact = detail(&scene, "alice", "app");
    assert_eq!((exact.objects.len(), exact.truncated), (2_000, false));
    // 가진 권한이 없는 객체는 세지 않는다
    scene.db.relations.push(table("app", "zzz_unreadable", "app_owner"));
    assert_eq!((detail(&scene, "alice", "app").objects.len(), detail(&scene, "alice", "app").truncated), (2_000, false));
}

#[test]
fn a_cell_detail_of_a_cut_snapshot_says_it_is_partial() {
    let mut scene = app_scene(PG16);
    assert!(!detail(&scene, "alice", "app").truncated);
    scene.db.truncated = true;
    let result = detail(&scene, "alice", "app");
    assert!(result.truncated, "스냅숏 자체가 잘렸으면 칸도 일부만 본 거예요");
    assert!(!result.objects.is_empty());
}

#[test]
fn a_cell_detail_asks_for_a_known_role_and_schema() {
    let scene = app_scene(PG16);
    assert_eq!(cell_detail(&scene.cluster, &scene.db, "nobody", "app"), Err(AppError::other("역할을 찾을 수 없어요: nobody")));
    assert_eq!(cell_detail(&scene.cluster, &scene.db, "alice", "nope"), Err(AppError::other("스키마를 찾을 수 없어요: nope")));
}

#[test]
fn objects_of_other_schemas_are_not_mixed_in() {
    let mut scene = app_scene(PG16);
    scene.db.relations.push(table("audit", "orders", "app_owner").grant("alice", &[Select]));
    let app = detail(&scene, "alice", "app");
    let audit = detail(&scene, "alice", "audit");
    assert_eq!(app.objects.iter().filter(|o| o.object.name == "orders").count(), 1);
    assert_eq!(audit.objects.iter().map(|o| (o.object.schema.as_deref(), o.object.name.as_str())).collect::<Vec<_>>(), [(Some("audit"), "orders")]);
}
