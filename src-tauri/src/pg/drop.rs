//! 역할 안전하게 삭제하기: 계획(순수 함수)과 실행.
//!
//! 역할을 지우려면 그 역할이 가진 객체를 넘기고(`REASSIGN OWNED`), 그 역할이 받은 권한과 기본 권한을 거둔 뒤(`DROP OWNED`), 마지막에 `DROP ROLE`을 한다.
//! 앞의 둘은 데이터베이스 하나 안의 일이라 연결할 수 있는 데이터베이스마다 한 번씩, 각각 트랜잭션 하나로 돈다. 그래서 중간에 멈추면 앞의 데이터베이스는
//! 이미 정리돼 있다. 멈추면 어디까지 했는지를 알린다(`apply`).
//!
//! 계획은 거짓말을 하지 않아야 한다. 서버가 `DROP OWNED`로 무엇을 거두고 무엇을 남기는지를 서버 규칙대로 미리 계산해서(`predicted_stays`)
//! 남는 것이 있으면 막는다. `DROP OWNED`는 로그인한 역할이 부여자로서 거둘 수 있는 항목만 거둔다(`select_best_grantor`): 그 역할이 객체의 소유자이거나
//! 그 권한의 GRANT OPTION을 가졌을 때다. 그 밖의 항목은 남고, 그러면 `DROP ROLE`이 실패한다.
//! 삭제하려고 로그인한 역할이 삭제할 역할의 권한을 물려받아야 하는 때는 단계 안에서 구성원 관계를 잠깐 받았다가(`GRANT … WITH INHERIT TRUE`) 되돌려 놓는다.
//! 그래서 멈춰도 구성원 관계가 남지 않는다. 계산은 그 구성원 관계가 있는 상태(`with_membership`)로 한다.
//!
//! 스냅숏이 읽지 않는 객체(콜레이션, 연산자, 텍스트 검색 객체, 확장 통계, 컬럼 권한)가 단계를 멈출 수도 있다. 그때는 서버의 오류가 삭제 결과의 글에 실린다.

use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::sync::Arc;

use super::change::model::PgChange;
use super::change::resolve::{system_role_text, unknown_role_text, DROP_LOGIN, READ_REPLICA};
use super::change::rights::{drop_inherit_text, Rights};
use super::change::sql_text;
use super::commit::{gate_of, STALE};
use super::eval::{offers, Ctx, Eval, Obj};
use super::exec::{ExecError, Step, UNKNOWN_OUTCOME};
use super::log::PgLogEntry;
use super::model::{AclEntry, ClusterSnapshot, DbSnapshot, MemberGrant, MemberRec, Privilege, MEMBERSHIP_OPTIONS_SINCE};
use super::summary::is_system_role;
use super::view::{PgDropPlan, PgDropStep, PgGrantedMembership, PgWarnLevel, PgWarning};
use crate::error::AppError;
use crate::iam::clock::iso;

const DROP_CONFIRM: &str = "역할을 삭제해요. 되돌릴 수 없어요";

/// 객체 종류마다 있는 권한을 가려내려고 모든 권한을 한 번 훑는다
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

fn bad_heir_text(role: &str) -> String {
    format!("넘겨받을 역할로 쓸 수 없어요: {role}")
}

fn reassign_rights_text(role: &str) -> String {
    format!("{role} 역할의 권한을 물려받아야 그 역할에게 넘길 수 있어요")
}

fn stays_text(role: &str, count: usize, sample: &[String], grantors: &[String]) -> String {
    format!("{role} 역할이 받은 권한 중 로그인한 역할이 뺄 수 없는 것이 있어요({count}개, 예: {}). 준 역할: {}", sample.join(", "), grantors.join(", "))
}

fn reassign_check_text(heir: &str, object: &str, reason: &str) -> String {
    format!("{heir} 역할에게 넘길 수 없어요: {object}. {reason}")
}

fn unreachable_text(names: &[String]) -> String {
    format!("연결하지 못한 데이터베이스가 있어 삭제 계획을 만들 수 없어요: {}", names.join(", "))
}

fn truncated_text(names: &[String]) -> String {
    format!("객체가 많아 일부만 읽은 데이터베이스가 있어 삭제 계획을 만들 수 없어요: {}", names.join(", "))
}

fn granted_text(granted: &[PgGrantedMembership]) -> String {
    let leaving: Vec<String> = granted.iter().filter(|m| m.lost).map(|m| format!("{} → {}", m.member, m.group)).collect();
    let first = format!("이 역할이 준 구성원 관계 {}개가 함께 지워져요", granted.len());
    if leaving.is_empty() {
        return first;
    }
    format!("{first}. {}개는 다른 부여가 없어 구성원이 그룹에서 빠져요(예: {})", leaving.len(), leaving.iter().take(3).cloned().collect::<Vec<_>>().join(", "))
}

pub fn sessions_stay_text(sessions: usize) -> String {
    format!("이 역할로 접속한 세션 {sessions}개는 끊기지 않아요")
}

/// 멈췄을 때 화면에 나가는 글(계약의 "삭제 결과")
pub fn stopped_text(total: usize, done: usize, reason: &str) -> String {
    format!("{total}개 데이터베이스 중 {done}개를 정리하고 멈췄어요: {reason}")
}

// ───────────────────────── 계획 ─────────────────────────

/// 남는 권한 하나
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Stay {
    /// `${객체} ${권한}`
    shown: String,
    grantor: String,
    /// 같은 이름의 객체가 여러 데이터베이스에 있을 수 있어 센 것을 가린다
    database: String,
}

/// 데이터베이스 스냅숏을 읽지 못한 단계에서 판단에 쓰는 빈 스냅숏(구성원 관계와 데이터베이스 ACL 판단에는 데이터베이스 안의 객체가 필요 없다)
fn empty_db(name: &str) -> DbSnapshot {
    DbSnapshot {
        database: name.to_string(),
        owner: String::new(),
        schemas: Vec::new(),
        relations: Vec::new(),
        functions: Vec::new(),
        default_acls: Vec::new(),
        truncated: false,
        fetched_at: String::new(),
    }
}

/// 단계 안에서 로그인한 역할이 `role`의 구성원이 된 클러스터. 160000부터는 `WITH INHERIT TRUE`로 주니 상속하고 SET도 된다
fn with_membership(cluster: &ClusterSnapshot, role: &str, login: &str, grantor: &str) -> ClusterSnapshot {
    let mut next = cluster.clone();
    let options = next.version_num >= MEMBERSHIP_OPTIONS_SINCE;
    let grant = MemberGrant { grantor: grantor.to_string(), admin: false, inherit: options.then_some(true), set: options.then_some(true) };
    match next.members.iter_mut().find(|m| m.member == login && m.group == role) {
        Some(pair) => {
            pair.grants.retain(|g| g.grantor != grant.grantor);
            pair.grants.push(grant);
            pair.grants.sort_by(|a, b| a.grantor.cmp(&b.grantor));
            if options {
                pair.inherit = Some(true);
                pair.set = Some(true);
            }
        }
        None => next.members.push(MemberRec { member: login.to_string(), group: role.to_string(), admin: false, inherit: grant.inherit, set: grant.set, grants: vec![grant] }),
    }
    next
}

/// 서버의 `select_best_grantor`: 로그인한 역할이 `acl`을 고칠 때 부여자로 나서는 역할과 그 역할이 가진 GRANT OPTION.
/// 로그인한 역할이 소유자이거나 superuser면 소유자다. 아니면 권한을 쓰는 역할들(`order`, 로그인한 역할이 먼저)을 차례로 보며, 소유자를 만나거나
/// 필요한 권한 모두의 GRANT OPTION을 가진 첫 역할이 부여자다. 그런 역할이 없으면 가장 많이 가진 역할(같으면 먼저 본 역할)이고, 아무도 없으면 로그인한 역할이다
fn select_best_grantor(login: &str, superuser: bool, order: &[String], owner: &str, acl: &[AclEntry], needed: &[Privilege]) -> (String, BTreeSet<Privilege>) {
    let all: BTreeSet<Privilege> = needed.iter().copied().collect();
    if login == owner || superuser {
        return (owner.to_string(), all);
    }
    let mut best = (login.to_string(), BTreeSet::new());
    for role in order {
        if role == owner {
            return (owner.to_string(), all);
        }
        // 직접 받았거나 PUBLIC에 준 GRANT OPTION(`aclmask_direct`)
        let held: BTreeSet<Privilege> =
            needed.iter().copied().filter(|&p| acl.iter().any(|e| e.privilege == p && e.grantable && e.grantee.as_deref().is_none_or(|grantee| grantee == role))).collect();
        if held.len() == needed.len() {
            return (role.clone(), held);
        }
        if held.len() > best.1.len() {
            best = (role.clone(), held);
        }
    }
    best
}

/// 한 데이터베이스 단계에서 세어 보는 것
struct Tally {
    owned: usize,
    privileges: usize,
    defaults: usize,
    stays: Vec<Stay>,
}

/// 단계를 돌리는 쪽의 처지: 지우는 역할, 로그인한 역할(superuser인가, 권한을 쓰는 역할들의 차례), 서버 버전
struct Actor<'a> {
    role: &'a str,
    login: &'a str,
    superuser: bool,
    /// 로그인한 역할이 먼저인, 권한을 쓰는 역할들의 차례(`Eval::privilege_order`)
    order: &'a [String],
    version: i32,
}

/// `DROP OWNED`가 `role`에 준 권한을 거둔 뒤에도 남는 항목들과 센 수. `role`이 소유하지 않은 객체만 본다(소유한 객체는 `REASSIGN OWNED`가 넘긴다)
fn tally_objects<'a>(objects: impl Iterator<Item = (String, Obj<'a>)>, actor: &Actor, database: &str, tally: &mut Tally) {
    let role = actor.role;
    for (label, obj) in objects {
        if obj.owner() == role {
            continue;
        }
        let acl = obj.acl();
        tally.privileges += acl.iter().filter(|e| e.grantee.as_deref() == Some(role) || e.grantor == role).count();
        if !acl.iter().any(|e| e.grantee.as_deref() == Some(role)) {
            continue;
        }
        let needed: Vec<Privilege> = ALL_PRIVILEGES.iter().copied().filter(|&p| offers(obj.priv_kind(), p, actor.version)).collect();
        let (grantor, held) = select_best_grantor(actor.login, actor.superuser, actor.order, obj.owner(), acl, &needed);
        for entry in acl.iter().filter(|e| e.grantee.as_deref() == Some(role)) {
            // 부여자가 `grantor`이고 그 역할이 소유자이거나 그 권한의 GRANT OPTION을 가졌을 때만 거둔다
            let removed = entry.grantor == grantor && (grantor == obj.owner() || held.contains(&entry.privilege));
            if !removed {
                tally.stays.push(Stay { shown: format!("{label} {}", entry.privilege.as_str()), grantor: entry.grantor.clone(), database: database.to_string() });
            }
        }
    }
}

/// 객체 이름표(권한 변경의 `ObjKey::label`과 같은 꼴)
fn relation_label(schema: &str, name: &str) -> String {
    format!("{schema}.{name}")
}

fn function_label(schema: &str, name: &str, signature: &str) -> String {
    format!("{schema}.{name}({signature})")
}

pub fn drop_plan(cluster: &ClusterSnapshot, dbs: &[Arc<DbSnapshot>], unreachable: &[String], role: &str, reassign_to: &str, default_db: &str) -> PgDropPlan {
    let login = cluster.login_user.as_str();
    let version = cluster.version_num;
    let since_16 = version >= MEMBERSHIP_OPTIONS_SINCE;
    let record = cluster.roles.iter().find(|r| r.name == role);

    // 데이터베이스 단계: 읽은 것과 읽지 못한 것을 이름순으로
    let by_name: BTreeMap<&str, Option<&DbSnapshot>> =
        unreachable.iter().map(|name| (name.as_str(), None)).chain(dbs.iter().map(|d| (d.database.as_str(), Some(d.as_ref())))).collect();
    let fallback = empty_db(default_db);
    let base = by_name.get(default_db).copied().flatten().unwrap_or(&fallback);
    let rights = Rights::new(cluster, base);

    // 삭제할 역할의 권한을 물려받지 않았으면 단계 안에서 구성원 관계를 받는다
    let needs_membership = record.is_some() && !rights.has_privs_of(role);
    let grantor_choice = if since_16 { rights.membership_grantor(role) } else { Ok(login.to_string()) };
    let grantor = grantor_choice.clone().unwrap_or_else(|_| login.to_string());
    let augmented = needs_membership.then(|| with_membership(cluster, role, login, &grantor));
    let during: &ClusterSnapshot = augmented.as_ref().unwrap_or(cluster);

    let heir_known = cluster.roles.iter().any(|r| r.name == reassign_to);
    let heir_ok = heir_known && !is_system_role(reassign_to) && reassign_to != role;

    let mut steps = Vec::new();
    let mut stays: Vec<Stay> = Vec::new();
    let mut reassign_blocks: Vec<String> = Vec::new();
    let mut truncated: Vec<String> = Vec::new();
    for (index, (name, snapshot)) in by_name.iter().enumerate() {
        let owned_db;
        let db: &DbSnapshot = match snapshot {
            Some(db) => db,
            None => {
                owned_db = empty_db(name);
                &owned_db
            }
        };
        if db.truncated {
            truncated.push(name.to_string());
        }
        let step_rights = Rights::new(during, db);
        let eval = Eval::new(&Ctx { cluster: during, db });
        let order: Vec<String> = eval.privilege_order(login).into_iter().map(|r| r.role).collect();
        let actor = Actor { role, login, superuser: step_rights.superuser(), order: &order, version };

        let mut tally = Tally {
            owned: db.schemas.iter().filter(|s| s.owner == role).count()
                + db.relations.iter().filter(|r| r.owner == role).count()
                + db.functions.iter().filter(|f| f.owner == role).count()
                + usize::from(db.owner == role),
            privileges: 0,
            defaults: db.default_acls.iter().filter(|d| d.creator == role || d.acl.iter().any(|e| e.grantee.as_deref() == Some(role) || e.grantor == role)).count(),
            stays: Vec::new(),
        };
        let objects = db
            .schemas
            .iter()
            .map(|s| (format!("스키마 {}", s.name), Obj::Schema(s)))
            .chain(db.relations.iter().map(|r| (relation_label(&r.schema, &r.name), Obj::Relation(r))))
            .chain(db.functions.iter().map(|f| (function_label(&f.schema, &f.name, &f.signature), Obj::Function(f))));
        tally_objects(objects, &actor, name, &mut tally);
        if index == 0 {
            // 데이터베이스의 ACL은 공유 객체라서 첫 단계의 `DROP OWNED`가 모든 데이터베이스에서 거둔다
            let databases = cluster.databases.iter().map(|d| (format!("데이터베이스 {}", d.name), Obj::Database(d)));
            tally_objects(databases, &actor, name, &mut tally);
        }
        stays.append(&mut tally.stays);

        if heir_ok && snapshot.is_some() {
            reassign_blocks.extend(reassign_checks(&step_rights, &eval, cluster, db, role, reassign_to, login));
        }

        let mut sql = Vec::new();
        if needs_membership {
            sql.push(sql_text::grant_role(role, login, false, since_16).shown());
        }
        sql.push(sql_text::reassign_owned(role, reassign_to).shown());
        sql.push(sql_text::drop_owned(role).shown());
        if needs_membership {
            // 줬던 구성원 관계를 거둔다. 160000부터는 부여자까지 대서 방금 준 줄만 지운다
            let revocable = step_rights.membership_revocations(role, login).rows;
            let granted_by = if since_16 { revocable.iter().find(|row| **row == grantor).cloned() } else { None };
            sql.push(sql_text::revoke_role(role, login, false, granted_by.as_deref()).shown());
        }
        steps.push(PgDropStep { database: Some(name.to_string()), sql, owned: tally.owned, privileges: tally.privileges, defaults: tally.defaults });
    }
    steps.push(PgDropStep { database: None, sql: vec![sql_text::drop_role(role).shown()], owned: 0, privileges: 0, defaults: 0 });

    let granted = granted_memberships(cluster, role);
    let sessions = cluster.sessions.iter().filter(|s| s.role.as_deref() == Some(role)).count();

    let mut blocks: Vec<String> = Vec::new();
    let mut block = |text: String| {
        if !blocks.contains(&text) {
            blocks.push(text);
        }
    };
    if is_system_role(role) {
        block(system_role_text(role));
    }
    if role == login {
        block(DROP_LOGIN.to_string());
    }
    if record.is_none() {
        block(unknown_role_text(role));
    }
    let drop_rights = record.map(|rec| rights.drop(rec));
    if let Some(Err(text)) = &drop_rights {
        block(text.clone());
    }
    if !heir_ok {
        block(bad_heir_text(reassign_to));
    } else if reassign_to != login && !rights.has_privs_of(reassign_to) {
        block(reassign_rights_text(reassign_to));
    }
    let names_of = |names: &[String]| {
        let mut sorted = names.to_vec();
        sorted.sort();
        sorted
    };
    if !unreachable.is_empty() {
        block(unreachable_text(&names_of(unreachable)));
    }
    if !truncated.is_empty() {
        block(truncated_text(&names_of(&truncated)));
    }
    if matches!(drop_rights, Some(Ok(()))) && needs_membership {
        let login_inherits = cluster.roles.iter().find(|r| r.name == login).is_some_and(|r| r.inherit);
        if !since_16 && !login_inherits {
            block(drop_inherit_text(role));
        }
        if let Err(text) = grantor_choice {
            block(text);
        }
    }
    stays.sort();
    stays.dedup();
    if !stays.is_empty() {
        let sample: Vec<String> = stays.iter().map(|s| s.shown.clone()).take(3).collect();
        let grantors: BTreeSet<String> = stays.iter().map(|s| s.grantor.clone()).collect();
        block(stays_text(role, stays.len(), &sample, &grantors.into_iter().collect::<Vec<_>>()));
    }
    for text in reassign_blocks {
        block(text);
    }

    let mut warnings: Vec<PgWarning> = blocks.into_iter().map(|message| PgWarning { level: PgWarnLevel::Block, message, add: Vec::new() }).collect();
    warnings.push(PgWarning { level: PgWarnLevel::Confirm, message: DROP_CONFIRM.to_string(), add: Vec::new() });
    if !granted.is_empty() {
        warnings.push(PgWarning { level: PgWarnLevel::Confirm, message: granted_text(&granted), add: Vec::new() });
    }
    if sessions > 0 {
        warnings.push(PgWarning { level: PgWarnLevel::Warn, message: sessions_stay_text(sessions), add: Vec::new() });
    }
    PgDropPlan { role: role.to_string(), reassign_to: reassign_to.to_string(), steps, warnings, confirm_text: role.to_string(), sessions, granted_memberships: granted }
}

/// 160000부터: `role`이 부여자인 구성원 관계(`DROP OWNED`가 클러스터 전체에서 지운다). 이름순
fn granted_memberships(cluster: &ClusterSnapshot, role: &str) -> Vec<PgGrantedMembership> {
    if cluster.version_num < MEMBERSHIP_OPTIONS_SINCE {
        return Vec::new();
    }
    let mut granted: Vec<PgGrantedMembership> = cluster
        .members
        .iter()
        .filter(|m| m.member != role && m.group != role && m.grants.iter().any(|g| g.grantor == role))
        .map(|m| PgGrantedMembership { member: m.member.clone(), group: m.group.clone(), lost: m.grants.iter().all(|g| g.grantor == role) })
        .collect();
    granted.sort_by(|a, b| (&a.member, &a.group).cmp(&(&b.member, &b.group)));
    granted
}

/// 이 데이터베이스에서 `REASSIGN OWNED`가 서버의 점검에 걸릴 객체: 역할이 소유한 스키마는 로그인한 역할이 데이터베이스에 CREATE가 있고 넘겨받을 역할로
/// `SET ROLE` 할 수 있어야 하고, 함수는 넘겨받을 역할이 함수의 스키마에 CREATE가 있어야 한다(역할이 소유한 스키마는 넘겨받을 역할의 것이 된다)
fn reassign_checks(rights: &Rights, eval: &Eval, cluster: &ClusterSnapshot, db: &DbSnapshot, role: &str, heir: &str, login: &str) -> Vec<String> {
    let mut texts = Vec::new();
    let database = cluster.databases.iter().find(|d| d.name == db.database);
    for schema in db.schemas.iter().filter(|s| s.owner == role) {
        let object = format!("스키마 {}", schema.name);
        if let Some(database) = database {
            if eval.role(login).sources(Obj::Database(database), Privilege::Create).is_empty() {
                texts.push(reassign_check_text(heir, &object, &format!("데이터베이스 {}에 CREATE 권한이 있어야 해요", db.database)));
            }
        }
        if heir != login && !rights.can_set_role(heir) {
            texts.push(reassign_check_text(heir, &object, &format!("로그인한 역할이 {heir} 역할로 SET ROLE 할 수 있어야 해요")));
        }
    }
    for function in db.functions.iter().filter(|f| f.owner == role) {
        let Some(schema) = db.schemas.iter().find(|s| s.name == function.schema) else { continue };
        if schema.owner != role && eval.role(heir).sources(Obj::Schema(schema), Privilege::Create).is_empty() {
            let object = function_label(&function.schema, &function.name, &function.signature);
            texts.push(reassign_check_text(heir, &object, &format!("스키마 {}에 CREATE 권한이 있어야 해요", function.schema)));
        }
    }
    texts
}

/// 읽기 전용 복제본이면 막는다(문장이 서버에서 어차피 실패하니 그 전에 알린다). 계획은 순수 함수라 이 판단은 명령이 덧붙인다
pub fn block_replica(plan: &mut PgDropPlan) {
    plan.warnings.insert(0, PgWarning { level: PgWarnLevel::Block, message: READ_REPLICA.to_string(), add: Vec::new() });
}

// ───────────────────────── 적용 ─────────────────────────

/// 사용자가 본 계획과 다시 계산한 계획을 견주는 꼴: 세션은 계속 바뀌니 세션 수와 세션 경고는 견주지 않는다
fn comparable(plan: &PgDropPlan) -> PgDropPlan {
    let stay = sessions_stay_text(plan.sessions);
    PgDropPlan { sessions: 0, warnings: plan.warnings.iter().filter(|w| !(w.level == PgWarnLevel::Warn && w.message == stay)).cloned().collect(), ..plan.clone() }
}

/// 본 계획이 지금 계산한 계획과 같고(세션만 빼고) 막힘이 없고 확인 문구가 맞아야 실행한다
pub fn check(plan: &PgDropPlan, seen: Option<&PgDropPlan>, typed: Option<&str>) -> Result<(), AppError> {
    if seen.map(comparable) != Some(comparable(plan)) {
        return Err(AppError::other(STALE));
    }
    gate_of(plan.warnings.iter(), Some(&plan.confirm_text), typed)
}

/// 단계를 계획의 차례대로 돌린다. 첫 실패에서 멈추고 뒤의 단계는 돌리지 않는다. 돌려주는 값은 끝난 데이터베이스 단계의 수와 멈춘 이유의 글(끝까지 갔으면 None)이다.
/// `done`은 `plan.steps`의 앞에서부터 센 수다(데이터베이스 단계가 먼저고 `DROP ROLE`이 마지막이다). `COMMIT`의 답을 못 받은 단계는 끝난 것으로 세지 않는다.
/// `exec`는 (데이터베이스, 문장들)을 받는다. 데이터베이스가 없는 단계는 `default_db`에서 돈다
pub async fn apply<X, XF>(plan: &PgDropPlan, default_db: &str, mut exec: X) -> (usize, Option<String>)
where
    X: FnMut(&str, Vec<Step>) -> XF,
    XF: Future<Output = Result<(), ExecError>>,
{
    let total = plan.steps.iter().filter(|s| s.database.is_some()).count();
    let mut done = 0;
    for step in &plan.steps {
        let database = step.database.as_deref().unwrap_or(default_db);
        let steps = step.sql.iter().map(|sql| Step { run: sql.clone(), expect: None }).collect();
        match exec(database, steps).await {
            Ok(()) => done += usize::from(step.database.is_some()),
            Err(ExecError::Failed(error)) => return (done, Some(stopped_text(total, done, &error_text(&error)))),
            Err(ExecError::CommitUnknown) => return (done, Some(stopped_text(total, done, UNKNOWN_OUTCOME))),
        }
    }
    (done, None)
}

fn error_text(error: &AppError) -> String {
    match error {
        AppError::Other { message } | AppError::Network { message } => message.clone(),
        other => other.to_string(),
    }
}

/// 삭제 기록 하나: 모든 단계의 문장을 담고 되돌릴 수 없다(`inverse`가 없다)
pub struct DropLog<'a> {
    pub plan: &'a PgDropPlan,
    pub profile: &'a str,
    pub target_arn: &'a str,
    pub login_user: &'a str,
    pub default_db: &'a str,
    pub now: i64,
    pub log_id: &'a str,
    pub stopped: Option<&'a str>,
}

pub fn log_entry(log: &DropLog) -> PgLogEntry {
    PgLogEntry {
        id: log.log_id.to_string(),
        at: iso(log.now),
        profile: log.profile.to_string(),
        target_arn: log.target_arn.to_string(),
        database: log.default_db.to_string(),
        login_user: log.login_user.to_string(),
        change: PgChange::DropRole { role: log.plan.role.clone() },
        summary: format!("역할 삭제: {}", log.plan.role),
        sql: log.plan.steps.iter().flat_map(|s| s.sql.iter().cloned()).collect(),
        ok: log.stopped.is_none(),
        error: log.stopped.map(str::to_string),
        inverse: None,
        undo_of: None,
        undone: false,
        batch_id: None,
    }
}

#[cfg(test)]
mod tests;
