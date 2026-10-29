//! 변경 하나와 장바구니(묶음)의 미리보기(순수 함수): 문장, 영향, 역할과 기본 권한의 변화, 경고, 확인 문구, 되돌릴 수 있는가.
//! 입력이 같으면 결과도 같다. 시각도 `PreviewCtx::now`로 받아서 미리보기는 시계를 읽지 않는다.
//!
//! 묶음은 변경마다 복제한 스냅숏 한 쌍에 차례로 풀고 적용한다. 영향과 역할·기본 권한의 변화는 첫 스냅숏과 마지막 스냅숏을 견준 것이다.

use std::collections::{HashMap, HashSet};

use super::after;
use super::impact::{self, Impacts};
use super::inverse;
use super::model::{GrantTarget, PgChange};
use super::resolve::{resolve, ObjKey, ResolveCtx, Resolved};
use super::text::summary;
use super::warnings;
use crate::pg::eval::Ctx;
use crate::pg::model::{ClusterSnapshot, DbSnapshot, DefaultObjType, Privilege, RelKind};
use crate::pg::view::{PgBatchItem, PgBatchPreview, PgPreview, PgWarnLevel, PgWarning};

/// 한 묶음에 담을 수 있는 변경의 수
pub const MAX_BATCH: usize = 50;
const EMPTY_BATCH: &str = "담긴 변경이 없어요";
const OVER_LIMIT: &str = "한 번에 50개까지 적용할 수 있어요";
const NOT_A_TRAY_CHANGE: &str = "장바구니에 담을 수 없는 변경이에요";
const ANOTHER_DATABASE: &str = "다른 데이터베이스의 변경이 담겨 있어요. 먼저 적용하거나 비워 주세요";
const SAME_TARGET: &str = "같은 대상의 변경이 두 번 담겨 있어요";

/// 미리보기를 만드는 데 드는 것. 모두 빌려 온 값이라 미리보기는 순수 함수다
pub struct PreviewCtx<'a> {
    pub cluster: &'a ClusterSnapshot,
    /// 변경이 도는 데이터베이스의 스냅숏
    pub db: &'a DbSnapshot,
    /// 이 앱이 연 연결들의 백엔드 pid
    pub own_pids: &'a [i32],
    pub read_replica: bool,
    /// 대상의 기본 데이터베이스
    pub default_db: &'a str,
    /// 지금(유닉스 초)
    pub now: i64,
}

/// 확인 문구의 대상: 만들기는 새 이름, 구성원 관계는 구성원, 속성·비밀번호·삭제·세션 끊기는 역할, 권한과 기본 권한은 받는 쪽
pub fn confirm_target(change: &PgChange) -> &str {
    match change {
        PgChange::CreateRole { name, .. } => name,
        PgChange::Membership { member, .. } => member,
        PgChange::Attributes { role, .. } | PgChange::Password { role } | PgChange::DropRole { role } | PgChange::Terminate { role, .. } => role,
        PgChange::Grant { grantee, .. } | PgChange::DefaultPrivilege { grantee, .. } => grantee,
    }
}

/// 변경 하나를 푼 결과와 그 변경에 속한 경고, 되돌리기
struct Step {
    resolved: Resolved,
    warnings: Vec<PgWarning>,
    inverse: Option<Vec<PgChange>>,
}

/// 변경 하나를 지금까지의 스냅숏 위에 풀고 그 연산을 적용한다
fn step(ctx: &PreviewCtx, cluster: &mut ClusterSnapshot, db: &mut DbSnapshot, change: &PgChange) -> Step {
    let (before_cluster, before_db) = (cluster.clone(), db.clone());
    let resolved = resolve(&ResolveCtx { cluster: &before_cluster, db: &before_db, own_pids: ctx.own_pids, read_replica: ctx.read_replica }, change);
    after::apply(cluster, db, &resolved.ops);
    let (before, after) = (Ctx { cluster: &before_cluster, db: &before_db }, Ctx { cluster, db });
    Step { warnings: warnings::item(change, &resolved, &before, &after), inverse: inverse::of(&before, &after, change, &resolved), resolved }
}

fn has_confirm(warnings: &[PgWarning]) -> bool {
    warnings.iter().any(|w| w.level == PgWarnLevel::Confirm)
}

pub fn preview(ctx: &PreviewCtx, change: &PgChange) -> PgPreview {
    let (mut cluster, mut db) = (ctx.cluster.clone(), ctx.db.clone());
    let step = step(ctx, &mut cluster, &mut db, change);
    let (before, after) = (Ctx { cluster: ctx.cluster, db: ctx.db }, Ctx { cluster: &cluster, db: &db });
    let Impacts { impacts, omitted } = impact::impacts(&before, &after, &step.resolved.ops);

    let blocked = !step.resolved.blocks.is_empty();
    let mut all = step.warnings;
    all.extend(warnings::closing(&before, &after, &step.resolved.ops, ctx.now));
    let warnings = warnings::ordered(all, blocked);
    let confirm_text = has_confirm(&warnings).then(|| confirm_target(change).to_string());
    let reversible = !blocked && step.inverse.as_ref().is_some_and(|inverse| !inverse.is_empty());
    PgPreview {
        change: change.clone(),
        database: change.execution_database(ctx.default_db).to_string(),
        summary: summary(change),
        login_user: ctx.cluster.login_user.clone(),
        sql: step.resolved.statements.iter().map(|s| s.shown()).collect(),
        impacts,
        impacts_omitted: omitted,
        roles: impact::role_deltas(&before, &after),
        defaults: impact::default_deltas(&before, &after, &step.resolved.ops),
        warnings,
        confirm_text,
        reversible,
    }
}

// ───────────────────────── 묶음 ─────────────────────────

/// 묶음 안에서 문장이 나가는 차례: 구성원 넣기, 속성, 권한 주기, 기본 권한 주기, 기본 권한 빼기, 권한 빼기, 구성원 빼기, 역할 삭제.
/// 묶음에 담을 수 없는 변경(역할 만들기, 비밀번호, 세션 끊기)은 막히지만 미리보기는 보여 주려고 맨 뒤에 둔다
fn rank(change: &PgChange) -> u8 {
    match change {
        PgChange::Membership { add: true, .. } => 0,
        PgChange::Attributes { .. } => 1,
        PgChange::Grant { add: true, .. } => 2,
        PgChange::DefaultPrivilege { add: true, .. } => 3,
        PgChange::DefaultPrivilege { add: false, .. } => 4,
        PgChange::Grant { add: false, .. } => 5,
        PgChange::Membership { add: false, .. } => 6,
        PgChange::DropRole { .. } => 7,
        PgChange::CreateRole { .. } | PgChange::Password { .. } | PgChange::Terminate { .. } => 8,
    }
}

/// 변경이 겨냥하는 대상. 같은 대상을 두 변경이 겨냥하면 묶을 수 없다
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum Target {
    Privilege(String, ObjKey, Privilege),
    Pair(String, String),
    Attributes(String),
    Drop(String),
    Default(String, Option<String>, String, String, Privilege),
}

fn targets(db: &DbSnapshot, change: &PgChange) -> Vec<Target> {
    match change {
        PgChange::Membership { group, member, .. } => vec![Target::Pair(group.clone(), member.clone())],
        PgChange::Attributes { role, .. } => vec![Target::Attributes(role.clone())],
        PgChange::DropRole { role } => vec![Target::Drop(role.clone())],
        PgChange::Grant { grantee, items, .. } => items
            .iter()
            .flat_map(|item| {
                let keys = match &item.target {
                    GrantTarget::Database { name } => vec![ObjKey::Database(name.clone())],
                    GrantTarget::Schema { name } => vec![ObjKey::Schema(name.clone())],
                    GrantTarget::Relation { schema, name } | GrantTarget::Sequence { schema, name } => vec![ObjKey::Relation(schema.clone(), name.clone())],
                    GrantTarget::Function { schema, name, signature } => vec![ObjKey::Function(schema.clone(), name.clone(), signature.clone())],
                    GrantTarget::AllTables { schema } => in_schema(db, schema, |kind| kind != RelKind::Sequence),
                    GrantTarget::AllSequences { schema } => in_schema(db, schema, |kind| kind == RelKind::Sequence),
                };
                keys.into_iter().flat_map(|key| item.privileges.iter().map(move |&p| Target::Privilege(grantee.clone(), key.clone(), p)))
            })
            .collect(),
        PgChange::DefaultPrivilege { creator, schema, object_type, grantee, privileges, .. } => {
            let object_type = object_type_name(*object_type).to_string();
            privileges.iter().map(|&p| Target::Default(creator.clone(), schema.clone(), object_type.clone(), grantee.clone(), p)).collect()
        }
        PgChange::CreateRole { .. } | PgChange::Password { .. } | PgChange::Terminate { .. } => Vec::new(),
    }
}

fn object_type_name(object_type: DefaultObjType) -> &'static str {
    match object_type {
        DefaultObjType::Tables => "tables",
        DefaultObjType::Sequences => "sequences",
        DefaultObjType::Functions => "functions",
        DefaultObjType::Types => "types",
        DefaultObjType::Schemas => "schemas",
    }
}

fn in_schema(db: &DbSnapshot, schema: &str, pick: fn(RelKind) -> bool) -> Vec<ObjKey> {
    db.relations.iter().filter(|r| r.schema == schema && pick(r.kind)).map(|r| ObjKey::Relation(r.schema.clone(), r.name.clone())).collect()
}

/// 묶음 자체의 막힘: 비어 있음, 너무 많음, 담을 수 없는 변경, 다른 데이터베이스, 같은 대상
fn batch_blocks(ctx: &PreviewCtx, database: &str, changes: &[PgChange]) -> Vec<String> {
    let mut blocks: Vec<String> = Vec::new();
    let mut block = |text: &str| {
        if !blocks.iter().any(|b| b == text) {
            blocks.push(text.to_string());
        }
    };
    if changes.is_empty() {
        block(EMPTY_BATCH);
    }
    if changes.len() > MAX_BATCH {
        block(OVER_LIMIT);
    }
    for change in changes {
        match change {
            PgChange::CreateRole { .. } | PgChange::Password { .. } | PgChange::Terminate { .. } => block(NOT_A_TRAY_CHANGE),
            PgChange::Grant { database: other, .. } | PgChange::DefaultPrivilege { database: other, .. } if other != database => block(ANOTHER_DATABASE),
            _ => {}
        }
    }
    let mut seen: HashMap<Target, usize> = HashMap::new();
    for (index, change) in changes.iter().enumerate() {
        for target in targets(ctx.db, change) {
            if seen.insert(target, index).is_some_and(|earlier| earlier != index) {
                block(SAME_TARGET);
            }
        }
    }
    blocks
}

fn block_warning(text: &str) -> PgWarning {
    PgWarning { level: PgWarnLevel::Block, message: text.to_string(), add: Vec::new() }
}

pub fn preview_batch(ctx: &PreviewCtx, database: &str, changes: &[PgChange]) -> PgBatchPreview {
    batch(ctx, database, changes).0
}

/// 묶음을 되돌리는 변경들: 변경마다의 되돌림을 적용한 반대 순서로 이은 것. 하나라도 되돌릴 수 없으면 `None`이다
pub fn inverse_batch(ctx: &PreviewCtx, database: &str, changes: &[PgChange]) -> Option<Vec<PgChange>> {
    batch(ctx, database, changes).1
}

fn batch(ctx: &PreviewCtx, database: &str, changes: &[PgChange]) -> (PgBatchPreview, Option<Vec<PgChange>>) {
    let mut structural = batch_blocks(ctx, database, changes);
    if ctx.db.database != database {
        structural.push(format!("이 데이터베이스에서는 바꿀 수 없어요: {database}"));
    }
    let mut preview = PgBatchPreview {
        database: database.to_string(),
        login_user: ctx.cluster.login_user.clone(),
        items: Vec::new(),
        sql: Vec::new(),
        impacts: Vec::new(),
        impacts_omitted: 0,
        roles: Vec::new(),
        defaults: Vec::new(),
        warnings: Vec::new(),
        confirm_text: None,
        reversible: false,
    };
    if changes.is_empty() || changes.len() > MAX_BATCH {
        preview.warnings = structural.iter().map(|t| block_warning(t)).collect();
        return (preview, None);
    }

    // 문장이 나가는 차례대로 변경마다 풀고 적용한다
    let mut order: Vec<&PgChange> = changes.iter().collect();
    order.sort_by_key(|change| rank(change));
    let (mut cluster, mut db) = (ctx.cluster.clone(), ctx.db.clone());
    let steps: Vec<(&PgChange, Step)> = order.into_iter().map(|change| (change, step(ctx, &mut cluster, &mut db, change))).collect();
    let (before, after) = (Ctx { cluster: ctx.cluster, db: ctx.db }, Ctx { cluster: &cluster, db: &db });
    let ops: Vec<_> = steps.iter().flat_map(|(_, step)| step.resolved.ops.iter().cloned()).collect();

    let blocked = !structural.is_empty() || steps.iter().any(|(_, step)| !step.resolved.blocks.is_empty());
    let mut all: Vec<PgWarning> = structural.iter().map(|t| block_warning(t)).collect();
    all.extend(warnings::closing(&before, &after, &ops, ctx.now));
    let batch_warnings = warnings::ordered(all, blocked);

    let mut confirm = has_confirm(&batch_warnings);
    let mut inverse: Option<Vec<PgChange>> = Some(Vec::new());
    for (_, step) in steps.iter().rev() {
        match (&mut inverse, &step.inverse) {
            (Some(all), Some(own)) => all.extend(own.iter().cloned()),
            _ => inverse = None,
        }
    }
    preview.items = steps
        .iter()
        .map(|(change, step)| {
            let item_warnings = warnings::ordered(step.warnings.clone(), blocked);
            confirm |= has_confirm(&item_warnings);
            PgBatchItem { change: (*change).clone(), summary: summary(change), sql: step.resolved.statements.iter().map(|s| s.shown()).collect(), warnings: item_warnings }
        })
        .collect();
    preview.sql = preview.items.iter().flat_map(|item| item.sql.iter().cloned()).collect();
    let Impacts { impacts, omitted } = impact::impacts(&before, &after, &ops);
    preview.impacts = impacts;
    preview.impacts_omitted = omitted;
    preview.roles = impact::role_deltas(&before, &after);
    preview.defaults = impact::default_deltas(&before, &after, &ops);
    preview.warnings = batch_warnings;
    preview.confirm_text = confirm.then(|| batch_confirm_text(changes));
    preview.reversible = !blocked && inverse.as_ref().is_some_and(|inverse| !inverse.is_empty());
    (preview, inverse)
}

/// 모든 변경의 확인 대상이 같으면 그 이름, 아니면 `변경 ${n}개 적용`
fn batch_confirm_text(changes: &[PgChange]) -> String {
    let names: HashSet<&str> = changes.iter().map(confirm_target).collect();
    match (names.len(), changes.first()) {
        (1, Some(first)) => confirm_target(first).to_string(),
        _ => format!("변경 {}개 적용", changes.len()),
    }
}

#[cfg(test)]
mod tests;
