//! 생성한 스냅숏으로 하는 시험과 속도 시험. `tests`의 시험은 손으로 만든 장면의 기대값을 보고, 여기서는 시드가 정해진 난수로 만든 스냅숏에서
//! 빠른 길(`schema_cells`)을 정의와, 상속 계산을 서버 규칙을 다시 적은 것과 맞대 본다.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use super::SourceKind::{Direct, Owner, Superuser};
use super::tests::{inh, schema_cells};
use super::*;
use crate::pg::fixtures::*;
use crate::pg::model::Privilege::{Connect, Create, Delete, Insert, Maintain, Select, Temporary, Update, Usage};
use crate::pg::model::RelKind::{Foreign, MatView, Partitioned, Sequence, Table, View};
use crate::pg::model::{AclEntry, MemberRec, Privilege, RelKind, RelationRec, RoleRec, SchemaRec};

// ───────────────────────── 생성한 스냅숏으로 빠른 길과 정의를 맞대 보기 ─────────────────────────

/// 시드가 정해진 간단한 난수(xorshift). 시험이 매번 같은 스냅숏을 만든다
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: usize) -> usize {
        usize::try_from(self.next() % n as u64).expect("fits")
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }
}

const RANDOM_RELATION_PRIVILEGES: [Privilege; 4] = [Select, Insert, Update, Delete];

/// 받는 쪽(PUBLIC 포함)마다 권한 일부를 고른 ACL 항목들
fn random_acl(rng: &mut Rng, grantees: &[Option<String>], privileges: &[Privilege], owner: &str) -> Vec<AclEntry> {
    let mut acl = Vec::new();
    for &p in privileges {
        if rng.chance(80) {
            acl.push(entry(owner, Some(owner), p));
        }
    }
    for grantee in grantees {
        for &p in privileges {
            if rng.chance(8) {
                acl.push(entry(rng.pick(&[owner, "grantor"]), grantee.as_deref(), p));
            }
        }
    }
    acl
}

/// PG16부터 구성원 관계마다 INHERIT·SET 옵션이 있다(서버가 비워 주는 일은 없지만 가끔 비운다)
fn random_member(rng: &mut Rng, version: i32, who: &str, group: &str) -> MemberRec {
    if version < 160_000 {
        return member(who, group);
    }
    let inherit = if rng.chance(90) { Some(rng.chance(60)) } else { None };
    let set = if rng.chance(90) { Some(rng.chance(70)) } else { None };
    MemberRec { inherit, set, ..member(who, group) }
}

fn random_scene(seed: u64) -> Scene {
    let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    for _ in 0..4 {
        rng.next();
    }
    let version = *rng.pick(&[PG13, PG14, PG15, PG16]);
    let users: Vec<String> = (0..10).map(|i| format!("r{i}")).collect();
    let mut roles: Vec<RoleRec> = users.iter().map(|n| RoleRec { inherit: rng.chance(70), superuser: rng.chance(8), ..role(n) }).collect();
    roles.extend(["pg_read_all_data", "pg_write_all_data", "pg_database_owner"].map(role));

    // 구성원 관계: 번호가 큰 역할이 작은 역할의 구성원이다(순환 없음). 읽기·쓰기 역할의 구성원도 있다
    let mut members = Vec::new();
    for i in 1..users.len() {
        for j in 0..i {
            if rng.chance(18) {
                members.push(random_member(&mut rng, version, &users[i], &users[j]));
            }
        }
    }
    for user in &users {
        for group in ["pg_read_all_data", "pg_write_all_data"] {
            if rng.chance(12) {
                members.push(random_member(&mut rng, version, user, group));
            }
        }
    }
    members.sort_by(|a, b| (&a.member, &a.group).cmp(&(&b.member, &b.group)));

    let mut grantees: Vec<Option<String>> = users.iter().cloned().map(Some).collect();
    grantees.extend(["pg_read_all_data", "pg_write_all_data", "pg_database_owner"].map(|n| Some(n.to_string())));
    grantees.push(None);
    let owners: Vec<String> = users.iter().cloned().chain(["pg_database_owner".to_string()]).collect();

    let db_owner = rng.pick(&users).clone();
    let mut database = database("d", &db_owner);
    database.acl = random_acl(&mut rng, &grantees, &[Connect, Create, Temporary], &db_owner);
    let schemas: Vec<SchemaRec> = (0..4)
        .map(|i| {
            let owner = rng.pick(&owners).clone();
            SchemaRec { acl: random_acl(&mut rng, &grantees, &[Usage, Create], &owner), ..schema(&format!("s{i}"), &owner) }
        })
        .collect();
    let kinds = [Table, Table, Table, View, MatView, Partitioned, Foreign, Sequence];
    let relations: Vec<RelationRec> = (0..40)
        .map(|i| {
            let kind = *rng.pick(&kinds);
            let owner = rng.pick(&users).clone();
            let privileges: &[Privilege] = if kind == Sequence { &[Usage, Select, Update] } else { &RANDOM_RELATION_PRIVILEGES };
            let schema_name = format!("s{}", rng.below(4));
            RelationRec { acl: random_acl(&mut rng, &grantees, privileges, &owner), ..relation(kind, &schema_name, &format!("t{i:02}"), &owner) }
        })
        .collect();
    Scene { cluster: cluster(version, roles, members, vec![database]), db: db("d", &db_owner, schemas, relations, vec![]) }
}

/// 관계에 권한이 거의 없는 스냅숏: s0과 s2의 관계에서 ACL을 모두 지운다. 거기서는 CREATE만 보이는 칸이 흔해진다
fn thinned(mut scene: Scene) -> Scene {
    for rel in scene.db.relations.iter_mut().filter(|r| r.schema == "s0" || r.schema == "s2") {
        rel.acl.clear();
    }
    scene
}

const READ_KINDS: [RelKind; 5] = [Table, View, MatView, Partitioned, Foreign];
const WRITE_KINDS: [RelKind; 3] = [Table, Partitioned, Foreign];

/// 칸의 정의를 `sources`와 `unusable`만으로 그대로 옮긴 계산. 느리지만 읽는 대로다
fn defined_cell(ctx: &Ctx, role: &str, schema: &SchemaRec) -> SchemaCell {
    let mut own = false;
    let mut note = |sources: &[Source]| own |= sources.iter().any(|s| matches!(s.kind, Owner | Direct | Superuser));
    let has = |obj: Obj, p: Privilege, note: &mut dyn FnMut(&[Source])| {
        let sources = ctx.sources(role, obj, p);
        note(&sources);
        !sources.is_empty()
    };
    let usage = has(Obj::Schema(schema), Usage, &mut note);
    let create = has(Obj::Schema(schema), Create, &mut note);
    let (mut read_have, mut read_total, mut write_have, mut write_total) = (0, 0, 0, 0);
    for rel in ctx.db.relations.iter().filter(|r| r.schema == schema.name) {
        if READ_KINDS.contains(&rel.kind) {
            read_total += 1;
            read_have += usize::from(has(Obj::Relation(rel), Select, &mut note));
        }
        if WRITE_KINDS.contains(&rel.kind) {
            write_total += 1;
            let mut any = false;
            for p in [Insert, Update, Delete] {
                any |= has(Obj::Relation(rel), p, &mut note);
            }
            write_have += usize::from(any);
        }
    }
    let coverage = |have: usize, total: usize| match (have, total) {
        (0, _) => Coverage::None,
        (h, t) if h == t => Coverage::All,
        _ => Coverage::Some,
    };
    let (read, write) = (coverage(read_have, read_total), coverage(write_have, write_total));
    let shown = usage || create || read != Coverage::None || write != Coverage::None;
    // 보이는 것이 CREATE뿐인 칸은 USAGE 없이도 쓸 수 있어서 USAGE가 없다는 이유를 달지 않는다
    let create_only = create && !usage && read == Coverage::None && write == Coverage::None;
    let unusable = match ctx.unusable(role, &schema.name) {
        Some("USAGE 없음") if create_only => None,
        other => other,
    };
    SchemaCell {
        role: role.to_string(),
        schema: schema.name.clone(),
        usage,
        create,
        read,
        write,
        inherited_only: shown && !own,
        unusable: if shown { unusable } else { None },
    }
}

#[test]
fn the_cells_equal_their_definition_on_generated_snapshots() {
    let mut seen = std::collections::BTreeMap::<&str, usize>::new();
    for (seed, thin) in (1..=100u64).flat_map(|seed| [(seed, false), (seed, true)]) {
        let scene = random_scene(seed);
        let scene = if thin { thinned(scene) } else { scene };
        let ctx = scene.ctx();
        let mut roles: Vec<&str> = scene.cluster.roles.iter().map(|r| r.name.as_str()).collect();
        roles.push("stranger");
        let cells = schema_cells(&ctx, &roles);
        assert_eq!(cells.len(), roles.len() * scene.db.schemas.len(), "seed {seed}, thin {thin}");
        let mut at = cells.iter();
        for role in &roles {
            for schema in &scene.db.schemas {
                let got = at.next().expect("cell");
                let want = defined_cell(&ctx, role, schema);
                assert_eq!(got, &want, "seed {seed}, thin {thin}, version {}, {role}/{}", scene.cluster.version_num, schema.name);
                for (name, hit) in [
                    ("usage", got.usage),
                    ("create", got.create),
                    ("read_all", got.read == Coverage::All),
                    ("read_some", got.read == Coverage::Some),
                    ("write_all", got.write == Coverage::All),
                    ("write_some", got.write == Coverage::Some),
                    ("inherited_only", got.inherited_only),
                    ("own_source", !got.inherited_only && (got.usage || got.read != Coverage::None)),
                    ("no_connect", got.unusable == Some("CONNECT 없음")),
                    ("no_usage", got.unusable == Some("USAGE 없음")),
                    ("create_only", got.create && !got.usage && got.read == Coverage::None && got.write == Coverage::None),
                ] {
                    *seen.entry(name).or_default() += usize::from(hit);
                }
            }
        }
    }
    // 생성한 스냅숏이 모든 경우를 실제로 만나는지 확인한다: 안 그러면 위 비교가 아무것도 시험하지 못한다
    for (name, count) in &seen {
        assert!(*count >= 100, "생성한 스냅숏에서 `{name}`이(가) {count}번뿐이에요: 비교가 이 경우를 시험하지 못해요 ({seen:?})");
    }
}

#[test]
fn who_can_equals_the_roles_that_have_a_source_on_generated_snapshots() {
    let (mut nonempty, mut reasons) = (0, std::collections::BTreeMap::<&str, usize>::new());
    for seed in 1..=150u64 {
        let scene = random_scene(seed);
        let ctx = scene.ctx();
        let mut names: Vec<&str> = scene.cluster.roles.iter().map(|r| r.name.as_str()).collect();
        names.sort_unstable();
        for rel in scene.db.relations.iter().take(8) {
            for p in [Select, Insert, Update, Delete, Usage] {
                let rows = who_can(&ctx, Obj::Relation(rel), p);
                let expected: Vec<(&str, Vec<Source>)> =
                    names.iter().map(|&n| (n, ctx.sources(n, Obj::Relation(rel), p))).filter(|(_, s)| !s.is_empty()).collect();
                let got: Vec<(&str, Vec<Source>)> = rows.iter().map(|r| (r.role.as_str(), r.sources.clone())).collect();
                assert_eq!(got, expected, "seed {seed} {}.{} {p:?}", rel.schema, rel.name);
                nonempty += usize::from(!rows.is_empty());
                // 관계의 행은 그 스키마의 USAGE와 데이터베이스의 CONNECT를 이유로 든다
                for row in rows {
                    assert_eq!(row.unusable, ctx.unusable(&row.role, &rel.schema), "seed {seed} {}.{} {p:?} {}", rel.schema, rel.name, row.role);
                }
            }
        }
        // 스키마의 행도 같다. 다만 CREATE는 USAGE 없이도 되니 "USAGE 없음"을 이유로 들지 않는다
        for schema in &scene.db.schemas {
            for p in [Usage, Create] {
                for row in who_can(&ctx, Obj::Schema(schema), p) {
                    let raw = ctx.unusable(&row.role, &schema.name);
                    let want = if p == Create && raw == Some("USAGE 없음") { None } else { raw };
                    assert_eq!(row.unusable, want, "seed {seed} {}.{p:?} {}", schema.name, row.role);
                    *reasons.entry(if p == Create && raw == Some("USAGE 없음") { "create_without_usage" } else { "other" }).or_default() += 1;
                }
            }
        }
    }
    assert!(nonempty > 100, "{nonempty}");
    assert!(reasons.get("create_without_usage").copied().unwrap_or(0) >= 20, "{reasons:?}");
}

/// 서버 규칙으로 `from → to` 한 걸음이 상속인지(시험이 규칙을 따로 다시 적은 것)
fn inherits_edge(scene: &Scene, from: &str, to: &str) -> bool {
    let version = scene.cluster.version_num;
    let attribute = scene.cluster.roles.iter().find(|r| r.name == from).is_none_or(|r| r.inherit);
    match scene.cluster.members.iter().find(|m| m.member == from && m.group == to) {
        Some(m) if version >= 160_000 => m.inherit.unwrap_or(attribute),
        Some(_) => attribute,
        // 데이터베이스 소유자는 PG14부터 pg_database_owner의 구성원이다. PG15 이하는 소유자의 INHERIT 속성을 따른다
        None => to == "pg_database_owner" && version >= 140_000 && from == scene.db.owner && (version >= 160_000 || attribute),
    }
}

#[test]
fn inherited_is_the_closure_of_the_inheriting_memberships_on_generated_snapshots() {
    let (mut followed, mut blocked, mut longest) = (0, 0, 0);
    for seed in 1..=300u64 {
        let scene = random_scene(seed);
        let ctx = scene.ctx();
        let all: Vec<&str> = scene.cluster.roles.iter().map(|r| r.name.as_str()).collect();
        for member in &scene.cluster.members {
            if inherits_edge(&scene, &member.member, &member.group) {
                followed += 1;
            } else {
                blocked += 1;
            }
        }
        for &role in &all {
            // 닿는 역할을 늘려 가며 더 늘지 않을 때까지 모은다
            let mut reached: HashSet<&str> = HashSet::from([role]);
            loop {
                let more: Vec<&str> =
                    all.iter().copied().filter(|to| !reached.contains(to) && reached.iter().any(|from| inherits_edge(&scene, from, to))).collect();
                if more.is_empty() {
                    break;
                }
                reached.extend(more);
            }

            let inherited = ctx.inherited(role);
            let names: HashSet<&str> = inherited.iter().map(|i| i.role.as_str()).collect();
            assert_eq!(inherited[0], inh(role, &[]), "seed {seed}: 자기 자신이 먼저예요");
            assert_eq!(names.len(), inherited.len(), "seed {seed}: 중복");
            assert_eq!(names, reached, "seed {seed}, 버전 {}, {role}", scene.cluster.version_num);
            longest = longest.max(inherited.len());
            // 경로: 끝은 그 역할이고, 걸음마다 상속 규칙을 통과한다
            for item in &inherited[1..] {
                assert_eq!(item.path.last(), Some(&item.role), "seed {seed}");
                let mut from = role;
                for to in &item.path {
                    assert!(inherits_edge(&scene, from, to), "seed {seed}: {role}의 경로 {:?}에서 {from} → {to}는 상속이 아니에요", item.path);
                    from = to;
                }
            }
            // SET ROLE로만 닿는 역할은 상속하는 역할과 겹치지 않고 자기 자신도 아니다
            let only = ctx.set_role_only(role);
            assert!(only.iter().all(|r| !names.contains(r.as_str()) && r != role), "seed {seed}: {role} {only:?}");
        }
    }
    // 생성한 스냅숏에 상속하는 관계도 막힌 관계도 긴 사슬도 있어야 위 비교가 의미가 있다
    assert!(followed > 200 && blocked > 200 && longest >= 5, "상속한 관계 {followed}, 막힌 관계 {blocked}, 가장 큰 상속 집합 {longest}");
}

#[test]
fn the_handle_answers_like_the_ctx_methods_on_generated_snapshots() {
    // 비교하는 질문: 일부러 이 객체에 없는 권한도 묻는다(MAINTAIN은 PG17부터, 스키마에 SELECT는 없다)
    let privileges = [Select, Insert, Update, Delete, Usage, Create, Connect, Maintain];
    let (mut per_version, mut compared) = (std::collections::BTreeMap::<i32, usize>::new(), 0);
    for seed in 1..=200u64 {
        let scene = random_scene(seed);
        // 서버 버전마다 장면 세 개씩만 본다
        let seen = per_version.entry(scene.cluster.version_num).or_default();
        if *seen >= 3 {
            continue;
        }
        *seen += 1;

        let ctx = scene.ctx();
        let eval = Eval::new(&ctx);
        let mut roles: Vec<&str> = scene.cluster.roles.iter().map(|r| r.name.as_str()).collect();
        roles.push("stranger");
        let objects: Vec<Obj> = scene
            .db
            .relations
            .iter()
            .take(6)
            .map(Obj::Relation)
            .chain(scene.db.schemas.iter().map(Obj::Schema))
            .chain([Obj::Database(scene.database())])
            .collect();

        // 모든 역할의 뷰를 먼저 만들어 두고 섞어서 묻는다: 뷰마다 자기 역할의 계산만 써야 한다
        let views: Vec<_> = roles.iter().map(|&role| eval.role(role)).collect();
        // 역할 하나의 답: 객체마다, 권한마다 출처들
        type PerRole = Vec<Vec<Vec<Source>>>;
        let mut first_pass: Vec<PerRole> = Vec::new();
        for (&role, view) in roles.iter().zip(&views) {
            assert_eq!(view.inherited(), ctx.inherited(role), "seed {seed}, {role}");
            assert_eq!(view.set_role_only(), ctx.set_role_only(role), "seed {seed}, {role}");
            for name in scene.db.schemas.iter().map(|s| s.name.as_str()).chain(["no_such_schema"]) {
                assert_eq!(view.unusable(name), ctx.unusable(role, name), "seed {seed}, {role}, {name}");
            }
            let mut answers = Vec::new();
            for &obj in &objects {
                let per_object: Vec<Vec<Source>> = privileges.iter().map(|&p| view.sources(obj, p)).collect();
                for (&p, got) in privileges.iter().zip(&per_object) {
                    assert_eq!(got, &ctx.sources(role, obj, p), "seed {seed}, {role}, {obj:?}, {p:?}");
                    compared += 1;
                }
                answers.push(per_object);
            }
            first_pass.push(answers);
        }
        // 거꾸로 다시 묻는다: 같은 뷰를 다시 불러도 같은 답이어야 한다(처음 계산한 것을 간직하든 다시 계산하든)
        for (index, (&role, view)) in roles.iter().zip(&views).enumerate().rev() {
            assert_eq!(view.set_role_only(), ctx.set_role_only(role), "seed {seed}, {role}: 두 번째");
            for (&obj, before) in objects.iter().zip(&first_pass[index]) {
                let again: Vec<Vec<Source>> = privileges.iter().map(|&p| view.sources(obj, p)).collect();
                assert_eq!(&again, before, "seed {seed}, {role}, {obj:?}: 두 번째");
            }
        }
    }
    assert_eq!(per_version.len(), 4, "{per_version:?}");
    assert!(compared > 3_000, "{compared}");
}

// ───────────────────────── 속도 ─────────────────────────

/// 역할 200개 × 관계 2만 개(스키마 100개, 관계마다 ACL 항목 열 개 안팎)
fn big_scene() -> (Scene, Vec<String>) {
    let tops: Vec<String> = (0..10).map(|i| format!("top{i}")).collect();
    let mids: Vec<String> = (0..20).map(|i| format!("mid{i}")).collect();
    let owners: Vec<String> = (0..5).map(|i| format!("owner{i}")).collect();
    let users: Vec<String> = (0..200).map(|i| format!("user{i:03}")).collect();
    let roles: Vec<RoleRec> = owners.iter().chain(&tops).chain(&mids).chain(&users).map(|n| role(n)).collect();
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
    let schemas: Vec<SchemaRec> = (0..100)
        .map(|i| schema(&format!("s{i:03}"), &owners[i % 5]).grant(&tops[i % 10], &[Usage]).grant(&mids[i % 20], &[Usage]))
        .collect();
    let mut relations = Vec::with_capacity(20_000);
    for (i, schema) in schemas.iter().enumerate() {
        for n in 0..200 {
            let kind = match n % 25 {
                0 => MatView,
                1..=4 => View,
                _ => Table,
            };
            let mut rel = relation(kind, &schema.name, &format!("t{n:04}"), &owners[i % 5]).grant(&tops[i % 10], &[Select]).grant(&mids[i % 20], &[Insert, Update, Delete]);
            if n % 20 == 0 {
                rel = rel.grant_public(&[Select]);
            }
            relations.push(rel);
        }
    }
    let scene = Scene { cluster: cluster(PG16, roles, members, vec![database("appdb", &owners[0])]), db: db("appdb", &owners[0], schemas, relations, vec![]) };
    (scene, users)
}

#[test]
#[ignore = "큰 스냅숏(역할 200 × 관계 2만 개)으로 속도를 재요: cargo test --release pg::eval -- --ignored"]
fn schema_cells_for_200_roles_and_20000_relations_stay_within_two_seconds() {
    let (scene, users) = big_scene();
    assert_eq!((users.len(), scene.db.relations.len()), (200, 20_000));
    let roles: Vec<&str> = users.iter().map(String::as_str).collect();

    let started = Instant::now();
    let cells = schema_cells(&scene.ctx(), &roles);
    let elapsed = started.elapsed();
    eprintln!("schema_cells: 역할 {} × 스키마 {} = 칸 {}개, {elapsed:?}", roles.len(), scene.db.schemas.len(), cells.len());

    assert_eq!(cells.len(), 200 * 100);
    // 계산이 비어 있지 않은지 몇 칸을 본다: user000은 mid0과 mid3을 거쳐 top0·top3을 상속한다(여기에 top0도 직접)
    let find = |role: &str, schema: &str| cells.iter().find(|c| c.role == role && c.schema == schema).expect("cell").clone();
    let sample = find("user000", "s000");
    assert!(sample.usage && sample.read != Coverage::None && sample.write != Coverage::None, "{sample:?}");
    // 디버그 빌드는 최적화가 없어 수십 배 느리다: 예산은 릴리스에서만 2초다
    let budget = if cfg!(debug_assertions) { Duration::from_secs(120) } else { Duration::from_secs(2) };
    assert!(elapsed < budget, "{elapsed:?}이(가) 예산 {budget:?}을(를) 넘었어요");
}

#[test]
#[ignore = "큰 스냅숏(역할 200 × 관계 2만 개)에서 `sources`를 400만 번 부르는 속도를 재요: cargo test --release pg::eval -- --ignored"]
fn sources_for_200_roles_and_20000_relations_through_one_handle_stay_within_two_seconds() {
    let (scene, users) = big_scene();
    let ctx = scene.ctx();
    assert_eq!((users.len(), scene.db.relations.len()), (200, 20_000));

    // 핸들 하나, 역할마다 뷰 하나. 모든 (역할, 관계) 쌍에 SELECT의 출처를 묻는다
    let started = Instant::now();
    let eval = Eval::new(&ctx);
    let (mut asked, mut with_sources) = (0usize, 0usize);
    for user in &users {
        let view = eval.role(user);
        for rel in &scene.db.relations {
            asked += 1;
            with_sources += usize::from(!view.sources(Obj::Relation(rel), Select).is_empty());
        }
    }
    let elapsed = started.elapsed();
    eprintln!("sources: 핸들 하나로 {asked}번 물었고 {with_sources}번이 출처가 있었어요, {elapsed:?}");

    assert_eq!(asked, 4_000_000);
    assert!(0 < with_sources && with_sources < asked, "{with_sources}");
    // 시간을 잰 뒤에 일부 쌍을 `Ctx`의 답과 맞대 본다(`Ctx`는 부를 때마다 새로 계산한다)
    for pair in (0..asked).step_by(39_989) {
        let (user, rel) = (&users[pair / 20_000], &scene.db.relations[pair % 20_000]);
        let obj = Obj::Relation(rel);
        assert_eq!(eval.role(user).sources(obj, Select), ctx.sources(user, obj, Select), "{user} {}.{}", rel.schema, rel.name);
    }
    // 디버그 빌드는 최적화가 없어 수십 배 느리다: 예산은 릴리스에서만 2초다
    let budget = if cfg!(debug_assertions) { Duration::from_secs(120) } else { Duration::from_secs(2) };
    assert!(elapsed < budget, "{elapsed:?}이(가) 예산 {budget:?}을(를) 넘었어요");
}
