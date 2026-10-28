//! 보안 점검(순수 함수): 클러스터 스냅숏과 읽어 둔 데이터베이스 스냅숏들을 보고 설계 문서의 열 가지를 찾는다. 질의도 입출력도 없다.
//!
//! - 클러스터 전체에서: `rds_superuser` 멤버, CREATEROLE, BYPASSRLS, 만료됐거나 곧 만료되는 사용자, 그룹도 권한도 없는 사용자, `password_encryption`
//! - 데이터베이스마다: PUBLIC이 만들 수 있는 스키마, PUBLIC이 권한을 받는 관계, 기본 권한의 빈틈, search_path를 고정하지 않은 SECURITY DEFINER 함수
//!
//! 항목 하나는 가리키는 역할·데이터베이스·객체를 따로 담는다(화면이 링크로 보인다). 그래서 `detail`은 그 이름을 되풀이하지 않는다.
//! 다만 기본 권한의 빈틈은 만드는 역할이 항목의 어느 칸에도 없어서 문장 안에 이름이 든다. 이름 뒤에 "역할"을 붙여 조사를 고르지 않는다.
//! 항목은 서버의 정렬에 기대지 않고 이름의 바이트 순서로 낸다. 객체마다 평가기에 묻는 일은 `Eval` 하나로 한다(`Ctx`의 메서드를 반복해 부르지 않는다).

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use super::eval::{Ctx, Eval, Obj, SourceKind};
use super::model::{AclEntry, ClusterSnapshot, DbSnapshot, DefaultObjType, Privilege, RelKind, RelationRec, RoleRec};
use super::summary::{expiry_of, is_system_role, Expiry, RDS_IAM, RDS_SUPERUSER};
use super::view::{PgFinding, PgFindingGroup, PgFindingKind, PgFindingLevel, PgFindings, PgObjectRef, PgSkippedDatabase};
use crate::iam::clock::{iso, parse_iso};

/// 점검 표: 종류, 제목, 심각도. 순서는 `PgFindingKind`의 선언 순서와 같고, 같은 심각도 안에서는 이 순서로 나온다.
const TABLE: [(PgFindingKind, &str, PgFindingLevel); 10] = [
    (PgFindingKind::PublicSchemaCreate, "PUBLIC이 스키마에 객체를 만들 수 있어요", PgFindingLevel::High),
    (PgFindingKind::PublicObjectGrant, "PUBLIC에 테이블·시퀀스 권한이 있어요", PgFindingLevel::Medium),
    (PgFindingKind::RdsSuperuser, "rds_superuser 멤버", PgFindingLevel::High),
    (PgFindingKind::CreateRole, "CREATEROLE을 가진 역할", PgFindingLevel::Medium),
    (PgFindingKind::BypassRls, "BYPASSRLS를 가진 역할", PgFindingLevel::Medium),
    (PgFindingKind::ExpiringLogin, "만료됐거나 곧 만료되는 사용자", PgFindingLevel::Low),
    (PgFindingKind::EmptyLogin, "그룹도 권한도 없는 사용자", PgFindingLevel::Low),
    (PgFindingKind::DefaultPrivilegeGap, "새 테이블에는 권한이 없는 역할", PgFindingLevel::Medium),
    (PgFindingKind::SecurityDefinerPath, "search_path를 고정하지 않은 SECURITY DEFINER 함수", PgFindingLevel::High),
    (PgFindingKind::Md5Encryption, "password_encryption이 md5예요", PgFindingLevel::Medium),
];

const PUBLIC_SCHEMA_CREATE: &str = "모든 역할(PUBLIC)이 이 스키마에 객체를 만들 수 있어요";
const RDS_SUPERUSER_DIRECT: &str = "rds_superuser의 직접 구성원이에요";
const RDS_SUPERUSER_SET_ROLE: &str = "SET ROLE로 rds_superuser 권한을 쓸 수 있어요";
const CREATE_ROLE: &str = "역할을 만들고 바꿀 수 있어요";
/// PG15 이하에서는 CREATEROLE이 다른 역할(관리자급 포함)의 속성과 구성원 관계까지 바꿀 수 있다
const CREATE_ROLE_BEFORE_PG16: &str = " PG15 이하에서는 거의 관리자급이에요";
const BYPASS_RLS: &str = "행 수준 보안 정책을 건너뛰고 모든 행을 읽고 쓸 수 있어요";
const EMPTY_LOGIN: &str = "로그인할 수 있지만 속한 그룹도, 받은 권한도, 가진 객체도 없어요";
const SECURITY_DEFINER_PATH: &str = "SECURITY DEFINER 함수인데 search_path를 고정하지 않았어요";
const MD5_ENCRYPTION: &str = "새 비밀번호가 md5 해시로 저장돼요. 파라미터 그룹에서 password_encryption을 scram-sha-256으로 바꾸세요";

/// `CREATEROLE`의 힘이 달라지는 서버 버전(PG16)
const CREATE_ROLE_SCOPED_SINCE: i32 = 160_000;

fn finding(database: Option<&str>, role: Option<&str>, object: Option<PgObjectRef>, detail: impl Into<String>) -> PgFinding {
    PgFinding { database: database.map(str::to_string), role: role.map(str::to_string), object, detail: detail.into() }
}

/// 역할만 가리키는 항목
fn role_finding(role: &RoleRec, detail: impl Into<String>) -> PgFinding {
    finding(None, Some(&role.name), None, detail)
}

/// 한 번 읽어 둔 스냅숏들로 점검한다. `dbs`는 읽은 데이터베이스들(이름순으로 주면 그 순서로 나온다), `skipped`는 읽지 못한 데이터베이스와 이유다.
/// 항목이 있는 그룹만 심각도 높은 순으로, 같은 심각도 안에서는 `TABLE`의 순서로 돌려준다. `now`는 유닉스 초다.
pub fn findings(cluster: &ClusterSnapshot, dbs: &[&DbSnapshot], skipped: Vec<PgSkippedDatabase>, now: i64) -> PgFindings {
    let mut roles: Vec<&RoleRec> = cluster.roles.iter().collect();
    roles.sort_by(|a, b| a.name.cmp(&b.name));
    let by_kind = |kind: PgFindingKind| kind as usize;

    let mut found: [Vec<PgFinding>; 10] = Default::default();
    let cluster_eval = Eval::for_cluster(cluster);
    found[by_kind(PgFindingKind::RdsSuperuser)] = rds_superuser(cluster, &roles, &cluster_eval);
    found[by_kind(PgFindingKind::CreateRole)] = create_role(cluster, &roles);
    found[by_kind(PgFindingKind::BypassRls)] = bypass_rls(&roles);
    found[by_kind(PgFindingKind::ExpiringLogin)] = expiring_login(&roles, now);
    found[by_kind(PgFindingKind::EmptyLogin)] = empty_login(cluster, dbs, &roles);
    found[by_kind(PgFindingKind::Md5Encryption)] = md5_encryption(cluster);
    for db in dbs {
        found[by_kind(PgFindingKind::PublicSchemaCreate)].extend(public_schema_create(db));
        found[by_kind(PgFindingKind::PublicObjectGrant)].extend(public_object_grant(db));
        found[by_kind(PgFindingKind::DefaultPrivilegeGap)].extend(default_privilege_gap(cluster, db, &roles));
        found[by_kind(PgFindingKind::SecurityDefinerPath)].extend(security_definer_path(db));
    }

    let mut groups: Vec<PgFindingGroup> = TABLE
        .into_iter()
        .zip(found)
        .filter(|(_, items)| !items.is_empty())
        .map(|((kind, title, level), items)| PgFindingGroup { kind, title: title.to_string(), level, items })
        .collect();
    // 안정 정렬이라 같은 심각도 안에서는 표의 순서가 남는다
    groups.sort_by_key(|group| group.level);
    PgFindings { groups, skipped, fetched_at: iso(now) }
}

// ───────────────────────── 클러스터 전체 ─────────────────────────

/// 시스템 역할이 아닌, `rds_superuser`의 권한을 쓸 수 있는 역할: 직접 구성원, 상속하는 구성원 관계로 그 권한을 받는 역할,
/// 상속하지는 않지만 `SET ROLE`로 닿는 역할(PG16부터는 사슬의 모든 관계에 SET 옵션이 있어야 한다).
/// 직접 구성원이면 상속 여부와 상관없이 직접 구성원이라고 쓴다. 상속해서 받으면 거치는 역할들을 보이고, 그렇지 않고 SET ROLE로만 닿으면 그렇게 쓴다.
fn rds_superuser(cluster: &ClusterSnapshot, roles: &[&RoleRec], eval: &Eval) -> Vec<PgFinding> {
    let direct: HashSet<&str> = cluster.members.iter().filter(|m| m.group == RDS_SUPERUSER).map(|m| m.member.as_str()).collect();
    roles
        .iter()
        .filter(|role| !is_system_role(&role.name))
        .filter_map(|role| {
            if direct.contains(role.name.as_str()) {
                return Some(role_finding(role, RDS_SUPERUSER_DIRECT));
            }
            let view = eval.role(&role.name);
            if let Some(reach) = view.inherited().iter().find(|i| i.role == RDS_SUPERUSER) {
                // 경로는 이 역할을 뺀 사슬이고 `rds_superuser`로 끝난다: 거치는 역할은 그 앞까지다
                let (_, via) = reach.path.split_last()?;
                return Some(role_finding(role, format!("{} 역할을 거쳐 rds_superuser 권한을 받아요", via.join(" → "))));
            }
            view.set_role_only().iter().any(|reached| reached == RDS_SUPERUSER).then(|| role_finding(role, RDS_SUPERUSER_SET_ROLE))
        })
        .collect()
}

fn create_role(cluster: &ClusterSnapshot, roles: &[&RoleRec]) -> Vec<PgFinding> {
    let detail = if cluster.version_num < CREATE_ROLE_SCOPED_SINCE { format!("{CREATE_ROLE}{CREATE_ROLE_BEFORE_PG16}") } else { CREATE_ROLE.to_string() };
    roles.iter().filter(|role| role.create_role && !is_system_role(&role.name)).map(|role| role_finding(role, detail.clone())).collect()
}

fn bypass_rls(roles: &[&RoleRec]) -> Vec<PgFinding> {
    roles.iter().filter(|role| role.bypass_rls && !is_system_role(&role.name)).map(|role| role_finding(role, BYPASS_RLS)).collect()
}

/// 만료 시각의 날짜(UTC, YYYY-MM-DD)
fn date_of(valid_until: &str) -> Option<String> {
    let text = iso(parse_iso(valid_until)?);
    text.get(..10).map(str::to_string)
}

/// 만료됐거나 30일 안에 만료되는, 로그인할 수 있는 사용자(시스템 역할은 뺀다)
fn expiring_login(roles: &[&RoleRec], now: i64) -> Vec<PgFinding> {
    roles
        .iter()
        .filter(|role| role.login && !is_system_role(&role.name))
        .filter_map(|role| {
            let valid_until = role.valid_until.as_deref()?;
            let date = date_of(valid_until)?;
            match expiry_of(Some(valid_until), now) {
                Expiry::Expired => Some(role_finding(role, format!("{date}에 만료됐어요"))),
                Expiry::Soon => Some(role_finding(role, format!("{date}에 만료돼요"))),
                Expiry::Later => None,
            }
        })
        .collect()
}

/// 이름이 오른 ACL 항목(받는 쪽이든 준 쪽이든)을 모은다
fn name_acl<'a>(named: &mut HashSet<&'a str>, acl: &'a [AclEntry]) {
    for entry in acl {
        named.insert(&entry.grantor);
        named.extend(entry.grantee.as_deref());
    }
}

/// 읽어 둔 데이터베이스들에서 어떤 식으로든 이름이 오르는 역할들: 소유자, ACL의 받는 쪽·준 쪽, 기본 권한을 정한 역할
fn named_roles<'a>(cluster: &'a ClusterSnapshot, dbs: &[&'a DbSnapshot]) -> HashSet<&'a str> {
    let mut named = HashSet::new();
    for database in &cluster.databases {
        named.insert(database.owner.as_str());
        name_acl(&mut named, &database.acl);
    }
    for db in dbs {
        named.insert(db.owner.as_str());
        for schema in &db.schemas {
            named.insert(schema.owner.as_str());
            name_acl(&mut named, &schema.acl);
        }
        for relation in &db.relations {
            named.insert(relation.owner.as_str());
            name_acl(&mut named, &relation.acl);
        }
        for function in &db.functions {
            named.insert(function.owner.as_str());
            name_acl(&mut named, &function.acl);
        }
        for default in &db.default_acls {
            named.insert(default.creator.as_str());
            name_acl(&mut named, &default.acl);
        }
    }
    named
}

/// 로그인할 수 있는데 `rds_iam` 말고는 속한 그룹이 없고, 읽어 둔 데이터베이스 어디에서도 ACL에 이름이 없고, 아무것도 소유하지 않은 사용자.
/// 읽지 못한 데이터베이스는 볼 수 없으니, 거기서 가진 것이 있으면 이 점검은 모른다.
fn empty_login(cluster: &ClusterSnapshot, dbs: &[&DbSnapshot], roles: &[&RoleRec]) -> Vec<PgFinding> {
    let in_a_group: HashSet<&str> = cluster.members.iter().filter(|m| m.group != RDS_IAM).map(|m| m.member.as_str()).collect();
    let named = named_roles(cluster, dbs);
    roles
        .iter()
        .filter(|role| role.login && !is_system_role(&role.name))
        .filter(|role| !in_a_group.contains(role.name.as_str()) && !named.contains(role.name.as_str()))
        .map(|role| role_finding(role, EMPTY_LOGIN))
        .collect()
}

fn md5_encryption(cluster: &ClusterSnapshot) -> Vec<PgFinding> {
    if cluster.password_encryption == "md5" {
        vec![finding(None, None, None, MD5_ENCRYPTION)]
    } else {
        Vec::new()
    }
}

// ───────────────────────── 데이터베이스 하나 ─────────────────────────

fn public_schema_create(db: &DbSnapshot) -> Vec<PgFinding> {
    let mut schemas: Vec<&str> = db
        .schemas
        .iter()
        .filter(|schema| schema.acl.iter().any(|e| e.grantee.is_none() && e.privilege == Privilege::Create))
        .map(|schema| schema.name.as_str())
        .collect();
    schemas.sort_unstable();
    schemas.into_iter().map(|name| finding(Some(&db.database), None, Some(PgObjectRef::schema(name)), PUBLIC_SCHEMA_CREATE)).collect()
}

fn public_object_grant(db: &DbSnapshot) -> Vec<PgFinding> {
    let mut relations: Vec<(&RelationRec, BTreeSet<Privilege>)> = db
        .relations
        .iter()
        .filter_map(|rel| {
            let public: BTreeSet<Privilege> = rel.acl.iter().filter(|e| e.grantee.is_none()).map(|e| e.privilege).collect();
            (!public.is_empty()).then_some((rel, public))
        })
        .collect();
    relations.sort_by(|(a, _), (b, _)| (&a.schema, &a.name).cmp(&(&b.schema, &b.name)));
    relations
        .into_iter()
        .map(|(rel, privileges)| {
            let list = privileges.into_iter().map(Privilege::as_str).collect::<Vec<_>>().join(", ");
            finding(Some(&db.database), None, Some(PgObjectRef::relation(rel)), format!("모든 역할(PUBLIC)이 {list} 권한을 받아요"))
        })
        .collect()
}

fn security_definer_path(db: &DbSnapshot) -> Vec<PgFinding> {
    let mut functions: Vec<_> = db.functions.iter().filter(|f| f.security_definer && !f.search_path_set).collect();
    functions.sort_by(|a, b| (&a.schema, &a.name, &a.signature).cmp(&(&b.schema, &b.name, &b.signature)));
    functions.into_iter().map(|f| finding(Some(&db.database), None, Some(PgObjectRef::function(f)), SECURITY_DEFINER_PATH)).collect()
}

/// 만드는 역할이 `schema`에 만들 새 테이블의 SELECT를 `reach`의 어느 역할(None은 PUBLIC)이 기본으로 받는가.
/// 그 만드는 역할의 기본 권한 가운데 이 스키마의 것과 모든 스키마의 것을 본다.
fn selects_by_default(defaults: &HashMap<(&str, Option<&str>), Vec<Option<&str>>>, creator: &str, schema: &str, reach: &HashSet<&str>) -> bool {
    [Some(schema), None]
        .iter()
        .filter_map(|scope| defaults.get(&(creator, *scope)))
        .flatten()
        .any(|grantee| grantee.is_none_or(|name| reach.contains(name)))
}

/// 기본 권한의 빈틈. 스키마 S의 모든 테이블(테이블과 파티션 테이블)을 직접 또는 그룹으로 읽는 역할 R이 있는데,
/// S의 테이블을 소유한 역할 C가 새로 만드는 테이블은 R이 못 읽는 경우다. C가 R이거나 R이 C를 상속하면 R은 새 테이블도 읽으니 빼고,
/// C의 기본 권한(S의 것이나 모든 스키마의 것)이 R, R이 상속하는 역할, PUBLIC 가운데 하나에게 SELECT를 주면 빈틈이 아니다.
/// 모든 테이블의 SELECT가 미리 정의된 역할(`pg_read_all_data`)이나 superuser 속성으로도 오면 그 역할이 새 테이블도 읽게 하니 빈틈이 아니다.
/// 항목은 (R, S, C)마다 하나고 역할, 스키마, 만드는 역할의 이름순이다.
fn default_privilege_gap(cluster: &ClusterSnapshot, db: &DbSnapshot, roles: &[&RoleRec]) -> Vec<PgFinding> {
    let mut tables: BTreeMap<&str, Vec<&RelationRec>> = BTreeMap::new();
    for rel in db.relations.iter().filter(|r| matches!(r.kind, RelKind::Table | RelKind::Partitioned)) {
        tables.entry(&rel.schema).or_default().push(rel);
    }
    if tables.is_empty() {
        return Vec::new();
    }
    let creators: BTreeMap<&str, BTreeSet<&str>> = tables.iter().map(|(schema, rels)| (*schema, rels.iter().map(|r| r.owner.as_str()).collect())).collect();

    // (만드는 역할, 스키마 또는 모든 스키마) → 새 테이블의 SELECT를 받는 쪽들
    let mut defaults: HashMap<(&str, Option<&str>), Vec<Option<&str>>> = HashMap::new();
    for default in db.default_acls.iter().filter(|d| d.obj_type == DefaultObjType::Tables) {
        let grantees = default.acl.iter().filter(|e| e.privilege == Privilege::Select).map(|e| e.grantee.as_deref());
        defaults.entry((&default.creator, default.schema.as_deref())).or_default().extend(grantees);
    }

    let ctx = Ctx { cluster, db };
    let eval = Eval::new(&ctx);
    let mut gaps = Vec::new();
    for role in roles {
        let view = eval.role(&role.name);
        let inherited = view.inherited();
        let reach: HashSet<&str> = inherited.iter().map(|i| i.role.as_str()).collect();
        for (schema, rels) in &tables {
            // 모든 테이블을 직접 또는 그룹으로 읽는가. 하나라도 못 읽으면 바로 멈춘다.
            // 그러면서 모든 테이블에서 미리 정의된 역할이나 superuser로도 읽는다면, 그 힘이 새 테이블에도 닿으니 빈틈이 아니다
            let (mut reads_all, mut reads_new_too) = (true, true);
            for rel in rels {
                let sources = view.sources(Obj::Relation(rel), Privilege::Select);
                if !sources.iter().any(|s| matches!(s.kind, SourceKind::Direct | SourceKind::Group)) {
                    reads_all = false;
                    break;
                }
                reads_new_too &= sources.iter().any(|s| matches!(s.kind, SourceKind::Predefined | SourceKind::Superuser));
            }
            if !reads_all || reads_new_too {
                continue;
            }
            for creator in &creators[schema] {
                // R 자신이거나 R이 상속하는 C의 테이블은 새 것도 읽는다
                if reach.contains(creator) || selects_by_default(&defaults, creator, schema, &reach) {
                    continue;
                }
                gaps.push(finding(
                    Some(&db.database),
                    Some(&role.name),
                    Some(PgObjectRef::schema(schema)),
                    format!("{} 역할은 {schema}의 지금 테이블은 읽지만 {creator} 역할이 새로 만드는 테이블은 못 읽어요", role.name),
                ));
            }
        }
    }
    gaps
}

#[cfg(test)]
mod tests;
