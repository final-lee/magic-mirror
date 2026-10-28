//! 뷰 만들기 시험: 스냅숏 픽스처(`app_scene`)로 돈다. 계약의 JSON 모양은 `view`의 시험이 지킨다.

use super::*;
use crate::iam::clock::{parse_iso, DAY_SECS};
use crate::pg::eval::SourceKind;
use crate::pg::fixtures::*;
use crate::pg::model::Privilege::{Connect, Create, Delete, Execute, Insert, Maintain, References, Select, Temporary, Trigger, Truncate, Update, Usage};
use crate::pg::model::{AclEntry, DefaultAclRec, DefaultObjType, RoleRec, RoleSettingRec, SessionRec};
use crate::pg::target::TargetKind;
use crate::pg::view::{PgBadge, PgBadgeKind, PgBadgeLevel, PgCoverage, PgObjectKind, PgRoleKind, PgSource};

fn now() -> i64 {
    parse_iso("2026-10-28T12:00:00Z").expect("now")
}

/// 앱 장면에 RDS의 역할 둘을 더한다: rds_superuser(CREATEROLE·CREATEDB가 있다), rds_iam
fn rds_scene(version: i32) -> Scene {
    let mut scene = app_scene(version);
    scene.cluster.roles.extend([RoleRec { create_role: true, create_db: true, ..role("rds_superuser") }, role("rds_iam")]);
    scene
}

fn by_name<'a>(all: &'a [PgRoleSummary], name: &str) -> &'a PgRoleSummary {
    all.iter().find(|r| r.name == name).unwrap_or_else(|| panic!("{name} 역할이 없어요"))
}

fn badge_kinds(role: &PgRoleSummary) -> Vec<PgBadgeKind> {
    role.badges.iter().map(|b| b.kind).collect()
}

fn summaries(scene: &Scene) -> Vec<PgRoleSummary> {
    role_summaries(&scene.cluster, now())
}

fn source(kind: SourceKind, via: &[&str], grantor: Option<&str>) -> PgSource {
    PgSource { kind, via: via.iter().map(|s| s.to_string()).collect(), grantor: grantor.map(str::to_string) }
}

mod summaries_and_overview;
mod database_view_and_cell_detail;
mod search;
mod role_view_and_who_can;
