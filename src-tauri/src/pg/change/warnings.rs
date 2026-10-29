//! 미리보기의 경고(순수 함수): 막힘(`resolve`의 `blocks`), 확인해야 하는 것, 알려 주는 것.
//! 변경 하나에 속한 경고(`item`)와, 변경 전 스냅숏과 변경 뒤의 스냅숏을 견줘야 하는 경고(`closing`)가 따로 있다.
//! 장바구니는 변경마다 `item`을 만들고 묶음 전체에 `closing`을 한 번 만든다: 묶음이 이미 기본 권한을 담았으면 "기본 권한 없음" 알림이 나오지 않는다.

use std::collections::BTreeSet;

use super::after::built_in;
use super::model::{PgChange, PresetKind};
use super::resolve::{OnTarget, Op, Resolved};
use super::rights::Rights;
use super::sql_text::AttrClause;
use crate::iam::clock::parse_iso;
use crate::pg::eval::{Ctx, Eval};
use crate::pg::model::{AclEntry, DefaultAclRec, DefaultObjType, Privilege, RelKind, RoleRec};
use crate::pg::summary::RDS_SUPERUSER;
use crate::pg::view::{PgWarnLevel, PgWarning};

/// 구성원이 이만큼 이상인 그룹이 큰 그룹이다
pub const BIG_GROUP: usize = 10;
const RDS_IAM: &str = "rds_iam";
const SUPERUSER_TEXT: &str = "rds_superuser를 주면 대부분의 관리 작업을 할 수 있게 돼요";
const CREATE_ROLE_TEXT: &str = "CREATEROLE을 주면 역할을 만들고 바꿀 수 있게 돼요";
const PUBLIC_TEXT: &str = "모든 역할(PUBLIC)에 권한을 줘요";
const DROP_TEXT: &str = "역할을 삭제해요. 되돌릴 수 없어요";
const TERMINATE_TEXT: &str = "세션을 끊어요. 되돌릴 수 없어요";
const LOGIN_LOSES_TEXT: &str = "적용하면 이 앱이 다시 접속하지 못할 수 있어요";
const TABLES_TEXT: &str = "새로 만드는 테이블에는 적용되지 않아요";
const SEQUENCES_TEXT: &str = "새로 만드는 시퀀스에는 적용되지 않아요";
const NO_OP_TEXT: &str = "이미 그 상태라 달라지는 게 없어요";
const IAM_USER_TEXT: &str = "이 사용자는 rds_iam 구성원이라 비밀번호로는 로그인하지 못해요";
const GLOBAL_DEFAULT_TEXT: &str = "스키마별 기본 권한에서는 모든 스키마에 준 권한을 뺄 수 없어요. 모든 스키마의 기본 권한에서 빼 주세요";
const LOGIN_OFF_TEXT: &str = "LOGIN을 끄면 이 역할은 역할 목록의 그룹 쪽에 보여요";

fn warning(level: PgWarnLevel, message: impl Into<String>) -> PgWarning {
    PgWarning { level, message: message.into(), add: Vec::new() }
}

/// 같은 글은 한 번만 담는다
fn push(out: &mut Vec<PgWarning>, warning: PgWarning) {
    if !out.iter().any(|w| w.level == warning.level && w.message == warning.message) {
        out.push(warning);
    }
}

/// 막힘, 확인, 알림 순서로 늘어놓는다(같은 단계 안에서는 만든 순서). 막힌 것이 있으면 확인은 버린다: 확인할 일이 아니라 적용할 수 없는 변경이다
pub fn ordered(mut warnings: Vec<PgWarning>, blocked: bool) -> Vec<PgWarning> {
    if blocked {
        warnings.retain(|w| w.level != PgWarnLevel::Confirm);
    }
    warnings.sort_by_key(|w| w.level);
    warnings
}

pub fn direct_members(ctx: &Ctx, group: &str) -> usize {
    ctx.cluster.members.iter().filter(|m| m.group == group).count()
}

fn role_rec<'a>(ctx: &Ctx<'a>, name: &str) -> Option<&'a RoleRec> {
    ctx.cluster.roles.iter().find(|r| r.name == name)
}

/// 변경 하나에 속한 경고. `before`와 `after`는 이 변경 하나의 앞뒤 스냅숏이다
pub fn item(change: &PgChange, resolved: &Resolved, before: &Ctx, after: &Ctx) -> Vec<PgWarning> {
    let mut out = Vec::new();
    for text in &resolved.blocks {
        push(&mut out, warning(PgWarnLevel::Block, text));
    }
    confirms(&mut out, change, resolved, before);
    warns(&mut out, change, resolved, before, after);
    out
}

fn confirms(out: &mut Vec<PgWarning>, change: &PgChange, resolved: &Resolved, before: &Ctx) {
    let mut confirm = |text: &str| push(out, warning(PgWarnLevel::Confirm, text));
    match change {
        PgChange::Membership { group, add: true, .. } if group == RDS_SUPERUSER => confirm(SUPERUSER_TEXT),
        PgChange::CreateRole { groups, preset, .. } => {
            if groups.iter().any(|g| g == RDS_SUPERUSER) || preset.as_ref().is_some_and(|p| p.preset == PresetKind::Admin) {
                confirm(SUPERUSER_TEXT);
            }
        }
        PgChange::Attributes { role, set } if set.create_role && role_rec(before, role).is_some_and(|r| !r.create_role) => confirm(CREATE_ROLE_TEXT),
        PgChange::Grant { grantee, add: true, .. } | PgChange::DefaultPrivilege { grantee, add: true, .. } if grantee == "PUBLIC" => confirm(PUBLIC_TEXT),
        PgChange::DropRole { .. } => confirm(DROP_TEXT),
        PgChange::Terminate { .. } => confirm(TERMINATE_TEXT),
        _ => {}
    }
    // 구성원이 많은 그룹의 권한을 바꾸거나 그 그룹을 다른 그룹에 넣는 변경
    let group = match change {
        PgChange::Grant { grantee, .. } | PgChange::DefaultPrivilege { grantee, .. } => Some(grantee),
        PgChange::Membership { member, .. } => Some(member),
        _ => None,
    };
    if let Some(group) = group {
        let n = direct_members(before, group);
        if n >= BIG_GROUP {
            confirm(&format!("구성원이 {n}명인 그룹의 권한을 바꿔요"));
        }
    }
    for text in &resolved.confirms {
        confirm(text);
    }
}

fn warns(out: &mut Vec<PgWarning>, change: &PgChange, resolved: &Resolved, before: &Ctx, after: &Ctx) {
    let mut warn = |text: String| push(out, warning(PgWarnLevel::Warn, text));
    // 비밀번호와 세션 끊기는 스냅숏 밖의 일을 한다: 스냅숏이 같아도 달라지는 게 없는 것이 아니다
    let outside = matches!(change, PgChange::Password { .. } | PgChange::Terminate { .. });
    if !outside && resolved.blocks.is_empty() && before.cluster == after.cluster && before.db == after.db {
        warn(NO_OP_TEXT.to_string());
    }
    if !resolved.stays.is_empty() {
        let sample: Vec<&str> = resolved.stays.iter().take(3).map(String::as_str).collect();
        warn(format!("다른 역할이 준 권한은 남아요({}개, 예: {})", resolved.stays.len(), sample.join(", ")));
    }
    if !resolved.memberships_stay.is_empty() {
        warn(format!("다른 역할이 준 구성원 관계는 남아요: {}", resolved.memberships_stay.join(", ")));
    }
    let in_rds_iam = |role: &str| Eval::for_cluster(before.cluster).member_closure(role).iter().any(|r| r == RDS_IAM);
    match change {
        PgChange::Password { role } if in_rds_iam(role) => warn(IAM_USER_TEXT.to_string()),
        PgChange::CreateRole { login: true, groups, .. } if groups.iter().any(|g| g == RDS_IAM) => warn(IAM_USER_TEXT.to_string()),
        PgChange::Attributes { role, set } if !set.login && role_rec(before, role).is_some_and(|r| r.login) => warn(LOGIN_OFF_TEXT.to_string()),
        PgChange::DefaultPrivilege { creator, schema: Some(_), object_type, grantee, privileges, add: false, .. }
            if resolved.blocks.is_empty() && global_holds(before, creator, *object_type, grantee, privileges) =>
        {
            warn(GLOBAL_DEFAULT_TEXT.to_string())
        }
        _ => {}
    }
}

fn default_acl<'a>(ctx: &Ctx<'a>, creator: &str, schema: Option<&str>, object_type: DefaultObjType) -> Option<&'a DefaultAclRec> {
    ctx.db.default_acl(creator, schema, object_type)
}

fn grants(acl: &[AclEntry], creator: &str, grantee: Option<&str>, privilege: Privilege) -> bool {
    acl.iter().any(|e| e.grantor == creator && e.grantee.as_deref() == grantee && e.privilege == privilege)
}

/// 모든 스키마의 기록(없으면 서버 내장 기본값)에 있는 권한이 하나라도 있는가. 스키마별 기록에도 있든 없든 스키마별로 빼도 새 객체가 받는 권한은 달라지지 않는다
fn global_holds(before: &Ctx, creator: &str, object_type: DefaultObjType, grantee: &str, privileges: &[Privilege]) -> bool {
    let grantee = (grantee != "PUBLIC").then_some(grantee);
    let global = default_acl(before, creator, None, object_type).map(|d| d.acl.clone()).unwrap_or_else(|| built_in(before.cluster.version_num, creator, object_type));
    privileges.iter().any(|&p| grants(&global, creator, grantee, p))
}

/// 변경 전과 변경 뒤(변경 하나 또는 묶음 전체)의 스냅숏을 견줘 알 수 있는 경고
pub fn closing(before: &Ctx, after: &Ctx, ops: &[Op], now: i64) -> Vec<PgWarning> {
    let mut out = Vec::new();
    if login_loses_access(before, after, now) {
        push(&mut out, warning(PgWarnLevel::Confirm, LOGIN_LOSES_TEXT));
    }
    for warning in tables_without_defaults(after, ops) {
        push(&mut out, warning);
    }
    let touches_every_database = ops.iter().any(|op| match op {
        Op::GrantRole { .. } | Op::RevokeRole { .. } | Op::CreateRole { .. } | Op::DropRole { .. } => true,
        Op::AlterRole { clauses, .. } => clauses.iter().any(|c| matches!(c, AttrClause::Inherit(_))),
        _ => false,
    });
    if touches_every_database {
        push(&mut out, warning(PgWarnLevel::Warn, format!("영향은 {} 데이터베이스만 계산했어요", after.db.database)));
    }
    out
}

fn expired(role: &RoleRec, now: i64) -> bool {
    role.valid_until.as_deref().and_then(parse_iso).is_some_and(|until| until < now)
}

/// 이 앱의 로그인이 변경 때문에 접속하지 못하게 되는가: rds_iam에서 빠지거나, LOGIN이 꺼지거나, 만료되거나, 역할을 관리할 수 없게 된다
fn login_loses_access(before: &Ctx, after: &Ctx, now: i64) -> bool {
    let login = &before.cluster.login_user;
    let (rights_before, rights_after) = (Rights::new(before.cluster, before.db), Rights::new(after.cluster, after.db));
    if (rights_before.member_of(RDS_IAM) && !rights_after.member_of(RDS_IAM)) || (rights_before.can_manage() && !rights_after.can_manage()) {
        return true;
    }
    match (role_rec(before, login), role_rec(after, login)) {
        (Some(was), Some(is)) => (was.login && !is.login) || (!expired(was, now) && expired(is, now)),
        _ => false,
    }
}

/// `ALL TABLES`·`ALL SEQUENCES` 권한을 준 그룹에, 지금 그 스키마에 객체를 가진 소유자가 새로 만들 객체의 기본 권한이 없는가
fn tables_without_defaults(after: &Ctx, ops: &[Op]) -> Vec<PgWarning> {
    let eval = Eval::new(after);
    let mut tables = warning(PgWarnLevel::Warn, TABLES_TEXT);
    let mut sequences = warning(PgWarnLevel::Warn, SEQUENCES_TEXT);
    for op in ops {
        let Op::Privileges { add: true, on, privileges, grantee, .. } = op else { continue };
        let (schema, object_type, target) = match on {
            OnTarget::AllTables(schema) => (schema, DefaultObjType::Tables, &mut tables),
            OnTarget::AllSequences(schema) => (schema, DefaultObjType::Sequences, &mut sequences),
            _ => continue,
        };
        // 받는 쪽이 쓰는 역할들(자기 자신과 상속하는 역할). PUBLIC이면 PUBLIC뿐이다
        let holders: BTreeSet<String> = if grantee == "PUBLIC" { BTreeSet::new() } else { eval.role(grantee).inherited().into_iter().map(|i| i.role).collect() };
        let is_sequence = |kind: RelKind| kind == RelKind::Sequence;
        let owners: BTreeSet<&str> = after
            .db
            .relations
            .iter()
            .filter(|r| &r.schema == schema && is_sequence(r.kind) == (object_type == DefaultObjType::Sequences))
            .map(|r| r.owner.as_str())
            .collect();
        for creator in owners.into_iter().filter(|&owner| !holders.contains(owner)) {
            let covered: BTreeSet<Privilege> = [Some(schema.as_str()), None]
                .into_iter()
                .filter_map(|scope| default_acl(after, creator, scope, object_type))
                .flat_map(|d| d.acl.iter())
                .filter(|e| e.grantee.as_deref().is_none_or(|g| holders.contains(g)))
                .map(|e| e.privilege)
                .collect();
            if privileges.iter().all(|p| covered.contains(p)) {
                continue;
            }
            let add = PgChange::DefaultPrivilege {
                database: after.db.database.clone(),
                creator: creator.to_string(),
                schema: Some(schema.clone()),
                object_type,
                grantee: grantee.clone(),
                privileges: privileges.clone(),
                add: true,
            };
            if !target.add.contains(&add) {
                target.add.push(add);
            }
        }
    }
    [tables, sequences].into_iter().filter(|w| !w.add.is_empty()).collect()
}

#[cfg(test)]
mod tests;
