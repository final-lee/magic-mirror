//! 실효 권한 계산(순수 함수): 역할이 객체에 어떤 권한을 어디서 받는지, 받아도 실제로 쓸 수 있는지, 스키마별 요약, 누가 할 수 있나.
//! 서버가 `has_*_privilege`로 하는 판단을 스냅숏만으로 다시 짠 것이다. Docker의 PostgreSQL 14·16과 대조해 검증한다(`live_tests`).
//! 질의도 입출력도 없고 `model`의 스냅숏만 읽는다.
//!
//! 서버가 따르는 규칙:
//! - ACL은 소유자의 권한도 항목으로 담는다. 소유자가 자기 권한을 거두면 항목이 없고 그 권한도 없다.
//! - 역할은 자기 자신과, *상속하는* 구성원 관계로 닿는 모든 역할의 권한을 쓴다. 관계를 따라갈지는 PG15 이하에서는 구성원 역할의
//!   `rolinherit`가, PG16부터는 관계마다의 INHERIT 옵션이 정한다. 경로의 모든 걸음이 통과해야 한다.
//! - superuser 속성은 상속되지 않는다. 역할 자신이 superuser여야 권한 검사를 건너뛴다. superuser 역할의 구성원은 ACL이 주는 것만 갖는다.
//! - PG14부터 `pg_read_all_data`는 모든 관계의 SELECT와 모든 스키마의 USAGE를, `pg_write_all_data`는 모든 관계의 INSERT·UPDATE·DELETE와
//!   모든 스키마의 USAGE를 ACL과 상관없이 준다(권한을 쓰는 역할 가운데 있을 때).
//! - PG14부터 데이터베이스 소유자는 `pg_database_owner`의 구성원이다. PG16은 늘 상속하고, PG15 이하는 다른 구성원 관계처럼 소유자의
//!   `rolinherit`를 따른다.
//!
//! 구성: 공개된 것은 `Ctx`의 메서드(한 역할·한 객체), `schema_cells`(역할 × 스키마), `who_can`(한 객체에 권한이 있는 역할들)이다.
//! 셋 모두 안쪽의 `Evaluator` 하나를 거친다. 그것이 `Ctx`에서 역할 그래프를 한 번 만들고, 역할마다 상속하는 역할의 집합을 한 번 구해 둔다.

use std::collections::HashMap;

use serde::Serialize;

use super::model::{
    AclEntry, ClusterSnapshot, DatabaseRec, DbSnapshot, FunctionRec, Privilege, RelKind, RelationRec, RoleRec, SchemaRec, MEMBERSHIP_OPTIONS_SINCE,
};

/// `pg_read_all_data`·`pg_write_all_data`·`pg_database_owner`가 있는 첫 서버 버전
const PREDEFINED_ROLES_SINCE: i32 = 140_000;
const READ_ALL_DATA: &str = "pg_read_all_data";
const WRITE_ALL_DATA: &str = "pg_write_all_data";
const DATABASE_OWNER: &str = "pg_database_owner";

/// 권한은 있어도 쓸 수 없는 이유(화면에 그대로 나간다)
const NO_CONNECT: &str = "CONNECT 없음";
const NO_USAGE: &str = "USAGE 없음";

/// 스키마 칸의 "읽기"가 세는 관계: SELECT를 볼 수 있는 것(시퀀스는 뺀다)
const READ_KINDS: [RelKind; 5] = [RelKind::Table, RelKind::View, RelKind::MatView, RelKind::Partitioned, RelKind::Foreign];
/// 스키마 칸의 "쓰기"가 세는 관계
const WRITE_KINDS: [RelKind; 3] = [RelKind::Table, RelKind::Partitioned, RelKind::Foreign];
const READ: [Privilege; 1] = [Privilege::Select];
/// 이 가운데 하나라도 있으면 쓰는 것으로 센다
const WRITE: [Privilege; 3] = [Privilege::Insert, Privilege::Update, Privilege::Delete];

/// 권한의 출처
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceKind {
    /// 객체의 소유자(이거나 소유자 역할을 상속한다)로서 소유자의 ACL 항목에서 받았다
    Owner,
    /// 그 역할 앞으로 부여된 ACL 항목
    Direct,
    /// 상속하는 다른 역할 앞으로 부여된 ACL 항목
    Group,
    /// PUBLIC 앞으로 부여된 ACL 항목
    Public,
    /// `pg_read_all_data`·`pg_write_all_data`(ACL에 없다)
    Predefined,
    /// 역할 자신이 superuser다(ACL에 없다)
    Superuser,
}

impl SourceKind {
    /// 그룹·PUBLIC·미리 정의된 역할에서 받은 것이 아니라 이 역할이 직접 쥔 출처인가
    fn is_own(self) -> bool {
        matches!(self, SourceKind::Owner | SourceKind::Direct | SourceKind::Superuser)
    }
}

/// 권한 하나의 출처 하나
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub kind: SourceKind,
    /// 권한을 쥔 역할에서 권한을 받은 역할까지의 경로(권한을 쥔 역할은 뺀다). 직접 받았거나 PUBLIC이면 비어 있다.
    /// `Predefined`는 미리 정의된 역할까지의 경로다
    pub via: Vec<String>,
    /// 권한을 준 역할. `Predefined`와 `Superuser`는 ACL에 없어서 None
    pub grantor: Option<String>,
}

/// 상속하는 역할 하나와 거기까지의 경로
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Inherited {
    pub role: String,
    /// 시작한 역할은 빼고 이 역할로 끝나는 경로(시작한 역할 자신은 비어 있다)
    pub path: Vec<String>,
}

/// 계산에 쓰는 스냅숏 한 쌍: 클러스터 전체의 것과, 권한을 볼 데이터베이스의 것
#[derive(Debug, Clone, Copy)]
pub struct Ctx<'a> {
    pub cluster: &'a ClusterSnapshot,
    pub db: &'a DbSnapshot,
}

/// 권한을 가질 수 있는 객체
#[derive(Debug, Clone, Copy)]
pub enum Obj<'a> {
    Database(&'a DatabaseRec),
    Schema(&'a SchemaRec),
    Relation(&'a RelationRec),
    Function(&'a FunctionRec),
}

impl<'a> Obj<'a> {
    fn owner(self) -> &'a str {
        match self {
            Obj::Database(d) => &d.owner,
            Obj::Schema(s) => &s.owner,
            Obj::Relation(r) => &r.owner,
            Obj::Function(f) => &f.owner,
        }
    }

    fn acl(self) -> &'a [AclEntry] {
        match self {
            Obj::Database(d) => &d.acl,
            Obj::Schema(s) => &s.acl,
            Obj::Relation(r) => &r.acl,
            Obj::Function(f) => &f.acl,
        }
    }

    /// 객체를 쓰려면 USAGE가 있어야 하는 스키마(데이터베이스는 None)
    fn schema(self) -> Option<&'a str> {
        match self {
            Obj::Database(_) => None,
            Obj::Schema(s) => Some(&s.name),
            Obj::Relation(r) => Some(&r.schema),
            Obj::Function(f) => Some(&f.schema),
        }
    }

    /// 이 객체에 있는 권한인가. 테이블에 USAGE, 스키마에 SELECT, 시퀀스에 INSERT 같은 것은 없다
    fn offers(self, p: Privilege) -> bool {
        use Privilege::*;
        match self {
            Obj::Database(_) => matches!(p, Connect | Create | Temporary),
            Obj::Schema(_) => matches!(p, Usage | Create),
            Obj::Relation(r) if r.kind == RelKind::Sequence => matches!(p, Usage | Select | Update),
            Obj::Relation(_) => matches!(p, Select | Insert | Update | Delete | Truncate | References | Trigger | Maintain),
            Obj::Function(_) => matches!(p, Execute),
        }
    }
}

/// 서버가 ACL과 상관없이 `p`를 주는 미리 정의된 역할들(PG14부터). 권한을 쓰는 역할 가운데 있으면 준다
fn predefined_roles(obj: Obj, p: Privilege) -> &'static [&'static str] {
    if !obj.offers(p) {
        return &[];
    }
    match (obj, p) {
        // 모든 스키마의 USAGE는 읽기 역할도 쓰기 역할도 준다
        (Obj::Schema(_), Privilege::Usage) => &[READ_ALL_DATA, WRITE_ALL_DATA],
        // 모든 관계의 SELECT(시퀀스 포함)
        (Obj::Relation(_), Privilege::Select) => &[READ_ALL_DATA],
        // 모든 관계의 INSERT·UPDATE·DELETE. 서버는 관계 종류를 가리지 않는다(시퀀스는 `offers`가 UPDATE만 남긴다)
        (Obj::Relation(_), Privilege::Insert | Privilege::Update | Privilege::Delete) => &[WRITE_ALL_DATA],
        _ => &[],
    }
}

// ───────────────────────── 역할 그래프 ─────────────────────────

/// 구성원 관계 하나를 계산용으로 푼 것
struct Edge<'a> {
    group: &'a str,
    /// 이 관계로 그룹의 권한을 쓴다
    inherits: bool,
    /// 이 관계로 그룹에 `SET ROLE`을 할 수 있다
    can_set: bool,
}

/// 구성원 → 그룹 관계들. 스냅숏의 `members` 순서를 지킨다
struct Graph<'a> {
    version: i32,
    roles: HashMap<&'a str, &'a RoleRec>,
    edges: HashMap<&'a str, Vec<Edge<'a>>>,
}

/// 걸음으로 닿은 역할 하나와 그 앞 걸음
struct Node<'x> {
    role: &'x str,
    parent: Option<usize>,
}

/// 한 역할에서 닿는 역할들. 너비 우선 순서고 시작한 역할이 `nodes[0]`이다
struct Reach<'x> {
    nodes: Vec<Node<'x>>,
    index: HashMap<&'x str, usize>,
}

impl<'a> Graph<'a> {
    fn new(ctx: &Ctx<'a>) -> Graph<'a> {
        let cluster = ctx.cluster;
        let version = cluster.version_num;
        let roles: HashMap<&str, &RoleRec> = cluster.roles.iter().map(|r| (r.name.as_str(), r)).collect();
        // 스냅숏에 없는 역할은 서버 기본값(INHERIT)으로 본다
        let inherit_attribute = |name: &str| roles.get(name).is_none_or(|r| r.inherit);

        let mut edges: HashMap<&str, Vec<Edge>> = HashMap::new();
        for m in &cluster.members {
            let attribute = inherit_attribute(&m.member);
            // PG16부터 관계마다의 옵션이 정한다(비어 있으면 구성원 속성, SET은 허용). 그 전에는 구성원의 속성이 정하고 SET ROLE은 늘 된다
            let (inherits, can_set) =
                if version >= MEMBERSHIP_OPTIONS_SINCE { (m.inherit.unwrap_or(attribute), m.set.unwrap_or(true)) } else { (attribute, true) };
            edges.entry(&m.member).or_default().push(Edge { group: &m.group, inherits, can_set });
        }
        if version >= PREDEFINED_ROLES_SINCE {
            // 소유자 → pg_database_owner. 실제 관계들 뒤에 둔다. PG16은 늘 상속하고, PG15 이하는 소유자의 속성을 따른다
            let owner = ctx.db.owner.as_str();
            let inherits = version >= MEMBERSHIP_OPTIONS_SINCE || inherit_attribute(owner);
            edges.entry(owner).or_default().push(Edge { group: DATABASE_OWNER, inherits, can_set: true });
        }
        Graph { version, roles, edges }
    }

    /// `start`에서 `follow`가 허락하는 관계만 따라 닿는 역할들. 같은 역할에는 처음 닿은(가장 짧은) 길만 남긴다
    fn reach<'x>(&'x self, start: &'x str, follow: fn(&Edge) -> bool) -> Reach<'x> {
        let mut nodes = vec![Node { role: start, parent: None }];
        let mut index = HashMap::from([(start, 0)]);
        let mut next = 0;
        while let Some(&Node { role, .. }) = nodes.get(next) {
            for edge in self.edges.get(role).into_iter().flatten().filter(|e| follow(e)) {
                if !index.contains_key(edge.group) {
                    index.insert(edge.group, nodes.len());
                    nodes.push(Node { role: edge.group, parent: Some(next) });
                }
            }
            next += 1;
        }
        Reach { nodes, index }
    }
}

impl Reach<'_> {
    /// 시작한 역할을 뺀, 시작한 역할에서 `node`까지의 경로
    fn path(&self, node: usize) -> Vec<String> {
        let mut path = Vec::new();
        let mut at = node;
        while let Some(parent) = self.nodes[at].parent {
            path.push(self.nodes[at].role.to_string());
            at = parent;
        }
        path.reverse();
        path
    }

    fn inherited(&self) -> Vec<Inherited> {
        (0..self.nodes.len()).map(|i| Inherited { role: self.nodes[i].role.to_string(), path: self.path(i) }).collect()
    }
}

// ───────────────────────── 계산 ─────────────────────────

/// 역할 하나와, 그 역할이 권한을 쓰는 역할들(자기 자신 포함). 한 번 구해 두고 객체마다 쓴다
struct Holder<'x> {
    reach: Reach<'x>,
    superuser: bool,
}

impl Holder<'_> {
    /// ACL 항목의 받는 쪽(`grantee`, None이면 PUBLIC)이 이 역할에게 어떤 출처인가. 이 역할과 무관하면 None.
    /// 반환하는 수는 `reach.nodes`에서 받는 쪽의 자리다
    fn link(&self, owner: &str, grantee: Option<&str>) -> Option<(SourceKind, usize)> {
        let Some(grantee) = grantee else {
            return Some((SourceKind::Public, 0));
        };
        let node = *self.reach.index.get(grantee)?;
        let kind = if grantee == owner {
            SourceKind::Owner
        } else if node == 0 {
            SourceKind::Direct
        } else {
            SourceKind::Group
        };
        Some((kind, node))
    }
}

/// 찾은 출처 하나. `node`는 권한을 받은 역할이 `Holder.reach.nodes`에서 차지한 자리(자기 자신, PUBLIC, superuser는 0)
struct Found<'o> {
    kind: SourceKind,
    node: usize,
    grantor: Option<&'o str>,
}

struct Evaluator<'a> {
    ctx: Ctx<'a>,
    graph: Graph<'a>,
    /// 이 스냅숏의 데이터베이스. 클러스터 스냅숏에 없으면 None
    database: Option<&'a DatabaseRec>,
}

impl<'a> Evaluator<'a> {
    fn new(ctx: &Ctx<'a>) -> Evaluator<'a> {
        let database = ctx.cluster.databases.iter().find(|d| d.name == ctx.db.database);
        Evaluator { ctx: *ctx, graph: Graph::new(ctx), database }
    }

    fn holder<'x>(&'x self, role: &'x str) -> Holder<'x> {
        Holder { reach: self.graph.reach(role, |e| e.inherits), superuser: self.graph.roles.get(role).is_some_and(|r| r.superuser) }
    }

    fn set_role_only(&self, role: &str) -> Vec<String> {
        let inherited = self.graph.reach(role, |e| e.inherits);
        let settable = self.graph.reach(role, |e| e.can_set);
        settable.nodes.iter().skip(1).filter(|n| !inherited.index.contains_key(n.role)).map(|n| n.role.to_string()).collect()
    }

    /// `ps` 가운데 하나라도 `obj`에 대해 갖는 출처를 모두 `found`로 넘긴다. ACL 항목 순서대로, 그다음 미리 정의된 역할, 마지막에 superuser
    fn each_source<'o>(&self, h: &Holder, obj: Obj<'o>, ps: &[Privilege], mut found: impl FnMut(Found<'o>)) {
        let owner = obj.owner();
        // ACL은 받는 쪽끼리 이웃해 있어서 방금 본 받는 쪽의 결과를 다시 쓴다
        let mut previous: Option<Option<&str>> = None;
        let mut link = None;
        for entry in obj.acl().iter().filter(|e| ps.contains(&e.privilege)) {
            let grantee = entry.grantee.as_deref();
            if previous != Some(grantee) {
                link = h.link(owner, grantee);
                previous = Some(grantee);
            }
            if let Some((kind, node)) = link {
                found(Found { kind, node, grantor: Some(entry.grantor.as_str()) });
            }
        }
        if self.graph.version >= PREDEFINED_ROLES_SINCE {
            for &p in ps {
                for name in predefined_roles(obj, p) {
                    if let Some(&node) = h.reach.index.get(*name) {
                        found(Found { kind: SourceKind::Predefined, node, grantor: None });
                    }
                }
            }
        }
        if h.superuser && ps.iter().any(|&p| obj.offers(p)) {
            found(Found { kind: SourceKind::Superuser, node: 0, grantor: None });
        }
    }

    /// `ps` 가운데 하나라도 갖는지와, 그 출처에 소유·직접·superuser가 있는지
    fn access(&self, h: &Holder, obj: Obj, ps: &[Privilege]) -> (bool, bool) {
        let (mut any, mut own) = (false, false);
        self.each_source(h, obj, ps, |found| {
            any = true;
            own |= found.kind.is_own();
        });
        (any, own)
    }

    fn holds(&self, h: &Holder, obj: Obj, p: Privilege) -> bool {
        obj.offers(p) && self.access(h, obj, &[p]).0
    }

    fn sources(&self, h: &Holder, obj: Obj, p: Privilege) -> Vec<Source> {
        let mut sources = Vec::new();
        if obj.offers(p) {
            self.each_source(h, obj, &[p], |found| {
                sources.push(Source { kind: found.kind, via: h.reach.path(found.node), grantor: found.grantor.map(str::to_string) });
            });
        }
        sources
    }

    /// 권한이 있어도 못 쓰는 이유. 데이터베이스 CONNECT가 먼저고 스키마 USAGE가 다음이다.
    /// 판단할 수 없는 것(클러스터 스냅숏에 없는 데이터베이스, `schema`가 None)은 문제로 보지 않는다
    fn unusable(&self, h: &Holder, schema: Option<&SchemaRec>) -> Option<&'static str> {
        if let Some(database) = self.database {
            if !self.holds(h, Obj::Database(database), Privilege::Connect) {
                return Some(NO_CONNECT);
            }
        }
        let schema = schema?;
        (!self.holds(h, Obj::Schema(schema), Privilege::Usage)).then_some(NO_USAGE)
    }

    fn schema(&self, name: &str) -> Option<&'a SchemaRec> {
        self.ctx.db.schemas.iter().find(|s| s.name == name)
    }

    /// 역할 하나와 스키마 하나의 칸. `relations`는 그 스키마의 관계들이다
    fn cell(&self, h: &Holder, role: &str, schema: &SchemaRec, relations: &[&RelationRec]) -> SchemaCell {
        // 보이는 값 가운데 하나라도 소유·직접·superuser 출처에서 온 것이 있는가
        let mut own = false;
        let (usage, usage_own) = self.access(h, Obj::Schema(schema), &[Privilege::Usage]);
        let (create, create_own) = self.access(h, Obj::Schema(schema), &[Privilege::Create]);
        own |= usage_own | create_own;

        let (mut read_have, mut read_total, mut write_have, mut write_total) = (0, 0, 0, 0);
        for &rel in relations {
            if READ_KINDS.contains(&rel.kind) {
                let (any, from_own) = self.access(h, Obj::Relation(rel), &READ);
                read_total += 1;
                read_have += usize::from(any);
                own |= from_own;
            }
            if WRITE_KINDS.contains(&rel.kind) {
                let (any, from_own) = self.access(h, Obj::Relation(rel), &WRITE);
                write_total += 1;
                write_have += usize::from(any);
                own |= from_own;
            }
        }
        let (read, write) = (Coverage::of(read_have, read_total), Coverage::of(write_have, write_total));
        // 잃을 것이 있는 칸만 못 쓰는 이유를 붙인다. 보이는 값이 없는 칸은 출처를 내세우지 않는다
        let shown = usage || create || read != Coverage::None || write != Coverage::None;
        SchemaCell {
            role: role.to_string(),
            schema: schema.name.clone(),
            usage,
            create,
            read,
            write,
            inherited_only: shown && !own,
            unusable: if shown { self.unusable(h, Some(schema)) } else { None },
        }
    }
}

impl Ctx<'_> {
    /// 역할 자신(경로 없음)과 상속하는 모든 역할을 너비 우선 순서로
    pub fn inherited(&self, role: &str) -> Vec<Inherited> {
        Evaluator::new(self).holder(role).reach.inherited()
    }

    /// 상속하지는 않지만 `SET ROLE`로 닿을 수 있는 역할들. PG16부터 SET 옵션이 꺼진 관계는 건너뛴다
    pub fn set_role_only(&self, role: &str) -> Vec<String> {
        Evaluator::new(self).set_role_only(role)
    }

    /// `role`이 `obj`에 `p`를 갖는 모든 출처. 비어 있으면 그 권한이 없다
    pub fn sources(&self, role: &str, obj: Obj, p: Privilege) -> Vec<Source> {
        let evaluator = Evaluator::new(self);
        evaluator.sources(&evaluator.holder(role), obj, p)
    }

    /// 권한이 있어도 못 쓰는 이유: 이 데이터베이스의 CONNECT가 없으면 "CONNECT 없음", 있으면서 `schema`의 USAGE가 없으면 "USAGE 없음"
    pub fn unusable(&self, role: &str, schema: &str) -> Option<&'static str> {
        let evaluator = Evaluator::new(self);
        evaluator.unusable(&evaluator.holder(role), evaluator.schema(schema))
    }
}

/// 스키마 안의 관계 가운데 권한을 가진 정도
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Coverage {
    /// 모두. 대상 관계가 하나도 없는 스키마는 여기가 아니다
    All,
    Some,
    None,
}

impl Coverage {
    fn of(have: usize, total: usize) -> Coverage {
        match (have, total) {
            (0, _) => Coverage::None,
            (have, total) if have == total => Coverage::All,
            _ => Coverage::Some,
        }
    }
}

/// 역할 하나와 스키마 하나의 권한 요약
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaCell {
    pub role: String,
    pub schema: String,
    /// 스키마의 USAGE
    pub usage: bool,
    /// 스키마의 CREATE
    pub create: bool,
    /// 읽는 관계(테이블, 뷰, 구체화 뷰, 파티션 테이블, 외부 테이블) 가운데 SELECT가 있는 정도
    pub read: Coverage,
    /// 쓰는 관계(테이블, 파티션 테이블, 외부 테이블) 가운데 INSERT·UPDATE·DELETE 중 하나라도 있는 정도
    pub write: Coverage,
    /// 보이는 값(`usage`, `create`가 참이거나 `read`, `write`가 `None`이 아닌 것)의 출처가 모두 그룹·PUBLIC·미리 정의된 역할이다.
    /// 보이는 값이 하나도 없는 칸은 거짓이다
    pub inherited_only: bool,
    /// 잃을 것이 있는 칸(`usage || create || read != None || write != None`)에 `Ctx::unusable`의 결과
    pub unusable: Option<&'static str>,
}

/// 역할 × 스키마의 칸들. 주어진 역할 순서대로, 각 역할 안에서는 스키마 이름순이다.
/// 20,000개 관계에 역할 200개여도 2초 안에 끝나도록, 역할마다 상속하는 역할의 집합을 한 번만 구한다
pub fn schema_cells(ctx: &Ctx, roles: &[&str]) -> Vec<SchemaCell> {
    let evaluator = Evaluator::new(ctx);
    let mut schemas: Vec<&SchemaRec> = ctx.db.schemas.iter().collect();
    schemas.sort_by(|a, b| a.name.cmp(&b.name));
    let mut relations: HashMap<&str, Vec<&RelationRec>> = HashMap::new();
    for rel in &ctx.db.relations {
        relations.entry(rel.schema.as_str()).or_default().push(rel);
    }

    let mut cells = Vec::with_capacity(roles.len() * schemas.len());
    for &role in roles {
        let holder = evaluator.holder(role);
        for &schema in &schemas {
            let of_schema = relations.get(schema.name.as_str()).map_or(&[][..], Vec::as_slice);
            cells.push(evaluator.cell(&holder, role, schema, of_schema));
        }
    }
    cells
}

/// "누가 할 수 있나"의 한 줄
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WhoCanRow {
    pub role: String,
    pub sources: Vec<Source>,
    /// 권한은 있어도 못 쓰는 이유. 객체가 있는 스키마의 USAGE와 데이터베이스의 CONNECT를 본다
    pub unusable: Option<&'static str>,
}

/// `obj`에 `p`를 가진 역할들(출처가 하나 이상). 역할 이름순이다. 시스템 역할도 포함한다
pub fn who_can(ctx: &Ctx, obj: Obj, p: Privilege) -> Vec<WhoCanRow> {
    let evaluator = Evaluator::new(ctx);
    let schema = obj.schema().and_then(|name| evaluator.schema(name));
    let mut names: Vec<&str> = ctx.cluster.roles.iter().map(|r| r.name.as_str()).collect();
    names.sort_unstable();
    names.dedup();
    names
        .into_iter()
        .filter_map(|role| {
            let holder = evaluator.holder(role);
            let sources = evaluator.sources(&holder, obj, p);
            (!sources.is_empty()).then(|| WhoCanRow { role: role.to_string(), unusable: evaluator.unusable(&holder, schema), sources })
        })
        .collect()
}

#[cfg(test)]
mod tests;
