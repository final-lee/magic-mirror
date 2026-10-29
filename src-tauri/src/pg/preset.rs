//! 새 역할을 만들 때 고르는 프리셋의 제안(순수 함수): 같은 권한을 이미 가진 그룹, 새 그룹에 붙일 이름, 기본 권한을 줄 만드는 역할 후보.
//! 프리셋이 주는 권한은 `change::resolve`(`preset_grants`)가 정하고, 여기서는 그 권한을 이미 가진 그룹을 찾는다. 실효 권한은 `eval`로 본다:
//! 직접 받은 것이든 상속한 것이든 쓸 수 있으면 가진 것이다.

use std::collections::BTreeSet;

use super::change::model::PresetKind;
use super::change::rights::Rights;
use super::eval::{schema_cells, Coverage, Ctx, Eval, Obj};
use super::model::{ClusterSnapshot, DbSnapshot, DefaultObjType, Privilege, RelKind, RoleRec};
use super::summary::is_system_role;
use super::view::{PgBlockedCreator, PgPresetSuggestion};

/// 역할 이름의 길이 한도(바이트)
const NAME_LIMIT: usize = 63;

pub fn suggest(cluster: &ClusterSnapshot, db: &DbSnapshot, preset: PresetKind, schemas: &[String]) -> PgPresetSuggestion {
    let creators = creators_of(db, schemas);
    let rights = Rights::new(cluster, db);
    let blocked_creators = creators.iter().filter_map(|creator| rights.defaults_for(creator).err().map(|reason| PgBlockedCreator { role: creator.clone(), reason })).collect();
    PgPresetSuggestion { matching: matching(cluster, db, preset, schemas), proposed_name: proposed_name(cluster, db, preset, schemas), creators, blocked_creators }
}

// ───────────────────────── 이름 ─────────────────────────

fn proposed_name(cluster: &ClusterSnapshot, db: &DbSnapshot, preset: PresetKind, schemas: &[String]) -> String {
    let suffix = match preset {
        PresetKind::ReadOnly => "read",
        PresetKind::ReadWrite => "write",
        PresetKind::Owner => "owner",
        PresetKind::Admin => return String::new(),
    };
    let stem = match schemas {
        [only] => only.as_str(),
        _ => db.database.as_str(),
    };
    let base = clean(&format!("{stem}_{suffix}"));
    let taken = |name: &str| cluster.roles.iter().any(|r| r.name == name);
    if !taken(&base) {
        return base;
    }
    // 번호를 붙여도 한도를 넘지 않게 앞쪽을 줄인다
    (2..)
        .map(|n| {
            let tail = format!("_{n}");
            format!("{}{tail}", cut(&base, NAME_LIMIT - tail.len()))
        })
        .find(|name| !taken(name))
        .unwrap_or(base)
}

/// 소문자로 바꾸고 `[a-z0-9_]` 밖의 글자는 모두 `_`로, 63바이트까지만 남긴다
fn clean(name: &str) -> String {
    let mapped: String = name.to_lowercase().chars().map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' { c } else { '_' }).collect();
    cut(&mapped, NAME_LIMIT)
}

/// 앞에서 `limit`바이트까지(여기서는 모두 ASCII다)
fn cut(name: &str, limit: usize) -> String {
    name.chars().take(limit).collect()
}

// ───────────────────────── 만드는 역할 ─────────────────────────

/// 고른 스키마의 테이블과 시퀀스를 가진 역할들. 뷰와 구체화 뷰의 소유자도 넣는다: 기본 권한의 TABLES가 그것들도 덮는다(`defaults_ok`가 시퀀스가 아닌 관계를 모두 테이블로 보는 것과 같다).
/// 시스템 역할은 뺀다. 이름순
fn creators_of(db: &DbSnapshot, schemas: &[String]) -> Vec<String> {
    let owners: BTreeSet<&str> = db.relations.iter().filter(|r| schemas.contains(&r.schema) && !is_system_role(&r.owner)).map(|r| r.owner.as_str()).collect();
    owners.into_iter().map(str::to_string).collect()
}

// ───────────────────────── 같은 권한을 가진 그룹 ─────────────────────────

/// 로그인할 수 없는 시스템이 아닌 역할 가운데 프리셋의 권한을 정확히 가진 것들(이름순). 관리자 프리셋은 권한이 아니라 `rds_superuser` 구성원이라 찾지 않는다
fn matching(cluster: &ClusterSnapshot, db: &DbSnapshot, preset: PresetKind, schemas: &[String]) -> Vec<String> {
    if preset == PresetKind::Admin || schemas.is_empty() {
        return Vec::new();
    }
    let ctx = Ctx { cluster, db };
    let eval = Eval::new(&ctx);
    let mut groups: Vec<&RoleRec> = cluster.roles.iter().filter(|r| !r.login && !is_system_role(&r.name)).collect();
    groups.sort_by(|a, b| a.name.cmp(&b.name));
    groups.into_iter().filter(|group| has_preset(&eval, &ctx, preset, schemas, &group.name)).map(|group| group.name.clone()).collect()
}

fn has_preset(eval: &Eval, ctx: &Ctx, preset: PresetKind, schemas: &[String], group: &str) -> bool {
    let (cluster, db) = (ctx.cluster, ctx.db);
    let view = eval.role(group);
    let Some(database) = cluster.databases.iter().find(|d| d.name == db.database) else { return false };
    if view.sources(Obj::Database(database), Privilege::Connect).is_empty() {
        return false;
    }
    let cells = schema_cells(eval, ctx, &[group]);
    let holds = |obj: Obj, privileges: &[Privilege]| privileges.iter().all(|&p| !view.sources(obj, p).is_empty());
    schemas.iter().all(|schema| {
        let Some(cell) = cells.iter().find(|c| &c.schema == schema) else { return false };
        if !cell.usage {
            return false;
        }
        if preset == PresetKind::Owner {
            return cell.create;
        }
        if cell.create || cell.read != Coverage::All {
            return false;
        }
        let write = preset == PresetKind::ReadWrite;
        if !write && cell.write != Coverage::None {
            return false;
        }
        let relations = || db.relations.iter().filter(|r| &r.schema == schema);
        let sequence_privileges: &[Privilege] = if write { &[Privilege::Select, Privilege::Usage] } else { &[Privilege::Select] };
        let table_privileges: &[Privilege] = if write { &[Privilege::Select, Privilege::Insert, Privilege::Update, Privilege::Delete] } else { &[Privilege::Select] };
        let sequences_ok = relations().filter(|r| r.kind == RelKind::Sequence).all(|r| holds(Obj::Relation(r), sequence_privileges));
        let tables_ok = !write || relations().filter(|r| matches!(r.kind, RelKind::Table | RelKind::Partitioned | RelKind::Foreign)).all(|r| holds(Obj::Relation(r), table_privileges));
        sequences_ok && tables_ok && defaults_ok(eval, db, schema, group, table_privileges, sequence_privileges)
    })
}

/// 지금 있는 소유자(그룹 자신은 빼고)가 이 스키마에 새로 만드는 테이블과 시퀀스에도 그룹이 권한을 받는가
fn defaults_ok(eval: &Eval, db: &DbSnapshot, schema: &str, group: &str, tables: &[Privilege], sequences: &[Privilege]) -> bool {
    let inherited: BTreeSet<String> = eval.privilege_order(group).into_iter().map(|r| r.role).collect();
    let covered = |creator: &str, object_type: DefaultObjType, privileges: &[Privilege]| {
        privileges.iter().all(|&p| {
            db.default_acls.iter().any(|d| {
                d.creator == creator
                    && d.obj_type == object_type
                    && d.schema.as_deref().is_none_or(|s| s == schema)
                    && d.acl.iter().any(|e| e.privilege == p && e.grantee.as_ref().is_some_and(|grantee| inherited.contains(grantee)))
            })
        })
    };
    let owners = |is_sequence: bool| -> BTreeSet<&str> {
        db.relations.iter().filter(|r| r.schema == schema && (r.kind == RelKind::Sequence) == is_sequence && r.owner != group).map(|r| r.owner.as_str()).collect()
    };
    owners(false).into_iter().all(|creator| covered(creator, DefaultObjType::Tables, tables)) && owners(true).into_iter().all(|creator| covered(creator, DefaultObjType::Sequences, sequences))
}

#[cfg(test)]
mod tests;
