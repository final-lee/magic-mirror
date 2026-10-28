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
//! - MAINTAIN은 PG17부터 시퀀스를 뺀 모든 관계에 있다. 그 전에는 어떤 객체에도 없어서 superuser도 갖지 못한다.
//!   PG17부터 `pg_maintain`이 모든 관계의 MAINTAIN을 준다.
//! - 스키마에 만드는 데는 CREATE만 있으면 되고 USAGE는 필요 없다(서버가 그 스키마의 이름으로 만드는 것을 허락한다). 데이터베이스에 붙는 CONNECT는 그대로 필요하다.
//!
//! 구성: 공개된 것은 `Eval`(한 명령이 한 번 만들어 쓰는 계산기)과 그것이 역할마다 돌려주는 `RoleView`, `schema_cells`(역할 × 스키마),
//! `who_can`(한 객체에 권한이 있는 역할들)이다. 시험에는 `Ctx`의 메서드도 있다(부를 때마다 `Eval`을 새로 만드는 한 줄 포장).
//! `Eval`이 `Ctx`에서 역할 그래프를 한 번 만들고, `RoleView`가 역할마다 상속하는 역할의 집합을 한 번 구해 둔다.
//! `schema_cells`는 호출하는 쪽이 만든 `Eval`을 받아서 한 명령이 `Eval` 하나를 나눠 쓴다. `who_can`은 `Eval` 하나를 스스로 만든다.
//! 데이터베이스 스냅숏 없이 클러스터 스냅숏만 있을 때는 `Eval::for_cluster`다.

use std::cell::OnceCell;
use std::collections::{BTreeSet, HashMap};

use serde::Serialize;

use super::model::{
    AclEntry, ClusterSnapshot, DatabaseRec, DbSnapshot, FunctionRec, Privilege, RelKind, RelationRec, RoleRec, SchemaRec, MEMBERSHIP_OPTIONS_SINCE,
};

/// `pg_read_all_data`·`pg_write_all_data`·`pg_database_owner`가 있는 첫 서버 버전
const PREDEFINED_ROLES_SINCE: i32 = 140_000;
const READ_ALL_DATA: &str = "pg_read_all_data";
const WRITE_ALL_DATA: &str = "pg_write_all_data";
const DATABASE_OWNER: &str = "pg_database_owner";
/// MAINTAIN 권한과 `pg_maintain`이 있는 첫 서버 버전
const MAINTAIN_SINCE: i32 = 170_000;
const MAINTAIN_ROLE: &str = "pg_maintain";

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
    /// `pg_read_all_data`·`pg_write_all_data`·`pg_maintain`(ACL에 없다)
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

    /// 서버 버전 `version`에서 이 객체에 있는 권한인가. 테이블에 USAGE, 스키마에 SELECT, 시퀀스에 INSERT 같은 것은 없고,
    /// MAINTAIN은 PG17부터 시퀀스를 뺀 관계에만 있다
    fn offers(self, p: Privilege, version: i32) -> bool {
        use Privilege::*;
        match self {
            Obj::Database(_) => matches!(p, Connect | Create | Temporary),
            Obj::Schema(_) => matches!(p, Usage | Create),
            Obj::Relation(r) if r.kind == RelKind::Sequence => matches!(p, Usage | Select | Update),
            Obj::Relation(_) => matches!(p, Select | Insert | Update | Delete | Truncate | References | Trigger) || (p == Maintain && version >= MAINTAIN_SINCE),
            Obj::Function(_) => matches!(p, Execute),
        }
    }
}

/// 서버 버전 `version`에서 ACL과 상관없이 `p`를 주는 미리 정의된 역할들(PG14부터). 권한을 쓰는 역할 가운데 있으면 준다
fn predefined_roles(obj: Obj, p: Privilege, version: i32) -> &'static [&'static str] {
    if !obj.offers(p, version) {
        return &[];
    }
    match (obj, p) {
        // 모든 스키마의 USAGE는 읽기 역할도 쓰기 역할도 준다
        (Obj::Schema(_), Privilege::Usage) => &[READ_ALL_DATA, WRITE_ALL_DATA],
        // 모든 관계의 SELECT(시퀀스 포함)
        (Obj::Relation(_), Privilege::Select) => &[READ_ALL_DATA],
        // 모든 관계의 INSERT·UPDATE·DELETE. 서버는 관계 종류를 가리지 않는다(시퀀스는 `offers`가 UPDATE만 남긴다)
        (Obj::Relation(_), Privilege::Insert | Privilege::Update | Privilege::Delete) => &[WRITE_ALL_DATA],
        // PG17부터 모든 관계의 MAINTAIN(시퀀스는 `offers`가 거른다)
        (Obj::Relation(_), Privilege::Maintain) => &[MAINTAIN_ROLE],
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
    /// `database_owner`는 이 그래프가 다루는 데이터베이스의 소유자다. 데이터베이스 스냅숏 없이 만들면 None이고, 그때는 소유자 → `pg_database_owner`
    /// 관계(데이터베이스마다 다르다)가 빠진다
    fn new(cluster: &'a ClusterSnapshot, database_owner: Option<&'a str>) -> Graph<'a> {
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
        if let Some(owner) = database_owner.filter(|_| version >= PREDEFINED_ROLES_SINCE) {
            // 소유자 → pg_database_owner. 실제 관계들 뒤에 둔다. PG16은 늘 상속하고, PG15 이하는 소유자의 속성을 따른다
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

/// 한 명령이 한 번 만들어 두고 여러 번 묻는 계산기. `Ctx`에서 역할 그래프(모든 역할과 구성원 관계)를 한 번 만든다.
/// 역할 하나에 대한 질문은 `role`이 돌려주는 `RoleView`로 한다. 거기서 그 역할이 상속하는 역할의 집합을 한 번만 구한다.
/// `Ctx`의 메서드는 부를 때마다 이것을 새로 만든다. 같은 `Ctx`에 여러 번 묻는다면(객체마다, 역할마다) `Eval`을 한 번 만들어 쓴다.
/// 릴리스에서 역할 235개, 구성원 관계 460개일 때 `Ctx::sources` 한 번은 23µs였고, 뷰의 `sources`는 호출당 60ns 안팎이다
/// (역할 200 × 관계 2만 개, 400만 번에 0.25초).
pub struct Eval<'a> {
    graph: Graph<'a>,
    /// 이 스냅숏의 데이터베이스. 클러스터 스냅숏에 없으면 None
    database: Option<&'a DatabaseRec>,
    schemas: HashMap<&'a str, &'a SchemaRec>,
}

impl<'a> Eval<'a> {
    pub fn new(ctx: &Ctx<'a>) -> Eval<'a> {
        let database = ctx.cluster.databases.iter().find(|d| d.name == ctx.db.database);
        let schemas = ctx.db.schemas.iter().map(|s| (s.name.as_str(), s)).collect();
        Eval { graph: Graph::new(ctx.cluster, Some(ctx.db.owner.as_str())), database, schemas }
    }

    /// 데이터베이스 스냅숏 없이 클러스터 스냅숏만으로 만든다. 역할 사이의 관계(`inherited`, `set_role_only`, `membership_inherits`)와
    /// 클러스터가 가진 객체(데이터베이스)의 `sources`를 묻는 데 쓴다. 데이터베이스마다 다른 것은 모른다: 소유자 → `pg_database_owner` 관계가 없고,
    /// 스키마를 모르니 `unusable`은 아무것도 판단하지 못한다.
    pub fn for_cluster(cluster: &'a ClusterSnapshot) -> Eval<'a> {
        Eval { graph: Graph::new(cluster, None), database: None, schemas: HashMap::new() }
    }

    /// `member`가 `group`의 구성원이고 그 관계로 `group`의 권한을 쓰는가. PG16부터는 관계마다의 INHERIT 옵션(비어 있으면 구성원의 `rolinherit`)이,
    /// 그 전에는 구성원의 `rolinherit`가 정한다. 구성원 관계가 아니면 false다.
    pub fn membership_inherits(&self, member: &str, group: &str) -> bool {
        self.graph.edges.get(member).is_some_and(|edges| edges.iter().any(|e| e.group == group && e.inherits))
    }

    /// 역할 하나의 계산. 스냅숏에 없는 역할도 자기 자신과 PUBLIC이 주는 것은 갖는다
    pub fn role<'x>(&'x self, name: &'x str) -> RoleView<'x> {
        let superuser = self.graph.roles.get(name).is_some_and(|r| r.superuser);
        let holder = Holder { reach: self.graph.reach(name, |e| e.inherits), superuser };
        RoleView { eval: self, holder, set_only: OnceCell::new(), after_set: OnceCell::new() }
    }
}

/// `Eval`이 만든 역할 하나의 계산. 상속하는 역할의 집합을 만들 때 한 번 구해 두고 질문마다 다시 구하지 않는다
pub struct RoleView<'x> {
    eval: &'x Eval<'x>,
    holder: Holder<'x>,
    /// `SET ROLE`로만 닿는 역할들. 처음 물을 때 구한다
    set_only: OnceCell<Vec<String>>,
    /// `SET ROLE`을 한 뒤에 권한을 쓰는 역할들. 처음 물을 때 구한다
    after_set: OnceCell<BTreeSet<String>>,
}

impl RoleView<'_> {
    /// 역할 자신(경로 없음)과 상속하는 모든 역할을 너비 우선 순서로
    pub fn inherited(&self) -> Vec<Inherited> {
        self.holder.reach.inherited()
    }

    /// 상속하지는 않지만 `SET ROLE`로 닿을 수 있는 역할들. PG16부터 SET 옵션이 꺼진 관계는 건너뛴다
    pub fn set_role_only(&self) -> Vec<String> {
        self.set_only
            .get_or_init(|| {
                let settable = self.eval.graph.reach(self.holder.reach.nodes[0].role, |e| e.can_set);
                let inherited = &self.holder.reach.index;
                settable.nodes.iter().skip(1).filter(|n| !inherited.contains_key(n.role)).map(|n| n.role.to_string()).collect()
            })
            .clone()
    }

    /// `SET ROLE`을 한 뒤에 그 권한을 쓰게 되는 역할들 가운데, 지금 상속하는 것이 아닌 것(이름순). `SET ROLE`로 닿는 모든 역할
    /// (PG16부터는 사슬의 모든 관계에 SET 옵션이 있어야 한다)이 각각 상속하는 역할의 합집합에서 이 역할이 지금 상속하는 역할을 뺀 것이다.
    /// `set_role_only`는 "되어 볼 수 있는 역할", 이것은 "그렇게 되면 권한을 쓰는 역할"이다: PG16에서 `GRANT g TO dba WITH INHERIT TRUE, SET FALSE`면
    /// dba로 SET ROLE을 한 세션은 g의 권한을 쓰지만 g로 SET ROLE을 할 수는 없으니 g는 여기에만 나온다.
    /// PG15 이하는 모든 관계로 SET ROLE을 할 수 있어서 `set_role_only`와 같은 역할들이다.
    pub fn usable_after_set_role(&self) -> &BTreeSet<String> {
        self.after_set.get_or_init(|| {
            let graph = &self.eval.graph;
            let settable = graph.reach(self.holder.reach.nodes[0].role, |e| e.can_set);
            let inherited = &self.holder.reach.index;
            let mut usable = BTreeSet::new();
            for switched in settable.nodes.iter().skip(1) {
                let inherits = graph.reach(switched.role, |e| e.inherits);
                usable.extend(inherits.nodes.iter().filter(|n| !inherited.contains_key(n.role)).map(|n| n.role.to_string()));
            }
            usable
        })
    }

    /// 이 역할이 `obj`에 `p`를 갖는 모든 출처. 비어 있으면 그 권한이 없다
    pub fn sources(&self, obj: Obj, p: Privilege) -> Vec<Source> {
        let mut sources = Vec::new();
        if self.offers(obj, p) {
            self.each_source(obj, &[p], |found| {
                sources.push(Source { kind: found.kind, via: self.holder.reach.path(found.node), grantor: found.grantor.map(str::to_string) });
            });
        }
        sources
    }

    /// 권한이 있어도 못 쓰는 이유: 이 데이터베이스의 CONNECT가 없으면 "CONNECT 없음", 있으면서 `schema`의 USAGE가 없으면 "USAGE 없음".
    /// 칸과 누가 할 수 있나는 같은 판단을 안에서 하고(`cell`, `who_can`), 이 메서드는 그 판단을 시험이 직접 묻는 길이다.
    #[cfg(test)]
    pub fn unusable(&self, schema: &str) -> Option<&'static str> {
        self.unusable_in(self.eval.database, self.eval.schemas.get(schema).copied())
    }

    /// `ps` 가운데 하나라도 `obj`에 대해 갖는 출처를 모두 `found`로 넘긴다. ACL 항목 순서대로, 그다음 미리 정의된 역할, 마지막에 superuser
    fn each_source<'o>(&self, obj: Obj<'o>, ps: &[Privilege], mut found: impl FnMut(Found<'o>)) {
        let holder = &self.holder;
        let owner = obj.owner();
        // ACL은 받는 쪽끼리 이웃해 있어서 방금 본 받는 쪽의 결과를 다시 쓴다
        let mut previous: Option<Option<&str>> = None;
        let mut link = None;
        for entry in obj.acl().iter().filter(|e| ps.contains(&e.privilege)) {
            let grantee = entry.grantee.as_deref();
            if previous != Some(grantee) {
                link = holder.link(owner, grantee);
                previous = Some(grantee);
            }
            if let Some((kind, node)) = link {
                found(Found { kind, node, grantor: Some(entry.grantor.as_str()) });
            }
        }
        if self.eval.graph.version >= PREDEFINED_ROLES_SINCE {
            for &p in ps {
                for name in predefined_roles(obj, p, self.eval.graph.version) {
                    if let Some(&node) = holder.reach.index.get(*name) {
                        found(Found { kind: SourceKind::Predefined, node, grantor: None });
                    }
                }
            }
        }
        if holder.superuser && ps.iter().any(|&p| self.offers(obj, p)) {
            found(Found { kind: SourceKind::Superuser, node: 0, grantor: None });
        }
    }

    /// `ps` 가운데 하나라도 갖는지와, 그 출처에 소유·직접·superuser가 있는지
    fn access(&self, obj: Obj, ps: &[Privilege]) -> (bool, bool) {
        let (mut any, mut own) = (false, false);
        self.each_source(obj, ps, |found| {
            any = true;
            own |= found.kind.is_own();
        });
        (any, own)
    }

    /// 이 서버 버전에서 `obj`에 `p`가 있는가
    fn offers(&self, obj: Obj, p: Privilege) -> bool {
        obj.offers(p, self.eval.graph.version)
    }

    fn holds(&self, obj: Obj, p: Privilege) -> bool {
        self.offers(obj, p) && self.access(obj, &[p]).0
    }

    /// 못 쓰는 이유. 데이터베이스 CONNECT가 먼저고 스키마 USAGE가 다음이다.
    /// 판단할 수 없는 것(`database`나 `schema`가 None)은 문제로 보지 않는다
    fn unusable_in(&self, database: Option<&DatabaseRec>, schema: Option<&SchemaRec>) -> Option<&'static str> {
        if let Some(database) = database {
            if !self.holds(Obj::Database(database), Privilege::Connect) {
                return Some(NO_CONNECT);
            }
        }
        let schema = schema?;
        (!self.holds(Obj::Schema(schema), Privilege::Usage)).then_some(NO_USAGE)
    }

    /// 이 역할과 스키마 하나의 칸. `relations`는 그 스키마의 관계들이다
    fn cell(&self, schema: &SchemaRec, relations: &[&RelationRec]) -> SchemaCell {
        // 보이는 값 가운데 하나라도 소유·직접·superuser 출처에서 온 것이 있는가
        let mut own = false;
        let (usage, usage_own) = self.access(Obj::Schema(schema), &[Privilege::Usage]);
        let (create, create_own) = self.access(Obj::Schema(schema), &[Privilege::Create]);
        own |= usage_own | create_own;

        let (mut read_have, mut read_total, mut write_have, mut write_total) = (0, 0, 0, 0);
        for &rel in relations {
            if READ_KINDS.contains(&rel.kind) {
                let (any, from_own) = self.access(Obj::Relation(rel), &READ);
                read_total += 1;
                read_have += usize::from(any);
                own |= from_own;
            }
            if WRITE_KINDS.contains(&rel.kind) {
                let (any, from_own) = self.access(Obj::Relation(rel), &WRITE);
                write_total += 1;
                write_have += usize::from(any);
                own |= from_own;
            }
        }
        let (read, write) = (Coverage::of(read_have, read_total), Coverage::of(write_have, write_total));
        // 잃을 것이 있는 칸만 못 쓰는 이유를 붙인다. 보이는 값이 없는 칸은 출처를 내세우지 않는다
        let shown = usage || create || read != Coverage::None || write != Coverage::None;
        // 보이는 것이 CREATE뿐인 칸은 USAGE 없이도 쓸 수 있어서 USAGE가 없다는 이유를 달지 않는다. CONNECT는 그대로 본다
        let create_only = create && !usage && read == Coverage::None && write == Coverage::None;
        SchemaCell {
            role: self.holder.reach.nodes[0].role.to_string(),
            schema: schema.name.clone(),
            usage,
            create,
            read,
            write,
            inherited_only: shown && !own,
            unusable: if shown { self.unusable_in(self.eval.database, (!create_only).then_some(schema)) } else { None },
        }
    }
}

/// 부를 때마다 `Eval`을 새로 만드는 한 줄 포장. 명령은 쓰지 않고(`Eval` 하나로 묻는다) 시험이 짧게 묻는 데 쓴다.
#[cfg(test)]
impl Ctx<'_> {
    /// 역할 자신(경로 없음)과 상속하는 모든 역할을 너비 우선 순서로
    pub fn inherited(&self, role: &str) -> Vec<Inherited> {
        Eval::new(self).role(role).inherited()
    }

    /// 상속하지는 않지만 `SET ROLE`로 닿을 수 있는 역할들. PG16부터 SET 옵션이 꺼진 관계는 건너뛴다
    pub fn set_role_only(&self, role: &str) -> Vec<String> {
        Eval::new(self).role(role).set_role_only()
    }

    /// `SET ROLE`을 한 뒤에 쓸 수 있는 권한의 역할들 가운데 지금 상속하지 않는 것
    pub fn usable_after_set_role(&self, role: &str) -> Vec<String> {
        Eval::new(self).role(role).usable_after_set_role().iter().cloned().collect()
    }

    /// `role`이 `obj`에 `p`를 갖는 모든 출처. 비어 있으면 그 권한이 없다
    pub fn sources(&self, role: &str, obj: Obj, p: Privilege) -> Vec<Source> {
        Eval::new(self).role(role).sources(obj, p)
    }

    /// 권한이 있어도 못 쓰는 이유: 이 데이터베이스의 CONNECT가 없으면 "CONNECT 없음", 있으면서 `schema`의 USAGE가 없으면 "USAGE 없음"
    pub fn unusable(&self, role: &str, schema: &str) -> Option<&'static str> {
        Eval::new(self).role(role).unusable(schema)
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
    /// 잃을 것이 있는 칸(`usage || create || read != None || write != None`)에 `Ctx::unusable`의 결과.
    /// 보이는 값이 `create`뿐이면 스키마의 USAGE 없이도 쓸 수 있어서 "USAGE 없음"이 아니라 "CONNECT 없음"이거나 None이다
    pub unusable: Option<&'static str>,
}

/// 역할 × 스키마의 칸들. 주어진 역할 순서대로, 각 역할 안에서는 스키마 이름순이다. `eval`은 같은 `ctx`로 만든 것이어야 한다.
/// 20,000개 관계에 역할 200개여도 2초 안에 끝나도록, 역할마다 상속하는 역할의 집합을 한 번만 구한다
pub fn schema_cells(eval: &Eval, ctx: &Ctx, roles: &[&str]) -> Vec<SchemaCell> {
    let mut schemas: Vec<&SchemaRec> = ctx.db.schemas.iter().collect();
    schemas.sort_by(|a, b| a.name.cmp(&b.name));
    let mut relations: HashMap<&str, Vec<&RelationRec>> = HashMap::new();
    for rel in &ctx.db.relations {
        relations.entry(rel.schema.as_str()).or_default().push(rel);
    }

    let mut cells = Vec::with_capacity(roles.len() * schemas.len());
    for &role in roles {
        let view = eval.role(role);
        for &schema in &schemas {
            let of_schema = relations.get(schema.name.as_str()).map_or(&[][..], Vec::as_slice);
            cells.push(view.cell(schema, of_schema));
        }
    }
    cells
}

/// "누가 할 수 있나"의 한 줄
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WhoCanRow {
    pub role: String,
    pub sources: Vec<Source>,
    /// 권한은 있어도 못 쓰는 이유. 데이터베이스의 CONNECT(데이터베이스를 물었으면 그 데이터베이스의, 아니면 이 스냅숏의)와
    /// 객체가 있는 스키마의 USAGE를 본다. 스키마의 CREATE는 USAGE 없이도 되니 "CONNECT 없음"만 있을 수 있다
    pub unusable: Option<&'static str>,
}

/// `obj`에 `p`를 가진 역할들(출처가 하나 이상). 역할 이름순이다. 시스템 역할도 포함한다
pub fn who_can(ctx: &Ctx, obj: Obj, p: Privilege) -> Vec<WhoCanRow> {
    let eval = Eval::new(ctx);
    // CONNECT는 물은 데이터베이스에서 본다. 그 밖의 객체는 이 스냅숏의 데이터베이스 안에 있다
    let database = match obj {
        Obj::Database(d) => Some(d),
        _ => eval.database,
    };
    // 스키마에 만드는 일은 그 스키마의 USAGE 없이도 되니 USAGE를 보지 않는다
    let schema = match (obj, p) {
        (Obj::Schema(_), Privilege::Create) => None,
        _ => obj.schema().and_then(|name| eval.schemas.get(name).copied()),
    };
    let mut names: Vec<&str> = ctx.cluster.roles.iter().map(|r| r.name.as_str()).collect();
    names.sort_unstable();
    names.dedup();
    names
        .into_iter()
        .filter_map(|role| {
            let view = eval.role(role);
            let sources = view.sources(obj, p);
            (!sources.is_empty()).then(|| WhoCanRow { role: role.to_string(), unusable: view.unusable_in(database, schema), sources })
        })
        .collect()
}

#[cfg(test)]
mod generated;
#[cfg(test)]
mod tests;
