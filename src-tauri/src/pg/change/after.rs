//! 변경이 서버에서 이뤄진 뒤의 스냅숏(순수 함수). 연산(`Op`)을 복제한 스냅숏에 차례로 적용한다.
//! 미리보기의 영향·역할·기본 권한 변화가 이 결과와 원래 스냅숏의 차이이고, 같은 결과를 다음 변경의 판단 근거로도 쓴다(`resolve`).
//! 실제 서버에서 다시 읽은 스냅숏과 같아야 한다: `live_tests`가 대조한다.

use super::resolve::{ObjKey, Op};
use crate::pg::eval::MAINTAIN_SINCE;
use super::sql_text::AttrClause;
use crate::iam::clock::{iso, parse_iso};
use crate::pg::model::{
    AclEntry, ClusterSnapshot, DbSnapshot, DefaultAclRec, DefaultObjType, MemberGrant, MemberRec, Privilege, RoleRec, MEMBERSHIP_OPTIONS_SINCE,
};


pub fn apply(cluster: &mut ClusterSnapshot, db: &mut DbSnapshot, ops: &[Op]) {
    for op in ops {
        match op {
            Op::CreateRole { name, login, connection_limit, valid_until, .. } => create_role(cluster, name, *login, *connection_limit, valid_until.as_deref().map(normalized)),
            Op::AlterRole { role, clauses } => alter_role(cluster, role, clauses),
            // 비밀번호는 스냅숏에 없다
            Op::SetPassword { .. } => {}
            Op::DropRole { role } => {
                cluster.roles.retain(|r| &r.name != role);
                cluster.members.retain(|m| &m.member != role && &m.group != role);
            }
            Op::GrantRole { group, member, admin, grantor } => grant_role(cluster, group, member, *admin, grantor),
            Op::RevokeRole { group, member, admin_only, row_grantor, .. } => revoke_role(cluster, group, member, *admin_only, row_grantor),
            Op::Privileges { add, grantee, effects, .. } => {
                for effect in effects {
                    let Some(acl) = acl_mut(cluster, db, &effect.object) else { continue };
                    let same = |e: &AclEntry| e.grantor == effect.grantor && e.grantee.as_deref() == public_to_none(grantee) && e.privilege == effect.privilege;
                    if *add {
                        if !acl.iter().any(same) {
                            acl.push(AclEntry { grantor: effect.grantor.clone(), grantee: public_to_none(grantee).map(str::to_string), privilege: effect.privilege, grantable: false });
                        }
                    } else {
                        acl.retain(|e| !same(e));
                    }
                }
            }
            Op::DefaultAcl { creator, schema, object_type, privileges, grantee, add } => {
                let spec = DefaultSpec { creator, schema: schema.as_deref(), object_type: *object_type, privileges, grantee: public_to_none(grantee), add: *add };
                default_acl(cluster.version_num, db, &spec)
            }
            Op::Terminate { pid, .. } => cluster.sessions.retain(|s| s.pid != *pid),
        }
    }
}

/// 변경의 받는 쪽 이름은 글자 그대로 `PUBLIC`이면 모든 역할이다(ACL에서는 grantee가 없다)
fn public_to_none(grantee: &str) -> Option<&str> {
    (grantee != "PUBLIC").then_some(grantee)
}

fn acl_mut<'x>(cluster: &'x mut ClusterSnapshot, db: &'x mut DbSnapshot, key: &ObjKey) -> Option<&'x mut Vec<AclEntry>> {
    match key {
        ObjKey::Database(name) => cluster.databases.iter_mut().find(|d| &d.name == name).map(|d| &mut d.acl),
        ObjKey::Schema(name) => db.schemas.iter_mut().find(|s| &s.name == name).map(|s| &mut s.acl),
        ObjKey::Relation(schema, name) => db.relations.iter_mut().find(|r| &r.schema == schema && &r.name == name).map(|r| &mut r.acl),
        ObjKey::Function(schema, name, signature) => {
            db.functions.iter_mut().find(|f| &f.schema == schema && &f.name == name && &f.signature == signature).map(|f| &mut f.acl)
        }
    }
}

// ───────────────────────── 역할 ─────────────────────────

/// 서버가 읽어 주는 만료 시각의 꼴: 초까지, UTC, `Z`
fn normalized(time: &str) -> String {
    parse_iso(time).map_or_else(|| time.to_string(), iso)
}

fn create_role(cluster: &mut ClusterSnapshot, name: &str, login: bool, connection_limit: i32, valid_until: Option<String>) {
    let oid = cluster.roles.iter().map(|r| r.oid).max().unwrap_or(0) + 1;
    cluster.roles.push(RoleRec {
        name: name.to_string(),
        login,
        inherit: true,
        create_role: false,
        create_db: false,
        replication: false,
        bypass_rls: false,
        superuser: false,
        conn_limit: connection_limit,
        valid_until,
        comment: None,
        oid,
    });
    if cluster.version_num < MEMBERSHIP_OPTIONS_SINCE {
        return;
    }
    let creator = cluster.login_user.clone();
    if cluster.roles.iter().any(|r| r.name == creator && r.superuser) {
        return;
    }
    // CREATEROLE 사용자가 만든 역할은 그 사용자에게 ADMIN만 있는 구성원 부여가 부트스트랩 superuser의 이름으로 남는다
    let bootstrap = cluster.bootstrap_superuser.clone();
    put_grant(cluster, name, &creator, MemberGrant { grantor: bootstrap, admin: true, inherit: Some(false), set: Some(false) });
    // `createrole_self_grant`가 있으면 로그인한 역할이 자신에게 주는 부여가 하나 더 생긴다(ADMIN 없이, 적힌 옵션만)
    let options: Vec<String> = cluster.createrole_self_grant.split(',').map(|o| o.trim().to_ascii_lowercase()).filter(|o| !o.is_empty()).collect();
    if !options.is_empty() {
        let grant = MemberGrant { grantor: creator.clone(), admin: false, inherit: Some(options.iter().any(|o| o == "inherit")), set: Some(options.iter().any(|o| o == "set")) };
        put_grant(cluster, name, &creator, grant);
    }
}

fn alter_role(cluster: &mut ClusterSnapshot, role: &str, clauses: &[AttrClause]) {
    let Some(rec) = cluster.roles.iter_mut().find(|r| r.name == role) else { return };
    for clause in clauses {
        match clause {
            AttrClause::Login(on) => rec.login = *on,
            AttrClause::CreateDb(on) => rec.create_db = *on,
            AttrClause::CreateRole(on) => rec.create_role = *on,
            AttrClause::Inherit(on) => rec.inherit = *on,
            AttrClause::ConnectionLimit(limit) => rec.conn_limit = *limit,
            AttrClause::ValidUntil(until) => rec.valid_until = until.as_deref().map(normalized),
        }
    }
}

// ───────────────────────── 구성원 관계 ─────────────────────────

/// 쌍의 합친 값(`admin`, `inherit`, `set`)을 부여들에서 다시 구한다: 하나라도 있으면 있고, 옵션이 하나도 적혀 있지 않으면 None이다
fn recompute(rec: &mut MemberRec) {
    rec.grants.sort_by(|a, b| a.grantor.cmp(&b.grantor));
    rec.admin = rec.grants.iter().any(|g| g.admin);
    let merged = |pick: fn(&MemberGrant) -> Option<bool>, grants: &[MemberGrant]| grants.iter().any(|g| pick(g).is_some()).then(|| grants.iter().any(|g| pick(g) == Some(true)));
    rec.inherit = merged(|g| g.inherit, &rec.grants);
    rec.set = merged(|g| g.set, &rec.grants);
}

fn pair_mut<'x>(cluster: &'x mut ClusterSnapshot, member: &str, group: &str) -> &'x mut MemberRec {
    let index = match cluster.members.iter().position(|m| m.member == member && m.group == group) {
        Some(index) => index,
        None => {
            cluster.members.push(MemberRec { member: member.into(), group: group.into(), admin: false, inherit: None, set: None, grants: Vec::new() });
            cluster.members.len() - 1
        }
    };
    &mut cluster.members[index]
}

/// 부여자의 부여를 넣는다. 그 부여자의 줄이 이미 있으면 바꾼다
fn put_grant(cluster: &mut ClusterSnapshot, group: &str, member: &str, grant: MemberGrant) {
    let rec = pair_mut(cluster, member, group);
    rec.grants.retain(|g| g.grantor != grant.grantor);
    rec.grants.push(grant);
    recompute(rec);
}

fn grant_role(cluster: &mut ClusterSnapshot, group: &str, member: &str, admin: bool, grantor: &str) {
    if cluster.version_num >= MEMBERSHIP_OPTIONS_SINCE {
        // 새 부여의 INHERIT는 서버가 부여할 때 구성원의 `rolinherit`를 옮긴다. SET은 켠다
        let inherit = cluster.roles.iter().find(|r| r.name == member).is_none_or(|r| r.inherit);
        let rec = pair_mut(cluster, member, group);
        match rec.grants.iter_mut().find(|g| g.grantor == grantor) {
            Some(row) => row.admin |= admin,
            None => rec.grants.push(MemberGrant { grantor: grantor.into(), admin, inherit: Some(inherit), set: Some(true) }),
        }
        recompute(rec);
        return;
    }
    // 160000 전에는 쌍마다 줄 하나다. 이미 있는 쌍에 ADMIN OPTION을 더하면 부여자가 로그인한 역할로 바뀐다
    let rec = pair_mut(cluster, member, group);
    match rec.grants.first_mut() {
        Some(row) if admin => {
            row.admin = true;
            row.grantor = grantor.into();
        }
        Some(_) => {}
        None => rec.grants.push(MemberGrant { grantor: grantor.into(), admin, inherit: None, set: None }),
    }
    recompute(rec);
}

fn revoke_role(cluster: &mut ClusterSnapshot, group: &str, member: &str, admin_only: bool, row_grantor: &str) {
    let version = cluster.version_num;
    let Some(rec) = cluster.members.iter_mut().find(|m| m.member == member && m.group == group) else { return };
    if version >= MEMBERSHIP_OPTIONS_SINCE {
        if admin_only {
            rec.grants.iter_mut().filter(|g| g.grantor == row_grantor).for_each(|g| g.admin = false);
        } else {
            rec.grants.retain(|g| g.grantor != row_grantor);
        }
    } else if admin_only {
        rec.grants.iter_mut().for_each(|g| g.admin = false);
    } else {
        rec.grants.clear();
    }
    recompute(rec);
    let gone = rec.grants.is_empty();
    if gone {
        cluster.members.retain(|m| !(m.member == member && m.group == group));
    }
}

// ───────────────────────── 기본 권한 ─────────────────────────

/// 서버가 만드는 객체의 기본 ACL(`acldefault`)에서 `creator`가 갖는 권한들
fn built_in(version: i32, creator: &str, object_type: DefaultObjType) -> Vec<AclEntry> {
    use Privilege::*;
    let own: Vec<Privilege> = match object_type {
        DefaultObjType::Tables => {
            let mut all = vec![Select, Insert, Update, Delete, Truncate, References, Trigger];
            if version >= MAINTAIN_SINCE {
                all.push(Maintain);
            }
            all
        }
        DefaultObjType::Sequences => vec![Select, Update, Usage],
        DefaultObjType::Functions => vec![Execute],
        DefaultObjType::Types => vec![Usage],
        DefaultObjType::Schemas => vec![Usage, Create],
    };
    let entry = |grantee: Option<&str>, privilege| AclEntry { grantor: creator.into(), grantee: grantee.map(str::to_string), privilege, grantable: false };
    let mut acl: Vec<AclEntry> = own.into_iter().map(|p| entry(Some(creator), p)).collect();
    match object_type {
        DefaultObjType::Functions => acl.push(entry(None, Execute)),
        DefaultObjType::Types => acl.push(entry(None, Usage)),
        _ => {}
    }
    acl
}

/// ACL을 순서와 상관없이 비교하는 열쇠
fn key(acl: &[AclEntry]) -> Vec<(String, Option<String>, Privilege, bool)> {
    let mut keys: Vec<_> = acl.iter().map(|e| (e.grantor.clone(), e.grantee.clone(), e.privilege, e.grantable)).collect();
    keys.sort();
    keys
}

/// 기본 권한 한 건의 내용
struct DefaultSpec<'a> {
    creator: &'a str,
    schema: Option<&'a str>,
    object_type: DefaultObjType,
    privileges: &'a [Privilege],
    /// None은 PUBLIC
    grantee: Option<&'a str>,
    add: bool,
}

/// 기본 권한 한 건. 모든 스키마의 기록은 없으면 내장 기본값에서, 스키마별 기록은 빈 것에서 시작한다. 부여자는 만드는 역할이다.
/// 모든 스키마의 기록이 내장 기본값과 같아지거나 스키마별 기록이 비면 그 기록은 없어진다
fn default_acl(version: i32, db: &mut DbSnapshot, spec: &DefaultSpec) {
    let DefaultSpec { creator, schema, object_type, privileges, grantee, add } = *spec;
    let found = db.default_acls.iter().position(|r| r.creator == creator && r.schema.as_deref() == schema && r.obj_type == object_type);
    let mut acl = match found {
        Some(index) => db.default_acls[index].acl.clone(),
        None if schema.is_none() => built_in(version, creator, object_type),
        None => Vec::new(),
    };
    for &privilege in privileges {
        let same = |e: &AclEntry| e.grantor == creator && e.grantee.as_deref() == grantee && e.privilege == privilege;
        if add {
            if !acl.iter().any(same) {
                acl.push(AclEntry { grantor: creator.into(), grantee: grantee.map(str::to_string), privilege, grantable: false });
            }
        } else {
            acl.retain(|e| !same(e));
        }
    }
    let gone = if schema.is_none() { key(&acl) == key(&built_in(version, creator, object_type)) } else { acl.is_empty() };
    match (found, gone) {
        (Some(index), true) => {
            db.default_acls.remove(index);
        }
        (Some(index), false) => db.default_acls[index].acl = acl,
        (None, false) => db.default_acls.push(DefaultAclRec { creator: creator.into(), schema: schema.map(str::to_string), obj_type: object_type, acl }),
        (None, true) => {}
    }
}

#[cfg(test)]
mod tests;
