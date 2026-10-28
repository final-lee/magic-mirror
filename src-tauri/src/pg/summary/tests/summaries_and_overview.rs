use super::*;

const MANAGE_REASON: &str = "이 사용자는 rds_superuser 멤버가 아니고 CREATEROLE도 없어서 바꿀 수 없어요";

// ───────────────────────── 역할 요약 ─────────────────────────

#[test]
fn a_role_is_a_user_when_it_can_log_in_and_a_group_otherwise() {
    let mut scene = app_scene(PG16);
    scene.cluster.roles.push(RoleRec { login: false, ..role("locked_user") });
    let all = summaries(&scene);
    assert_eq!(by_name(&all, "alice").kind, PgRoleKind::User);
    assert_eq!(by_name(&all, "app_owner").kind, PgRoleKind::User);
    assert_eq!(by_name(&all, "app_read").kind, PgRoleKind::Group);
    // 로그인을 끈(잠근) 사용자도 PostgreSQL에서는 그룹과 구분되지 않는다
    assert_eq!(by_name(&all, "locked_user").kind, PgRoleKind::Group);
    // 스냅숏의 역할 순서를 지킨다
    assert_eq!(all.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), scene.cluster.roles.iter().map(|r| r.name.as_str()).collect::<Vec<_>>());
}

#[test]
fn system_roles_are_the_pg_and_rds_prefixes_and_the_three_named_ones() {
    for name in ["pg_read_all_data", "pg_monitor", "pg_database_owner", "rds_superuser", "rds_iam", "rds_replication", "rdsadmin", "rdstopmgr", "rdsrepladmin"] {
        assert!(is_system_role(name), "{name}");
    }
    for name in ["postgres", "app_read", "iam_admin", "rds", "rdsuser", "rdsfoo", "pgbouncer", "pg", "my_pg_user", "app_rds_iam", "rdsadmin2", "RDSADMIN", "PG_X"] {
        assert!(!is_system_role(name), "{name}");
    }
    let mut scene = rds_scene(PG16);
    scene.cluster.roles.push(role("rdsadmin"));
    let all = summaries(&scene);
    assert!(by_name(&all, "rds_superuser").system && by_name(&all, "rds_iam").system && by_name(&all, "rdsadmin").system);
    assert!(!by_name(&all, "alice").system && !by_name(&all, "app_read").system);
}

#[test]
fn the_attributes_and_the_comment_are_copied() {
    let mut scene = app_scene(PG16);
    scene.cluster.roles.push(RoleRec {
        inherit: false,
        create_db: true,
        create_role: true,
        replication: true,
        bypass_rls: true,
        conn_limit: 5,
        valid_until: Some("2031-01-01T00:00:00Z".into()),
        comment: Some("야간 배치".into()),
        ..login("batch")
    });
    let all = summaries(&scene);
    let batch = by_name(&all, "batch");
    assert_eq!(
        batch.attributes,
        crate::pg::view::PgAttributes {
            login: true,
            create_db: true,
            create_role: true,
            inherit: false,
            replication: true,
            bypass_rls: true,
            connection_limit: 5,
            valid_until: Some("2031-01-01T00:00:00Z".into()),
        }
    );
    assert_eq!(batch.comment.as_deref(), Some("야간 배치"));
    let alice = by_name(&all, "alice");
    assert_eq!((alice.attributes.connection_limit, alice.attributes.valid_until.as_deref(), alice.comment.as_deref()), (-1, None, None));
}

fn badge(kind: PgBadgeKind, label: &str, level: PgBadgeLevel) -> PgBadge {
    PgBadge { kind, label: label.into(), level }
}

#[test]
fn badges_come_in_the_contract_order_with_their_labels_and_levels() {
    let mut scene = rds_scene(PG16);
    scene.cluster.roles.push(RoleRec {
        create_role: true,
        create_db: true,
        bypass_rls: true,
        replication: true,
        valid_until: Some("2026-10-27T12:00:00Z".into()),
        ..login("iam_admin")
    });
    scene.cluster.members.extend([member("iam_admin", "rds_superuser"), member("iam_admin", "rds_iam")]);
    let all = summaries(&scene);
    assert_eq!(
        by_name(&all, "iam_admin").badges,
        [
            badge(PgBadgeKind::Admin, "관리자급", PgBadgeLevel::High),
            badge(PgBadgeKind::IamAuth, "IAM 인증", PgBadgeLevel::Info),
            badge(PgBadgeKind::CreateRole, "CREATEROLE", PgBadgeLevel::Medium),
            badge(PgBadgeKind::CreateDb, "CREATEDB", PgBadgeLevel::Info),
            badge(PgBadgeKind::BypassRls, "BYPASSRLS", PgBadgeLevel::Medium),
            badge(PgBadgeKind::Replication, "REPLICATION", PgBadgeLevel::Info),
            badge(PgBadgeKind::Expired, "만료됨", PgBadgeLevel::Medium),
            badge(PgBadgeKind::LoginRole, "앱이 로그인한 역할", PgBadgeLevel::Info),
        ]
    );
    // 만료가 곧이면 "곧 만료"가 같은 자리에 온다
    scene.role_mut("iam_admin").valid_until = Some("2026-11-05T12:00:00Z".into());
    let soon = summaries(&scene);
    assert_eq!(
        badge_kinds(by_name(&soon, "iam_admin")),
        [
            PgBadgeKind::Admin,
            PgBadgeKind::IamAuth,
            PgBadgeKind::CreateRole,
            PgBadgeKind::CreateDb,
            PgBadgeKind::BypassRls,
            PgBadgeKind::Replication,
            PgBadgeKind::ExpiringSoon,
            PgBadgeKind::LoginRole
        ]
    );
    assert_eq!(by_name(&soon, "iam_admin").badges[6], badge(PgBadgeKind::ExpiringSoon, "곧 만료", PgBadgeLevel::Info));
    // 속성이 없는 보통 역할은 배지가 없다
    assert!(by_name(&soon, "alice").badges.is_empty());
}

#[test]
fn the_admin_badge_covers_every_membership_path_that_reaches_rds_superuser() {
    let mut scene = rds_scene(PG16);
    scene.cluster.roles.extend([
        login("direct"),
        login("via_group"),
        login("two_hops"),
        RoleRec { inherit: false, ..login("noinherit_direct") },
        RoleRec { inherit: false, ..login("blocked") },
        RoleRec { inherit: false, ..login("deep_blocked") },
        login("outsider"),
        role("admins"),
        role("ops"),
    ]);
    scene.cluster.members.extend([
        member("direct", "rds_superuser"),
        member("admins", "rds_superuser"),
        member("via_group", "admins"),
        member("ops", "admins"),
        member("two_hops", "ops"),
        // 상속하지 않는 직접 구성원: SET ROLE로 쓸 수 있으니 관리자급이다
        member("noinherit_direct", "rds_superuser"),
        // 상속하지 않는 구성원이 그룹을 거쳐도 마찬가지다: `SET ROLE admins`나 `SET ROLE rds_superuser`를 하면 그 권한을 쓴다
        // (PostgreSQL 문서의 joe/admin/wheel 예). NOINHERIT 로그인을 관리자 그룹에 두는 것은 관리자 일에 SET ROLE을 요구하는 흔한 방법이다
        member("blocked", "admins"),
        member("deep_blocked", "ops"),
    ]);
    let all = summaries(&scene);
    for name in ["direct", "via_group", "two_hops", "noinherit_direct", "blocked", "deep_blocked", "admins", "ops"] {
        assert!(badge_kinds(by_name(&all, name)).contains(&PgBadgeKind::Admin), "{name}");
    }
    for name in ["outsider", "alice", "rds_superuser", "rds_iam"] {
        assert!(!badge_kinds(by_name(&all, name)).contains(&PgBadgeKind::Admin), "{name}");
    }
    // 배지는 관리자급 하나만 더해진다(다른 속성은 없다)
    assert_eq!(badge_kinds(by_name(&all, "blocked")), [PgBadgeKind::Admin]);

    // PG16에서 관계의 INHERIT 옵션을 끈 직접 구성원도 구성원이다
    let mut scene = rds_scene(PG16);
    scene.cluster.roles.push(login("option_off"));
    scene.cluster.members.push(member_with("option_off", "rds_superuser", false, true));
    assert!(badge_kinds(by_name(&summaries(&scene), "option_off")).contains(&PgBadgeKind::Admin));
}

#[test]
fn from_pg16_a_set_role_path_needs_the_set_option_and_what_the_new_role_inherits_counts() {
    let setup = |version: i32| {
        let mut scene = rds_scene(version);
        scene.cluster.roles.extend([
            RoleRec { inherit: false, ..login("set_ok") },
            RoleRec { inherit: false, ..login("first_link_off") },
            RoleRec { inherit: false, ..login("last_link_off") },
            RoleRec { inherit: false, ..login("sudoer") },
            role("admins"),
            role("sealed"),
            role("dba"),
        ]);
        // PG16부터는 관계마다 INHERIT·SET 옵션이 있고, 그 전에는 옵션 없이 구성원 속성만 본다
        let link = |who: &str, group: &str, inherit: bool, set: bool| if version >= 160_000 { member_with(who, group, inherit, set) } else { member(who, group) };
        scene.cluster.members.extend([
            link("admins", "rds_superuser", false, true),
            link("set_ok", "admins", false, true),
            // 첫 관계에 SET 옵션이 없다: admins가 되지 못한다
            link("first_link_off", "admins", false, false),
            // 마지막 관계에 INHERIT도 SET도 없다: sealed까지 가도 rds_superuser의 권한을 쓰지 못한다
            link("sealed", "rds_superuser", false, false),
            link("last_link_off", "sealed", false, true),
            // sudoer는 dba로 SET ROLE을 할 수 있다. dba는 rds_superuser를 상속하지만 그것으로 SET ROLE을 할 수는 없다(SET 끔):
            // dba가 된 세션은 rds_superuser의 권한을 쓴다
            link("dba", "rds_superuser", true, false),
            link("sudoer", "dba", false, true),
        ]);
        scene
    };
    let admin = |all: &[PgRoleSummary], name: &str| badge_kinds(by_name(all, name)).contains(&PgBadgeKind::Admin);

    let all = summaries(&setup(PG16));
    assert!(admin(&all, "set_ok"));
    assert!(!admin(&all, "first_link_off"), "첫 관계에 SET 옵션이 없으면 닿지 못해요");
    assert!(!admin(&all, "last_link_off"), "마지막 관계에 INHERIT도 SET도 없으면 닿지 못해요");
    assert!(admin(&all, "sudoer"), "dba로 SET ROLE을 한 뒤에는 dba가 상속하는 rds_superuser의 권한을 써요");

    // PG15 이하에는 옵션이 없다: 구성원 관계가 이어지면 SET ROLE을 할 수 있다
    let all = summaries(&setup(PG15));
    for name in ["set_ok", "first_link_off", "last_link_off", "sudoer"] {
        assert!(admin(&all, name), "{name}");
    }
}

#[test]
fn the_iam_badge_covers_direct_and_inherited_members_of_rds_iam() {
    let mut scene = rds_scene(PG15);
    scene.cluster.roles.extend([login("direct"), login("via_group"), login("outsider"), role("iam_users")]);
    scene.cluster.members.extend([member("direct", "rds_iam"), member("iam_users", "rds_iam"), member("via_group", "iam_users")]);
    let all = summaries(&scene);
    assert_eq!(badge_kinds(by_name(&all, "direct")), [PgBadgeKind::IamAuth]);
    assert_eq!(badge_kinds(by_name(&all, "via_group")), [PgBadgeKind::IamAuth]);
    assert_eq!(badge_kinds(by_name(&all, "iam_users")), [PgBadgeKind::IamAuth]);
    assert!(by_name(&all, "outsider").badges.is_empty());
    assert!(by_name(&all, "rds_iam").badges.is_empty(), "rds_iam 자신은 구성원이 아니에요");
}

#[test]
fn expiry_badges_use_the_time_of_the_read_and_a_window_of_30_days() {
    let mut scene = app_scene(PG16);
    let at = |secs: i64| Some(crate::iam::clock::iso(secs));
    scene.cluster.roles.extend([
        RoleRec { valid_until: at(now() - 1), ..login("just_expired") },
        RoleRec { valid_until: at(now()), ..login("expires_now") },
        RoleRec { valid_until: at(now() + 30 * DAY_SECS), ..login("on_the_last_day") },
        RoleRec { valid_until: at(now() + 30 * DAY_SECS + 1), ..login("later") },
        RoleRec { valid_until: Some("1970-01-01T00:00:00Z".into()), ..login("forever_expired") },
        // 로그인하지 못하는 역할도 만료 시각이 있으면 같은 배지를 단다
        RoleRec { valid_until: at(now() - DAY_SECS), ..role("old_group") },
        RoleRec { valid_until: Some("not a time".into()), ..login("unreadable") },
    ]);
    let all = summaries(&scene);
    assert_eq!(badge_kinds(by_name(&all, "just_expired")), [PgBadgeKind::Expired]);
    assert_eq!(badge_kinds(by_name(&all, "expires_now")), [PgBadgeKind::ExpiringSoon], "지금 만료되는 역할은 아직 만료된 것이 아니에요");
    assert_eq!(badge_kinds(by_name(&all, "on_the_last_day")), [PgBadgeKind::ExpiringSoon]);
    assert!(by_name(&all, "later").badges.is_empty());
    assert_eq!(badge_kinds(by_name(&all, "forever_expired")), [PgBadgeKind::Expired]);
    assert_eq!(badge_kinds(by_name(&all, "old_group")), [PgBadgeKind::Expired]);
    assert!(by_name(&all, "unreadable").badges.is_empty(), "읽지 못하는 시각은 만료로 치지 않아요");
    assert!(by_name(&all, "alice").badges.is_empty());
}

#[test]
fn only_the_login_user_gets_the_login_role_badge() {
    let mut scene = app_scene(PG16);
    scene.cluster.login_user = "alice".into();
    let all = summaries(&scene);
    assert_eq!(badge_kinds(by_name(&all, "alice")), [PgBadgeKind::LoginRole]);
    assert_eq!(all.iter().filter(|r| r.badges.iter().any(|b| b.kind == PgBadgeKind::LoginRole)).count(), 1);
}

#[test]
fn member_count_counts_direct_members_and_session_count_the_sessions_of_the_role() {
    let mut scene = app_scene(PG16);
    let session = |pid: i32, role: Option<&str>| SessionRec {
        pid,
        role: role.map(str::to_string),
        database: Some("appdb".into()),
        client_addr: None,
        application_name: String::new(),
        state: None,
        backend_start: None,
        query_start: None,
        wait_event: None,
    };
    scene.cluster.sessions = vec![session(1, Some("alice")), session(2, Some("alice")), session(3, Some("bob")), session(4, None)];
    let all = summaries(&scene);
    // app_read의 직접 구성원은 app_write와 bob이다. alice는 app_write를 거치는 간접 구성원이라 세지 않는다
    assert_eq!(by_name(&all, "app_read").member_count, 2);
    assert_eq!(by_name(&all, "app_write").member_count, 1);
    assert_eq!(by_name(&all, "alice").member_count, 0);
    assert_eq!(by_name(&all, "alice").session_count, 2);
    assert_eq!(by_name(&all, "bob").session_count, 1);
    assert_eq!(by_name(&all, "carol").session_count, 0);
}

#[test]
fn member_of_lists_the_direct_memberships_with_their_inherit_and_admin_flags() {
    // PG16: 관계마다의 INHERIT 옵션이다. bob은 NOINHERIT라서 false다
    let mut scene = app_scene(PG16);
    scene.member_mut("alice", "app_write").admin = true;
    scene.cluster.members.push(member_with("alice", "app_read", false, true));
    let all = summaries(&scene);
    assert_eq!(
        by_name(&all, "alice").member_of.iter().map(|m| (m.group.as_str(), m.inherit, m.admin)).collect::<Vec<_>>(),
        [("app_read", false, false), ("app_write", true, true)]
    );
    assert_eq!(by_name(&all, "bob").member_of.iter().map(|m| (m.group.as_str(), m.inherit)).collect::<Vec<_>>(), [("app_read", false)]);
    assert!(by_name(&all, "app_read").member_of.is_empty());

    // PG15 이하: 구성원 역할의 INHERIT 속성이다
    let scene = app_scene(PG15);
    let all = summaries(&scene);
    assert_eq!(by_name(&all, "bob").member_of.iter().map(|m| (m.group.as_str(), m.inherit)).collect::<Vec<_>>(), [("app_read", false)]);
    assert_eq!(by_name(&all, "alice").member_of.iter().map(|m| (m.group.as_str(), m.inherit)).collect::<Vec<_>>(), [("app_write", true)]);
    assert_eq!(by_name(&all, "carol").member_of.iter().map(|m| m.group.as_str()).collect::<Vec<_>>(), ["pg_read_all_data"]);
}

#[test]
fn member_of_says_whether_each_membership_allows_set_role() {
    let sets = |all: &[PgRoleSummary], name: &str| -> Vec<(String, bool, bool)> {
        by_name(all, name).member_of.iter().map(|m| (m.group.clone(), m.inherit, m.set)).collect()
    };

    // PG16: 관계마다 SET 옵션이 있고 INHERIT과는 따로다. CREATEROLE 사용자가 만든 역할의 자동 부여는 INHERIT도 SET도 없다
    let mut scene = app_scene(PG16);
    scene.cluster.members.extend([member_with("alice", "app_read", false, false), member_with("carol", "app_write", false, true)]);
    let all = summaries(&scene);
    assert_eq!(sets(&all, "alice"), [("app_read".to_string(), false, false), ("app_write".to_string(), true, true)], "상속도 SET도 없는 관계");
    assert_eq!(sets(&all, "carol"), [("app_write".to_string(), false, true), ("pg_read_all_data".to_string(), true, true)], "상속하지 않아도 SET은 되는 관계");
    assert_eq!(sets(&all, "bob"), [("app_read".to_string(), false, true)], "NOINHERIT 구성원의 부여는 SET이 켜져 있다");

    // PG15 이하: SET 옵션이 없고 구성원이면 언제나 SET ROLE을 할 수 있다. 상속하지 않는 bob도 그렇다
    let all = summaries(&app_scene(PG15));
    assert_eq!(sets(&all, "bob"), [("app_read".to_string(), false, true)]);
    assert_eq!(sets(&all, "alice"), [("app_write".to_string(), true, true)]);
    assert_eq!(sets(&all, "carol"), [("pg_read_all_data".to_string(), true, true)]);
}

// ───────────────────────── 개요 ─────────────────────────

fn info() -> PgTargetInfo {
    PgTargetInfo {
        arn: "arn:aws:rds:ap-northeast-2:123456789012:cluster:orders-aurora".into(),
        identifier: "orders-aurora".into(),
        kind: TargetKind::Cluster,
        engine: "aurora-postgresql".into(),
        engine_version: "16.4".into(),
        endpoint: "orders-aurora.cluster-c9akciq32.ap-northeast-2.rds.amazonaws.com".into(),
        port: 5432,
        default_database: "appdb".into(),
        iam_auth: true,
        read_replica: false,
    }
}

fn manage(scene: &Scene) -> (bool, Option<String>) {
    let overview = overview(&info(), &scene.cluster, now());
    (overview.can_manage, overview.manage_reason)
}

/// 로그인 사용자 `iam_admin`(픽스처의 기본값)이 있는 장면
fn scene_with_login(login_role: RoleRec) -> Scene {
    let mut scene = rds_scene(PG16);
    assert_eq!(scene.cluster.login_user, "iam_admin");
    scene.cluster.roles.push(login_role);
    scene
}

#[test]
fn the_login_user_can_manage_when_it_inherits_rds_superuser() {
    let mut scene = scene_with_login(login("iam_admin"));
    scene.cluster.members.push(member("iam_admin", "rds_superuser"));
    assert_eq!(manage(&scene), (true, None));

    // 그룹을 거쳐 상속해도 된다
    let mut scene = scene_with_login(login("iam_admin"));
    scene.cluster.roles.push(role("admins"));
    scene.cluster.members.extend([member("iam_admin", "admins"), member("admins", "rds_superuser")]);
    assert_eq!(manage(&scene), (true, None));
}

#[test]
fn the_login_user_can_manage_with_createrole_or_as_a_superuser() {
    assert_eq!(manage(&scene_with_login(RoleRec { create_role: true, ..login("iam_admin") })), (true, None));
    assert_eq!(manage(&scene_with_login(RoleRec { superuser: true, ..login("iam_admin") })), (true, None));
}

#[test]
fn the_login_user_cannot_manage_otherwise_and_the_reason_is_the_exact_text() {
    // 아무것도 없다
    assert_eq!(manage(&scene_with_login(login("iam_admin"))), (false, Some(MANAGE_REASON.to_string())));
    // rds_superuser 멤버여도 상속하지 않으면(NOINHERIT) 그 권한을 쓰지 못한다
    let mut scene = scene_with_login(RoleRec { inherit: false, ..login("iam_admin") });
    scene.cluster.members.push(member("iam_admin", "rds_superuser"));
    assert_eq!(manage(&scene), (false, Some(MANAGE_REASON.to_string())));
    // PG16에서 관계의 INHERIT 옵션을 끈 구성원도 마찬가지다
    let mut scene = scene_with_login(login("iam_admin"));
    scene.cluster.members.push(member_with("iam_admin", "rds_superuser", false, true));
    assert_eq!(manage(&scene), (false, Some(MANAGE_REASON.to_string())));
    // 상속하는 그룹이 rds_superuser가 아니다
    let mut scene = scene_with_login(login("iam_admin"));
    scene.cluster.members.push(member("iam_admin", "app_read"));
    assert_eq!(manage(&scene), (false, Some(MANAGE_REASON.to_string())));
    // 로그인 사용자가 역할 목록에 없다
    assert_eq!(manage(&rds_scene(PG16)), (false, Some(MANAGE_REASON.to_string())));
}

#[test]
fn the_overview_carries_the_target_the_server_facts_and_the_databases() {
    let mut scene = scene_with_login(login("iam_admin"));
    scene.cluster.version = "16.4".into();
    scene.cluster.version_num = 160_004;
    scene.cluster.password_encryption = "md5".into();
    let mut archive = database("legacy_archive", "app_owner");
    archive.allow_conn = false;
    scene.cluster.databases.push(archive);
    let result = overview(&info(), &scene.cluster, now());

    assert_eq!(result.target, info());
    assert_eq!(result.login_user, "iam_admin");
    assert_eq!((result.server_version.as_str(), result.server_version_num, result.password_encryption.as_str()), ("16.4", 160_004, "md5"));
    assert_eq!(result.fetched_at, scene.cluster.fetched_at);
    assert_eq!(result.roles, role_summaries(&scene.cluster, now()));
    assert_eq!(
        result.databases.iter().map(|d| (d.name.as_str(), d.owner.as_str(), d.allow_conn)).collect::<Vec<_>>(),
        [("appdb", "app_owner", true), ("legacy_archive", "app_owner", false)]
    );
}
