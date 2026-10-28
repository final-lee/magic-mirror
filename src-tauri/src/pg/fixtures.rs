//! 시험용 카탈로그 스냅숏을 짧게 만드는 도구들(시험 전용). 서버가 실제로 주는 모양을 따른다.
//! ACL은 `aclexplode`가 푼 줄이라, 소유자의 권한과 PUBLIC 기본값도 모두 항목으로 들어 있다(소유자가 자기 권한을 거두면 그 항목이 없다).
//!
//! - 부품: `role`, `member`, `table`, `schema`, `function`, `database`, `cluster`, `db`. 객체는 `acldefault`와 같은 기본 ACL로 시작하고,
//!   `Granting`의 `grant`·`revoke`로 고친다.
//! - `app_scene`: 여러 시험이 함께 쓰는 장면. `live_tests`가 Docker에 심는 장면과 같은 모양이다.

use super::eval::Ctx;
use super::model::Privilege::{Connect, Create, Delete, Execute, Insert, References, Select, Temporary, Trigger, Truncate, Update, Usage};
use super::model::{
    AclEntry, ClusterSnapshot, DatabaseRec, DbSnapshot, FunctionRec, MemberGrant, MemberRec, Privilege, RelKind, RelationRec, RoleRec, SchemaRec,
    MEMBERSHIP_OPTIONS_SINCE,
};

/// 서버 버전(`server_version_num`). 미리 정의된 데이터 역할과 `pg_database_owner`는 14부터, 구성원 관계마다의 옵션은 16부터, MAINTAIN은 17부터 있다
pub const PG13: i32 = 130_000;
pub const PG14: i32 = 140_000;
pub const PG15: i32 = 150_000;
pub const PG16: i32 = 160_000;
pub const PG17: i32 = 170_000;

/// 시험 장면의 부트스트랩 superuser(RDS의 `rdsadmin`): 클러스터의 `bootstrap_superuser`고, 시험의 구성원 관계는 이 역할이 맺어 준 것이다
pub const BOOTSTRAP: &str = "rdsadmin";

/// 서버가 사용자 역할에 처음 매기는 OID. 그 아래는 서버가 직접 만든 역할(미리 정의된 역할 등)의 것이다
const FIRST_ROLE_OID: u32 = 16_384;

/// 속성이 서버 기본값인 NOLOGIN 역할(INHERIT만 켜져 있다). OID는 0이다: `cluster`가 역할들에 이름순으로 서로 다른 OID를 매긴다
pub fn role(name: &str) -> RoleRec {
    RoleRec {
        name: name.into(),
        login: false,
        inherit: true,
        create_role: false,
        create_db: false,
        replication: false,
        bypass_rls: false,
        superuser: false,
        conn_limit: -1,
        valid_until: None,
        comment: None,
        oid: 0,
    }
}

pub fn login(name: &str) -> RoleRec {
    RoleRec { login: true, ..role(name) }
}

/// 옵션이 없는 구성원 관계(PG15 이하가 주는 모양). 부여는 `BOOTSTRAP`이 한 하나다
pub fn member(member: &str, group: &str) -> MemberRec {
    member_options(member, group, None, None)
}

/// INHERIT·SET 옵션이 있는 구성원 관계(PG16 이상이 주는 모양). 부여는 `BOOTSTRAP`이 한 하나다
pub fn member_with(member: &str, group: &str, inherit: bool, set: bool) -> MemberRec {
    member_options(member, group, Some(inherit), Some(set))
}

/// 옵션을 `Option`으로 주는 꼴. 부여는 `BOOTSTRAP`이 한 하나이고, 합친 값(`admin`·`inherit`·`set`)은 그 부여와 같다.
/// 시험이 합친 값만 고쳐 쓰면(`scene.member_mut(…).inherit = …`) `grants`는 그대로라서, 부여를 읽는 시험은 `grants`도 함께 고친다
pub fn member_options(member: &str, group: &str, inherit: Option<bool>, set: Option<bool>) -> MemberRec {
    let grant = MemberGrant { grantor: BOOTSTRAP.into(), admin: false, inherit, set };
    MemberRec { member: member.into(), group: group.into(), admin: false, inherit, set, grants: vec![grant] }
}

pub fn entry(grantor: &str, grantee: Option<&str>, privilege: Privilege) -> AclEntry {
    AclEntry { grantor: grantor.into(), grantee: grantee.map(Into::into), privilege, grantable: false }
}

/// ACL을 가진 객체. 권한은 소유자가 준다(`grant_by`로 다른 부여자를 쓴다)
pub trait Granting: Sized {
    fn owner(&self) -> &str;
    fn acl_mut(&mut self) -> &mut Vec<AclEntry>;

    fn grant(self, grantee: &str, privileges: &[Privilege]) -> Self {
        let grantor = self.owner().to_string();
        self.grant_by(&grantor, grantee, privileges)
    }

    fn grant_by(mut self, grantor: &str, grantee: &str, privileges: &[Privilege]) -> Self {
        self.acl_mut().extend(privileges.iter().map(|&p| entry(grantor, Some(grantee), p)));
        self
    }

    fn grant_public(mut self, privileges: &[Privilege]) -> Self {
        let grantor = self.owner().to_string();
        self.acl_mut().extend(privileges.iter().map(|&p| entry(&grantor, None, p)));
        self
    }

    /// `grantee`의 항목 가운데 `privileges`를 거둔다. 소유자가 자기 권한을 거두는 것도 이것이다
    fn revoke(mut self, grantee: &str, privileges: &[Privilege]) -> Self {
        self.acl_mut().retain(|e| !(e.grantee.as_deref() == Some(grantee) && privileges.contains(&e.privilege)));
        self
    }

    fn revoke_public(mut self, privileges: &[Privilege]) -> Self {
        self.acl_mut().retain(|e| !(e.grantee.is_none() && privileges.contains(&e.privilege)));
        self
    }
}

macro_rules! impl_granting {
    ($($ty:ty),*) => {$(
        impl Granting for $ty {
            fn owner(&self) -> &str {
                &self.owner
            }
            fn acl_mut(&mut self) -> &mut Vec<AclEntry> {
                &mut self.acl
            }
        }
    )*};
}
impl_granting!(RelationRec, SchemaRec, FunctionRec, DatabaseRec);

/// 소유자가 기본으로 갖는 권한만 가진 관계: 시퀀스는 USAGE·SELECT·UPDATE, 나머지는 테이블의 일곱 가지.
/// 이것은 PG14~16의 기본값이다. PG17부터는 서버가 주는 소유자의 기본 권한에 MAINTAIN도 들어 있다(여기서는 넣지 않는다.
/// 시험이 PG17 모양의 MAINTAIN을 볼 때는 `grant`로 더한다)
pub fn relation(kind: RelKind, schema: &str, name: &str, owner: &str) -> RelationRec {
    let privileges: &[Privilege] =
        if kind == RelKind::Sequence { &[Usage, Select, Update] } else { &[Select, Insert, Update, Delete, Truncate, References, Trigger] };
    let acl = privileges.iter().map(|&p| entry(owner, Some(owner), p)).collect();
    RelationRec { schema: schema.into(), name: name.into(), kind, owner: owner.into(), rls: false, acl }
}

pub fn table(schema: &str, name: &str, owner: &str) -> RelationRec {
    relation(RelKind::Table, schema, name, owner)
}

/// 소유자만 USAGE·CREATE를 가진 스키마
pub fn schema(name: &str, owner: &str) -> SchemaRec {
    SchemaRec { name: name.into(), owner: owner.into(), acl: vec![entry(owner, Some(owner), Usage), entry(owner, Some(owner), Create)] }
}

/// 소유자와 PUBLIC이 EXECUTE를 가진 함수(서버 기본값)
pub fn function(schema: &str, name: &str, signature: &str, owner: &str) -> FunctionRec {
    FunctionRec {
        schema: schema.into(),
        name: name.into(),
        signature: signature.into(),
        owner: owner.into(),
        security_definer: false,
        search_path_set: false,
        acl: vec![entry(owner, None, Execute), entry(owner, Some(owner), Execute)],
    }
}

/// 서버 기본 ACL의 데이터베이스: PUBLIC은 CONNECT·TEMPORARY, 소유자는 CONNECT·CREATE·TEMPORARY
pub fn database(name: &str, owner: &str) -> DatabaseRec {
    let acl = vec![
        entry(owner, None, Temporary),
        entry(owner, None, Connect),
        entry(owner, Some(owner), Create),
        entry(owner, Some(owner), Temporary),
        entry(owner, Some(owner), Connect),
    ];
    DatabaseRec { name: name.into(), owner: owner.into(), allow_conn: true, acl }
}

/// 역할마다 서로 다른 OID를 이름순으로 매긴다(`FIRST_ROLE_OID`부터). 이미 있던 OID는 덮어쓴다: 특정 OID가 필요한 시험은 장면을 만든 뒤 `role_mut`로 고친다
fn numbered(mut roles: Vec<RoleRec>) -> Vec<RoleRec> {
    let mut by_name: Vec<usize> = (0..roles.len()).collect();
    by_name.sort_by(|&a, &b| roles[a].name.cmp(&roles[b].name));
    for (rank, index) in by_name.into_iter().enumerate() {
        roles[index].oid = FIRST_ROLE_OID + u32::try_from(rank).expect("역할이 너무 많아요");
    }
    roles
}

/// 클러스터 스냅숏. 역할의 OID는 이름순으로 매기고(`numbered`), 부트스트랩 superuser는 `BOOTSTRAP`이며,
/// `createrole_self_grant`는 비어 있고 `restrict_password_commands`는 꺼져 있다
pub fn cluster(version_num: i32, roles: Vec<RoleRec>, members: Vec<MemberRec>, databases: Vec<DatabaseRec>) -> ClusterSnapshot {
    ClusterSnapshot {
        version_num,
        version: format!("{}.{}", version_num / 10_000, version_num % 10_000),
        password_encryption: "scram-sha-256".into(),
        login_user: "iam_admin".into(),
        roles: numbered(roles),
        members,
        databases,
        settings: Vec::new(),
        sessions: Vec::new(),
        fetched_at: "2026-10-28T00:00:00Z".into(),
        bootstrap_superuser: BOOTSTRAP.into(),
        createrole_self_grant: String::new(),
        restrict_password_commands: false,
    }
}

pub fn db(database: &str, owner: &str, schemas: Vec<SchemaRec>, relations: Vec<RelationRec>, functions: Vec<FunctionRec>) -> DbSnapshot {
    DbSnapshot {
        database: database.into(),
        owner: owner.into(),
        schemas,
        relations,
        functions,
        default_acls: Vec::new(),
        truncated: false,
        fetched_at: "2026-10-28T00:00:00Z".into(),
    }
}

/// 클러스터와 데이터베이스 하나의 스냅숏
pub struct Scene {
    pub cluster: ClusterSnapshot,
    pub db: DbSnapshot,
}

impl Scene {
    pub fn ctx(&self) -> Ctx<'_> {
        Ctx { cluster: &self.cluster, db: &self.db }
    }

    /// `스키마.이름`으로 찾는다
    pub fn relation(&self, qualified: &str) -> &RelationRec {
        self.db.relations.iter().find(|r| format!("{}.{}", r.schema, r.name) == qualified).unwrap_or_else(|| panic!("{qualified} 관계가 없어요"))
    }

    pub fn schema(&self, name: &str) -> &SchemaRec {
        self.db.schemas.iter().find(|s| s.name == name).unwrap_or_else(|| panic!("{name} 스키마가 없어요"))
    }

    /// `스키마.이름`으로 찾는다
    pub fn function(&self, qualified: &str) -> &FunctionRec {
        self.db.functions.iter().find(|f| format!("{}.{}", f.schema, f.name) == qualified).unwrap_or_else(|| panic!("{qualified} 함수가 없어요"))
    }

    /// 이 장면의 데이터베이스
    pub fn database(&self) -> &DatabaseRec {
        self.cluster.databases.iter().find(|d| d.name == self.db.database).expect("데이터베이스가 클러스터에 없어요")
    }

    pub fn role_mut(&mut self, name: &str) -> &mut RoleRec {
        self.cluster.roles.iter_mut().find(|r| r.name == name).unwrap_or_else(|| panic!("{name} 역할이 없어요"))
    }

    pub fn member_mut(&mut self, member: &str, group: &str) -> &mut MemberRec {
        self.cluster
            .members
            .iter_mut()
            .find(|m| m.member == member && m.group == group)
            .unwrap_or_else(|| panic!("{member} → {group} 구성원 관계가 없어요"))
    }
}

/// 여러 시험이 함께 쓰는 장면(`live_tests`가 Docker에 심는 장면과 같은 모양):
/// - 역할: `app_owner`(데이터베이스와 모든 객체의 소유자), `app_read`, `app_write`(`app_read`의 구성원), `alice`(`app_write`의 구성원),
///   `bob`(NOINHERIT, `app_read`의 구성원), `carol`(`pg_read_all_data`의 구성원). 시스템 역할은 목록에 넣지 않는다.
/// - 데이터베이스 `appdb`: PUBLIC의 CONNECT를 거두고 `app_read`에 부여했다.
/// - 스키마 `app`(`app_read`가 USAGE), `audit`(`app_write`가 USAGE), `scratch`(비어 있다)
/// - `app`: 테이블 `customers`·`orders`, 뷰 `order_totals`, 구체화 뷰 `order_summary`, 시퀀스 `ticket_seq`.
///   `app_read`가 읽는 것을 모두 SELECT하고, `app_write`는 `orders`에 INSERT·UPDATE, `ticket_seq`에 USAGE를 받았다.
/// - `audit`: 파티션 테이블 `events`, 외부 테이블 `remote_log`(소유자만)
/// - 함수 `app.plain`(기본값), `app.touch`(PUBLIC의 EXECUTE를 거두고 `app_write`에 부여)
pub fn app_scene(version_num: i32) -> Scene {
    let roles = vec![login("alice"), login("app_owner"), role("app_read"), role("app_write"), RoleRec { inherit: false, ..login("bob") }, login("carol")];
    // 서버는 PG16부터 부여할 때 구성원의 INHERIT 속성을 그 부여의 INHERIT 옵션으로 삼는다
    let grant = |who: &str, group: &str| {
        let inherit = roles.iter().find(|r| r.name == who).is_none_or(|r| r.inherit);
        if version_num >= MEMBERSHIP_OPTIONS_SINCE {
            member_with(who, group, inherit, true)
        } else {
            member(who, group)
        }
    };
    let members = vec![grant("alice", "app_write"), grant("app_write", "app_read"), grant("bob", "app_read"), grant("carol", "pg_read_all_data")];
    let appdb = database("appdb", "app_owner").revoke_public(&[Connect]).grant("app_read", &[Connect]);
    let schemas = vec![schema("app", "app_owner").grant("app_read", &[Usage]), schema("audit", "app_owner").grant("app_write", &[Usage]), schema("scratch", "app_owner")];
    let relations = vec![
        table("app", "customers", "app_owner").grant("app_read", &[Select]),
        relation(RelKind::MatView, "app", "order_summary", "app_owner").grant("app_read", &[Select]),
        relation(RelKind::View, "app", "order_totals", "app_owner").grant("app_read", &[Select]),
        table("app", "orders", "app_owner").grant("app_read", &[Select]).grant("app_write", &[Insert, Update]),
        relation(RelKind::Sequence, "app", "ticket_seq", "app_owner").grant("app_write", &[Usage]),
        relation(RelKind::Partitioned, "audit", "events", "app_owner"),
        relation(RelKind::Foreign, "audit", "remote_log", "app_owner"),
    ];
    let functions = vec![
        function("app", "plain", "a integer, b text", "app_owner"),
        function("app", "touch", "order_id integer", "app_owner").revoke_public(&[Execute]).grant("app_write", &[Execute]),
    ];
    Scene { cluster: cluster(version_num, roles, members, vec![appdb]), db: db("appdb", "app_owner", schemas, relations, functions) }
}

#[cfg(test)]
mod tests;
