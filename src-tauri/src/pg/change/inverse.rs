//! 변경을 되돌리는 변경들(순수 함수). `None`은 되돌릴 수 없다는 뜻이고, `Some(빈 목록)`은 변경이 아무것도 바꾸지 않는다는 뜻이다.
//! 풀린 연산(`Resolved::ops`)과 변경 전 스냅숏으로 판단한다: 실제로 일어난 일만 되돌리고, 되돌려도 같은 상태가 되지 않는 것은 `None`이다.

use std::collections::{BTreeMap, BTreeSet};

use super::after::built_in;
use super::model::{AttributesSet, GrantItem, GrantTarget, PgChange};
use super::preview::PreviewCtx;
use super::resolve::{resolve, ObjKey, OnTarget, Op, ResolveCtx, Resolved};
use super::rights::Rights;
use crate::pg::eval::Ctx;
use crate::pg::model::{AclEntry, DefaultObjType, MemberRec, Privilege, RelKind, MEMBERSHIP_OPTIONS_SINCE};

pub fn inverse(ctx: &PreviewCtx, change: &PgChange) -> Option<Vec<PgChange>> {
    let resolved = resolve(&ResolveCtx { cluster: ctx.cluster, db: ctx.db, own_pids: ctx.own_pids, read_replica: ctx.read_replica }, change);
    let (mut cluster, mut db) = (ctx.cluster.clone(), ctx.db.clone());
    super::after::apply(&mut cluster, &mut db, &resolved.ops);
    of(&Ctx { cluster: ctx.cluster, db: ctx.db }, &Ctx { cluster: &cluster, db: &db }, change, &resolved)
}

/// 이미 푼 변경의 되돌리기. `before`와 `after`는 이 변경 하나의 앞뒤 스냅숏이다
pub(super) fn of(before: &Ctx, after: &Ctx, change: &PgChange, resolved: &Resolved) -> Option<Vec<PgChange>> {
    match change {
        PgChange::CreateRole { name, preset, .. } => Some(create_role(name, preset.as_ref().and_then(|p| p.database.as_deref()), &resolved.ops, &before.db.database)),
        PgChange::Membership { group, member, add, admin } => membership(before, after, group, member, *add, *admin, &resolved.ops),
        PgChange::Attributes { role, .. } => {
            let altered = resolved.ops.iter().any(|op| matches!(op, Op::AlterRole { role: r, .. } if r == role));
            let rec = before.cluster.roles.iter().find(|r| &r.name == role)?;
            let set = AttributesSet {
                login: rec.login,
                create_db: rec.create_db,
                create_role: rec.create_role,
                inherit: rec.inherit,
                connection_limit: rec.conn_limit,
                valid_until: rec.valid_until.clone(),
            };
            Some(if altered { vec![PgChange::Attributes { role: role.clone(), set }] } else { Vec::new() })
        }
        PgChange::Grant { database, grantee, add, .. } => grant(before, database, grantee, *add, &resolved.ops),
        PgChange::DefaultPrivilege { .. } => default_privilege(before, after, change, &resolved.ops),
        PgChange::Password { .. } | PgChange::DropRole { .. } | PgChange::Terminate { .. } => None,
    }
}

// ───────────────────────── 역할 만들기 ─────────────────────────

/// 새로 만든 역할(과 같은 변경에서 만든 그룹)이 받은 권한과 기본 권한을 거두고 역할을 지운다. 새 역할에는 원래 아무것도 없었으니 프리셋의 항목을 그대로 거두는 것이
/// 정확하고(`ALL TABLES`도 그대로 거둔다), 그 사이 기본 권한으로 새 테이블이 받은 권한도 함께 거둬진다.
/// 순서: 거두기, 기본 권한 거두기, 역할 이름 지우기, 그룹 지우기
fn create_role(name: &str, preset_database: Option<&str>, ops: &[Op], default_db: &str) -> Vec<PgChange> {
    let created: Vec<&str> = ops.iter().filter_map(|op| if let Op::CreateRole { name, .. } = op { Some(name.as_str()) } else { None }).collect();
    if !created.contains(&name) {
        return Vec::new();
    }
    let database = preset_database.unwrap_or(default_db).to_string();
    let mut held: Vec<(&str, Vec<GrantItem>)> = Vec::new();
    for op in ops {
        let Op::Privileges { add: true, on, privileges, grantee, .. } = op else { continue };
        if !created.contains(&grantee.as_str()) {
            continue;
        }
        let item = GrantItem { target: grant_target_of(on), privileges: privileges.clone() };
        match held.iter_mut().find(|(holder, _)| holder == grantee) {
            Some((_, items)) => items.push(item),
            None => held.push((grantee, vec![item])),
        }
    }
    let revokes = held.into_iter().map(|(grantee, items)| PgChange::Grant { database: database.clone(), grantee: grantee.to_string(), add: false, items });
    let defaults = ops.iter().filter_map(|op| match op {
        Op::DefaultAcl { creator, schema, object_type, privileges, grantee, add: true } if created.contains(&grantee.as_str()) => Some(PgChange::DefaultPrivilege {
            database: database.clone(),
            creator: creator.clone(),
            schema: schema.clone(),
            object_type: *object_type,
            grantee: grantee.clone(),
            privileges: privileges.clone(),
            add: false,
        }),
        _ => None,
    });
    let mut out: Vec<PgChange> = revokes.collect();
    out.extend(defaults);
    out.push(PgChange::DropRole { role: name.to_string() });
    out.extend(created.iter().filter(|&&group| group != name).map(|&group| PgChange::DropRole { role: group.to_string() }));
    out
}

fn grant_target_of(on: &OnTarget) -> GrantTarget {
    use OnTarget as T;
    match on {
        T::Database(name) => GrantTarget::Database { name: name.clone() },
        T::Schema(name) => GrantTarget::Schema { name: name.clone() },
        T::Relation(schema, name) => GrantTarget::Relation { schema: schema.clone(), name: name.clone() },
        T::Sequence(schema, name) => GrantTarget::Sequence { schema: schema.clone(), name: name.clone() },
        T::Function(schema, name, signature) => GrantTarget::Function { schema: schema.clone(), name: name.clone(), signature: signature.clone() },
        T::AllTables(schema) => GrantTarget::AllTables { schema: schema.clone() },
        T::AllSequences(schema) => GrantTarget::AllSequences { schema: schema.clone() },
    }
}

// ───────────────────────── 구성원 관계 ─────────────────────────

fn membership(before: &Ctx, after: &Ctx, group: &str, member: &str, add: bool, admin: bool, ops: &[Op]) -> Option<Vec<PgChange>> {
    let pair: Option<&MemberRec> = before.cluster.members.iter().find(|m| m.group == group && m.member == member);
    let from_16 = before.cluster.version_num >= MEMBERSHIP_OPTIONS_SINCE;
    let remove = |admin: bool| Some(vec![PgChange::Membership { group: group.into(), member: member.into(), add: false, admin }]);
    if add {
        let Some(grantor) = ops.iter().find_map(|op| match op {
            Op::GrantRole { group: g, member: m, grantor, .. } if g == group && m == member => Some(grantor.as_str()),
            _ => None,
        }) else {
            return Some(Vec::new());
        };
        let Some(pair) = pair else { return remove(false) };
        if !from_16 {
            // 쌍이 이미 있는데 연산이 있다는 것은 ADMIN OPTION을 더했다는 뜻이다
            return if admin { remove(true) } else { Some(Vec::new()) };
        }
        // 부여자의 줄이 없으면 이 GRANT가 기본 옵션의 줄을 새로 만든다. 거두기는 줄 하나만 짚을 수 없다
        if !pair.grants.iter().any(|g| g.grantor == grantor) {
            return None;
        }
        if !admin {
            return Some(Vec::new());
        }
        // ADMIN만 거두면 다른 부여자의 ADMIN 줄에서도 ADMIN이 빠진다
        if pair.grants.iter().any(|g| g.grantor != grantor && g.admin) {
            return None;
        }
        return remove(true);
    }
    let revoked: Vec<(&Option<String>, bool)> = ops
        .iter()
        .filter_map(|op| match op {
            Op::RevokeRole { group: g, member: m, granted_by, admin_only, .. } if g == group && m == member => Some((granted_by, *admin_only)),
            _ => None,
        })
        .collect();
    if revoked.is_empty() {
        return Some(Vec::new());
    }
    let admin_only = revoked.iter().all(|(_, admin_only)| *admin_only);
    let grant_back = |admin: bool| Some(vec![PgChange::Membership { group: group.into(), member: member.into(), add: true, admin }]);
    let pair = pair?;
    if !from_16 {
        return grant_back(admin_only || pair.admin);
    }
    // 160000부터: 줄 하나를 같은 부여자로 같은 옵션으로 되살릴 수 있을 때만. 다시 주면 서버가 정하는 부여자와 기본 옵션(INHERIT는 구성원의 속성, SET은 켜짐)이 된다
    let [(Some(granted_by), _)] = revoked.as_slice() else { return None };
    let regrantor = Rights::new(after.cluster, after.db).membership_grantor(group).ok()?;
    if &regrantor != granted_by {
        return None;
    }
    if admin_only {
        return grant_back(true);
    }
    let row = pair.grants.iter().find(|g| &g.grantor == granted_by)?;
    let member_inherits = before.cluster.roles.iter().find(|r| r.name == member).is_none_or(|r| r.inherit);
    if row.inherit != Some(member_inherits) || row.set != Some(true) {
        return None;
    }
    grant_back(row.admin)
}

// ───────────────────────── 권한 ─────────────────────────

fn acl_of<'a>(ctx: &Ctx<'a>, key: &ObjKey) -> Option<&'a [AclEntry]> {
    match key {
        ObjKey::Database(name) => ctx.cluster.databases.iter().find(|d| &d.name == name).map(|d| d.acl.as_slice()),
        ObjKey::Schema(name) => ctx.db.schemas.iter().find(|s| &s.name == name).map(|s| s.acl.as_slice()),
        ObjKey::Relation(schema, name) => ctx.db.relations.iter().find(|r| &r.schema == schema && &r.name == name).map(|r| r.acl.as_slice()),
        ObjKey::Function(schema, name, signature) => {
            ctx.db.functions.iter().find(|f| &f.schema == schema && &f.name == name && &f.signature == signature).map(|f| f.acl.as_slice())
        }
    }
}

fn target_of(ctx: &Ctx, key: &ObjKey) -> GrantTarget {
    match key {
        ObjKey::Database(name) => GrantTarget::Database { name: name.clone() },
        ObjKey::Schema(name) => GrantTarget::Schema { name: name.clone() },
        ObjKey::Relation(schema, name) => {
            let sequence = ctx.db.relations.iter().any(|r| &r.schema == schema && &r.name == name && r.kind == RelKind::Sequence);
            if sequence {
                GrantTarget::Sequence { schema: schema.clone(), name: name.clone() }
            } else {
                GrantTarget::Relation { schema: schema.clone(), name: name.clone() }
            }
        }
        ObjKey::Function(schema, name, signature) => GrantTarget::Function { schema: schema.clone(), name: name.clone(), signature: signature.clone() },
    }
}

/// 실제로 더하거나 거둔 (객체, 권한) 항목을 객체마다 하나의 항목으로 모아 반대로 한다. `ALL TABLES`는 쓰지 않는다.
/// 거둔 항목에 GRANT OPTION이 있었으면 다시 줘도 되살릴 수 없으니 `None`이다
fn grant(before: &Ctx, database: &str, grantee: &str, add: bool, ops: &[Op]) -> Option<Vec<PgChange>> {
    let grantee_name = (grantee != "PUBLIC").then_some(grantee);
    let mut by_object: BTreeMap<&ObjKey, BTreeSet<Privilege>> = BTreeMap::new();
    for op in ops {
        let Op::Privileges { effects, .. } = op else { continue };
        for effect in effects {
            if !add {
                let grantable = acl_of(before, &effect.object).is_some_and(|acl| {
                    acl.iter().any(|e| e.grantor == effect.grantor && e.grantee.as_deref() == grantee_name && e.privilege == effect.privilege && e.grantable)
                });
                if grantable {
                    return None;
                }
            }
            by_object.entry(&effect.object).or_default().insert(effect.privilege);
        }
    }
    if by_object.is_empty() {
        return Some(Vec::new());
    }
    let items = by_object.into_iter().map(|(key, privileges)| GrantItem { target: target_of(before, key), privileges: privileges.into_iter().collect() }).collect();
    Some(vec![PgChange::Grant { database: database.into(), grantee: grantee.into(), add: !add, items }])
}

// ───────────────────────── 기본 권한 ─────────────────────────

/// 기록이 없을 때의 효과 있는 항목: 모든 스키마는 서버 내장 기본값, 스키마별은 비어 있다
fn effective_default(ctx: &Ctx, creator: &str, schema: Option<&str>, object_type: DefaultObjType) -> Vec<AclEntry> {
    match ctx.db.default_acls.iter().find(|d| d.creator == creator && d.schema.as_deref() == schema && d.obj_type == object_type) {
        Some(rec) => rec.acl.clone(),
        None if schema.is_none() => built_in(ctx.cluster.version_num, creator, object_type),
        None => Vec::new(),
    }
}

fn default_privilege(before: &Ctx, after: &Ctx, change: &PgChange, ops: &[Op]) -> Option<Vec<PgChange>> {
    let PgChange::DefaultPrivilege { database, creator, schema, object_type, grantee, privileges, add } = change else { return None };
    let (creator, grantee, schema, object_type, add) = (creator.as_str(), grantee.as_str(), schema.as_deref(), *object_type, *add);
    if !ops.iter().any(|op| matches!(op, Op::DefaultAcl { .. })) {
        return Some(Vec::new());
    }
    let grantee_name = (grantee != "PUBLIC").then_some(grantee);
    let (acl_before, acl_after) = (effective_default(before, creator, schema, object_type), effective_default(after, creator, schema, object_type));
    let entry = |acl: &[AclEntry], p: Privilege| acl.iter().find(|e| e.grantor == creator && e.grantee.as_deref() == grantee_name && e.privilege == p).cloned();
    let mut changed: Vec<Privilege> = Vec::new();
    for &p in privileges {
        let (was, is) = (entry(&acl_before, p), entry(&acl_after, p));
        if was.is_some() == is.is_some() {
            continue;
        }
        if !add && was.is_some_and(|e| e.grantable) {
            return None;
        }
        changed.push(p);
    }
    changed.sort();
    changed.dedup();
    if changed.is_empty() {
        return Some(Vec::new());
    }
    Some(vec![PgChange::DefaultPrivilege {
        database: database.clone(),
        creator: creator.into(),
        schema: schema.map(str::to_string),
        object_type,
        grantee: grantee.into(),
        privileges: changed,
        add: !add,
    }])
}

#[cfg(test)]
mod tests;
