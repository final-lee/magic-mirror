//! 뷰 만들기 시험: 스냅숏 픽스처(`app_scene`)로 돈다. 계약의 JSON 모양은 `view`의 시험이 지킨다.

use super::*;
use crate::iam::clock::{parse_iso, DAY_SECS};
use crate::pg::eval::SourceKind;
use crate::pg::fixtures::*;
use crate::pg::model::Privilege::{Connect, Create, Delete, Execute, Insert, Maintain, References, Select, Temporary, Trigger, Truncate, Update, Usage};
use crate::pg::model::{AclEntry, DefaultAclRec, DefaultObjType, RoleRec, RoleSettingRec, SessionRec};
use crate::pg::target::TargetKind;
use crate::pg::view::{PgBadge, PgBadgeKind, PgBadgeLevel, PgCoverage, PgObjectKind, PgRoleKind, PgSource};

const MANAGE_REASON: &str = "이 사용자는 rds_superuser 멤버가 아니고 CREATEROLE도 없어서 바꿀 수 없어요";

fn now() -> i64 {
    parse_iso("2026-10-28T12:00:00Z").expect("now")
}

/// 앱 장면에 RDS의 역할 둘을 더한다: rds_superuser(CREATEROLE·CREATEDB가 있다), rds_iam
fn rds_scene(version: i32) -> Scene {
    let mut scene = app_scene(version);
    scene.cluster.roles.extend([RoleRec { create_role: true, create_db: true, ..role("rds_superuser") }, role("rds_iam")]);
    scene
}

fn by_name<'a>(all: &'a [PgRoleSummary], name: &str) -> &'a PgRoleSummary {
    all.iter().find(|r| r.name == name).unwrap_or_else(|| panic!("{name} 역할이 없어요"))
}

fn badge_kinds(role: &PgRoleSummary) -> Vec<PgBadgeKind> {
    role.badges.iter().map(|b| b.kind).collect()
}

fn summaries(scene: &Scene) -> Vec<PgRoleSummary> {
    role_summaries(&scene.cluster, now())
}

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
fn the_admin_badge_covers_direct_and_inherited_members_of_rds_superuser() {
    let mut scene = rds_scene(PG16);
    scene.cluster.roles.extend([
        login("direct"),
        login("via_group"),
        login("two_hops"),
        RoleRec { inherit: false, ..login("noinherit_direct") },
        RoleRec { inherit: false, ..login("blocked") },
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
        // 상속하지 않는 구성원이 그룹을 거치면 rds_superuser의 권한에 닿지 않는다
        member("blocked", "admins"),
    ]);
    let all = summaries(&scene);
    for name in ["direct", "via_group", "two_hops", "noinherit_direct", "admins", "ops"] {
        assert!(badge_kinds(by_name(&all, name)).contains(&PgBadgeKind::Admin), "{name}");
    }
    for name in ["blocked", "outsider", "alice", "rds_superuser", "rds_iam"] {
        assert!(!badge_kinds(by_name(&all, name)).contains(&PgBadgeKind::Admin), "{name}");
    }
    // PG16에서 관계의 INHERIT 옵션을 끈 직접 구성원도 구성원이다
    let mut scene = rds_scene(PG16);
    scene.cluster.roles.push(login("option_off"));
    scene.cluster.members.push(member_with("option_off", "rds_superuser", false, true));
    assert!(badge_kinds(by_name(&summaries(&scene), "option_off")).contains(&PgBadgeKind::Admin));
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

fn source(kind: SourceKind, via: &[&str], grantor: Option<&str>) -> PgSource {
    PgSource { kind, via: via.iter().map(|s| s.to_string()).collect(), grantor: grantor.map(str::to_string) }
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
    assert_eq!(cell_detail(&scene.cluster, &scene.db, "nobody", "app"), Err(AppError::other("알 수 없는 역할이에요: nobody")));
    assert_eq!(cell_detail(&scene.cluster, &scene.db, "alice", "nope"), Err(AppError::other("스키마를 찾지 못했어요: nope")));
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

// ───────────────────────── 객체 검색 ─────────────────────────

/// 검색 결과를 (종류, 사람이 읽는 이름)으로 줄여 본다
fn found(scene: &Scene, query: &str) -> Vec<(PgObjectKind, String)> {
    search_objects(&scene.cluster, &scene.db, query)
        .into_iter()
        .map(|o| {
            let qualified = match (&o.schema, o.kind) {
                (Some(schema), _) => format!("{schema}.{}", o.name),
                (None, _) => o.name.clone(),
            };
            (o.kind, o.signature.map_or(qualified.clone(), |signature| format!("{qualified}({signature})")))
        })
        .collect()
}

fn search_scene() -> Scene {
    let mut scene = app_scene(PG16);
    scene.cluster.databases.push(database("orders_archive", "app_owner"));
    scene
}

#[test]
fn search_is_a_case_insensitive_substring_of_schema_dot_name_and_of_the_name_for_databases_and_schemas() {
    let scene = search_scene();
    use PgObjectKind::*;
    assert_eq!(
        found(&scene, "ORD"),
        [
            (Database, "orders_archive".into()),
            (Matview, "app.order_summary".into()),
            (View, "app.order_totals".into()),
            (Table, "app.orders".into()),
        ]
    );
    // 스키마와 이름 사이의 점을 넘어 맞춘다
    assert_eq!(found(&scene, "app.ord").len(), 3);
    assert_eq!(found(&scene, "p.cust"), [(Table, "app.customers".into())]);
    // 데이터베이스와 스키마는 이름만 본다: "appdb"에서 점은 없다
    assert_eq!(found(&scene, "b.")[..], []);
    assert_eq!(found(&scene, "nothing like this"), []);
}

#[test]
fn search_sorts_databases_then_schemas_then_relations_then_functions_each_by_name() {
    let scene = search_scene();
    use PgObjectKind::*;
    assert_eq!(
        found(&scene, "app"),
        [
            (Database, "appdb".into()),
            (Schema, "app".into()),
            (Table, "app.customers".into()),
            (Matview, "app.order_summary".into()),
            (View, "app.order_totals".into()),
            (Table, "app.orders".into()),
            (Sequence, "app.ticket_seq".into()),
            (Function, "app.plain(a integer, b text)".into()),
            (Function, "app.touch(order_id integer)".into()),
        ]
    );
    // 함수는 인자 목록을 함께 돌려주고, 관계에는 인자 목록이 없다
    let results = search_objects(&scene.cluster, &scene.db, "touch");
    assert_eq!(results.len(), 1);
    assert_eq!((results[0].kind, results[0].schema.as_deref(), results[0].name.as_str(), results[0].signature.as_deref()), (Function, Some("app"), "touch", Some("order_id integer")));
    let orders = &search_objects(&scene.cluster, &scene.db, "app.orders")[0];
    assert_eq!((orders.kind, orders.schema.as_deref(), orders.signature.as_deref()), (Table, Some("app"), None));
    // 스키마와 데이터베이스는 스키마 칸이 비어 있다
    let schema = &search_objects(&scene.cluster, &scene.db, "scratch")[0];
    assert_eq!((schema.kind, schema.schema.as_deref(), schema.name.as_str()), (Schema, None, "scratch"));
}

#[test]
fn search_returns_at_most_100_results_and_the_databases_come_first() {
    let mut scene = search_scene();
    scene.db.relations = (0..150).map(|i| table("app", &format!("hit_{i:03}"), "app_owner")).collect();
    scene.db.relations.reverse();
    scene.cluster.databases.push(database("hit_db", "app_owner"));
    let results = found(&scene, "hit");
    assert_eq!(results.len(), 100);
    assert_eq!(results[0], (PgObjectKind::Database, "hit_db".into()));
    // 이름순의 앞쪽만 남는다(스냅숏의 순서와 상관없다)
    assert_eq!(results[1], (PgObjectKind::Table, "app.hit_000".into()));
    assert_eq!(results[99], (PgObjectKind::Table, "app.hit_098".into()));
}

#[test]
fn an_empty_query_returns_the_first_100_objects_in_the_same_order() {
    let scene = search_scene();
    use PgObjectKind::*;
    let all = found(&scene, "");
    // 데이터베이스 둘, 스키마 셋, 관계 일곱, 함수 둘
    assert_eq!(all.len(), 2 + 3 + 7 + 2);
    assert_eq!(all.iter().map(|(k, _)| *k).collect::<Vec<_>>()[..5], [Database, Database, Schema, Schema, Schema]);
    assert_eq!(all[0].1, "appdb");
    assert_eq!(all[1].1, "orders_archive");
    assert_eq!(all[2].1, "app");
    assert_eq!(all.last().map(|(k, _)| *k), Some(Function));

    let mut big = search_scene();
    big.db.relations = (0..300).map(|i| table("app", &format!("t{i:03}"), "app_owner")).collect();
    let first = found(&big, "");
    assert_eq!(first.len(), 100);
    assert_eq!(first[5], (Table, "app.t000".into()), "데이터베이스 둘과 스키마 셋 다음에 관계가 이름순으로 온다");
    assert_eq!(first[99], (Table, "app.t094".into()));
}

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
