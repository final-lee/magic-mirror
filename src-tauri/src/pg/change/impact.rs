//! 변경이 누구의 권한을 어떻게 바꾸나(순수 함수): 영향을 받는 역할마다 변경 전과 후의 실효 권한(출처는 가리지 않는다)을 `Eval` 하나씩으로 견주고,
//! 달라진 것을 (데이터베이스, 스키마, 객체 종류, 권한)으로 묶는다.
//!
//! 모든 객체를 견주지 않는다. 후보는 연산이 정하는 객체뿐이다:
//! - 권한 연산: 연산의 `effects`에 든 (객체, 권한)
//! - 구성원 관계·INHERIT·역할 만들기·삭제 연산: 바뀐 역할의 위쪽 닫힘(상속하는 관계를 따라 오르는 역할들, 변경 전과 후 합집합)을
//!   받는 쪽으로 적은 ACL 항목이 있거나 그 역할이 가진 객체의 권한
//! - 그 닫힘에 미리 정의된 역할(`pg_read_all_data` 등)이나 `pg_database_owner`가 들면 ACL에 없는 권한이 따라오니 모든 객체의 모든 권한

use std::collections::{BTreeMap, BTreeSet, HashMap};

use super::resolve::{ObjKey, Op};
use super::sql_text::AttrClause;
use crate::pg::eval::{offers, Ctx, Eval, Obj};
use crate::pg::model::{Privilege, RelKind};
use crate::pg::model::{DefaultAclRec, RoleRec};
use crate::pg::summary::default_rows;
use crate::pg::view::{PgAttributeDelta, PgDefaultDelta, PgImpact, PgObjectKind, PgPrivDelta, PgRoleDelta};

/// 목록에 올리는 역할의 상한
pub const MAX_ROLES: usize = 30;
/// 묶음마다 보이는 이름의 상한
const MAX_SAMPLE: usize = 5;
const DATABASE_OWNER: &str = "pg_database_owner";
/// 이 역할들을 위쪽 닫힘에 가진 역할은 ACL에 없는 권한도 얻고 잃는다
const WIDE_ROLES: [&str; 4] = ["pg_read_all_data", "pg_write_all_data", "pg_maintain", DATABASE_OWNER];
const ALL_PRIVILEGES: [Privilege; 13] = [
    Privilege::Select,
    Privilege::Insert,
    Privilege::Update,
    Privilege::Delete,
    Privilege::Truncate,
    Privilege::References,
    Privilege::Trigger,
    Privilege::Maintain,
    Privilege::Execute,
    Privilege::Usage,
    Privilege::Create,
    Privilege::Connect,
    Privilege::Temporary,
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Impacts {
    /// 역할 이름순, 최대 `MAX_ROLES`개. 권한이 달라진 역할만 있다
    pub impacts: Vec<PgImpact>,
    /// 목록에 못 올린 역할의 수
    pub omitted: usize,
}

/// 상속하는 구성원 관계(구성원 → 그룹)의 양방향 색인
struct Edges {
    up: HashMap<String, Vec<String>>,
    down: HashMap<String, Vec<String>>,
}

impl Edges {
    fn of(ctx: &Ctx) -> Edges {
        let eval = Eval::new(ctx);
        let mut pairs: Vec<(&str, &str)> = ctx.cluster.members.iter().filter(|m| eval.membership_inherits(&m.member, &m.group)).map(|m| (m.member.as_str(), m.group.as_str())).collect();
        if eval.membership_inherits(&ctx.db.owner, DATABASE_OWNER) {
            pairs.push((&ctx.db.owner, DATABASE_OWNER));
        }
        let (mut up, mut down): (HashMap<String, Vec<String>>, HashMap<String, Vec<String>>) = (HashMap::new(), HashMap::new());
        for (member, group) in pairs {
            up.entry(member.to_string()).or_default().push(group.to_string());
            down.entry(group.to_string()).or_default().push(member.to_string());
        }
        Edges { up, down }
    }
}

/// `seeds`와, `map`을 따라 닿는 모든 역할
fn walk(map: &HashMap<String, Vec<String>>, seeds: &BTreeSet<String>) -> BTreeSet<String> {
    let mut seen: BTreeSet<String> = seeds.clone();
    let mut stack: Vec<&String> = seeds.iter().collect();
    while let Some(role) = stack.pop() {
        for next in map.get(role).into_iter().flatten() {
            if seen.insert(next.clone()) {
                stack.push(next);
            }
        }
    }
    seen
}

fn objects<'a>(ctx: &Ctx<'a>) -> HashMap<ObjKey, Obj<'a>> {
    let mut map = HashMap::new();
    for d in &ctx.cluster.databases {
        map.insert(ObjKey::Database(d.name.clone()), Obj::Database(d));
    }
    for s in &ctx.db.schemas {
        map.insert(ObjKey::Schema(s.name.clone()), Obj::Schema(s));
    }
    for r in &ctx.db.relations {
        map.insert(ObjKey::Relation(r.schema.clone(), r.name.clone()), Obj::Relation(r));
    }
    for f in &ctx.db.functions {
        map.insert(ObjKey::Function(f.schema.clone(), f.name.clone(), f.signature.clone()), Obj::Function(f));
    }
    map
}

/// 어느 역할이 영향을 받나와 어느 객체를 견주나
struct Scope {
    /// 연산이 직접 바꾸는 역할(받는 쪽, 구성원, 만들거나 지우는 역할). 이 역할을 상속하는 역할도 영향을 받는다
    base: BTreeSet<String>,
    /// 모든 역할(PUBLIC)이 영향을 받는다
    everyone: bool,
    /// 위쪽 닫힘을 구할 역할: 구성원 관계는 그룹, INHERIT·만들기·삭제는 그 역할
    seeds: BTreeSet<String>,
    /// 연산이 직접 정한 (객체, 권한)
    explicit: BTreeMap<ObjKey, BTreeSet<Privilege>>,
}

fn scope(before: &Ctx, ops: &[Op]) -> Scope {
    let mut scope = Scope { base: BTreeSet::new(), everyone: false, seeds: BTreeSet::new(), explicit: BTreeMap::new() };
    for op in ops {
        match op {
            Op::Privileges { grantee, effects, .. } => {
                if grantee == "PUBLIC" {
                    scope.everyone = true;
                } else {
                    scope.base.insert(grantee.clone());
                }
                for effect in effects {
                    scope.explicit.entry(effect.object.clone()).or_default().insert(effect.privilege);
                }
            }
            Op::GrantRole { group, member, .. } | Op::RevokeRole { group, member, .. } => {
                scope.base.insert(member.clone());
                scope.seeds.insert(group.clone());
            }
            Op::AlterRole { role, clauses } if clauses.iter().any(|c| matches!(c, AttrClause::Inherit(_))) => {
                scope.base.insert(role.clone());
                scope.seeds.insert(role.clone());
            }
            Op::CreateRole { name, .. } => {
                scope.base.insert(name.clone());
                scope.seeds.insert(name.clone());
                // CREATEROLE 사용자가 만든 역할을 자신에게 INHERIT로 부여하면 로그인한 역할도 새 역할의 권한을 쓴다
                if before.cluster.createrole_self_grant.split(',').any(|o| o.trim().eq_ignore_ascii_case("inherit")) {
                    scope.base.insert(before.cluster.login_user.clone());
                }
            }
            Op::DropRole { role } => {
                scope.base.insert(role.clone());
                scope.seeds.insert(role.clone());
            }
            _ => {}
        }
    }
    scope
}

/// 견주는 객체 하나
struct Candidate<'a, 'b> {
    before: Obj<'a>,
    after: Obj<'b>,
    privileges: Vec<Privilege>,
    /// `Groups::table`의 자리
    group: usize,
    name: String,
}

/// (데이터베이스, 스키마, 객체 종류)의 표
#[derive(Default)]
struct Groups {
    table: Vec<(String, Option<String>, PgObjectKind)>,
    index: HashMap<(String, Option<String>, PgObjectKind), usize>,
}

impl Groups {
    fn id(&mut self, database: &str, schema: Option<&str>, kind: PgObjectKind) -> usize {
        let key = (database.to_string(), schema.map(str::to_string), kind);
        if let Some(&id) = self.index.get(&key) {
            return id;
        }
        self.table.push(key.clone());
        self.index.insert(key, self.table.len() - 1);
        self.table.len() - 1
    }
}

/// 묶음(자리, 권한)마다 모은 객체 이름
type Found<'a> = BTreeMap<(usize, Privilege), Vec<&'a str>>;

/// 객체의 묶음 자리와 이름
fn place(groups: &mut Groups, key: &ObjKey, obj: Obj, database: &str) -> (usize, String) {
    match (key, obj) {
        (ObjKey::Database(name), _) => (groups.id(name, None, PgObjectKind::Database), name.clone()),
        (ObjKey::Schema(name), _) => (groups.id(database, None, PgObjectKind::Schema), name.clone()),
        (ObjKey::Relation(schema, name), Obj::Relation(rel)) => (groups.id(database, Some(schema), PgObjectKind::of(rel.kind)), name.clone()),
        (ObjKey::Relation(schema, name), _) => (groups.id(database, Some(schema), PgObjectKind::of(RelKind::Table)), name.clone()),
        (ObjKey::Function(schema, name, signature), _) => (groups.id(database, Some(schema), PgObjectKind::Function), format!("{name}({signature})")),
    }
}

pub fn impacts(before: &Ctx, after: &Ctx, ops: &[Op]) -> Impacts {
    let scope = scope(before, ops);
    if scope.base.is_empty() && !scope.everyone {
        return Impacts { impacts: Vec::new(), omitted: 0 };
    }
    let (edges_before, edges_after) = (Edges::of(before), Edges::of(after));

    // 영향을 받는 역할: 직접 바뀌는 역할과, 변경 전이나 후에 그 역할을 상속하는 모든 역할
    let affected: BTreeSet<String> = if scope.everyone {
        before.cluster.roles.iter().chain(&after.cluster.roles).map(|r| r.name.clone()).collect()
    } else {
        let mut affected = walk(&edges_before.down, &scope.base);
        affected.extend(walk(&edges_after.down, &scope.base));
        affected
    };

    // 후보: 연산이 정한 (객체, 권한)과, 닫힘의 역할이 ACL에 이름이 있거나 가진 객체
    let closure: BTreeSet<String> = {
        let mut closure = walk(&edges_before.up, &scope.seeds);
        closure.extend(walk(&edges_after.up, &scope.seeds));
        closure
    };
    let wide = closure.iter().any(|r| WIDE_ROLES.contains(&r.as_str()));
    let (objects_before, objects_after) = (objects(before), objects(after));
    let mut wanted: BTreeMap<&ObjKey, BTreeSet<Privilege>> = scope.explicit.iter().map(|(k, v)| (k, v.clone())).collect();
    if !closure.is_empty() {
        for (key, obj) in objects_before.iter().chain(&objects_after) {
            let entry = wanted.entry(key).or_default();
            if wide || closure.contains(obj.owner()) {
                entry.extend(ALL_PRIVILEGES);
                continue;
            }
            for acl in obj.acl().iter().filter(|e| e.grantee.as_deref().is_some_and(|g| closure.contains(g))) {
                entry.insert(acl.privilege);
            }
        }
    }

    let version = after.cluster.version_num;
    let mut groups = Groups::default();
    let mut candidates: Vec<Candidate> = Vec::new();
    for (key, privileges) in wanted {
        let (Some(&b), Some(&a)) = (objects_before.get(key), objects_after.get(key)) else { continue };
        let privileges: Vec<Privilege> = privileges.into_iter().filter(|&p| offers(a.priv_kind(), p, version)).collect();
        if privileges.is_empty() {
            continue;
        }
        let (group, name) = place(&mut groups, key, a, &after.db.database);
        candidates.push(Candidate { before: b, after: a, privileges, group, name });
    }

    let (eval_before, eval_after) = (Eval::new(before), Eval::new(after));
    let mut impacts = Vec::new();
    let mut listed = 0;
    for role in &affected {
        let (view_before, view_after) = (eval_before.role(role), eval_after.role(role));
        let (mut gained, mut lost): (Found, Found) = (BTreeMap::new(), BTreeMap::new());
        for candidate in &candidates {
            for &p in &candidate.privileges {
                let had = !view_before.sources(candidate.before, p).is_empty();
                let has = !view_after.sources(candidate.after, p).is_empty();
                if has && !had {
                    gained.entry((candidate.group, p)).or_default().push(&candidate.name);
                } else if had && !has {
                    lost.entry((candidate.group, p)).or_default().push(&candidate.name);
                }
            }
        }
        if gained.is_empty() && lost.is_empty() {
            continue;
        }
        listed += 1;
        if listed <= MAX_ROLES {
            impacts.push(PgImpact { role: role.clone(), gained: deltas(&groups, gained), lost: deltas(&groups, lost) });
        }
    }
    Impacts { impacts, omitted: listed.saturating_sub(MAX_ROLES) }
}

/// 묶음을 (데이터베이스, 스키마, 객체 종류, 권한) 순서로 정렬해 낸다
fn deltas(groups: &Groups, found: Found) -> Vec<PgPrivDelta> {
    let mut deltas: Vec<PgPrivDelta> = found
        .into_iter()
        .map(|((group, privilege), mut names)| {
            let (database, schema, object_kind) = &groups.table[group];
            names.sort_unstable();
            PgPrivDelta {
                database: database.clone(),
                schema: schema.clone(),
                object_kind: *object_kind,
                privilege: privilege.as_str().to_string(),
                count: names.len(),
                sample: names.into_iter().take(MAX_SAMPLE).map(str::to_string).collect(),
            }
        })
        .collect();
    let order = |d: &PgPrivDelta| (d.database.clone(), d.schema.clone(), d.object_kind, Privilege::from_pg(&d.privilege));
    deltas.sort_by_key(order);
    deltas
}

// ───────────────────────── 역할과 기본 권한의 변화 ─────────────────────────

fn yes_no(on: bool) -> String {
    if on { "예" } else { "아니요" }.to_string()
}

/// 속성마다 (이름, 전, 후). 화면에 나가는 이름과 값이다
fn attribute_values(role: &RoleRec) -> [(&'static str, String); 6] {
    [
        ("LOGIN", yes_no(role.login)),
        ("CREATEDB", yes_no(role.create_db)),
        ("CREATEROLE", yes_no(role.create_role)),
        ("INHERIT", yes_no(role.inherit)),
        ("연결 수 제한", if role.conn_limit < 0 { "제한 없음".to_string() } else { role.conn_limit.to_string() }),
        ("만료일", role.valid_until.clone().unwrap_or_else(|| "없음".to_string())),
    ]
}

/// 역할이 직접 속한 그룹들(이름순)
fn groups_of(ctx: &Ctx, role: &str) -> BTreeSet<String> {
    ctx.cluster.members.iter().filter(|m| m.member == role).map(|m| m.group.clone()).collect()
}

/// 만들어지거나 지워지거나 속성이 바뀌거나 그룹이 달라진 역할들, 이름순
pub fn role_deltas(before: &Ctx, after: &Ctx) -> Vec<PgRoleDelta> {
    let find = |ctx: &Ctx, name: &str| ctx.cluster.roles.iter().find(|r| r.name == name).cloned();
    let names: BTreeSet<&str> = before.cluster.roles.iter().chain(&after.cluster.roles).map(|r| r.name.as_str()).collect();
    let mut deltas = Vec::new();
    for name in names {
        let (was, is) = (find(before, name), find(after, name));
        let (groups_before, groups_after) = (groups_of(before, name), groups_of(after, name));
        let attributes: Vec<PgAttributeDelta> = match (&was, &is) {
            (Some(was), Some(is)) => attribute_values(was)
                .into_iter()
                .zip(attribute_values(is))
                .filter(|((_, a), (_, b))| a != b)
                .map(|((name, before), (_, after))| PgAttributeDelta { name: name.to_string(), before, after })
                .collect(),
            _ => Vec::new(),
        };
        let delta = PgRoleDelta {
            role: name.to_string(),
            created: was.is_none() && is.is_some(),
            dropped: was.is_some() && is.is_none(),
            attributes,
            groups_added: groups_after.difference(&groups_before).cloned().collect(),
            groups_removed: groups_before.difference(&groups_after).cloned().collect(),
        };
        if delta.created || delta.dropped || !delta.attributes.is_empty() || !delta.groups_added.is_empty() || !delta.groups_removed.is_empty() {
            deltas.push(delta);
        }
    }
    deltas
}

/// 연산이 건드린 기본 권한 기록들의 전과 후(처음 건드린 순서). 달라지지 않은 기록은 뺀다
pub fn default_deltas(before: &Ctx, after: &Ctx, ops: &[Op]) -> Vec<PgDefaultDelta> {
    let mut seen = BTreeSet::new();
    let mut deltas = Vec::new();
    let record = |ctx: &Ctx, creator: &str, schema: Option<&str>, object_type| -> Option<DefaultAclRec> {
        ctx.db.default_acls.iter().find(|d| d.creator == creator && d.schema.as_deref() == schema && d.obj_type == object_type).cloned()
    };
    let row = |rec: Option<DefaultAclRec>| rec.and_then(|rec| default_rows(std::slice::from_ref(&rec)).pop());
    for op in ops {
        let Op::DefaultAcl { creator, schema, object_type, .. } = op else { continue };
        if !seen.insert((creator.clone(), schema.clone(), format!("{object_type:?}"))) {
            continue;
        }
        let (was, is) = (record(before, creator, schema.as_deref(), *object_type), record(after, creator, schema.as_deref(), *object_type));
        if was != is {
            deltas.push(PgDefaultDelta { before: row(was), after: row(is) });
        }
    }
    deltas
}

#[cfg(test)]
mod tests;
