use super::*;

// ───────────────────────── 역할 상세 ─────────────────────────

fn role_setting(role: Option<&str>, database: Option<&str>, setting: &str) -> RoleSettingRec {
    RoleSettingRec { role: role.map(str::to_string), database: database.map(str::to_string), setting: setting.into() }
}

fn view_of(scene: &Scene, role: &str, loaded: &[&DbSnapshot], own: &[i32]) -> PgRoleView {
    role_view(&scene.cluster, loaded, role, now(), own).unwrap_or_else(|e| panic!("{role}: {e:?}"))
}

#[test]
fn the_role_view_has_the_summary_the_settings_the_members_and_the_set_role_only_roles() {
    let mut scene = app_scene(PG16);
    scene.cluster.settings = vec![
        role_setting(Some("bob"), None, "work_mem=1MB"),
        role_setting(Some("alice"), Some("appdb"), "statement_timeout=5s"),
        role_setting(None, Some("appdb"), "work_mem=8MB"),
        role_setting(Some("alice"), None, "search_path=app, public"),
        role_setting(None, None, "log_statement=none"),
    ];
    let alice = view_of(&scene, "alice", &[], &[]);
    assert_eq!(alice.summary, by_name(&summaries(&scene), "alice").clone());
    // 이 역할의 설정과 모든 역할에 걸린 설정(role이 없다). 다른 역할의 것은 뺀다. 데이터베이스 없는 것이 먼저, 그다음 이름순
    assert_eq!(
        alice.settings.iter().map(|s| (s.database.as_deref(), s.setting.as_str())).collect::<Vec<_>>(),
        [(None, "log_statement=none"), (None, "search_path=app, public"), (Some("appdb"), "statement_timeout=5s"), (Some("appdb"), "work_mem=8MB")]
    );
    assert_eq!(
        view_of(&scene, "bob", &[], &[]).settings.iter().map(|s| s.setting.as_str()).collect::<Vec<_>>(),
        ["log_statement=none", "work_mem=1MB", "work_mem=8MB"]
    );

    // 구성원: 이 역할에 직접 속한 역할들(이름순)과 그 관계의 INHERIT·ADMIN
    scene.member_mut("app_write", "app_read").admin = true;
    let group = view_of(&scene, "app_read", &[], &[]);
    assert_eq!(group.members.iter().map(|m| (m.role.as_str(), m.inherit, m.admin)).collect::<Vec<_>>(), [("app_write", true, true), ("bob", false, false)]);
    assert!(alice.members.is_empty());

    // 상속하지 않는 관계로만 닿는 역할
    assert_eq!(view_of(&scene, "bob", &[], &[]).set_role_only, ["app_read"]);
    assert!(alice.set_role_only.is_empty());
}

#[test]
fn the_members_of_a_group_say_whether_each_membership_allows_set_role() {
    let members = |scene: &Scene, group: &str| -> Vec<(String, bool, bool)> {
        view_of(scene, group, &[], &[]).members.iter().map(|m| (m.role.clone(), m.inherit, m.set)).collect()
    };

    // PG16: bob의 부여는 SET을 껐고, carol의 부여는 상속을 끄고 SET만 켰다
    let mut scene = app_scene(PG16);
    scene.member_mut("bob", "app_read").set = Some(false);
    scene.cluster.members.push(member_with("carol", "app_read", false, true));
    assert_eq!(
        members(&scene, "app_read"),
        [("app_write".to_string(), true, true), ("bob".to_string(), false, false), ("carol".to_string(), false, true)]
    );
    // 같은 역할 상세의 `setRoleOnly`도 SET이 없는 관계로는 닿지 못한다고 말한다
    assert!(view_of(&scene, "bob", &[], &[]).set_role_only.is_empty());
    assert_eq!(view_of(&scene, "carol", &[], &[]).set_role_only, ["app_read"]);

    // PG15 이하: SET 옵션이 없어서 구성원이면 늘 SET ROLE을 할 수 있다
    let scene = app_scene(PG15);
    assert_eq!(members(&scene, "app_read"), [("app_write".to_string(), true, true), ("bob".to_string(), false, true)]);
}

#[test]
fn an_unknown_role_has_no_view() {
    let scene = app_scene(PG16);
    assert_eq!(role_view(&scene.cluster, &[], "nobody", now(), &[]), Err(AppError::other("알 수 없는 역할이에요: nobody")));
}

#[test]
fn the_role_view_lists_every_connectable_database_and_fills_only_the_loaded_ones() {
    let mut scene = app_scene(PG16);
    let mut legacy = database("legacy", "app_owner");
    legacy.allow_conn = false;
    scene.cluster.databases.extend([legacy, database("orders_archive", "app_owner")]);
    let alice = view_of(&scene, "alice", &[&scene.db], &[]);

    // 연결할 수 없는 데이터베이스는 없다. 아직 읽지 않은 데이터베이스는 loaded=false에 나머지가 비어 있다
    assert_eq!(alice.databases.iter().map(|d| (d.database.as_str(), d.loaded)).collect::<Vec<_>>(), [("appdb", true), ("orders_archive", false)]);
    let archive = &alice.databases[1];
    assert!(archive.cells.is_empty() && archive.owned.is_empty() && archive.owned_omitted == 0);

    // 읽은 데이터베이스는 이 역할에게 보이는 권한이 있는 칸만 담는다: scratch는 아무것도 없어서 빠진다
    let appdb = &alice.databases[0];
    assert_eq!(appdb.cells.iter().map(|c| c.schema.as_str()).collect::<Vec<_>>(), ["app", "audit"]);
    let app = &appdb.cells[0];
    assert_eq!((app.role.as_str(), app.usage, app.read, app.write, app.inherited_only), ("alice", true, PgCoverage::All, PgCoverage::Some, true));
    let audit = &appdb.cells[1];
    assert_eq!((audit.usage, audit.read, audit.write), (true, PgCoverage::None, PgCoverage::None));
    // 보이는 권한이 없는 역할은 칸이 하나도 없다
    let bob = view_of(&scene, "bob", &[&scene.db], &[]);
    assert!(bob.databases[0].loaded && bob.databases[0].cells.is_empty());
}

#[test]
fn the_role_view_lists_what_the_role_owns_schemas_then_tables_then_sequences_then_functions() {
    let scene = app_scene(PG16);
    let owner = view_of(&scene, "app_owner", &[&scene.db], &[]);
    let owned = &owner.databases[0].owned;
    let shown: Vec<(PgObjectKind, String)> = owned.iter().map(|o| (o.kind, o.schema.as_ref().map_or(o.name.clone(), |s| format!("{s}.{}", o.name)))).collect();
    use PgObjectKind::*;
    assert_eq!(
        shown,
        [
            (Schema, "app".into()),
            (Schema, "audit".into()),
            (Schema, "scratch".into()),
            (Table, "app.customers".into()),
            (Matview, "app.order_summary".into()),
            (View, "app.order_totals".into()),
            (Table, "app.orders".into()),
            (Partitioned, "audit.events".into()),
            (Foreign, "audit.remote_log".into()),
            (Sequence, "app.ticket_seq".into()),
            (Function, "app.plain".into()),
            (Function, "app.touch".into()),
        ]
    );
    assert_eq!(owned[10].signature.as_deref(), Some("a integer, b text"));
    assert_eq!(owner.databases[0].owned_omitted, 0);
    // 소유하지 않은 역할은 아무것도 없다(권한이 있는 것과 소유는 다르다)
    assert!(view_of(&scene, "alice", &[&scene.db], &[]).databases[0].owned.is_empty());
}

#[test]
fn the_owned_list_stops_at_200_and_counts_the_rest() {
    let mut scene = app_scene(PG16);
    scene.db.relations = (0..250).map(|i| table("app", &format!("t{i:03}"), "app_owner")).collect();
    scene.db.functions.clear();
    let owner = view_of(&scene, "app_owner", &[&scene.db], &[]);
    let database = &owner.databases[0];
    // 스키마 셋이 먼저 자리를 잡고, 남는 197개를 이름순의 테이블이 채운다
    assert_eq!(database.owned.len(), 200);
    assert_eq!(database.owned_omitted, 3 + 250 - 200);
    assert_eq!(database.owned[2].name, "scratch");
    assert_eq!(database.owned[3].name, "t000");
    assert_eq!(database.owned[199].name, "t196");
    // 정확히 200개면 빠진 것이 없다
    scene.db.relations.truncate(197);
    let exact = view_of(&scene, "app_owner", &[&scene.db], &[]);
    assert_eq!((exact.databases[0].owned.len(), exact.databases[0].owned_omitted), (200, 0));
}

fn session(pid: i32, role: Option<&str>, database: Option<&str>) -> SessionRec {
    SessionRec {
        pid,
        role: role.map(str::to_string),
        database: database.map(str::to_string),
        client_addr: Some("10.0.0.1".into()),
        application_name: "psql".into(),
        state: Some("idle".into()),
        backend_start: Some("2026-10-28T09:00:00Z".into()),
        query_start: None,
        wait_event: None,
    }
}

#[test]
fn the_role_view_has_the_sessions_of_the_role_and_marks_the_ones_the_app_opened() {
    let mut scene = app_scene(PG16);
    scene.cluster.sessions = vec![session(10, Some("alice"), Some("appdb")), session(11, Some("bob"), Some("appdb")), session(12, Some("alice"), Some("postgres"))];
    let alice = view_of(&scene, "alice", &[], &[12]);
    assert_eq!(alice.sessions.iter().map(|s| (s.pid, s.own)).collect::<Vec<_>>(), [(10, false), (12, true)]);
    assert_eq!(alice.sessions[0].database.as_deref(), Some("appdb"));
    assert!(view_of(&scene, "carol", &[], &[12]).sessions.is_empty());
}

// ───────────────────────── 누가 할 수 있나 ─────────────────────────

#[test]
fn privilege_names_are_the_ones_aclexplode_gives() {
    let all = [
        ("SELECT", Select),
        ("INSERT", Insert),
        ("UPDATE", Update),
        ("DELETE", Delete),
        ("TRUNCATE", Truncate),
        ("REFERENCES", References),
        ("TRIGGER", Trigger),
        ("MAINTAIN", Maintain),
        ("EXECUTE", Execute),
        ("USAGE", Usage),
        ("CREATE", Create),
        ("CONNECT", Connect),
        ("TEMPORARY", Temporary),
    ];
    for (name, privilege) in all {
        assert_eq!(parse_privilege(name), Ok(privilege), "{name}");
    }
    // `TEMP`는 SQL의 줄임말이다. 서버가 풀어 주는 이름은 TEMPORARY다
    for name in ["TEMP", "temporary", "select", "Select", "", "ALL", "ALL PRIVILEGES", "SET", " SELECT"] {
        assert_eq!(parse_privilege(name), Err(AppError::other(format!("알 수 없는 권한이에요: {name}"))), "{name:?}");
    }
}

fn allowed(who: &PgWhoCan) -> Vec<(&str, Vec<SourceKind>, Option<&str>)> {
    who.allowed.iter().map(|r| (r.role.as_str(), r.sources.iter().map(|s| s.kind).collect(), r.unusable.as_deref())).collect()
}

#[test]
fn who_can_lists_the_roles_with_their_kind_system_flag_sources_and_unusable_reason() {
    let mut scene = app_scene(PG16);
    // pg_read_all_data는 목록에 넣지 않으면 시스템 역할 행이 없다. 넣으면 그 역할 자신도 SELECT를 가진 행이 된다
    scene.cluster.roles.push(role("pg_read_all_data"));
    scene.db.relations.iter_mut().find(|r| r.name == "orders").expect("orders").acl.push(entry("app_owner", Some("bob"), Select));
    let orders = PgObjectRef::relation(scene.relation("app.orders"));
    let who = who_can_view(&scene.cluster, &scene.db, &orders, Select).expect("who can");

    assert_eq!(who.object, orders);
    assert_eq!(who.privilege, "SELECT");
    assert_eq!(
        allowed(&who),
        [
            ("alice", vec![SourceKind::Group], None),
            ("app_owner", vec![SourceKind::Owner], None),
            ("app_read", vec![SourceKind::Direct], None),
            ("app_write", vec![SourceKind::Group], None),
            // bob은 CONNECT가 없다
            ("bob", vec![SourceKind::Direct], Some("CONNECT 없음")),
            ("carol", vec![SourceKind::Predefined], Some("CONNECT 없음")),
            ("pg_read_all_data", vec![SourceKind::Predefined], Some("CONNECT 없음")),
        ]
    );
    let row = |name: &str| who.allowed.iter().find(|r| r.role == name).unwrap_or_else(|| panic!("{name}"));
    assert_eq!((row("alice").kind, row("alice").system), (PgRoleKind::User, false));
    assert_eq!((row("app_read").kind, row("app_read").system), (PgRoleKind::Group, false));
    assert_eq!((row("pg_read_all_data").kind, row("pg_read_all_data").system), (PgRoleKind::Group, true));
    assert_eq!(row("alice").sources, [source(SourceKind::Group, &["app_write", "app_read"], Some("app_owner"))]);
}

#[test]
fn who_can_resolves_every_kind_of_object_from_the_reference() {
    let scene = app_scene(PG16);
    let ask = |object: &PgObjectRef, privilege| who_can_view(&scene.cluster, &scene.db, object, privilege).unwrap_or_else(|e| panic!("{object:?}: {e:?}"));
    let roles = |who: &PgWhoCan| who.allowed.iter().map(|r| r.role.clone()).collect::<Vec<_>>();

    // 데이터베이스: CONNECT는 소유자·app_read·그 구성원, TEMPORARY는 PUBLIC이라 모두
    assert_eq!(roles(&ask(&PgObjectRef::database("appdb"), Connect)), ["alice", "app_owner", "app_read", "app_write"]);
    let temporary = ask(&PgObjectRef::database("appdb"), Temporary);
    assert_eq!(temporary.privilege, "TEMPORARY");
    assert_eq!(roles(&temporary).len(), 6);
    assert!(temporary.allowed.iter().filter(|r| r.role != "app_owner").all(|r| r.sources.iter().all(|s| s.kind == SourceKind::Public)));
    // 스키마, 시퀀스, 함수(인자 목록으로 가려낸다)
    assert_eq!(roles(&ask(&PgObjectRef::schema("audit"), Usage)), ["alice", "app_owner", "app_write", "carol"]);
    let ticket = PgObjectRef::relation(scene.relation("app.ticket_seq"));
    assert_eq!(roles(&ask(&ticket, Usage)), ["alice", "app_owner", "app_write"]);
    let touch = PgObjectRef::function(scene.function("app.touch"));
    assert_eq!(roles(&ask(&touch, Execute)), ["alice", "app_owner", "app_write"]);
    // 돌려주는 객체는 스냅숏의 것이다
    assert_eq!(ask(&touch, Execute).object, touch);
}

#[test]
fn who_can_refuses_an_object_the_snapshot_does_not_have() {
    let scene = app_scene(PG16);
    let ask = |object: PgObjectRef| who_can_view(&scene.cluster, &scene.db, &object, Select);
    let missing = |text: &str| Err(AppError::other(format!("객체를 찾지 못했어요: {text}")));
    assert_eq!(ask(PgObjectRef::database("nope")), missing("nope"));
    assert_eq!(ask(PgObjectRef::schema("nope")), missing("nope"));
    assert_eq!(ask(PgObjectRef { kind: PgObjectKind::Table, schema: Some("app".into()), name: "nope".into(), signature: None }), missing("app.nope"));
    assert_eq!(ask(PgObjectRef { kind: PgObjectKind::Table, schema: None, name: "orders".into(), signature: None }), missing("orders"));
    // 함수는 인자 목록이 맞아야 한다. 없으면 어느 함수인지 알 수 없다
    let touch = |signature: Option<&str>| PgObjectRef { kind: PgObjectKind::Function, schema: Some("app".into()), name: "touch".into(), signature: signature.map(str::to_string) };
    assert_eq!(ask(touch(Some("text"))), missing("app.touch(text)"));
    assert_eq!(ask(touch(None)), missing("app.touch"));
    assert!(ask(touch(Some("order_id integer"))).is_ok());
}

#[test]
fn a_privilege_the_object_does_not_have_has_no_roles_instead_of_an_error() {
    let scene = app_scene(PG16);
    let orders = PgObjectRef::relation(scene.relation("app.orders"));
    let who = who_can_view(&scene.cluster, &scene.db, &orders, Usage).expect("who can");
    assert_eq!((who.privilege.as_str(), who.allowed.len()), ("USAGE", 0));
}

// ───────────────────────── 세션 ─────────────────────────

#[test]
fn sessions_keep_their_fields_and_order_and_mark_the_connections_of_the_app() {
    let records = vec![
        session(3040, Some("bob"), Some("postgres")),
        SessionRec { client_addr: None, state: None, backend_start: None, ..session(3101, Some("iam_admin"), Some("orders")) },
        session(3102, None, None),
    ];
    let shown = sessions(&records, &[3102, 3101]);
    assert_eq!(shown.iter().map(|s| (s.pid, s.own)).collect::<Vec<_>>(), [(3040, false), (3101, true), (3102, true)]);
    assert_eq!(
        (shown[0].role.as_deref(), shown[0].database.as_deref(), shown[0].client_addr.as_deref(), shown[0].application_name.as_str(), shown[0].state.as_deref()),
        (Some("bob"), Some("postgres"), Some("10.0.0.1"), "psql", Some("idle"))
    );
    assert_eq!(shown[0].backend_start.as_deref(), Some("2026-10-28T09:00:00Z"));
    // 다른 사용자의 세션은 자세한 칸이 비어 온다: 그대로 None이다
    assert_eq!((shown[1].client_addr.as_ref(), shown[1].state.as_ref(), shown[1].backend_start.as_ref()), (None, None, None));
    assert!(sessions(&[], &[1]).is_empty());
}
