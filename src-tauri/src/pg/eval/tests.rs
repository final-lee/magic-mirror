use serde_json::json;

use super::SourceKind::{Direct, Group, Owner, Predefined, Public, Superuser};
use super::*;
use crate::pg::fixtures::*;
use crate::pg::model::Privilege::{
    Connect, Create, Delete, Execute, Insert, Maintain, References, Select, Temporary, Trigger, Truncate, Update, Usage,
};
use crate::pg::model::RelKind::Sequence;
use crate::pg::model::{Privilege, RoleRec};

/// 부를 때마다 `Eval`을 새로 만들어 `schema_cells`에 묻는다(명령은 `Eval`을 하나 만들어 나눠 쓴다)
pub(super) fn schema_cells(ctx: &Ctx, roles: &[&str]) -> Vec<SchemaCell> {
    super::schema_cells(&Eval::new(ctx), ctx, roles)
}

fn src(kind: SourceKind, via: &[&str], grantor: Option<&str>) -> Source {
    Source { kind, via: via.iter().map(|s| s.to_string()).collect(), grantor: grantor.map(str::to_string) }
}

pub(super) fn inh(role: &str, path: &[&str]) -> Inherited {
    Inherited { role: role.to_string(), path: path.iter().map(|s| s.to_string()).collect() }
}

fn kinds(sources: &[Source]) -> Vec<SourceKind> {
    sources.iter().map(|s| s.kind).collect()
}

fn cell(role: &str, schema: &str) -> SchemaCell {
    SchemaCell {
        role: role.into(),
        schema: schema.into(),
        usage: false,
        create: false,
        read: Coverage::None,
        write: Coverage::None,
        inherited_only: false,
        unusable: None,
    }
}

fn who(role: &str, sources: Vec<Source>, unusable: Option<&'static str>) -> WhoCanRow {
    WhoCanRow { role: role.into(), sources, unusable }
}

/// 스냅숏의 관계(이름만으로 찾는다)에 소유자가 `grantee`에게 준 항목을 더한다
fn grant_on(scene: &mut Scene, relation: &str, grantee: &str, privileges: &[Privilege]) {
    let rel = scene.db.relations.iter_mut().find(|r| r.name == relation).unwrap_or_else(|| panic!("{relation} 관계가 없어요"));
    rel.acl.extend(privileges.iter().map(|&p| entry(&rel.owner, Some(grantee), p)));
}

const APP_ROLES: [&str; 6] = ["alice", "app_owner", "app_read", "app_write", "bob", "carol"];

// ───────────────────────── 상속 ─────────────────────────

#[test]
fn before_pg16_the_inherit_attribute_of_the_member_decides() {
    let scene = app_scene(PG15);
    let ctx = scene.ctx();
    let orders = Obj::Relation(scene.relation("app.orders"));

    // alice → app_write → app_read: 둘 다 상속한다. 자기 자신이 먼저 오고, 경로는 alice를 뺀 사슬이다
    assert_eq!(ctx.inherited("alice"), [inh("alice", &[]), inh("app_write", &["app_write"]), inh("app_read", &["app_write", "app_read"])]);
    assert_eq!(kinds(&ctx.sources("alice", orders, Select)), [Group]);

    // NOINHERIT인 bob은 app_read의 구성원이어도 그 권한을 쓰지 못한다. SET ROLE로만 닿는다
    assert_eq!(ctx.inherited("bob"), [inh("bob", &[])]);
    assert!(ctx.sources("bob", orders, Select).is_empty());
    assert_eq!(ctx.set_role_only("bob"), ["app_read"]);

    // 모두 상속하는 alice에게는 SET ROLE로만 닿는 역할이 없다
    assert!(ctx.set_role_only("alice").is_empty());
    assert!(ctx.set_role_only("app_read").is_empty());
}

#[test]
fn before_pg16_every_role_on_the_path_must_inherit() {
    // top(INHERIT) → mid(NOINHERIT) → app_read: top은 mid의 권한을 쓰지만, mid가 상속하지 않으니 app_read까지는 가지 못한다
    let mut scene = app_scene(PG15);
    scene.cluster.roles.extend([role("top"), RoleRec { inherit: false, ..role("mid") }]);
    scene.cluster.members.extend([member("top", "mid"), member("mid", "app_read")]);
    let ctx = scene.ctx();
    let orders = Obj::Relation(scene.relation("app.orders"));

    assert_eq!(ctx.inherited("top"), [inh("top", &[]), inh("mid", &["mid"])]);
    assert_eq!(ctx.set_role_only("top"), ["app_read"]);
    assert!(ctx.sources("top", orders, Select).is_empty());
    assert_eq!(ctx.inherited("mid"), [inh("mid", &[])]);
    assert_eq!(ctx.set_role_only("mid"), ["app_read"]);
}

#[test]
fn inherited_roles_come_in_breadth_first_order_with_the_first_shortest_path() {
    let roles = ["x", "a", "b", "c", "d"].map(role).to_vec();
    // x → a → c, x → b → d → c. c는 a를 거치는 길이 더 짧다
    let members = vec![member("x", "a"), member("x", "b"), member("a", "c"), member("b", "d"), member("d", "c")];
    let scene = Scene { cluster: cluster(PG15, roles, members, vec![]), db: db("appdb", "nobody", vec![], vec![], vec![]) };
    assert_eq!(
        scene.ctx().inherited("x"),
        [inh("x", &[]), inh("a", &["a"]), inh("b", &["b"]), inh("c", &["a", "c"]), inh("d", &["b", "d"])]
    );
}

#[test]
fn a_membership_cycle_does_not_loop() {
    // 서버는 순환을 막지만, 스냅숏이 이상해도 계산은 끝나야 한다
    let scene = Scene {
        cluster: cluster(PG15, vec![role("p"), role("q")], vec![member("p", "q"), member("q", "p")], vec![]),
        db: db("appdb", "nobody", vec![], vec![], vec![]),
    };
    assert_eq!(scene.ctx().inherited("p"), [inh("p", &[]), inh("q", &["q"])]);
    assert!(scene.ctx().set_role_only("p").is_empty());
}

#[test]
fn a_role_that_is_not_in_the_snapshot_has_only_itself() {
    let scene = app_scene(PG16);
    assert_eq!(scene.ctx().inherited("nobody"), [inh("nobody", &[])]);
    assert!(scene.ctx().set_role_only("nobody").is_empty());
}

#[test]
fn from_pg16_the_inherit_option_of_each_membership_decides_not_the_rolinherit_attribute() {
    let mut scene = app_scene(PG16);
    // alice의 rolinherit는 true지만, app_write 부여의 INHERIT가 꺼져 있으면 그 관계로는 상속하지 않는다
    scene.member_mut("alice", "app_write").inherit = Some(false);
    // bob은 NOINHERIT지만, app_read 부여의 INHERIT가 켜져 있으면 상속한다
    scene.member_mut("bob", "app_read").inherit = Some(true);
    let ctx = scene.ctx();
    let orders = Obj::Relation(scene.relation("app.orders"));

    assert_eq!(ctx.inherited("alice"), [inh("alice", &[])]);
    assert!(ctx.sources("alice", orders, Select).is_empty());
    assert_eq!(ctx.inherited("bob"), [inh("bob", &[]), inh("app_read", &["app_read"])]);
    assert_eq!(ctx.sources("bob", orders, Select), [src(Group, &["app_read"], Some("app_owner"))]);
    // 상속하지 않아도 SET ROLE은 된다: app_write와 그 너머 app_read
    assert_eq!(ctx.set_role_only("alice"), ["app_write", "app_read"]);
    assert!(ctx.set_role_only("bob").is_empty());
}

#[test]
fn from_pg16_the_option_of_every_membership_on_the_path_counts() {
    // top → mid(INHERIT) → app_read(INHERIT 끔): mid까지만 닿는다
    let mut scene = app_scene(PG16);
    scene.cluster.roles.extend([role("top"), role("mid")]);
    scene.cluster.members.extend([member_with("top", "mid", true, true), member_with("mid", "app_read", false, true)]);
    let ctx = scene.ctx();
    assert_eq!(ctx.inherited("top"), [inh("top", &[]), inh("mid", &["mid"])]);
    assert_eq!(ctx.set_role_only("top"), ["app_read"]);
}

#[test]
fn a_pg16_membership_without_the_option_falls_back_to_the_inherit_attribute() {
    // 서버가 PG16에서 옵션을 비워 주는 일은 없지만, 비었으면 구성원의 속성을 따른다
    let mut scene = app_scene(PG16);
    scene.member_mut("alice", "app_write").inherit = None;
    scene.member_mut("bob", "app_read").inherit = None;
    let ctx = scene.ctx();
    assert_eq!(ctx.inherited("alice").len(), 3, "INHERIT 속성이 켜진 alice는 상속해요");
    assert_eq!(ctx.inherited("bob"), [inh("bob", &[])], "NOINHERIT 속성인 bob은 상속하지 않아요");
}

#[test]
fn before_pg16_the_options_are_ignored() {
    // PG16이었다면 alice는 막히고 bob은 통과했을 옵션이다. PG15 스냅숏은 구성원의 속성만 본다
    let mut scene = app_scene(PG15);
    scene.member_mut("alice", "app_write").inherit = Some(false);
    scene.member_mut("alice", "app_write").set = Some(false);
    scene.member_mut("bob", "app_read").inherit = Some(true);
    let ctx = scene.ctx();
    assert_eq!(ctx.inherited("alice").len(), 3);
    assert_eq!(ctx.inherited("bob"), [inh("bob", &[])]);
    assert_eq!(ctx.set_role_only("bob"), ["app_read"]);
}

#[test]
fn set_role_only_skips_memberships_that_do_not_allow_set_role() {
    let mut scene = app_scene(PG16);
    // 기본 부여는 SET을 허용한다. bob은 상속하지 않으니 SET ROLE로만 닿는다
    assert_eq!(scene.ctx().set_role_only("bob"), ["app_read"]);

    // PG16에서 CREATEROLE 사용자가 만든 역할은 그 사용자에게 ADMIN만 있고 INHERIT도 SET도 없이 부여된다: 어느 쪽으로도 닿지 않는다
    scene.member_mut("bob", "app_read").set = Some(false);
    assert!(scene.ctx().set_role_only("bob").is_empty());
    assert_eq!(scene.ctx().inherited("bob"), [inh("bob", &[])]);

    // 상속은 하고 SET만 끈 부여: 이미 상속으로 쓰니 SET ROLE로만 닿는 역할이 아니다
    scene.member_mut("bob", "app_read").inherit = Some(true);
    assert!(scene.ctx().set_role_only("bob").is_empty());
    assert_eq!(scene.ctx().inherited("bob").len(), 2);

    // SET을 끈 관계 뒤쪽은 SET ROLE로도 닿지 않는다: alice → app_write(상속 끔, SET 허용) → app_read(상속 켬, SET 끔)
    let mut scene = app_scene(PG16);
    *scene.member_mut("alice", "app_write") = member_with("alice", "app_write", false, true);
    *scene.member_mut("app_write", "app_read") = member_with("app_write", "app_read", true, false);
    assert_eq!(scene.ctx().set_role_only("alice"), ["app_write"]);
}

// ───────────────────────── 출처: 소유자, 직접, 그룹, PUBLIC ─────────────────────────

#[test]
fn the_acl_entry_of_the_owner_is_the_owner_source_and_inheriting_the_owner_keeps_the_path() {
    let mut scene = app_scene(PG15);
    scene.cluster.roles.push(login("ops"));
    scene.cluster.members.push(member("ops", "app_owner"));
    let ctx = scene.ctx();
    let orders = Obj::Relation(scene.relation("app.orders"));

    assert_eq!(ctx.sources("app_owner", orders, Select), [src(Owner, &[], Some("app_owner"))]);
    // 소유자 역할을 상속하면 Owner고, via는 소유자까지의 경로다
    assert_eq!(ctx.sources("ops", orders, Select), [src(Owner, &["app_owner"], Some("app_owner"))]);
    // 스키마·함수·데이터베이스도 마찬가지다
    assert_eq!(ctx.sources("ops", Obj::Schema(scene.schema("app")), Create), [src(Owner, &["app_owner"], Some("app_owner"))]);
    assert_eq!(
        ctx.sources("app_owner", Obj::Function(scene.function("app.plain")), Execute),
        [src(Public, &[], Some("app_owner")), src(Owner, &[], Some("app_owner"))]
    );
    assert_eq!(ctx.sources("ops", Obj::Database(scene.database()), Create), [src(Owner, &["app_owner"], Some("app_owner"))]);
}

#[test]
fn an_owner_who_revoked_their_own_privilege_does_not_have_it() {
    let mut scene = app_scene(PG15);
    scene.cluster.roles.push(login("ops"));
    scene.cluster.members.push(member("ops", "app_owner"));
    // 소유자가 자기 SELECT를 거뒀다: 항목이 없다. 다른 권한은 그대로다
    scene.db.relations.push(table("app", "locked", "app_owner").revoke("app_owner", &[Select]));
    // 소유자가 모든 권한을 거둬서 ACL이 빈 테이블
    scene.db.relations.push(table("app", "sealed", "app_owner").revoke("app_owner", &[Select, Insert, Update, Delete, Truncate, References, Trigger]));
    let ctx = scene.ctx();
    let locked = Obj::Relation(scene.relation("app.locked"));
    let sealed = Obj::Relation(scene.relation("app.sealed"));

    assert!(ctx.sources("app_owner", locked, Select).is_empty());
    assert!(ctx.sources("ops", locked, Select).is_empty());
    assert_eq!(kinds(&ctx.sources("app_owner", locked, Insert)), [Owner]);
    assert!(scene.relation("app.sealed").acl.is_empty());
    for p in [Select, Insert, Update, Delete, Truncate, References, Trigger] {
        assert!(ctx.sources("app_owner", sealed, p).is_empty(), "{p:?}");
    }
}

#[test]
fn direct_group_and_public_entries_are_told_apart_and_keep_their_grantor() {
    let mut scene = app_scene(PG15);
    scene.db.relations.push(
        table("app", "notes", "app_owner").grant("alice", &[Select]).grant_public(&[Select]).grant_by("auditor", "app_read", &[Select]),
    );
    let ctx = scene.ctx();
    let notes = Obj::Relation(scene.relation("app.notes"));

    // ACL의 순서대로: alice의 항목(직접), PUBLIC, app_read의 항목(app_write를 거쳐 상속한 그룹)
    assert_eq!(
        ctx.sources("alice", notes, Select),
        [
            src(Direct, &[], Some("app_owner")),
            src(Public, &[], Some("app_owner")),
            src(Group, &["app_write", "app_read"], Some("auditor")),
        ]
    );
    assert_eq!(ctx.sources("app_write", notes, Select), [src(Public, &[], Some("app_owner")), src(Group, &["app_read"], Some("auditor"))]);
    // NOINHERIT인 bob과, 스냅숏에 없는 역할도 PUBLIC은 받는다
    assert_eq!(ctx.sources("bob", notes, Select), [src(Public, &[], Some("app_owner"))]);
    assert_eq!(ctx.sources("stranger", notes, Select), [src(Public, &[], Some("app_owner"))]);
    // 받은 권한만 센다
    assert!(ctx.sources("stranger", notes, Insert).is_empty());
}

#[test]
fn group_sources_follow_the_group_the_privilege_was_granted_to() {
    let scene = app_scene(PG15);
    let ctx = scene.ctx();
    let orders = Obj::Relation(scene.relation("app.orders"));
    assert_eq!(ctx.sources("alice", orders, Insert), [src(Group, &["app_write"], Some("app_owner"))]);
    assert_eq!(ctx.sources("alice", orders, Select), [src(Group, &["app_write", "app_read"], Some("app_owner"))]);
    assert_eq!(ctx.sources("app_write", orders, Insert), [src(Direct, &[], Some("app_owner"))]);
    assert_eq!(ctx.sources("app_write", orders, Select), [src(Group, &["app_read"], Some("app_owner"))]);
    // 아무도 받지 않은 권한
    assert!(ctx.sources("alice", orders, Delete).is_empty());
    assert!(ctx.sources("app_read", orders, Insert).is_empty());
}

// ───────────────────────── 출처: 미리 정의된 역할 ─────────────────────────

#[test]
fn pg_read_all_data_gives_select_on_every_relation_kind_and_usage_on_schemas() {
    let scene = app_scene(PG14);
    let ctx = scene.ctx();
    let predefined = [src(Predefined, &["pg_read_all_data"], None)];

    for name in ["app.orders", "app.order_totals", "app.order_summary", "audit.remote_log", "audit.events", "app.ticket_seq"] {
        let relation = scene.relation(name);
        let obj = Obj::Relation(relation);
        assert_eq!(ctx.sources("carol", obj, Select), predefined, "{name}");
        // SELECT 말고는 주지 않는다
        let others: &[Privilege] = if relation.kind == Sequence { &[Usage, Update] } else { &[Insert, Update, Delete, Truncate, References, Trigger] };
        for &p in others {
            assert!(ctx.sources("carol", obj, p).is_empty(), "{name} {p:?}");
        }
    }
    for name in ["app", "audit", "scratch"] {
        let schema = Obj::Schema(scene.schema(name));
        assert_eq!(ctx.sources("carol", schema, Usage), predefined, "{name}");
        assert!(ctx.sources("carol", schema, Create).is_empty(), "{name}");
    }
    // 함수 EXECUTE와 데이터베이스 CONNECT는 주지 않는다
    assert!(ctx.sources("carol", Obj::Function(scene.function("app.touch")), Execute).is_empty());
    assert!(ctx.sources("carol", Obj::Database(scene.database()), Connect).is_empty());
}

#[test]
fn pg_write_all_data_gives_insert_update_delete_and_usage_but_not_select() {
    let mut scene = app_scene(PG14);
    scene.cluster.roles.push(login("dana"));
    scene.cluster.members.push(member("dana", "pg_write_all_data"));
    let ctx = scene.ctx();
    let predefined = [src(Predefined, &["pg_write_all_data"], None)];

    // 서버는 관계 종류를 가리지 않는다: 테이블, 뷰, 구체화 뷰, 파티션 테이블, 외부 테이블
    for name in ["app.orders", "app.customers", "app.order_totals", "app.order_summary", "audit.events", "audit.remote_log"] {
        let obj = Obj::Relation(scene.relation(name));
        for p in [Insert, Update, Delete] {
            assert_eq!(ctx.sources("dana", obj, p), predefined, "{name} {p:?}");
        }
        for p in [Select, Truncate, References, Trigger] {
            assert!(ctx.sources("dana", obj, p).is_empty(), "{name} {p:?}");
        }
    }
    // 시퀀스는 UPDATE(nextval)만 받는다. INSERT·DELETE는 시퀀스에 없는 권한이다
    let ticket = Obj::Relation(scene.relation("app.ticket_seq"));
    assert_eq!(ctx.sources("dana", ticket, Update), predefined);
    for p in [Usage, Select, Insert, Delete] {
        assert!(ctx.sources("dana", ticket, p).is_empty(), "{p:?}");
    }
    for name in ["app", "audit", "scratch"] {
        assert_eq!(ctx.sources("dana", Obj::Schema(scene.schema(name)), Usage), predefined, "{name}");
        assert!(ctx.sources("dana", Obj::Schema(scene.schema(name)), Create).is_empty(), "{name}");
    }
}

#[test]
fn predefined_sources_keep_the_path_and_count_once_per_role() {
    let mut scene = app_scene(PG14);
    scene.cluster.roles.extend([login("dave"), login("erin"), RoleRec { inherit: false, ..login("frank") }]);
    scene.cluster.members.extend([
        member("dave", "carol"),
        member("erin", "pg_read_all_data"),
        member("erin", "pg_write_all_data"),
        member("frank", "pg_read_all_data"),
    ]);
    let ctx = scene.ctx();
    let orders = Obj::Relation(scene.relation("app.orders"));
    let app = Obj::Schema(scene.schema("app"));

    // dave → carol → pg_read_all_data
    assert_eq!(ctx.sources("dave", orders, Select), [src(Predefined, &["carol", "pg_read_all_data"], None)]);
    // 두 역할 모두 구성원이면 SELECT는 읽기 역할만, 스키마 USAGE는 둘 다 준다
    assert_eq!(ctx.sources("erin", orders, Select), [src(Predefined, &["pg_read_all_data"], None)]);
    assert_eq!(ctx.sources("erin", orders, Insert), [src(Predefined, &["pg_write_all_data"], None)]);
    assert_eq!(
        ctx.sources("erin", app, Usage),
        [src(Predefined, &["pg_read_all_data"], None), src(Predefined, &["pg_write_all_data"], None)]
    );
    // NOINHERIT인 frank는 상속하지 못한다
    assert!(ctx.sources("frank", orders, Select).is_empty());
    assert_eq!(ctx.set_role_only("frank"), ["pg_read_all_data"]);
}

#[test]
fn the_predefined_role_itself_has_what_it_grants() {
    let mut scene = app_scene(PG14);
    scene.cluster.roles.push(role("pg_read_all_data"));
    let ctx = scene.ctx();
    assert_eq!(
        ctx.sources("pg_read_all_data", Obj::Relation(scene.relation("app.orders")), Select),
        [src(Predefined, &[], None)]
    );
}

#[test]
fn predefined_roles_are_ignored_before_pg14() {
    let mut scene = app_scene(PG13);
    scene.cluster.roles.push(login("dana"));
    scene.cluster.members.push(member("dana", "pg_write_all_data"));
    let ctx = scene.ctx();
    let orders = Obj::Relation(scene.relation("app.orders"));
    let app = Obj::Schema(scene.schema("app"));
    // 읽기 역할(carol)도 쓰기 역할(dana)도 주는 것이 없다
    assert!(ctx.sources("carol", orders, Select).is_empty());
    assert!(ctx.sources("carol", app, Usage).is_empty());
    for p in [Insert, Update, Delete] {
        assert!(ctx.sources("dana", orders, p).is_empty(), "{p:?}");
    }
    assert!(ctx.sources("dana", app, Usage).is_empty());
    // 구성원 관계 자체는 있다
    assert_eq!(ctx.inherited("carol").len(), 2);
    assert_eq!(ctx.inherited("dana").len(), 2);
}

// ───────────────────────── 출처: MAINTAIN ─────────────────────────

#[test]
fn maintain_exists_from_pg17_on_every_relation_except_sequences() {
    let mut scene = app_scene(PG17);
    scene.cluster.roles.extend([RoleRec { superuser: true, ..login("root") }, login("maint")]);
    scene.cluster.members.push(member_with("maint", "pg_maintain", true, true));
    scene.db.relations.push(table("app", "kept", "app_owner").grant("alice", &[Maintain]));
    let ctx = scene.ctx();

    // 테이블, 뷰, 구체화 뷰, 파티션 테이블, 외부 테이블: superuser도 pg_maintain의 구성원도 MAINTAIN을 갖는다
    for name in ["app.orders", "app.order_totals", "app.order_summary", "audit.events", "audit.remote_log"] {
        let obj = Obj::Relation(scene.relation(name));
        assert_eq!(ctx.sources("root", obj, Maintain), [src(Superuser, &[], None)], "{name}");
        assert_eq!(ctx.sources("maint", obj, Maintain), [src(Predefined, &["pg_maintain"], None)], "{name}");
        // pg_maintain은 MAINTAIN만 준다
        for p in [Select, Insert, Update, Delete, Truncate] {
            assert!(ctx.sources("maint", obj, p).is_empty(), "{name} {p:?}");
        }
    }
    // 시퀀스에는 MAINTAIN이 없다
    let ticket = Obj::Relation(scene.relation("app.ticket_seq"));
    for role in ["root", "maint", "app_owner"] {
        assert!(ctx.sources(role, ticket, Maintain).is_empty(), "{role}");
    }
    // ACL의 MAINTAIN은 다른 권한처럼 받는다
    assert_eq!(ctx.sources("alice", Obj::Relation(scene.relation("app.kept")), Maintain), [src(Direct, &[], Some("app_owner"))]);
    // 스키마·함수·데이터베이스에는 주지 않는다
    assert!(ctx.sources("maint", Obj::Schema(scene.schema("app")), Usage).is_empty());
    assert!(ctx.sources("maint", Obj::Function(scene.function("app.touch")), Execute).is_empty());
    assert!(ctx.sources("maint", Obj::Database(scene.database()), Connect).is_empty());
}

#[test]
fn before_pg17_no_object_offers_maintain() {
    let mut scene = app_scene(PG16);
    scene.cluster.roles.extend([RoleRec { superuser: true, ..login("root") }, login("maint")]);
    scene.cluster.members.push(member_with("maint", "pg_maintain", true, true));
    // PG16 서버가 줄 수 없는 ACL 항목이 있어도 이 권한은 없다
    scene.db.relations.push(table("app", "kept", "app_owner").grant("alice", &[Maintain]));
    let ctx = scene.ctx();
    for name in ["app.orders", "app.kept", "audit.events"] {
        let obj = Obj::Relation(scene.relation(name));
        for role in ["root", "maint", "alice", "app_owner"] {
            assert!(ctx.sources(role, obj, Maintain).is_empty(), "{role} {name}");
        }
    }
    // 다른 권한은 그대로다
    assert_eq!(ctx.sources("root", Obj::Relation(scene.relation("app.orders")), Select), [src(Superuser, &[], None)]);
}

// ───────────────────────── 출처: pg_database_owner ─────────────────────────

/// PG15부터 `public` 스키마는 `pg_database_owner`의 것이고 PUBLIC에는 USAGE만 있다
fn add_pg15_public_schema(scene: &mut Scene) {
    scene.cluster.roles.push(role("pg_database_owner"));
    scene.db.schemas.push(schema("public", "pg_database_owner").grant_public(&[Usage]));
}

#[test]
fn the_database_owner_is_implicitly_a_member_of_pg_database_owner() {
    let mut scene = app_scene(PG16);
    add_pg15_public_schema(&mut scene);
    scene.cluster.roles.push(login("ops"));
    scene.cluster.members.push(member_with("ops", "app_owner", true, true));
    let ctx = scene.ctx();
    let public = Obj::Schema(scene.schema("public"));
    let via_owner = &["pg_database_owner"];

    assert_eq!(ctx.sources("app_owner", public, Create), [src(Owner, via_owner, Some("pg_database_owner"))]);
    assert_eq!(
        ctx.sources("app_owner", public, Usage),
        [src(Owner, via_owner, Some("pg_database_owner")), src(Public, &[], Some("pg_database_owner"))]
    );
    // 소유자를 상속하는 역할도 받는다. via는 pg_database_owner로 끝난다
    assert_eq!(ctx.sources("ops", public, Create), [src(Owner, &["app_owner", "pg_database_owner"], Some("pg_database_owner"))]);
    // 다른 역할은 PUBLIC의 USAGE뿐이다
    assert!(ctx.sources("alice", public, Create).is_empty());
    assert_eq!(ctx.sources("alice", public, Usage), [src(Public, &[], Some("pg_database_owner"))]);
    assert_eq!(ctx.inherited("app_owner"), [inh("app_owner", &[]), inh("pg_database_owner", &["pg_database_owner"])]);
}

#[test]
fn privileges_granted_to_pg_database_owner_reach_the_owner_and_whoever_inherits_the_owner() {
    let mut scene = app_scene(PG14);
    scene.cluster.roles.push(login("ops"));
    scene.cluster.members.push(member("ops", "app_owner"));
    // 소유자가 자기 SELECT를 거두고 pg_database_owner에게 줬다
    scene.db.relations.push(table("app", "held", "app_owner").revoke("app_owner", &[Select]).grant("pg_database_owner", &[Select]));
    let ctx = scene.ctx();
    let held = Obj::Relation(scene.relation("app.held"));

    assert_eq!(ctx.sources("app_owner", held, Select), [src(Group, &["pg_database_owner"], Some("app_owner"))]);
    assert_eq!(ctx.sources("ops", held, Select), [src(Group, &["app_owner", "pg_database_owner"], Some("app_owner"))]);
    assert!(ctx.sources("alice", held, Select).is_empty());
    // PG14의 public은 소유자(superuser)의 것이고 PUBLIC이 CREATE도 가진다. pg_database_owner는 끼지 않는다
    let mut scene = app_scene(PG14);
    scene.db.schemas.push(schema("public", "postgres").grant_public(&[Usage, Create]));
    assert_eq!(kinds(&scene.ctx().sources("app_owner", Obj::Schema(scene.schema("public")), Create)), [Public]);
}

#[test]
fn pg_database_owner_does_not_exist_before_pg14() {
    let mut scene = app_scene(PG13);
    scene.db.relations.push(table("app", "held", "app_owner").revoke("app_owner", &[Select]).grant("pg_database_owner", &[Select]));
    let ctx = scene.ctx();
    assert!(ctx.sources("app_owner", Obj::Relation(scene.relation("app.held")), Select).is_empty());
    assert_eq!(ctx.inherited("app_owner"), [inh("app_owner", &[])]);
}

#[test]
fn a_noinherit_database_owner_gets_pg_database_owner_only_from_pg16() {
    let held = || table("app", "held", "app_owner").revoke("app_owner", &[Select]).grant("pg_database_owner", &[Select]);

    // PG15 이하: 암묵적 구성원 관계도 구성원 역할의 INHERIT 속성을 따른다. SET ROLE은 된다
    let mut scene = app_scene(PG15);
    scene.role_mut("app_owner").inherit = false;
    scene.db.relations.push(held());
    let ctx = scene.ctx();
    assert!(ctx.sources("app_owner", Obj::Relation(scene.relation("app.held")), Select).is_empty());
    assert_eq!(ctx.inherited("app_owner"), [inh("app_owner", &[])]);
    assert_eq!(ctx.set_role_only("app_owner"), ["pg_database_owner"]);

    // PG16: 이 관계에는 옵션이 없고 늘 상속한다
    let mut scene = app_scene(PG16);
    scene.role_mut("app_owner").inherit = false;
    scene.db.relations.push(held());
    let ctx = scene.ctx();
    assert_eq!(ctx.sources("app_owner", Obj::Relation(scene.relation("app.held")), Select), [src(Group, &["pg_database_owner"], Some("app_owner"))]);
    assert_eq!(ctx.inherited("app_owner").len(), 2);
    assert!(ctx.set_role_only("app_owner").is_empty());
}

#[test]
fn the_implicit_membership_comes_after_the_real_ones() {
    let mut scene = app_scene(PG16);
    scene.cluster.roles.push(role("auditors"));
    scene.cluster.members.push(member_with("app_owner", "auditors", true, true));
    assert_eq!(
        scene.ctx().inherited("app_owner"),
        [inh("app_owner", &[]), inh("auditors", &["auditors"]), inh("pg_database_owner", &["pg_database_owner"])]
    );
}

// ───────────────────────── 출처: superuser ─────────────────────────

#[test]
fn a_superuser_has_every_privilege_from_the_superuser_source() {
    let mut scene = app_scene(PG16);
    scene.cluster.roles.push(RoleRec { superuser: true, ..login("root") });
    let ctx = scene.ctx();
    let su = [src(Superuser, &[], None)];

    let checks: Vec<(Obj, &[Privilege])> = vec![
        (Obj::Relation(scene.relation("app.orders")), &[Select, Insert, Update, Delete, Truncate, References, Trigger]),
        (Obj::Relation(scene.relation("app.ticket_seq")), &[Usage, Select, Update]),
        (Obj::Schema(scene.schema("app")), &[Usage, Create]),
        (Obj::Function(scene.function("app.touch")), &[Execute]),
        (Obj::Database(scene.database()), &[Connect, Create]),
    ];
    for (obj, privileges) in checks {
        for &p in privileges {
            assert_eq!(ctx.sources("root", obj, p), su, "{obj:?} {p:?}");
        }
    }
    // ACL 항목이 있어도 superuser 출처가 뒤에 붙는다
    assert_eq!(ctx.sources("root", Obj::Database(scene.database()), Temporary), [src(Public, &[], Some("app_owner")), src(Superuser, &[], None)]);
    assert_eq!(ctx.unusable("root", "app"), None);
}

#[test]
fn superuser_is_not_inherited() {
    // 서버는 superuser 속성을 상속하지 않는다. superuser 역할의 구성원은 ACL이 주는 것만 갖는다
    let mut scene = app_scene(PG16);
    scene.cluster.roles.extend([RoleRec { superuser: true, ..role("root") }, login("ops")]);
    scene.cluster.members.push(member_with("ops", "root", true, true));
    scene.db.relations.push(table("app", "rooted", "app_owner").revoke("app_owner", &[Select]).grant("root", &[Select]));
    let ctx = scene.ctx();

    assert!(ctx.sources("ops", Obj::Relation(scene.relation("app.orders")), Select).is_empty());
    assert!(ctx.sources("ops", Obj::Schema(scene.schema("app")), Usage).is_empty());
    // root 앞으로 부여된 권한은 그룹으로 받는다
    assert_eq!(ctx.sources("ops", Obj::Relation(scene.relation("app.rooted")), Select), [src(Group, &["root"], Some("app_owner"))]);
    assert_eq!(kinds(&ctx.sources("root", Obj::Relation(scene.relation("app.rooted")), Select)), [Direct, Superuser]);
}

#[test]
fn a_privilege_the_object_does_not_have_is_never_a_source() {
    let mut scene = app_scene(PG16);
    scene.cluster.roles.push(RoleRec { superuser: true, ..login("root") });
    let ctx = scene.ctx();
    let orders = Obj::Relation(scene.relation("app.orders"));
    let ticket = Obj::Relation(scene.relation("app.ticket_seq"));
    let app = Obj::Schema(scene.schema("app"));
    let touch = Obj::Function(scene.function("app.touch"));
    let appdb = Obj::Database(scene.database());

    for (obj, p) in [
        (orders, Usage),
        (orders, Execute),
        (ticket, Insert),
        (ticket, Delete),
        (ticket, Truncate),
        (app, Select),
        (app, Connect),
        (touch, Select),
        (touch, Usage),
        (appdb, Usage),
        (appdb, Select),
    ] {
        assert!(ctx.sources("root", obj, p).is_empty(), "{obj:?} {p:?}");
        assert!(ctx.sources("app_owner", obj, p).is_empty(), "{obj:?} {p:?}");
    }
}

// ───────────────────────── 실제로 쓸 수 있는가 ─────────────────────────

#[test]
fn unusable_names_the_first_thing_missing_connect_then_schema_usage() {
    let scene = app_scene(PG16);
    let ctx = scene.ctx();

    // alice: CONNECT와 app·audit의 USAGE를 그룹(app_write → app_read)에서 상속한다
    assert_eq!(ctx.unusable("alice", "app"), None);
    assert_eq!(ctx.unusable("alice", "audit"), None);
    // scratch의 USAGE는 소유자만 갖는다
    assert_eq!(ctx.unusable("alice", "scratch"), Some("USAGE 없음"));
    // carol: pg_read_all_data로 USAGE는 있지만 CONNECT가 없다
    assert_eq!(ctx.unusable("carol", "app"), Some("CONNECT 없음"));
    // bob: 둘 다 없으면 CONNECT가 먼저다
    assert_eq!(ctx.unusable("bob", "app"), Some("CONNECT 없음"));
    // 소유자는 둘 다 있다
    assert_eq!(ctx.unusable("app_owner", "scratch"), None);
}

#[test]
fn connect_counts_from_direct_group_and_public_entries() {
    let mut scene = app_scene(PG16);
    // PUBLIC에 CONNECT를 되돌렸다: CONNECT가 없던 역할도 이제 USAGE만 본다
    scene.cluster.databases[0].acl.push(entry("app_owner", None, Connect));
    let ctx = scene.ctx();
    assert_eq!(ctx.unusable("bob", "app"), Some("USAGE 없음"));
    assert_eq!(ctx.unusable("carol", "app"), None);
    assert_eq!(ctx.unusable("carol", "scratch"), None);

    // PUBLIC이 아니라 bob에게만 직접 준 경우
    let mut scene = app_scene(PG16);
    scene.cluster.databases[0].acl.push(entry("app_owner", Some("bob"), Connect));
    assert_eq!(scene.ctx().unusable("bob", "app"), Some("USAGE 없음"));
    assert_eq!(scene.ctx().unusable("carol", "app"), Some("CONNECT 없음"));
}

#[test]
fn unusable_is_none_for_what_it_cannot_judge() {
    let mut scene = app_scene(PG16);
    // 모르는 스키마는 판단하지 않는다
    assert_eq!(scene.ctx().unusable("alice", "no_such_schema"), None);
    // 클러스터 스냅숏에 이 데이터베이스가 없으면 CONNECT는 판단하지 않는다
    scene.cluster.databases.clear();
    assert_eq!(scene.ctx().unusable("carol", "app"), None);
    assert_eq!(scene.ctx().unusable("bob", "app"), Some("USAGE 없음"));
}

// ───────────────────────── 스키마 칸 ─────────────────────────

#[test]
fn cells_are_roles_times_schemas_in_schema_name_order_within_the_given_role_order() {
    let mut scene = app_scene(PG16);
    let keys = |scene: &Scene| -> Vec<(String, String)> {
        schema_cells(&scene.ctx(), &["carol", "alice"]).into_iter().map(|c| (c.role, c.schema)).collect()
    };
    let expected: Vec<(String, String)> =
        [("carol", "app"), ("carol", "audit"), ("carol", "scratch"), ("alice", "app"), ("alice", "audit"), ("alice", "scratch")]
            .map(|(r, s)| (r.to_string(), s.to_string()))
            .to_vec();
    assert_eq!(keys(&scene), expected);
    // 스냅숏의 스키마 순서와 상관없이 이름순이다
    scene.db.schemas.reverse();
    assert_eq!(keys(&scene), expected);
    assert!(schema_cells(&scene.ctx(), &[]).is_empty());
}

#[test]
fn cells_summarize_usage_create_read_and_write() {
    let scene = app_scene(PG16);
    let cells = schema_cells(&scene.ctx(), &APP_ROLES);
    let find = |role: &str, schema: &str| cells.iter().find(|c| c.role == role && c.schema == schema).unwrap_or_else(|| panic!("{role}/{schema}")).clone();
    assert_eq!(cells.len(), 18);

    // alice는 모든 것을 그룹에서 받았다: app_read(읽기, 스키마 USAGE), app_write(INSERT·UPDATE는 orders 하나뿐이라 쓰기는 일부)
    assert_eq!(find("alice", "app"), SchemaCell { usage: true, read: Coverage::All, write: Coverage::Some, inherited_only: true, ..cell("alice", "app") });
    assert_eq!(find("alice", "audit"), SchemaCell { usage: true, inherited_only: true, ..cell("alice", "audit") });
    assert_eq!(find("alice", "scratch"), cell("alice", "scratch"));

    // 소유자는 모두 가진다. 파티션 테이블과 외부 테이블도 읽고 쓰는 관계로 센다
    assert_eq!(
        find("app_owner", "app"),
        SchemaCell { usage: true, create: true, read: Coverage::All, write: Coverage::All, ..cell("app_owner", "app") }
    );
    assert_eq!(
        find("app_owner", "audit"),
        SchemaCell { usage: true, create: true, read: Coverage::All, write: Coverage::All, ..cell("app_owner", "audit") }
    );
    assert_eq!(find("app_owner", "scratch"), SchemaCell { usage: true, create: true, ..cell("app_owner", "scratch") });

    // app_read는 직접 받았고, 쓰기는 없다. audit에는 아무것도 없다
    assert_eq!(find("app_read", "app"), SchemaCell { usage: true, read: Coverage::All, ..cell("app_read", "app") });
    assert_eq!(find("app_read", "audit"), cell("app_read", "audit"));

    // app_write: 쓰기를 직접 받았으니 흐리지 않는다. audit의 USAGE도 직접 받았다
    assert_eq!(find("app_write", "app"), SchemaCell { usage: true, read: Coverage::All, write: Coverage::Some, ..cell("app_write", "app") });
    assert_eq!(find("app_write", "audit"), SchemaCell { usage: true, ..cell("app_write", "audit") });

    // bob은 아무것도 없다. CONNECT도 없지만 잃을 것이 없으니 못 쓴다는 표시도 없다
    for schema in ["app", "audit", "scratch"] {
        assert_eq!(find("bob", schema), cell("bob", schema));
    }

    // carol은 pg_read_all_data로 모든 스키마의 USAGE와 읽기를 받았지만 CONNECT가 없다
    assert_eq!(
        find("carol", "app"),
        SchemaCell { usage: true, read: Coverage::All, inherited_only: true, unusable: Some("CONNECT 없음"), ..cell("carol", "app") }
    );
    assert_eq!(
        find("carol", "audit"),
        SchemaCell { usage: true, read: Coverage::All, inherited_only: true, unusable: Some("CONNECT 없음"), ..cell("carol", "audit") }
    );
    assert_eq!(find("carol", "scratch"), SchemaCell { usage: true, inherited_only: true, unusable: Some("CONNECT 없음"), ..cell("carol", "scratch") });
}

#[test]
fn read_is_all_some_or_none_of_the_readable_relations_and_an_empty_schema_reads_none() {
    let mut scene = app_scene(PG16);
    scene.cluster.roles.extend([login("tester"), login("seq_only"), login("deleter")]);
    let app = scene.db.schemas.iter_mut().find(|s| s.name == "app").expect("app");
    for role in ["tester", "seq_only", "deleter"] {
        app.acl.push(entry("app_owner", Some(role), Usage));
    }
    // tester는 읽는 관계 네 개 가운데 orders와 뷰만 받는다
    grant_on(&mut scene, "orders", "tester", &[Select]);
    grant_on(&mut scene, "order_totals", "tester", &[Select]);
    // seq_only는 시퀀스의 SELECT만 받는다: 읽기로 세지 않는다
    grant_on(&mut scene, "ticket_seq", "seq_only", &[Select]);
    // deleter는 customers의 DELETE만 받는다
    grant_on(&mut scene, "customers", "deleter", &[Delete]);
    let cells = schema_cells(&scene.ctx(), &["tester", "seq_only", "deleter", "app_owner"]);
    let find = |role: &str, schema: &str| cells.iter().find(|c| c.role == role && c.schema == schema).unwrap_or_else(|| panic!("{role}/{schema}")).clone();

    assert_eq!(find("tester", "app").read, Coverage::Some);
    assert_eq!(find("tester", "app").write, Coverage::None);
    assert_eq!(find("seq_only", "app").read, Coverage::None);
    // DELETE만 받아도 쓰기다(INSERT·UPDATE·DELETE 가운데 하나면 된다). customers는 쓰는 관계 둘 가운데 하나
    assert_eq!(find("deleter", "app").write, Coverage::Some);
    // 빈 스키마는 소유자도 None이다
    assert_eq!((find("app_owner", "scratch").read, find("app_owner", "scratch").write), (Coverage::None, Coverage::None));
    // 파티션 테이블·외부 테이블은 읽는 관계에 든다
    assert_eq!(find("app_owner", "audit").read, Coverage::All);
}

#[test]
fn views_are_read_but_not_written_and_sequences_are_neither() {
    let mut scene = app_scene(PG14);
    scene.cluster.roles.push(login("dana"));
    scene.cluster.members.push(member("dana", "pg_write_all_data"));
    let cells = schema_cells(&scene.ctx(), &["dana"]);
    let find = |schema: &str| cells.iter().find(|c| c.schema == schema).unwrap_or_else(|| panic!("{schema}")).clone();

    // pg_write_all_data는 뷰·구체화 뷰·시퀀스에도 쓰기를 주지만, 쓰기 칸은 테이블·파티션 테이블·외부 테이블만 센다
    // app: 쓰는 관계는 테이블 둘이고 모두 받았다. 읽기는 없다
    assert_eq!((find("app").read, find("app").write), (Coverage::None, Coverage::All));
    assert_eq!((find("audit").read, find("audit").write), (Coverage::None, Coverage::All));
    assert!(find("app").usage && !find("app").create);
}

#[test]
fn inherited_only_is_true_when_every_shown_value_comes_from_groups_public_or_predefined_roles() {
    let mut scene = app_scene(PG16);
    scene.cluster.roles.extend([login("ops"), RoleRec { superuser: true, ..login("root") }]);
    scene.cluster.members.push(member_with("ops", "app_owner", true, true));
    add_pg15_public_schema(&mut scene);
    let cells = schema_cells(&scene.ctx(), &["alice", "app_write", "ops", "root", "bob", "app_owner", "carol"]);
    let only = |role: &str, schema: &str| cells.iter().find(|c| c.role == role && c.schema == schema).unwrap_or_else(|| panic!("{role}/{schema}")).inherited_only;

    assert!(only("alice", "app"), "그룹에서만");
    assert!(only("carol", "app"), "미리 정의된 역할에서만");
    assert!(only("bob", "public"), "PUBLIC에서만(PG15 이후의 public은 PUBLIC에 USAGE를 준다)");
    assert!(!only("app_write", "app"), "쓰기를 직접 받았다");
    assert!(!only("app_write", "audit"), "USAGE를 직접 받았다");
    assert!(!only("app_owner", "app"), "소유자");
    assert!(!only("ops", "app"), "소유자를 상속해도 출처 종류는 Owner다");
    assert!(!only("app_owner", "public"), "public의 소유자는 pg_database_owner고 소유자 출처다");
    assert!(!only("root", "app"), "superuser");
    assert!(!only("bob", "app"), "보이는 값이 없는 칸은 출처를 내세우지 않는다");
}

#[test]
fn unusable_is_set_only_on_cells_with_something_to_lose() {
    let mut scene = app_scene(PG16);
    // 권한은 있지만 CONNECT가 없다(carol), CONNECT가 없고 가진 것도 없다(bob)
    let cells = schema_cells(&scene.ctx(), &["bob", "carol"]);
    let unusable = |role: &str, schema: &str| cells.iter().find(|c| c.role == role && c.schema == schema).expect("cell").unusable;
    assert_eq!(unusable("carol", "app"), Some("CONNECT 없음"));
    assert_eq!(unusable("bob", "app"), None);

    // CONNECT를 PUBLIC에 되돌리고 bob에게 orders의 SELECT만 직접 준다: 스키마 USAGE가 없어서 못 쓴다
    scene.cluster.databases[0].acl.push(entry("app_owner", None, Connect));
    grant_on(&mut scene, "orders", "bob", &[Select]);
    let cells = schema_cells(&scene.ctx(), &["bob"]);
    let bob_app = cells.iter().find(|c| c.schema == "app").expect("app");
    assert_eq!((bob_app.usage, bob_app.read, bob_app.unusable), (false, Coverage::Some, Some("USAGE 없음")));
    // 다른 스키마에는 잃을 것이 없다
    assert!(cells.iter().filter(|c| c.schema != "app").all(|c| c.unusable.is_none()));
}

#[test]
fn a_role_that_is_not_in_the_snapshot_still_gets_public_privileges_in_cells() {
    let mut scene = app_scene(PG16);
    add_pg15_public_schema(&mut scene);
    let cells = schema_cells(&scene.ctx(), &["stranger"]);
    let public = cells.iter().find(|c| c.schema == "public").expect("public");
    assert_eq!((public.usage, public.create, public.inherited_only), (true, false, true));
}

#[test]
fn a_cell_that_shows_only_create_is_not_blamed_on_a_missing_usage() {
    // CREATE는 USAGE 없이도 된다. 칸이 보이는 것이 CREATE뿐이면 USAGE가 없다는 이유를 달지 않는다. CONNECT는 그대로 본다
    let mut scene = app_scene(PG16);
    scene.cluster.roles.push(login("maker"));
    for name in ["scratch", "app"] {
        scene.db.schemas.iter_mut().find(|s| s.name == name).expect("schema").acl.push(entry("app_owner", Some("maker"), Create));
    }
    grant_on(&mut scene, "orders", "maker", &[Select]);

    // maker는 CONNECT가 없다: CREATE뿐인 칸도 읽기가 함께 보이는 칸도 CONNECT가 이유다
    let cells = schema_cells(&scene.ctx(), &["maker"]);
    let unusable = |schema: &str| cells.iter().find(|c| c.schema == schema).expect("cell").unusable;
    assert_eq!((unusable("scratch"), unusable("app"), unusable("audit")), (Some("CONNECT 없음"), Some("CONNECT 없음"), None));

    // PUBLIC에 CONNECT를 되돌렸다. scratch: 보이는 것이 CREATE뿐이라 이유가 없다. app: CREATE에 읽기도 보이니 USAGE가 없는 것이 이유다
    scene.cluster.databases[0].acl.push(entry("app_owner", None, Connect));
    let ctx = scene.ctx();
    let cells = schema_cells(&ctx, &["maker"]);
    let find = |schema: &str| cells.iter().find(|c| c.schema == schema).expect("cell").clone();
    assert_eq!(find("scratch"), SchemaCell { create: true, ..cell("maker", "scratch") });
    assert_eq!(find("app"), SchemaCell { create: true, read: Coverage::Some, unusable: Some("USAGE 없음"), ..cell("maker", "app") });
    // 역할과 스키마만 묻는 `Ctx::unusable`은 그대로 USAGE가 없다고 답한다. 무엇을 보이는지는 칸이 정한다
    assert_eq!(ctx.unusable("maker", "scratch"), Some("USAGE 없음"));

    // USAGE가 함께 있으면 이유가 있을 수 없다. 쓰기만 보이는 칸은 USAGE가 이유다
    scene.db.schemas.iter_mut().find(|s| s.name == "scratch").expect("scratch").acl.push(entry("app_owner", Some("maker"), Usage));
    scene.db.relations.push(table("scratch", "t", "app_owner").grant("maker", &[Insert]));
    scene.db.schemas.iter_mut().find(|s| s.name == "audit").expect("audit").acl.push(entry("app_owner", Some("maker"), Create));
    scene.db.relations.iter_mut().find(|r| r.name == "remote_log").expect("remote_log").acl.push(entry("app_owner", Some("maker"), Delete));
    let cells = schema_cells(&scene.ctx(), &["maker"]);
    let find = |schema: &str| cells.iter().find(|c| c.schema == schema).expect("cell").clone();
    assert_eq!(find("scratch"), SchemaCell { usage: true, create: true, write: Coverage::All, ..cell("maker", "scratch") });
    assert_eq!(find("audit"), SchemaCell { create: true, write: Coverage::Some, unusable: Some("USAGE 없음"), ..cell("maker", "audit") });
}

// ───────────────────────── 누가 할 수 있나 ─────────────────────────

#[test]
fn who_can_lists_the_roles_with_a_source_in_name_order() {
    let scene = app_scene(PG16);
    let rows = who_can(&scene.ctx(), Obj::Relation(scene.relation("app.orders")), Select);
    assert_eq!(
        rows,
        [
            who("alice", vec![src(Group, &["app_write", "app_read"], Some("app_owner"))], None),
            who("app_owner", vec![src(Owner, &[], Some("app_owner"))], None),
            who("app_read", vec![src(Direct, &[], Some("app_owner"))], None),
            who("app_write", vec![src(Group, &["app_read"], Some("app_owner"))], None),
            who("carol", vec![src(Predefined, &["pg_read_all_data"], None)], Some("CONNECT 없음")),
        ],
        "bob은 NOINHERIT라서 빠져요"
    );

    // 스냅숏의 역할 순서와 상관없이 이름순이다
    let mut scene = app_scene(PG16);
    scene.cluster.roles.reverse();
    let reversed = who_can(&scene.ctx(), Obj::Relation(scene.relation("app.orders")), Select);
    assert_eq!(reversed, rows);
}

#[test]
fn who_can_works_for_every_kind_of_object() {
    let mut scene = app_scene(PG16);
    scene.cluster.roles.push(RoleRec { superuser: true, ..login("root") });
    let ctx = scene.ctx();

    // 데이터베이스 CONNECT: 직접(app_read), 그룹(app_write, alice), 소유자. root는 superuser
    assert_eq!(
        who_can(&ctx, Obj::Database(scene.database()), Connect),
        [
            who("alice", vec![src(Group, &["app_write", "app_read"], Some("app_owner"))], None),
            who("app_owner", vec![src(Owner, &[], Some("app_owner"))], None),
            who("app_read", vec![src(Direct, &[], Some("app_owner"))], None),
            who("app_write", vec![src(Group, &["app_read"], Some("app_owner"))], None),
            who("root", vec![src(Superuser, &[], None)], None),
        ]
    );
    // 스키마 CREATE는 소유자(와 superuser)뿐이다
    assert_eq!(
        who_can(&ctx, Obj::Schema(scene.schema("audit")), Create),
        [who("app_owner", vec![src(Owner, &[], Some("app_owner"))], None), who("root", vec![src(Superuser, &[], None)], None)]
    );
    // 함수: PUBLIC의 EXECUTE를 거둬서 app_write와 그 구성원만 쓴다. 이 스키마의 USAGE가 없는 역할은 없다
    let touch = who_can(&ctx, Obj::Function(scene.function("app.touch")), Execute);
    assert_eq!(touch.iter().map(|r| r.role.as_str()).collect::<Vec<_>>(), ["alice", "app_owner", "app_write", "root"]);
    // 시퀀스
    let ticket = who_can(&ctx, Obj::Relation(scene.relation("app.ticket_seq")), Usage);
    assert_eq!(ticket.iter().map(|r| r.role.as_str()).collect::<Vec<_>>(), ["alice", "app_owner", "app_write", "root"]);
}

#[test]
fn who_can_marks_the_roles_that_cannot_use_the_privilege_for_lack_of_usage() {
    let mut scene = app_scene(PG16);
    // orders의 SELECT를 bob에게 직접 줬고 PUBLIC에 CONNECT를 돌려줬다: bob은 스키마 USAGE가 없다
    scene.cluster.databases[0].acl.push(entry("app_owner", None, Connect));
    grant_on(&mut scene, "orders", "bob", &[Select]);
    let rows = who_can(&scene.ctx(), Obj::Relation(scene.relation("app.orders")), Select);
    let bob = rows.iter().find(|r| r.role == "bob").expect("bob");
    assert_eq!(bob.sources, [src(Direct, &[], Some("app_owner"))]);
    assert_eq!(bob.unusable, Some("USAGE 없음"));
}

#[test]
fn who_can_marks_the_roles_that_hold_a_database_privilege_without_connect() {
    // 데이터베이스에 CREATE만 받고 CONNECT가 없는 역할은 그 권한을 쓸 수 없다
    let mut scene = app_scene(PG16);
    scene.cluster.databases[0].acl.push(entry("app_owner", Some("bob"), Create));
    let rows = who_can(&scene.ctx(), Obj::Database(scene.database()), Create);
    assert_eq!(rows.iter().map(|r| (r.role.as_str(), r.unusable)).collect::<Vec<_>>(), [("app_owner", None), ("bob", Some("CONNECT 없음"))]);
}

#[test]
fn who_can_does_not_blame_usage_for_a_schemas_create() {
    let mut scene = app_scene(PG16);
    scene.cluster.roles.push(login("maker"));
    scene.db.schemas.iter_mut().find(|s| s.name == "scratch").expect("scratch").acl.push(entry("app_owner", Some("maker"), Create));
    scene.db.relations.push(table("scratch", "t", "app_owner").grant("maker", &[Select]));
    let maker = |scene: &Scene, obj: Obj, p: Privilege| who_can(&scene.ctx(), obj, p).into_iter().find(|r| r.role == "maker").expect("maker").unusable;

    // CONNECT가 없으면 그것이 이유다
    let scratch = Obj::Schema(scene.schema("scratch"));
    assert_eq!(maker(&scene, scratch, Create), Some("CONNECT 없음"));
    // CONNECT를 되돌리면 이유가 없다: maker는 scratch의 USAGE가 없어도 거기에 만들 수 있다
    scene.cluster.databases[0].acl.push(entry("app_owner", None, Connect));
    assert_eq!(maker(&scene, Obj::Schema(scene.schema("scratch")), Create), None);
    // 같은 역할, 같은 스키마여도 그 안의 테이블을 읽으려면 USAGE가 있어야 한다
    assert_eq!(maker(&scene, Obj::Relation(scene.relation("scratch.t")), Select), Some("USAGE 없음"));
}

#[test]
fn who_can_on_a_database_object_checks_connect_on_that_database() {
    // reporting은 PUBLIC이 CONNECT를 그대로 갖고 bob만 CREATE를 받았다. 이 스냅숏의 appdb는 PUBLIC의 CONNECT를 거뒀다
    let mut scene = app_scene(PG16);
    scene.cluster.databases.push(database("reporting", "app_owner").grant("bob", &[Create]));
    let ctx = scene.ctx();
    let reporting = Obj::Database(&scene.cluster.databases[1]);
    let all = ["alice", "app_owner", "app_read", "app_write", "bob", "carol"];

    // bob과 carol은 appdb에 붙을 수 없지만 reporting에는 붙는다
    for p in [Connect, Temporary] {
        let rows = who_can(&ctx, reporting, p);
        assert_eq!(rows.iter().map(|r| r.role.as_str()).collect::<Vec<_>>(), all, "{p:?}");
        assert!(rows.iter().all(|r| r.unusable.is_none()), "{p:?}: {rows:?}");
    }
    let rows = who_can(&ctx, reporting, Create);
    assert_eq!(rows.iter().map(|r| (r.role.as_str(), r.unusable)).collect::<Vec<_>>(), [("app_owner", None), ("bob", None)]);
}

#[test]
fn who_can_on_a_database_object_reports_a_missing_connect_on_that_database_only() {
    // sealed는 PUBLIC의 CONNECT를 거뒀고 carol만 CREATE를 받았다. 이 스냅숏의 appdb에는 PUBLIC이 CONNECT를 가진다
    let mut scene = app_scene(PG16);
    scene.cluster.databases[0].acl.push(entry("app_owner", None, Connect));
    scene.cluster.databases.push(database("sealed", "app_owner").revoke_public(&[Connect]).grant("carol", &[Create]));
    let ctx = scene.ctx();
    let sealed = Obj::Database(&scene.cluster.databases[1]);

    // carol은 appdb에는 붙지만 sealed에는 붙을 수 없다
    let rows = who_can(&ctx, sealed, Create);
    assert_eq!(rows.iter().map(|r| (r.role.as_str(), r.unusable)).collect::<Vec<_>>(), [("app_owner", None), ("carol", Some("CONNECT 없음"))]);
    // PUBLIC의 TEMPORARY는 모두에게 있지만 CONNECT가 없으면 쓸 수 없다
    let rows = who_can(&ctx, sealed, Temporary);
    let usable: Vec<&str> = rows.iter().filter(|r| r.unusable.is_none()).map(|r| r.role.as_str()).collect();
    assert_eq!(usable, ["app_owner"]);
    assert_eq!(rows.len(), 6);
    assert!(rows.iter().filter(|r| r.role != "app_owner").all(|r| r.unusable == Some("CONNECT 없음")), "{rows:?}");
}

// ───────────────────────── 클러스터만으로 만든 계산기 ─────────────────────────

#[test]
fn a_cluster_only_handle_answers_the_role_questions_without_a_database() {
    let scene = app_scene(PG16);
    let eval = Eval::for_cluster(&scene.cluster);

    assert_eq!(eval.role("alice").inherited(), [inh("alice", &[]), inh("app_write", &["app_write"]), inh("app_read", &["app_write", "app_read"])]);
    assert_eq!(eval.role("bob").inherited(), [inh("bob", &[])]);
    assert_eq!(eval.role("bob").set_role_only(), ["app_read"]);
    // 클러스터에는 데이터베이스마다 다른 암묵적 구성원 관계(소유자 → pg_database_owner)가 없다. 그것은 데이터베이스 스냅숏이 있어야 생긴다
    assert_eq!(eval.role("app_owner").inherited(), [inh("app_owner", &[])]);
    assert_eq!(Eval::new(&scene.ctx()).role("app_owner").inherited(), [inh("app_owner", &[]), inh("pg_database_owner", &["pg_database_owner"])]);
}

#[test]
fn a_cluster_only_handle_answers_for_the_objects_the_cluster_has() {
    // 데이터베이스의 ACL은 클러스터 스냅숏에 있다. CONNECT를 어디서 받는지 데이터베이스 스냅숏 없이 묻는다
    let scene = app_scene(PG16);
    let eval = Eval::for_cluster(&scene.cluster);
    let appdb = Obj::Database(scene.database());

    assert_eq!(kinds(&eval.role("alice").sources(appdb, Connect)), [Group]);
    assert_eq!(kinds(&eval.role("app_owner").sources(appdb, Connect)), [Owner]);
    assert!(eval.role("bob").sources(appdb, Connect).is_empty());
    // 스키마를 모르니 "USAGE 없음"은 판단하지 않고, 데이터베이스도 몰라서 "CONNECT 없음"도 판단하지 않는다
    assert_eq!(eval.role("bob").unusable("app"), None);
}

#[test]
fn membership_inherits_follows_the_pg16_option_and_before_that_the_attribute_of_the_member() {
    // PG15 이하: bob은 NOINHERIT라서 app_read를 상속하지 않는다. alice → app_write는 상속한다
    let scene = app_scene(PG15);
    let eval = Eval::for_cluster(&scene.cluster);
    assert!(eval.membership_inherits("alice", "app_write"));
    assert!(!eval.membership_inherits("bob", "app_read"));
    // 구성원 관계가 아니면 거짓이다(방향도 맞아야 한다)
    assert!(!eval.membership_inherits("alice", "app_read"));
    assert!(!eval.membership_inherits("app_write", "alice"));
    assert!(!eval.membership_inherits("nobody", "app_read"));

    // PG16: 관계마다의 INHERIT 옵션이 정한다. 속성과 반대로 줄 수도 있다
    let mut scene = app_scene(PG16);
    scene.member_mut("alice", "app_write").inherit = Some(false);
    scene.member_mut("bob", "app_read").inherit = Some(true);
    let eval = Eval::for_cluster(&scene.cluster);
    assert!(!eval.membership_inherits("alice", "app_write"));
    assert!(eval.membership_inherits("bob", "app_read"));
    // 옵션이 비어 있으면 구성원의 속성이다
    scene.member_mut("bob", "app_read").inherit = None;
    assert!(!Eval::for_cluster(&scene.cluster).membership_inherits("bob", "app_read"));
}

// ───────────────────────── 계약 ─────────────────────────

#[test]
fn sources_serialize_to_the_contract() {
    assert_eq!(
        serde_json::to_value(src(Group, &["app_write", "app_read"], Some("app_owner"))).expect("json"),
        json!({ "kind": "group", "via": ["app_write", "app_read"], "grantor": "app_owner" })
    );
    assert_eq!(serde_json::to_value(src(Superuser, &[], None)).expect("json"), json!({ "kind": "superuser", "via": [], "grantor": null }));
    let names: Vec<_> = [Owner, Direct, Group, Public, Predefined, Superuser].map(|k| serde_json::to_value(k).expect("json")).to_vec();
    assert_eq!(names, [json!("owner"), json!("direct"), json!("group"), json!("public"), json!("predefined"), json!("superuser")]);
}
