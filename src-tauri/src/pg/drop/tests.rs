use std::future::{ready, Ready};
use std::sync::Mutex;

use super::*;
use crate::pg::change::support::admin;
use crate::pg::fixtures::*;
use crate::pg::model::Privilege::{Create, Insert, Select, Update, Usage};
use crate::pg::model::{AclEntry, DefaultAclRec, DefaultObjType, RelKind, SessionRec};

const ROLE: &str = "mm_drop";

/// 로그인한 `mm`(CREATEROLE, `app_owner`의 구성원)이 `mm_drop`을 지우는 장면. 데이터베이스는 `appdb`(기본)와 `other`.
/// 160000부터 `mm`은 `mm_drop`에 ADMIN OPTION만 있다(CREATEROLE 사용자가 만든 역할과 같다): 권한은 상속하지 않는다
struct World {
    cluster: ClusterSnapshot,
    dbs: Vec<Arc<DbSnapshot>>,
}

impl World {
    fn new(version: i32) -> World {
        let scene = admin(version).add_role(role(ROLE));
        let mut cluster = scene.cluster;
        if version >= PG16 {
            cluster.members.push(member_grants("mm", ROLE, &[(BOOTSTRAP, true, Some(false), Some(false))]));
        }
        cluster.databases.push(database("other", "app_owner"));
        let other = db("other", "app_owner", Vec::new(), Vec::new(), Vec::new());
        World { cluster, dbs: vec![Arc::new(scene.db), Arc::new(other)] }
    }

    fn db(&mut self, name: &str) -> &mut DbSnapshot {
        Arc::make_mut(self.dbs.iter_mut().find(|d| d.database == name).expect("데이터베이스가 없어요"))
    }

    fn plan_to(&self, role: &str, heir: &str) -> PgDropPlan {
        drop_plan(&self.cluster, &self.dbs, &[], role, heir, "appdb")
    }

    fn plan(&self) -> PgDropPlan {
        self.plan_to(ROLE, "mm")
    }
}

fn messages(plan: &PgDropPlan, level: PgWarnLevel) -> Vec<String> {
    plan.warnings.iter().filter(|w| w.level == level).map(|w| w.message.clone()).collect()
}

fn blocks(plan: &PgDropPlan) -> Vec<String> {
    messages(plan, PgWarnLevel::Block)
}

fn sql(plan: &PgDropPlan, step: usize) -> Vec<&str> {
    plan.steps[step].sql.iter().map(String::as_str).collect()
}

fn acl(grantor: &str, grantee: &str, privilege: Privilege, grantable: bool) -> AclEntry {
    AclEntry { grantor: grantor.into(), grantee: Some(grantee.into()), privilege, grantable }
}

fn session(pid: i32, role: &str) -> SessionRec {
    SessionRec {
        pid,
        role: Some(role.into()),
        database: Some("appdb".into()),
        client_addr: None,
        application_name: String::new(),
        state: None,
        backend_start: None,
        query_start: None,
        wait_event: None,
    }
}

// ───────────────────────── 단계 ─────────────────────────

#[test]
fn there_is_one_step_per_database_in_name_order_and_a_last_drop_role_step_in_the_default_database() {
    let plan = World::new(PG16).plan();
    let names: Vec<Option<&str>> = plan.steps.iter().map(|s| s.database.as_deref()).collect();
    assert_eq!(names, vec![Some("appdb"), Some("other"), None]);
    assert_eq!(sql(&plan, 2), vec!["DROP ROLE \"mm_drop\""]);
    assert_eq!((plan.role.as_str(), plan.reassign_to.as_str(), plan.confirm_text.as_str()), (ROLE, "mm", ROLE));
}

#[test]
fn from_160000_a_login_that_does_not_inherit_the_role_takes_the_membership_inside_each_step_and_gives_it_back() {
    let plan = World::new(PG16).plan();
    for step in 0..2 {
        assert_eq!(
            sql(&plan, step),
            vec![
                "GRANT \"mm_drop\" TO \"mm\" WITH INHERIT TRUE",
                "REASSIGN OWNED BY \"mm_drop\" TO \"mm\"",
                "DROP OWNED BY \"mm_drop\"",
                "REVOKE \"mm_drop\" FROM \"mm\" GRANTED BY \"mm\"",
            ]
        );
    }
    assert!(blocks(&plan).is_empty(), "{:?}", blocks(&plan));
}

#[test]
fn before_160000_the_membership_has_no_options_and_the_revoke_names_no_grantor() {
    let plan = World::new(PG14).plan();
    assert_eq!(
        sql(&plan, 0),
        vec!["GRANT \"mm_drop\" TO \"mm\"", "REASSIGN OWNED BY \"mm_drop\" TO \"mm\"", "DROP OWNED BY \"mm_drop\"", "REVOKE \"mm_drop\" FROM \"mm\""]
    );
    assert!(blocks(&plan).is_empty(), "{:?}", blocks(&plan));
}

#[test]
fn a_login_that_already_inherits_the_role_needs_no_membership_step() {
    let mut world = World::new(PG16);
    world.cluster.members.retain(|m| m.group != ROLE);
    world.cluster.members.push(member_grants("mm", ROLE, &[(BOOTSTRAP, true, Some(true), Some(true))]));
    let plan = world.plan();
    assert_eq!(sql(&plan, 0), vec!["REASSIGN OWNED BY \"mm_drop\" TO \"mm\"", "DROP OWNED BY \"mm_drop\""]);

    // 160000 전에는 구성원 관계가 있고 로그인한 역할이 INHERIT면 같다
    let mut old = World::new(PG14);
    old.cluster.members.push(member("mm", ROLE));
    assert_eq!(sql(&old.plan(), 0).len(), 2);
}

#[test]
fn the_counts_are_per_database_what_the_role_owns_the_entries_naming_it_and_the_default_records() {
    let mut world = World::new(PG16);
    {
        let appdb = world.db("appdb");
        appdb.relations.push(table("app", "t1", ROLE));
        appdb.relations.push(relation(RelKind::Sequence, "app", "t1_seq", ROLE));
        appdb.schemas.push(schema("mine", ROLE));
        appdb.functions.push(function("mine", "f", "", ROLE));
        // 소유하지 않은 객체의 항목 둘(받은 것 하나, 준 것 하나는 세지 않는다: 이 값은 받는 쪽이다)
        appdb.relations.push(table("app", "theirs", "app_owner").grant(ROLE, &[Select, Insert]));
        appdb.default_acls.push(DefaultAclRec { creator: ROLE.into(), schema: None, obj_type: DefaultObjType::Tables, acl: vec![entry(ROLE, Some(ROLE), Select)] });
        appdb.default_acls.push(DefaultAclRec { creator: "app_owner".into(), schema: Some("app".into()), obj_type: DefaultObjType::Tables, acl: vec![entry("app_owner", Some(ROLE), Select)] });
        appdb.default_acls.push(DefaultAclRec { creator: "app_owner".into(), schema: None, obj_type: DefaultObjType::Sequences, acl: vec![entry("app_owner", Some("alice"), Select)] });
    }
    world.db("other").schemas.push(schema("o", "app_owner").grant(ROLE, &[Usage]));
    // 데이터베이스 ACL은 첫 단계에서 센다
    world.cluster.databases[0] = world.cluster.databases[0].clone().grant(ROLE, &[Create]);
    let plan = world.plan();
    let appdb = &plan.steps[0];
    assert_eq!((appdb.owned, appdb.privileges, appdb.defaults), (4, 2 + 1, 2));
    let other = &plan.steps[1];
    assert_eq!((other.owned, other.privileges, other.defaults), (0, 1, 0));
    assert_eq!((plan.steps[2].owned, plan.steps[2].privileges, plan.steps[2].defaults), (0, 0, 0));
}

#[test]
fn a_database_the_role_owns_counts_as_an_owned_object_of_its_step() {
    let mut world = World::new(PG16);
    world.db("other").owner = ROLE.into();
    world.cluster.databases[1].owner = ROLE.into();
    let plan = world.plan();
    assert_eq!((plan.steps[0].owned, plan.steps[1].owned), (0, 1));
}

// ───────────────────────── 남는 권한 ─────────────────────────

fn with_theirs(world: &mut World, edit: impl FnOnce(&mut RelationRec)) {
    let mut rel = table("app", "theirs", "app_owner");
    edit(&mut rel);
    world.db("appdb").relations.push(rel);
}

use crate::pg::model::RelationRec;

#[test]
fn a_privilege_granted_by_a_role_the_login_inherits_is_removed() {
    // mm은 app_owner(소유자)의 권한을 물려받는다: 소유자가 부여자라서 거둘 수 있다
    for version in [PG14, PG16] {
        let mut world = World::new(version);
        with_theirs(&mut world, |r| r.acl.push(acl("app_owner", ROLE, Select, false)));
        assert!(blocks(&world.plan()).is_empty(), "{version}: {:?}", blocks(&world.plan()));
    }
}

#[test]
fn a_privilege_granted_by_a_role_the_login_does_not_inherit_stays_and_blocks_with_the_count_sample_and_grantors() {
    let mut world = World::new(PG16);
    world.cluster.members.retain(|m| m.member != "mm");
    world.cluster.members.push(member_grants("mm", ROLE, &[(BOOTSTRAP, true, Some(false), Some(false))]));
    with_theirs(&mut world, |r| r.acl.extend([acl("app_owner", ROLE, Select, false), acl("app_owner", ROLE, Insert, false)]));
    world.db("appdb").schemas.push(schema("zz", "app_owner").grant(ROLE, &[Usage]));
    let plan = world.plan();
    let expected = format!(
        "{ROLE} 역할이 받은 권한 중 로그인한 역할이 뺄 수 없는 것이 있어요(3개, 예: app.theirs INSERT, app.theirs SELECT, 스키마 zz USAGE). 준 역할: app_owner"
    );
    assert_eq!(blocks(&plan), vec![expected]);
}

#[test]
fn only_entries_granted_by_the_selected_grantor_with_the_grant_option_go() {
    // mm은 SELECT의 GRANT OPTION만 가졌다(부여자 app_owner). 그 밖의 항목은 mm이 부여자가 아니거나 GRANT OPTION이 없어서 남는다
    let mut world = World::new(PG16);
    world.cluster.members.retain(|m| m.member != "mm");
    world.cluster.members.push(member_grants("mm", ROLE, &[(BOOTSTRAP, true, Some(false), Some(false))]));
    with_theirs(&mut world, |r| {
        r.acl.extend([acl("app_owner", "mm", Select, true), acl("mm", ROLE, Select, false), acl("mm", ROLE, Insert, false), acl("app_owner", ROLE, Update, false)])
    });
    let plan = world.plan();
    let stays = blocks(&plan);
    assert_eq!(stays.len(), 1, "{stays:?}");
    assert!(stays[0].contains("(2개, 예: app.theirs INSERT, app.theirs UPDATE)") && stays[0].ends_with("준 역할: app_owner, mm"), "{}", stays[0]);
}

#[test]
fn the_role_counts_in_the_logins_closure_during_the_step() {
    // 객체는 mm_drop이 물려받는 그룹 g_own의 것이고 g_own이 mm_drop에 준 항목이 있다. mm이 mm_drop을 물려받는 동안은 g_own의 권한도 쓰니 거둘 수 있다
    let mut world = World::new(PG16);
    world.cluster.roles.push(role("g_own"));
    world.cluster.members.push(member_with(ROLE, "g_own", true, true));
    world.db("appdb").relations.push(table("app", "g_table", "g_own").grant(ROLE, &[Select]));
    assert!(blocks(&world.plan()).is_empty(), "{:?}", blocks(&world.plan()));
}

#[test]
fn a_database_acl_naming_the_role_is_predicted_in_the_first_step() {
    let mut world = World::new(PG16);
    // 데이터베이스 소유자는 app_owner이고 mm은 그 권한을 물려받으니 거둘 수 있다
    world.cluster.databases[1] = world.cluster.databases[1].clone().grant(ROLE, &[Create]);
    assert!(blocks(&world.plan()).is_empty());
    // 물려받지 않으면 남는다
    world.cluster.members.retain(|m| m.member != "mm" || m.group == ROLE);
    let plan = world.plan();
    assert_eq!(blocks(&plan).len(), 1);
    assert!(blocks(&plan)[0].contains("데이터베이스 other CREATE"), "{:?}", blocks(&plan));
    assert_eq!(plan.steps[0].privileges, 1, "첫 단계가 데이터베이스 ACL을 거둬요");
    assert_eq!(plan.steps[1].privileges, 0);
}

#[test]
fn a_superuser_login_removes_everything() {
    let mut world = World::new(PG16);
    world.cluster.members.retain(|m| m.member != "mm" || m.group == ROLE);
    world.cluster.roles.iter_mut().find(|r| r.name == "mm").unwrap().superuser = true;
    with_theirs(&mut world, |r| r.acl.push(acl("app_owner", ROLE, Select, false)));
    assert!(blocks(&world.plan()).is_empty());
}

// ───────────────────────── 막힘 ─────────────────────────

#[test]
fn a_system_role_the_login_and_an_unknown_role_are_blocked() {
    let world = World::new(PG16);
    assert!(blocks(&world.plan_to("rds_superuser", "mm")).contains(&"시스템 역할이라 바꿀 수 없어요: rds_superuser".to_string()));
    assert!(blocks(&world.plan_to("mm", "app_owner")).contains(&"앱이 로그인한 역할은 삭제할 수 없어요".to_string()));
    assert_eq!(blocks(&world.plan_to("nobody", "mm"))[0], "역할을 찾을 수 없어요: nobody");
}

#[test]
fn drop_rights_follow_the_server_rules_for_the_version() {
    // 160000 전: CREATEROLE이 없으면 막힌다
    let mut old = World::new(PG14);
    old.cluster.roles.iter_mut().find(|r| r.name == "mm").unwrap().create_role = false;
    assert_eq!(blocks(&old.plan()), vec!["mm_drop 역할을 삭제할 권한이 없어요. CREATEROLE이 있어야 해요"]);
    // 160000부터: ADMIN OPTION도 있어야 한다
    let mut new = World::new(PG16);
    new.cluster.members.retain(|m| m.group != ROLE);
    assert_eq!(blocks(&new.plan()), vec!["mm_drop 역할을 삭제할 권한이 없어요. CREATEROLE과 이 역할에 대한 ADMIN OPTION이 있어야 해요"]);
    // superuser나 REPLICATION 역할은 바꿀 수 없다
    let mut repl = World::new(PG16);
    repl.cluster.roles.iter_mut().find(|r| r.name == ROLE).unwrap().replication = true;
    assert_eq!(blocks(&repl.plan()), vec!["superuser나 REPLICATION 역할은 바꿀 수 없어요: mm_drop"]);
}

#[test]
fn a_bad_reassign_target_is_blocked_unknown_system_or_the_role_itself() {
    let world = World::new(PG16);
    for heir in ["nobody", "rds_superuser", ROLE] {
        assert!(blocks(&world.plan_to(ROLE, heir)).contains(&format!("넘겨받을 역할로 쓸 수 없어요: {heir}")), "{heir}");
    }
    assert!(!blocks(&world.plan_to(ROLE, "app_owner")).iter().any(|b| b.starts_with("넘겨받을")));
}

#[test]
fn the_reassign_target_must_be_the_login_or_a_role_whose_privileges_the_login_has() {
    let mut world = World::new(PG16);
    // alice는 mm이 권한을 물려받지 않는 역할이다
    assert_eq!(blocks(&world.plan_to(ROLE, "alice")), vec!["alice 역할의 권한을 물려받아야 그 역할에게 넘길 수 있어요"]);
    // app_owner는 물려받는다
    assert!(blocks(&world.plan_to(ROLE, "app_owner")).is_empty());
    // 로그인한 역할 자신
    assert!(blocks(&world.plan_to(ROLE, "mm")).is_empty());
    world.cluster.members.push(member_with("mm", "alice", false, true));
    assert_eq!(blocks(&world.plan_to(ROLE, "alice")).len(), 1, "상속하지 않는 구성원 관계는 권한을 물려받는 게 아니에요");
}

#[test]
fn unreachable_and_truncated_databases_block_the_plan_and_keep_their_steps() {
    let mut world = World::new(PG16);
    world.db("other").truncated = true;
    let plan = drop_plan(&world.cluster, &world.dbs[..], &["zz_hidden".to_string(), "aa_hidden".to_string()], ROLE, "mm", "appdb");
    assert_eq!(
        blocks(&plan),
        vec![
            "연결하지 못한 데이터베이스가 있어 삭제 계획을 만들 수 없어요: aa_hidden, zz_hidden".to_string(),
            "객체가 많아 일부만 읽은 데이터베이스가 있어 삭제 계획을 만들 수 없어요: other".to_string(),
        ]
    );
    let names: Vec<Option<&str>> = plan.steps.iter().map(|s| s.database.as_deref()).collect();
    assert_eq!(names, vec![Some("aa_hidden"), Some("appdb"), Some("other"), Some("zz_hidden"), None]);
}

#[test]
fn before_160000_a_noinherit_login_is_blocked_because_the_membership_would_give_it_nothing() {
    let mut world = World::new(PG14);
    world.cluster.roles.iter_mut().find(|r| r.name == "mm").unwrap().inherit = false;
    assert_eq!(blocks(&world.plan()), vec!["mm_drop 역할을 삭제할 권한이 없어요. 로그인한 역할에 INHERIT가 있어야 해요"]);
    // 이미 권한을 물려받는 일은 없는 NOINHERIT라서 구성원 관계를 줘도 같다. 160000부터는 구성원 관계가 INHERIT TRUE로 간다
    let mut new = World::new(PG16);
    new.cluster.roles.iter_mut().find(|r| r.name == "mm").unwrap().inherit = false;
    assert!(blocks(&new.plan()).is_empty());
}

#[test]
fn from_160000_admin_reached_only_through_a_non_inheriting_membership_blocks_the_membership_step() {
    let mut world = World::new(PG16);
    world.cluster.roles.push(role("adm"));
    world.cluster.members.retain(|m| m.group != ROLE);
    world.cluster.members.push(member_grants("mm", "adm", &[(BOOTSTRAP, false, Some(false), Some(true))]));
    world.cluster.members.push(member_grants("adm", ROLE, &[(BOOTSTRAP, true, Some(true), Some(true))]));
    assert_eq!(blocks(&world.plan()), vec!["mm_drop 역할의 구성원을 바꿀 수 없어요. ADMIN OPTION을 가진 역할의 권한을 물려받아야 해요"]);
}

// ───────────────────────── 넘길 때 서버가 보는 것 ─────────────────────────

#[test]
fn a_schema_the_role_owns_needs_create_on_the_database_and_set_role_to_the_target() {
    let mut world = World::new(PG16);
    world.db("appdb").schemas.push(schema("mine", ROLE));
    // mm은 데이터베이스 CREATE가 없고(소유자 app_owner의 권한은 물려받는다: 있다) ...
    assert!(blocks(&world.plan()).is_empty(), "{:?}", blocks(&world.plan()));
    // app_owner의 권한을 물려받지 않으면 CREATE가 없다
    let mut lacks = World::new(PG16);
    lacks.db("appdb").schemas.push(schema("mine", ROLE));
    lacks.cluster.members.retain(|m| m.member != "mm" || m.group == ROLE);
    lacks.cluster.members.push(member_with("mm", "alice", true, true));
    let plan = lacks.plan_to(ROLE, "mm");
    assert_eq!(blocks(&plan), vec!["mm 역할에게 넘길 수 없어요: 스키마 mine. 데이터베이스 appdb에 CREATE 권한이 있어야 해요"]);
    // 로그인한 역할이 아닌 대상으로 SET ROLE을 못 하면 막힌다(alice는 상속하지만 SET이 꺼져 있다)
    let mut no_set = World::new(PG16);
    no_set.db("appdb").schemas.push(schema("mine", ROLE));
    no_set.cluster.members.retain(|m| m.member != "mm" || m.group == ROLE);
    no_set.cluster.members.push(member_with("mm", "app_owner", true, false));
    let plan = no_set.plan_to(ROLE, "app_owner");
    assert_eq!(blocks(&plan), vec!["app_owner 역할에게 넘길 수 없어요: 스키마 mine. 로그인한 역할이 app_owner 역할로 SET ROLE 할 수 있어야 해요"]);
}

#[test]
fn before_160000_set_role_needs_only_a_membership_chain() {
    let mut world = World::new(PG14);
    world.db("appdb").schemas.push(schema("mine", ROLE));
    // mm은 app_owner의 구성원이다: SET ROLE이 된다
    assert!(blocks(&world.plan_to(ROLE, "app_owner")).is_empty());
    let mut chain = World::new(PG14);
    chain.db("appdb").schemas.push(schema("mine", ROLE));
    chain.cluster.members.retain(|m| m.member != "mm");
    chain.cluster.roles.iter_mut().find(|r| r.name == "mm").unwrap().inherit = true;
    let found = blocks(&chain.plan_to(ROLE, "app_owner"));
    assert!(found.contains(&"app_owner 역할의 권한을 물려받아야 그 역할에게 넘길 수 있어요".to_string()), "{found:?}");
    assert!(found.contains(&"app_owner 역할에게 넘길 수 없어요: 스키마 mine. 로그인한 역할이 app_owner 역할로 SET ROLE 할 수 있어야 해요".to_string()), "{found:?}");
}

#[test]
fn a_function_the_role_owns_needs_create_on_its_schema_for_the_target_unless_the_role_owns_the_schema() {
    let mut world = World::new(PG16);
    world.db("appdb").functions.push(function("app", "f", "a integer", ROLE));
    // app 스키마는 app_owner의 것이고 app_owner에는 CREATE가 있다
    assert!(blocks(&world.plan_to(ROLE, "app_owner")).is_empty());
    // mm에게 넘기면 mm이 app_owner의 권한을 물려받아 CREATE가 있다. 스키마의 CREATE를 거둔 장면에서는 없다
    let mut lacks = World::new(PG16);
    lacks.db("appdb").functions.push(function("app", "f", "a integer", ROLE));
    lacks.db("appdb").schemas.push(schema("empty", "app_owner"));
    lacks.db("appdb").schemas.iter_mut().find(|s| s.name == "app").unwrap().acl.clear();
    assert_eq!(blocks(&lacks.plan_to(ROLE, "app_owner")), vec!["app_owner 역할에게 넘길 수 없어요: app.f(a integer). 스키마 app에 CREATE 권한이 있어야 해요"]);
    // 함수가 역할이 소유한 스키마에 있으면 그 스키마도 넘어가니 괜찮다
    let mut own_schema = World::new(PG16);
    own_schema.db("appdb").schemas.push(schema("mine", ROLE));
    own_schema.db("appdb").functions.push(function("mine", "g", "", ROLE));
    assert!(blocks(&own_schema.plan()).is_empty());
}

// ───────────────────────── 확인과 알림 ─────────────────────────

#[test]
fn the_plan_always_asks_for_confirmation_and_warns_that_sessions_stay() {
    let mut world = World::new(PG16);
    let plan = world.plan();
    assert_eq!(messages(&plan, PgWarnLevel::Confirm), vec!["역할을 삭제해요. 되돌릴 수 없어요"]);
    assert!(messages(&plan, PgWarnLevel::Warn).is_empty());
    assert_eq!(plan.sessions, 0);

    world.cluster.sessions = vec![session(1, ROLE), session(2, ROLE), session(3, "alice")];
    let plan = world.plan();
    assert_eq!(plan.sessions, 2);
    assert_eq!(messages(&plan, PgWarnLevel::Warn), vec!["이 역할로 접속한 세션 2개는 끊기지 않아요"]);
}

#[test]
fn warnings_come_in_the_order_block_confirm_warn() {
    let mut world = World::new(PG16);
    world.cluster.sessions = vec![session(1, ROLE)];
    let plan = drop_plan(&world.cluster, &world.dbs, &["gone".to_string()], ROLE, "mm", "appdb");
    let levels: Vec<PgWarnLevel> = plan.warnings.iter().map(|w| w.level).collect();
    let mut sorted = levels.clone();
    sorted.sort();
    assert_eq!(levels, sorted);
    assert_eq!(levels.first(), Some(&PgWarnLevel::Block));
    assert_eq!(levels.last(), Some(&PgWarnLevel::Warn));
}

#[test]
fn memberships_the_role_granted_are_listed_from_160000_and_say_which_members_leave_their_group() {
    let mut world = World::new(PG16);
    world.cluster.roles.extend([role("g1"), role("g2"), role("m1"), role("m2")]);
    // m1 → g1: 이 역할만 줬다(빠진다). m2 → g2: 다른 부여자도 있다(남는다)
    world.cluster.members.push(member_grants("m1", "g1", &[(ROLE, false, Some(true), Some(true))]));
    world.cluster.members.push(member_grants("m2", "g2", &[(ROLE, false, Some(true), Some(true)), ("mm", false, Some(true), Some(true))]));
    // 이 역할이 구성원이거나 그룹인 관계는 역할과 함께 사라지니 세지 않는다
    world.cluster.members.push(member_grants(ROLE, "g1", &[(ROLE, false, Some(true), Some(true))]));
    let plan = world.plan();
    assert_eq!(
        plan.granted_memberships,
        vec![
            PgGrantedMembership { member: "m1".into(), group: "g1".into(), lost: true },
            PgGrantedMembership { member: "m2".into(), group: "g2".into(), lost: false },
        ]
    );
    assert_eq!(messages(&plan, PgWarnLevel::Confirm), vec!["역할을 삭제해요. 되돌릴 수 없어요".to_string(), "이 역할이 준 구성원 관계 2개가 함께 지워져요. 1개는 다른 부여가 없어 구성원이 그룹에서 빠져요(예: m1 → g1)".to_string()]);
}

#[test]
fn granted_memberships_are_empty_before_160000() {
    let mut world = World::new(PG15);
    world.cluster.roles.extend([role("g1"), role("m1")]);
    world.cluster.members.push(member("m1", "g1"));
    // 160000 전의 부여자는 정보일 뿐이다
    world.cluster.members.last_mut().unwrap().grants[0].grantor = ROLE.into();
    let plan = world.plan();
    assert!(plan.granted_memberships.is_empty());
    assert_eq!(messages(&plan, PgWarnLevel::Confirm), vec!["역할을 삭제해요. 되돌릴 수 없어요"]);
}

#[test]
fn the_sample_names_the_first_three_members_that_leave_in_name_order() {
    let mut world = World::new(PG16);
    world.cluster.roles.extend([role("g"), role("m1"), role("m2"), role("m3"), role("m4")]);
    for member in ["m4", "m2", "m1", "m3"] {
        world.cluster.members.push(member_grants(member, "g", &[(ROLE, false, Some(true), Some(true))]));
    }
    let confirms = messages(&world.plan(), PgWarnLevel::Confirm);
    assert_eq!(confirms[1], "이 역할이 준 구성원 관계 4개가 함께 지워져요. 4개는 다른 부여가 없어 구성원이 그룹에서 빠져요(예: m1 → g, m2 → g, m3 → g)");
}

// ───────────────────────── 읽기 전용 복제본, 직렬화 ─────────────────────────

#[test]
fn a_read_replica_blocks_the_plan_first() {
    let mut plan = World::new(PG16).plan();
    block_replica(&mut plan);
    assert_eq!(blocks(&plan), vec!["읽기 전용 복제본이라 바꿀 수 없어요"]);
    assert_eq!(plan.warnings[0].level, PgWarnLevel::Block);
}

#[test]
fn the_plan_serializes_in_the_contract_shape() {
    let json = serde_json::to_value(World::new(PG16).plan()).unwrap();
    for key in ["role", "reassignTo", "steps", "warnings", "confirmText", "sessions", "grantedMemberships"] {
        assert!(json.get(key).is_some(), "{key}");
    }
    assert!(json["steps"][2]["database"].is_null());
    assert_eq!(json["steps"][0]["database"], "appdb");
}

// ───────────────────────── 적용 ─────────────────────────

type Calls = Mutex<Vec<(String, Vec<String>)>>;

/// 정해 둔 결과를 차례로 돌려주는 가짜 실행: 부른 (데이터베이스, 문장들)을 기록한다
fn fake<'a>(calls: &'a Calls, outcomes: Vec<Result<(), ExecError>>) -> impl FnMut(&str, Vec<Step>) -> Ready<Result<(), ExecError>> + 'a {
    let mut outcomes = outcomes.into_iter();
    move |database, steps| {
        calls.lock().unwrap().push((database.to_string(), steps.iter().map(|s| s.run.clone()).collect()));
        ready(outcomes.next().unwrap_or(Ok(())))
    }
}

fn three_databases() -> PgDropPlan {
    let mut world = World::new(PG16);
    world.cluster.databases.push(database("zeta", "app_owner"));
    world.dbs.push(Arc::new(db("zeta", "app_owner", Vec::new(), Vec::new(), Vec::new())));
    world.plan()
}

fn failed(text: &str) -> ExecError {
    ExecError::Failed(AppError::other(text))
}

#[tokio::test]
async fn every_step_runs_in_plan_order_each_in_its_own_database_and_the_last_in_the_default_one() {
    let plan = three_databases();
    let calls = Calls::default();
    let (done, stopped) = apply(&plan, "appdb", fake(&calls, Vec::new())).await;
    assert_eq!((done, stopped), (3, None));
    let calls = calls.lock().unwrap();
    let order: Vec<&str> = calls.iter().map(|(database, _)| database.as_str()).collect();
    assert_eq!(order, vec!["appdb", "other", "zeta", "appdb"]);
    for (call, step) in calls.iter().zip(&plan.steps) {
        assert_eq!(call.1, step.sql);
    }
}

#[tokio::test]
async fn a_failure_in_the_second_database_stops_there_and_runs_nothing_after_it() {
    let plan = three_databases();
    let calls = Calls::default();
    let lock = "다른 작업이 객체를 잠그고 있어 적용하지 못했어요. 잠시 뒤 다시 시도하세요";
    let (done, stopped) = apply(&plan, "appdb", fake(&calls, vec![Ok(()), Err(failed(lock))])).await;
    assert_eq!(done, 1);
    assert_eq!(stopped, Some(format!("3개 데이터베이스 중 1개를 정리하고 멈췄어요: {lock}")));
    let calls = calls.lock().unwrap();
    assert_eq!(calls.iter().map(|(database, _)| database.as_str()).collect::<Vec<_>>(), vec!["appdb", "other"], "실패한 단계 뒤는 돌리지 않아요");
}

#[tokio::test]
async fn a_failure_in_the_first_database_has_done_zero() {
    let plan = three_databases();
    let calls = Calls::default();
    let (done, stopped) = apply(&plan, "appdb", fake(&calls, vec![Err(failed("적용하지 못했어요: permission denied"))])).await;
    assert_eq!(done, 0);
    assert_eq!(stopped.as_deref(), Some("3개 데이터베이스 중 0개를 정리하고 멈췄어요: 적용하지 못했어요: permission denied"));
    assert_eq!(calls.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn an_unknown_commit_stops_the_drop_with_the_unknown_text_and_does_not_count_that_database() {
    let plan = three_databases();
    let calls = Calls::default();
    let (done, stopped) = apply(&plan, "appdb", fake(&calls, vec![Ok(()), Err(ExecError::CommitUnknown)])).await;
    assert_eq!(done, 1);
    assert_eq!(
        stopped.as_deref(),
        Some("3개 데이터베이스 중 1개를 정리하고 멈췄어요: 데이터베이스 연결이 끊겨 적용됐는지 알 수 없어요. 다시 읽어서 확인해 주세요")
    );
    assert_eq!(calls.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn a_failed_drop_role_step_reports_all_database_steps_done() {
    let plan = three_databases();
    let calls = Calls::default();
    let (done, stopped) = apply(&plan, "appdb", fake(&calls, vec![Ok(()), Ok(()), Ok(()), Err(failed("적용하지 못했어요: role \"mm_drop\" cannot be dropped because some objects depend on it"))])).await;
    assert_eq!(done, 3, "DROP ROLE 단계는 세지 않아요");
    assert!(stopped.unwrap().starts_with("3개 데이터베이스 중 3개를 정리하고 멈췄어요: "));
}

#[tokio::test]
async fn done_counts_the_first_steps_of_the_plan_in_order() {
    // 프런트엔드는 `i < done`인 단계를 끝난 것으로 표시한다: 멈춘 단계 앞의 단계가 정확히 `done`개다
    let plan = three_databases();
    for stop_at in 0..3 {
        let calls = Calls::default();
        let outcomes: Vec<_> = (0..stop_at).map(|_| Ok(())).chain([Err(failed("x"))]).collect();
        let (done, stopped) = apply(&plan, "appdb", fake(&calls, outcomes)).await;
        assert!(stopped.is_some());
        let ran: Vec<Vec<String>> = calls.lock().unwrap().iter().map(|(_, sql)| sql.clone()).collect();
        let finished: Vec<Vec<String>> = plan.steps.iter().take(done).map(|s| s.sql.clone()).collect();
        assert_eq!(done, stop_at);
        assert_eq!(ran[..done], finished[..], "끝난 단계는 계획의 앞에서부터 차례로예요");
        assert_eq!(ran.len(), done + 1, "멈춘 단계 뒤는 돌리지 않아요");
    }
}

// ───────────────────────── 관문 ─────────────────────────

#[test]
fn a_plan_the_user_did_not_see_is_stale() {
    let plan = World::new(PG16).plan();
    let stale = Err(AppError::other("미리보기 뒤에 바뀌었어요. 미리보기를 다시 받아 주세요"));
    assert_eq!(check(&plan, None, Some(ROLE)), stale);
    let mut other = plan.clone();
    other.steps[0].owned += 1;
    assert_eq!(check(&plan, Some(&other), Some(ROLE)), stale);
    let mut warned = plan.clone();
    warned.warnings.push(PgWarning { level: PgWarnLevel::Warn, message: "다른 알림".into(), add: Vec::new() });
    assert_eq!(check(&plan, Some(&warned), Some(ROLE)), stale);
}

#[test]
fn only_the_sessions_may_differ_between_the_seen_plan_and_the_new_one() {
    let mut world = World::new(PG16);
    let seen = world.plan();
    assert_eq!(check(&seen, Some(&seen), Some(ROLE)), Ok(()));
    world.cluster.sessions = vec![session(1, ROLE)];
    let now = world.plan();
    assert_ne!(now.sessions, seen.sessions);
    assert_eq!(check(&now, Some(&seen), Some(ROLE)), Ok(()));
    // 반대로 사용자가 세션 경고를 본 계획에도 같다
    assert_eq!(check(&seen, Some(&now), Some(ROLE)), Ok(()));
}

#[test]
fn a_blocked_plan_and_a_wrong_confirmation_are_refused_with_the_gate_texts() {
    let world = World::new(PG16);
    let plan = world.plan();
    assert_eq!(check(&plan, Some(&plan), Some("다른 이름")), Err(AppError::other("확인 문구가 달라요. 입력해야 할 이름: mm_drop")));
    assert_eq!(check(&plan, Some(&plan), None), Err(AppError::other("확인 문구가 달라요. 입력해야 할 이름: mm_drop")));

    let blocked = world.plan_to("alice", "mm");
    let err = check(&blocked, Some(&blocked), Some("alice")).unwrap_err();
    assert!(err.to_string().starts_with("막혀 있어서 적용할 수 없어요: "), "{err}");
}

// ───────────────────────── 기록 ─────────────────────────

#[test]
fn the_log_entry_holds_every_steps_sql_and_cannot_be_undone() {
    let plan = three_databases();
    let make = |stopped: Option<&str>| {
        log_entry(&DropLog { plan: &plan, profile: "dev", target_arn: "arn:t", login_user: "mm", default_db: "appdb", now: 1_793_232_000, log_id: "log-9", stopped })
    };
    let ok = make(None);
    assert_eq!((ok.id.as_str(), ok.database.as_str(), ok.login_user.as_str(), ok.summary.as_str()), ("log-9", "appdb", "mm", "역할 삭제: mm_drop"));
    assert_eq!(ok.change, PgChange::DropRole { role: ROLE.into() });
    assert!(ok.ok && ok.error.is_none() && ok.inverse.is_none() && ok.undo_of.is_none() && !ok.undone && ok.batch_id.is_none());
    let all: Vec<String> = plan.steps.iter().flat_map(|s| s.sql.clone()).collect();
    assert_eq!(ok.sql, all);

    let stopped = make(Some("멈췄어요"));
    assert!(!stopped.ok);
    assert_eq!(stopped.error.as_deref(), Some("멈췄어요"));
    assert!(stopped.inverse.is_none());
}

#[test]
fn the_stopped_text_is_the_contract_text() {
    assert_eq!(stopped_text(4, 2, "이유"), "4개 데이터베이스 중 2개를 정리하고 멈췄어요: 이유");
}
