//! 뷰 만들기(순수 함수): 읽어 둔 스냅숏과 평가기(`eval`)로 화면 계약(`view`)의 값을 만든다. 질의도 입출력도 없다.
//! 역할 요약·개요, 권한 표, 칸 상세, 객체 검색, 역할 상세, 누가 할 수 있나, 세션.
//!
//! 한 명령이 `Eval`을 한 번 만들고 역할마다 `eval.role(이름)`을 한 번 만든다. 객체마다 `Ctx`의 메서드를 부르면 매번 역할 그래프를 새로 만든다.
//! 목록은 서버의 정렬(데이터베이스의 collation)에 기대지 않고 이름의 바이트 순서로 정한다.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use super::eval::{schema_cells, who_can, Coverage, Ctx, Eval, Obj, RoleView, SchemaCell, SourceKind};
use super::model::{
    AclEntry, ClusterSnapshot, DbSnapshot, DefaultAclRec, DefaultObjType, FunctionRec, MemberRec, Privilege, RelKind, RelationRec, RoleRec, SessionRec,
};
use super::target::PgTargetInfo;
use super::view::{
    PgAttributes, PgBadge, PgBadgeKind, PgBadgeLevel, PgCellDetail, PgCellObject, PgDatabaseInfo, PgDatabaseView, PgDbPrivilegeRow, PgDbValues,
    PgDefaultAclRow, PgDefaultGrant, PgDefaultObjectType, PgMembership, PgObjectKind, PgObjectRef, PgOverview, PgPrivilegeGrant, PgRoleDatabase, PgRoleKind,
    PgRoleMember, PgRoleSetting, PgRoleSummary, PgRoleView, PgSchemaInfo, PgSession, PgWhoCan, PgWhoCanRow,
};
use crate::error::AppError;
use crate::iam::clock::{parse_iso, DAY_SECS};

pub const RDS_SUPERUSER: &str = "rds_superuser";
pub const RDS_IAM: &str = "rds_iam";

const MANAGE_REASON: &str = "이 사용자는 rds_superuser 멤버가 아니고 CREATEROLE도 없어서 바꿀 수 없어요";
/// 로그인 사용자가 `rds_superuser`의 직접 구성원이거나 `SET ROLE`을 한 뒤에 그 권한을 쓰는 경우의 이유. 문장은 `SET ROLE` 없이 돌아서 바꿀 수 없지만,
/// 역할 목록은 이 사용자를 관리자급으로 보이니 "멤버가 아니다"라고 하면 틀린 말이다
const MANAGE_REASON_SET_ROLE: &str = "이 사용자는 SET ROLE로만 rds_superuser 권한을 쓸 수 있어서 바꿀 수 없어요";

/// 만료까지 이 일수 안이면 "곧 만료"다
pub const EXPIRING_SOON_DAYS: i64 = 30;
/// 객체 검색 결과의 상한
pub const MAX_SEARCH_RESULTS: usize = 100;
/// 칸 상세 하나에 담는 객체의 상한
pub const MAX_CELL_OBJECTS: usize = 2_000;
/// 역할 상세가 데이터베이스마다 나열하는 소유 객체의 상한
pub const MAX_OWNED: usize = 200;

/// 테이블 종류 관계(뷰·구체화 뷰·파티션 테이블·외부 테이블 포함)의 권한, 시퀀스의 권한, 함수의 권한: 칸 상세가 나열하는 순서다.
/// MAINTAIN은 PG17부터 있다. 그 전 서버에서는 평가기가 없는 권한으로 보아 출처가 비어 나오므로 칸 상세에 나오지 않는다.
const RELATION_PRIVILEGES: [Privilege; 8] =
    [Privilege::Select, Privilege::Insert, Privilege::Update, Privilege::Delete, Privilege::Truncate, Privilege::References, Privilege::Trigger, Privilege::Maintain];
const SEQUENCE_PRIVILEGES: [Privilege; 3] = [Privilege::Usage, Privilege::Select, Privilege::Update];
const FUNCTION_PRIVILEGES: [Privilege; 1] = [Privilege::Execute];

/// 시스템 역할: 이름이 `pg_`나 `rds_`로 시작하거나 `rdsadmin`, `rdstopmgr`, `rdsrepladmin`
pub fn is_system_role(name: &str) -> bool {
    name.starts_with("pg_") || name.starts_with("rds_") || matches!(name, "rdsadmin" | "rdstopmgr" | "rdsrepladmin")
}

/// 역할·스키마·객체를 찾을 수 없다는 오류의 문구는 모두 같은 꼴이다: "…을 찾을 수 없어요: 이름". 한 탭에서 한 가지 말을 쓴다
fn unknown_role(role: &str) -> AppError {
    AppError::other(format!("역할을 찾을 수 없어요: {role}"))
}

// ───────────────────────── 만료 ─────────────────────────

/// 만료 시각이 지금(`now`, 유닉스 초)에서 어디쯤인가
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Expiry {
    /// 만료 시각이 없거나(읽지 못하는 시각도 여기다) 30일보다 뒤다
    Later,
    /// 이미 지났다
    Expired,
    /// 지금부터 30일 안이다(지금 만료되는 역할도 아직은 여기다)
    Soon,
}

pub fn expiry_of(valid_until: Option<&str>, now: i64) -> Expiry {
    match valid_until.and_then(parse_iso) {
        Some(until) if until < now => Expiry::Expired,
        Some(until) if until - now <= EXPIRING_SOON_DAYS * DAY_SECS => Expiry::Soon,
        _ => Expiry::Later,
    }
}

// ───────────────────────── 역할 요약, 개요 ─────────────────────────

/// 역할 요약을 만드는 데 한 번 만들어 두는 것: 역할 그래프와 구성원 관계·세션의 색인
struct Index<'a> {
    cluster: &'a ClusterSnapshot,
    eval: Eval<'a>,
    /// 구성원 → 그 구성원이 직접 속한 관계들
    groups_of: HashMap<&'a str, Vec<&'a MemberRec>>,
    /// 그룹 → 직접 구성원의 수
    member_counts: HashMap<&'a str, usize>,
    /// 역할 → 그 역할의 세션 수
    session_counts: HashMap<&'a str, usize>,
}

impl<'a> Index<'a> {
    fn new(cluster: &'a ClusterSnapshot) -> Index<'a> {
        let mut groups_of: HashMap<&str, Vec<&MemberRec>> = HashMap::new();
        let mut member_counts: HashMap<&str, usize> = HashMap::new();
        for m in &cluster.members {
            groups_of.entry(&m.member).or_default().push(m);
            *member_counts.entry(&m.group).or_default() += 1;
        }
        let mut session_counts: HashMap<&str, usize> = HashMap::new();
        for role in cluster.sessions.iter().filter_map(|s| s.role.as_deref()) {
            *session_counts.entry(role).or_default() += 1;
        }
        Index { cluster, eval: Eval::for_cluster(cluster), groups_of, member_counts, session_counts }
    }

    fn summary(&self, role: &RoleRec, now: i64) -> PgRoleSummary {
        self.summary_of(role, &self.eval.role(&role.name), now)
    }

    /// `view`는 이 역할의 계산이다. 역할 상세는 같은 계산을 `setRoleOnly`에도 써서 역할 하나에 한 번만 만든다
    fn summary_of(&self, role: &RoleRec, view: &RoleView, now: i64) -> PgRoleSummary {
        let name = role.name.as_str();
        let direct: &[&MemberRec] = self.groups_of.get(name).map_or(&[][..], Vec::as_slice);
        // 직접 구성원이거나(상속 여부와 상관없이), 상속하는 구성원 관계로 닿는 구성원이다. 자기 자신은 구성원이 아니다
        let inherited = view.inherited();
        let is_member = |group: &str| direct.iter().any(|m| m.group == group) || inherited.iter().any(|i| i.role == group && !i.path.is_empty());
        // 상속하지 않아도 `SET ROLE`을 한 뒤에 그 그룹의 권한을 쓰면 쓰는 것이다. `SET ROLE`로 되어 볼 수 있는 역할(PG16부터는 사슬의 모든 관계에
        // SET 옵션이 있어야 한다)이 상속하는 역할까지 본다: `GRANT g TO dba WITH INHERIT TRUE, SET FALSE`여도 dba로 SET ROLE을 하면 g의 권한을 쓴다
        let after_set = view.usable_after_set_role();
        let can_use = |group: &str| is_member(group) || after_set.contains(group);

        let mut member_of: Vec<PgMembership> = direct
            .iter()
            .map(|m| PgMembership {
                group: m.group.clone(),
                inherit: self.eval.membership_inherits(&m.member, &m.group),
                set: self.eval.membership_can_set(&m.member, &m.group),
                admin: m.admin,
            })
            .collect();
        member_of.sort_by(|a, b| a.group.cmp(&b.group));

        PgRoleSummary {
            name: role.name.clone(),
            kind: role_kind(role),
            system: is_system_role(name),
            attributes: PgAttributes {
                login: role.login,
                create_db: role.create_db,
                create_role: role.create_role,
                inherit: role.inherit,
                replication: role.replication,
                bypass_rls: role.bypass_rls,
                connection_limit: role.conn_limit,
                valid_until: role.valid_until.clone(),
            },
            member_of,
            member_count: self.member_counts.get(name).copied().unwrap_or(0),
            session_count: self.session_counts.get(name).copied().unwrap_or(0),
            badges: badges(role, can_use(RDS_SUPERUSER), is_member(RDS_IAM), &self.cluster.login_user, now),
            comment: role.comment.clone(),
        }
    }
}

fn role_kind(role: &RoleRec) -> PgRoleKind {
    if role.login {
        PgRoleKind::User
    } else {
        PgRoleKind::Group
    }
}

fn badge(kind: PgBadgeKind, label: &str, level: PgBadgeLevel) -> PgBadge {
    PgBadge { kind, label: label.to_string(), level }
}

/// 배지는 이 순서로 붙는다: 관리자급, IAM 인증, CREATEROLE, CREATEDB, BYPASSRLS, REPLICATION, 만료됨·곧 만료, 앱이 로그인한 역할
fn badges(role: &RoleRec, admin: bool, iam: bool, login_user: &str, now: i64) -> Vec<PgBadge> {
    let mut badges = Vec::new();
    if admin {
        badges.push(badge(PgBadgeKind::Admin, "관리자급", PgBadgeLevel::High));
    }
    if iam {
        badges.push(badge(PgBadgeKind::IamAuth, "IAM 인증", PgBadgeLevel::Info));
    }
    if role.create_role {
        badges.push(badge(PgBadgeKind::CreateRole, "CREATEROLE", PgBadgeLevel::Medium));
    }
    if role.create_db {
        badges.push(badge(PgBadgeKind::CreateDb, "CREATEDB", PgBadgeLevel::Info));
    }
    if role.bypass_rls {
        badges.push(badge(PgBadgeKind::BypassRls, "BYPASSRLS", PgBadgeLevel::Medium));
    }
    if role.replication {
        badges.push(badge(PgBadgeKind::Replication, "REPLICATION", PgBadgeLevel::Info));
    }
    match expiry_of(role.valid_until.as_deref(), now) {
        Expiry::Expired => badges.push(badge(PgBadgeKind::Expired, "만료됨", PgBadgeLevel::Medium)),
        Expiry::Soon => badges.push(badge(PgBadgeKind::ExpiringSoon, "곧 만료", PgBadgeLevel::Info)),
        Expiry::Later => {}
    }
    if role.name == login_user {
        badges.push(badge(PgBadgeKind::LoginRole, "앱이 로그인한 역할", PgBadgeLevel::Info));
    }
    badges
}

impl Index<'_> {
    /// 모든 역할의 요약. 스냅숏의 순서를 지킨다
    fn summaries(&self, now: i64) -> Vec<PgRoleSummary> {
        self.cluster.roles.iter().map(|role| self.summary(role, now)).collect()
    }
}

/// 모든 역할의 요약. 스냅숏의 순서(이름순)를 지킨다. `now`는 유닉스 초다.
/// 명령은 `overview`가 같은 색인(`Index`)을 나눠 쓰고, 이 한 줄 포장은 시험이 역할 요약만 물을 때 쓴다.
#[cfg(test)]
pub fn role_summaries(cluster: &ClusterSnapshot, now: i64) -> Vec<PgRoleSummary> {
    Index::new(cluster).summaries(now)
}

/// 탭을 열 때 한 번 받는 개요. 로그인 사용자가 `rds_superuser`의 권한을 상속하거나 CREATEROLE이 있거나 superuser면 관리할 수 있다.
/// 관리할 수 없을 때의 이유는 둘이다: `rds_superuser`의 직접 구성원이거나 `SET ROLE`을 하면 그 권한을 쓰는 사용자는 `SET ROLE`로만 쓴다는 이유(역할 목록이
/// 관리자급으로 보이는 사용자와 말이 맞는다), 그 밖에는 멤버가 아니고 CREATEROLE도 없다는 이유다.
pub fn overview(info: &PgTargetInfo, cluster: &ClusterSnapshot, now: i64) -> PgOverview {
    // 역할 요약과 같은 `Eval`을 쓴다
    let index = Index::new(cluster);
    let login = cluster.roles.iter().find(|r| r.name == cluster.login_user);
    let view = index.eval.role(&cluster.login_user);
    let inherits_admin = view.inherited().iter().any(|i| i.role == RDS_SUPERUSER);
    let can_manage = inherits_admin || login.is_some_and(|r| r.create_role || r.superuser);
    let direct_admin = index.groups_of.get(cluster.login_user.as_str()).is_some_and(|groups| groups.iter().any(|m| m.group == RDS_SUPERUSER));
    let reason = if direct_admin || view.usable_after_set_role().contains(RDS_SUPERUSER) { MANAGE_REASON_SET_ROLE } else { MANAGE_REASON };
    PgOverview {
        target: info.clone(),
        login_user: cluster.login_user.clone(),
        server_version: cluster.version.clone(),
        server_version_num: cluster.version_num,
        password_encryption: cluster.password_encryption.clone(),
        fetched_at: cluster.fetched_at.clone(),
        roles: index.summaries(now),
        databases: cluster.databases.iter().map(|d| PgDatabaseInfo { name: d.name.clone(), owner: d.owner.clone(), allow_conn: d.allow_conn }).collect(),
        can_manage,
        manage_reason: (!can_manage).then(|| reason.to_string()),
    }
}

// ───────────────────────── 권한 표 ─────────────────────────

fn default_object_type(obj_type: DefaultObjType) -> PgDefaultObjectType {
    match obj_type {
        DefaultObjType::Tables => PgDefaultObjectType::Tables,
        DefaultObjType::Sequences => PgDefaultObjectType::Sequences,
        DefaultObjType::Functions => PgDefaultObjectType::Functions,
        DefaultObjType::Types => PgDefaultObjectType::Types,
        DefaultObjType::Schemas => PgDefaultObjectType::Schemas,
    }
}

/// 기본 권한 한 항목의 받는 쪽들. 받는 쪽은 PUBLIC이 먼저고 그다음 이름순이며, 같은 받는 쪽이라도 부여 옵션이 있는 것은 따로 낸다.
/// 권한은 `Privilege`의 순서(SELECT, INSERT …)로, 부여자가 달라 겹치는 것은 한 번만 낸다.
fn default_grants(acl: &[AclEntry]) -> Vec<PgDefaultGrant> {
    let mut grouped: BTreeMap<(bool, &str, bool), BTreeSet<Privilege>> = BTreeMap::new();
    for entry in acl {
        let grantee = entry.grantee.as_deref();
        grouped.entry((grantee.is_some(), grantee.unwrap_or_default(), entry.grantable)).or_default().insert(entry.privilege);
    }
    grouped
        .into_iter()
        .map(|((named, grantee, grantable), privileges)| PgDefaultGrant {
            grantee: if named { grantee.to_string() } else { "PUBLIC".to_string() },
            privileges: privileges.into_iter().map(|p| p.as_str().to_string()).collect(),
            grantable,
        })
        .collect()
}

/// 기본 권한 행들: (만드는 역할, 스키마(모든 스키마는 뒤), 객체 종류) 순서
pub(crate) fn default_rows(default_acls: &[DefaultAclRec]) -> Vec<PgDefaultAclRow> {
    let mut rows: Vec<PgDefaultAclRow> = default_acls
        .iter()
        .map(|d| PgDefaultAclRow {
            creator: d.creator.clone(),
            schema: d.schema.clone(),
            object_type: default_object_type(d.obj_type),
            grants: default_grants(&d.acl),
        })
        .collect();
    let key = |row: &PgDefaultAclRow| (row.creator.clone(), row.schema.is_none(), row.schema.clone(), row.object_type);
    rows.sort_by_key(key);
    rows
}

/// 데이터베이스 하나의 권한 표: 모든 역할(시스템 역할 포함) × 모든 스키마의 칸, 데이터베이스 수준 권한, 스키마, 기본 권한
pub fn database_view(cluster: &ClusterSnapshot, db: &DbSnapshot) -> PgDatabaseView {
    let ctx = Ctx { cluster, db };
    let eval = Eval::new(&ctx);
    let database = cluster.databases.iter().find(|d| d.name == db.database);
    let names: Vec<&str> = cluster.roles.iter().map(|r| r.name.as_str()).collect();

    // 클러스터에 없는 데이터베이스는 권한을 판단할 수 없다: 만들어 낸 답 대신 모두 false다.
    // `direct`와 `owned`는 같은 출처 가운데 직접 받은 것과 소유자로서 가진 것만 센다(칸의 `direct`, `owned`와 같은 규칙)
    let db_privileges = names
        .iter()
        .map(|&name| {
            let view = eval.role(name);
            let sources = [Privilege::Connect, Privilege::Create, Privilege::Temporary].map(|p| database.map_or_else(Vec::new, |d| view.sources(Obj::Database(d), p)));
            // `kind`가 None이면 출처가 하나라도 있는가, 아니면 그 종류의 출처가 있는가
            let values = |kind: Option<SourceKind>| {
                let [connect, create, temp] = sources.each_ref().map(|found| found.iter().any(|s| kind.is_none_or(|kind| s.kind == kind)));
                PgDbValues { connect, create, temp }
            };
            let shown = values(None);
            PgDbPrivilegeRow {
                role: name.to_string(),
                connect: shown.connect,
                create: shown.create,
                temp: shown.temp,
                direct: values(Some(SourceKind::Direct)),
                owned: values(Some(SourceKind::Owner)),
            }
        })
        .collect();

    let mut tables: HashMap<&str, usize> = HashMap::new();
    for rel in db.relations.iter().filter(|r| matches!(r.kind, RelKind::Table | RelKind::Partitioned)) {
        *tables.entry(&rel.schema).or_default() += 1;
    }
    let mut schemas: Vec<PgSchemaInfo> = db
        .schemas
        .iter()
        .map(|s| PgSchemaInfo { name: s.name.clone(), owner: s.owner.clone(), table_count: tables.get(s.name.as_str()).copied().unwrap_or(0) })
        .collect();
    schemas.sort_by(|a, b| a.name.cmp(&b.name));

    PgDatabaseView {
        database: db.database.clone(),
        fetched_at: db.fetched_at.clone(),
        truncated: db.truncated,
        db_privileges,
        schemas,
        cells: schema_cells(&eval, &ctx, &names).into_iter().map(Into::into).collect(),
        default_privileges: default_rows(&db.default_acls),
    }
}

// ───────────────────────── 칸 상세 ─────────────────────────

/// 가진 권한과 그 출처. `privileges`의 순서를 지키고, 권한이 없으면 비어 있다.
fn held(view: &RoleView, obj: Obj, privileges: &[Privilege]) -> Vec<PgPrivilegeGrant> {
    privileges
        .iter()
        .filter_map(|&p| {
            let sources = view.sources(obj, p);
            (!sources.is_empty()).then(|| PgPrivilegeGrant { privilege: p.as_str().to_string(), sources })
        })
        .collect()
}

/// 칸 상세에서 한 객체를 줄 세우는 열쇠: 이름, 관계가 함수보다 먼저, 같은 이름의 함수는 인자 목록 순서
enum Candidate<'a> {
    Relation(&'a RelationRec),
    Function(&'a FunctionRec),
}

impl Candidate<'_> {
    fn key(&self) -> (&str, u8, &str) {
        match self {
            Candidate::Relation(rel) => (&rel.name, 0, ""),
            Candidate::Function(function) => (&function.name, 1, &function.signature),
        }
    }
}

/// 역할 × 스키마 칸 하나를 눌렀을 때의 상세: 그 스키마의 객체 가운데 이 역할이 권한을 가진 것만, 이름순으로 최대 2천 개.
/// 스냅숏 자체가 객체 상한에 걸려 잘렸으면 칸도 일부만 본 것이라 `truncated`를 켠다.
pub fn cell_detail(cluster: &ClusterSnapshot, db: &DbSnapshot, role: &str, schema: &str) -> Result<PgCellDetail, AppError> {
    if !cluster.roles.iter().any(|r| r.name == role) {
        return Err(unknown_role(role));
    }
    if !db.schemas.iter().any(|s| s.name == schema) {
        return Err(AppError::other(format!("스키마를 찾을 수 없어요: {schema}")));
    }
    let ctx = Ctx { cluster, db };
    let eval = Eval::new(&ctx);
    let view = eval.role(role);

    let mut candidates: Vec<Candidate> = db.relations.iter().filter(|r| r.schema == schema).map(Candidate::Relation).collect();
    candidates.extend(db.functions.iter().filter(|f| f.schema == schema).map(Candidate::Function));
    candidates.sort_by(|a, b| a.key().cmp(&b.key()));

    let mut objects = Vec::new();
    let mut truncated = db.truncated;
    for candidate in candidates {
        let (object, owner, rls, privileges) = match candidate {
            Candidate::Relation(rel) => {
                let list: &[Privilege] = if rel.kind == RelKind::Sequence { &SEQUENCE_PRIVILEGES } else { &RELATION_PRIVILEGES };
                (PgObjectRef::relation(rel), &rel.owner, rel.rls, held(&view, Obj::Relation(rel), list))
            }
            Candidate::Function(function) => (PgObjectRef::function(function), &function.owner, false, held(&view, Obj::Function(function), &FUNCTION_PRIVILEGES)),
        };
        if privileges.is_empty() {
            continue;
        }
        if objects.len() == MAX_CELL_OBJECTS {
            truncated = true;
            break;
        }
        objects.push(PgCellObject { object, owner: owner.clone(), rls, privileges });
    }
    Ok(PgCellDetail { role: role.to_string(), schema: schema.to_string(), objects, truncated })
}

// ───────────────────────── 객체 검색 ─────────────────────────

/// `schema.name`(데이터베이스와 스키마는 이름)에 `query`가 들어 있는 객체를 대소문자 없이 찾는다. 데이터베이스, 스키마, 관계, 함수 순서고
/// 각각 이름순이며, 모두 합쳐 100개까지다. 빈 질의는 모든 객체에 맞아서 앞의 100개를 돌려준다.
pub fn search_objects(cluster: &ClusterSnapshot, db: &DbSnapshot, query: &str) -> Vec<PgObjectRef> {
    let needle = query.to_lowercase();
    let hit = |text: &str| text.to_lowercase().contains(&needle);

    let mut databases: Vec<&str> = cluster.databases.iter().map(|d| d.name.as_str()).filter(|name| hit(name)).collect();
    databases.sort_unstable();
    let mut schemas: Vec<&str> = db.schemas.iter().map(|s| s.name.as_str()).filter(|name| hit(name)).collect();
    schemas.sort_unstable();
    let mut relations: Vec<&RelationRec> = db.relations.iter().filter(|r| hit(&format!("{}.{}", r.schema, r.name))).collect();
    relations.sort_by(|a, b| (&a.schema, &a.name).cmp(&(&b.schema, &b.name)));
    let mut functions: Vec<&FunctionRec> = db.functions.iter().filter(|f| hit(&format!("{}.{}", f.schema, f.name))).collect();
    functions.sort_by(|a, b| (&a.schema, &a.name, &a.signature).cmp(&(&b.schema, &b.name, &b.signature)));

    databases
        .into_iter()
        .map(PgObjectRef::database)
        .chain(schemas.into_iter().map(PgObjectRef::schema))
        .chain(relations.into_iter().map(PgObjectRef::relation))
        .chain(functions.into_iter().map(PgObjectRef::function))
        .take(MAX_SEARCH_RESULTS)
        .collect()
}

// ───────────────────────── 역할 상세 ─────────────────────────

fn session_view(record: &SessionRec, own_pids: &[i32]) -> PgSession {
    PgSession {
        pid: record.pid,
        role: record.role.clone(),
        database: record.database.clone(),
        client_addr: record.client_addr.clone(),
        application_name: record.application_name.clone(),
        state: record.state.clone(),
        backend_start: record.backend_start.clone(),
        query_start: record.query_start.clone(),
        wait_event: record.wait_event.clone(),
        own: own_pids.contains(&record.pid),
    }
}

/// 보이는 권한이 하나라도 있는 칸인가
fn shows_something(cell: &SchemaCell) -> bool {
    cell.usage || cell.create || cell.read != Coverage::None || cell.write != Coverage::None
}

/// 이 역할이 소유한 객체: 스키마, 테이블 종류 관계, 시퀀스, 함수 순서로 각각 이름순이다. 앞의 `MAX_OWNED`개와 나머지의 수
fn owned_objects(db: &DbSnapshot, role: &str) -> (Vec<PgObjectRef>, usize) {
    let mut schemas: Vec<&str> = db.schemas.iter().filter(|s| s.owner == role).map(|s| s.name.as_str()).collect();
    schemas.sort_unstable();
    let (mut sequences, mut tables): (Vec<&RelationRec>, Vec<&RelationRec>) =
        db.relations.iter().filter(|r| r.owner == role).partition(|r| r.kind == RelKind::Sequence);
    for list in [&mut sequences, &mut tables] {
        list.sort_by(|a, b| (&a.schema, &a.name).cmp(&(&b.schema, &b.name)));
    }
    let mut functions: Vec<&FunctionRec> = db.functions.iter().filter(|f| f.owner == role).collect();
    functions.sort_by(|a, b| (&a.schema, &a.name, &a.signature).cmp(&(&b.schema, &b.name, &b.signature)));

    let total = schemas.len() + tables.len() + sequences.len() + functions.len();
    let owned: Vec<PgObjectRef> = schemas
        .into_iter()
        .map(PgObjectRef::schema)
        .chain(tables.into_iter().map(PgObjectRef::relation))
        .chain(sequences.into_iter().map(PgObjectRef::relation))
        .chain(functions.into_iter().map(PgObjectRef::function))
        .take(MAX_OWNED)
        .collect();
    let omitted = total - owned.len();
    (owned, omitted)
}

fn role_database(cluster: &ClusterSnapshot, db: &DbSnapshot, role: &str) -> PgRoleDatabase {
    let ctx = Ctx { cluster, db };
    let cells = schema_cells(&Eval::new(&ctx), &ctx, &[role]).into_iter().filter(shows_something).map(Into::into).collect();
    let (owned, owned_omitted) = owned_objects(db, role);
    PgRoleDatabase { database: db.database.clone(), loaded: true, truncated: db.truncated, cells, owned, owned_omitted }
}

/// 역할 하나의 상세. 새로 읽는 것은 없다: 클러스터 스냅숏과, 이미 읽어 둔 데이터베이스 스냅숏(`loaded`)만 쓴다.
/// `databases`는 연결할 수 있는 모든 데이터베이스고, 읽어 두지 않은 곳은 `loaded: false`에 나머지가 비어 있다.
pub fn role_view(cluster: &ClusterSnapshot, loaded: &[&DbSnapshot], role: &str, now: i64, own_pids: &[i32]) -> Result<PgRoleView, AppError> {
    let index = Index::new(cluster);
    let rec = cluster.roles.iter().find(|r| r.name == role).ok_or_else(|| unknown_role(role))?;
    // 이 역할의 계산은 한 번만 만들어 요약과 `setRoleOnly`가 나눠 쓴다
    let view = index.eval.role(role);

    let mut settings: Vec<PgRoleSetting> = cluster
        .settings
        .iter()
        .filter(|s| s.role.as_deref().is_none_or(|owner| owner == role))
        .map(|s| PgRoleSetting { database: s.database.clone(), setting: s.setting.clone(), all_roles: s.role.is_none() })
        .collect();
    settings.sort_by(|a, b| (&a.database, &a.setting).cmp(&(&b.database, &b.setting)));

    let mut members: Vec<PgRoleMember> = cluster
        .members
        .iter()
        .filter(|m| m.group == role)
        .map(|m| PgRoleMember {
            role: m.member.clone(),
            inherit: index.eval.membership_inherits(&m.member, &m.group),
            set: index.eval.membership_can_set(&m.member, &m.group),
            admin: m.admin,
        })
        .collect();
    members.sort_by(|a, b| a.role.cmp(&b.role));

    let databases = cluster
        .databases
        .iter()
        .filter(|d| d.allow_conn)
        .map(|d| match loaded.iter().find(|snapshot| snapshot.database == d.name) {
            Some(snapshot) => role_database(cluster, snapshot, role),
            None => PgRoleDatabase { database: d.name.clone(), loaded: false, truncated: false, cells: Vec::new(), owned: Vec::new(), owned_omitted: 0 },
        })
        .collect();

    Ok(PgRoleView {
        summary: index.summary_of(rec, &view, now),
        settings,
        members,
        databases,
        sessions: cluster.sessions.iter().filter(|s| s.role.as_deref() == Some(role)).map(|s| session_view(s, own_pids)).collect(),
        set_role_only: view.set_role_only(),
    })
}

// ───────────────────────── 누가 할 수 있나, 세션 ─────────────────────────

/// 권한 이름을 읽는다. 서버가 `aclexplode`로 풀어 주는 이름("TEMPORARY"이지 "TEMP"가 아니다)만 받고, 다른 이름은 오류다.
pub fn parse_privilege(name: &str) -> Result<Privilege, AppError> {
    Privilege::from_pg(name).ok_or_else(|| AppError::other(format!("알 수 없는 권한이에요: {name}")))
}

/// 사람이 읽는 객체 이름: `schema.name`(데이터베이스와 스키마는 이름만), 함수는 인자까지
fn object_text(object: &PgObjectRef) -> String {
    let base = match (&object.schema, object.kind) {
        (Some(schema), kind) if !matches!(kind, PgObjectKind::Database | PgObjectKind::Schema) => format!("{schema}.{}", object.name),
        _ => object.name.clone(),
    };
    match &object.signature {
        Some(signature) => format!("{base}({signature})"),
        None => base,
    }
}

/// 가리키는 객체를 스냅숏에서 찾는다. 돌려주는 `PgObjectRef`는 스냅숏의 것이다(관계는 종류도 스냅숏의 것).
fn resolve<'a>(cluster: &'a ClusterSnapshot, db: &'a DbSnapshot, object: &PgObjectRef) -> Option<(Obj<'a>, PgObjectRef)> {
    let (schema, name) = (object.schema.as_deref(), object.name.as_str());
    match object.kind {
        PgObjectKind::Database => cluster.databases.iter().find(|d| d.name == name).map(|d| (Obj::Database(d), PgObjectRef::database(&d.name))),
        PgObjectKind::Schema => db.schemas.iter().find(|s| s.name == name).map(|s| (Obj::Schema(s), PgObjectRef::schema(&s.name))),
        PgObjectKind::Function => db
            .functions
            .iter()
            .find(|f| Some(f.schema.as_str()) == schema && f.name == name && Some(f.signature.as_str()) == object.signature.as_deref())
            .map(|f| (Obj::Function(f), PgObjectRef::function(f))),
        _ => db.relations.iter().find(|r| Some(r.schema.as_str()) == schema && r.name == name).map(|r| (Obj::Relation(r), PgObjectRef::relation(r))),
    }
}

/// 한 객체에 한 권한을 가진 역할들. 그 객체를 스냅숏에서 찾지 못하면 오류고, 그 객체에 없는 권한이면 빈 목록이다.
pub fn who_can_view(cluster: &ClusterSnapshot, db: &DbSnapshot, object: &PgObjectRef, privilege: Privilege) -> Result<PgWhoCan, AppError> {
    let (obj, canonical) = resolve(cluster, db, object).ok_or_else(|| AppError::other(format!("객체를 찾을 수 없어요: {}", object_text(object))))?;
    let logins: HashMap<&str, bool> = cluster.roles.iter().map(|r| (r.name.as_str(), r.login)).collect();
    let allowed = who_can(&Ctx { cluster, db }, obj, privilege)
        .into_iter()
        .map(|row| PgWhoCanRow {
            kind: if logins.get(row.role.as_str()).copied().unwrap_or(false) { PgRoleKind::User } else { PgRoleKind::Group },
            system: is_system_role(&row.role),
            role: row.role,
            sources: row.sources,
            unusable: row.unusable.map(str::to_string),
        })
        .collect();
    Ok(PgWhoCan { object: canonical, privilege: privilege.as_str().to_string(), allowed })
}

/// 세션 목록. 서버가 준 순서를 지키고, 이 앱이 연 연결(`own_pids`)에 표시한다.
pub fn sessions(records: &[SessionRec], own_pids: &[i32]) -> Vec<PgSession> {
    records.iter().map(|record| session_view(record, own_pids)).collect()
}

#[cfg(test)]
mod tests;
