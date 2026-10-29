//! 미리보기·영향·경고·되돌리기 시험이 함께 쓰는 장면과 변경 만들기(시험 전용)

use super::model::{AttributesSet, GrantItem, GrantTarget, PgChange};
use super::preview::PreviewCtx;
use crate::pg::fixtures::*;
use crate::pg::model::{DefaultObjType, Privilege, RoleRec};

/// 시험의 "지금"(유닉스 초, 2026-10-29)
pub const NOW: i64 = 1_793_232_000;

/// 앱이 `mm`으로 로그인한 장면. `mm`은 CREATEROLE이 있고 `app_owner`의 권한을 물려받는다(그래서 `app_owner`의 객체에 권한을 줄 수 있다)
pub fn admin(version: i32) -> Scene {
    let mm = RoleRec { create_role: true, ..login("mm") };
    let owner = if version >= PG16 { member_grants("mm", "app_owner", &[(BOOTSTRAP, false, Some(true), Some(true))]) } else { member("mm", "app_owner") };
    app_scene(version).add_role(mm).login_as("mm").add_member(owner)
}

/// `mm`이 `groups`에 ADMIN OPTION을 가진 장면
pub fn admin_of(version: i32, groups: &[&str]) -> Scene {
    groups.iter().fold(admin(version), |scene, group| scene.add_member(member_grants("mm", group, &[(BOOTSTRAP, true, Some(true), Some(true))])))
}

pub fn ctx(scene: &Scene) -> PreviewCtx<'_> {
    PreviewCtx { cluster: &scene.cluster, db: &scene.db, own_pids: &[], read_replica: false, default_db: "appdb", now: NOW }
}

pub fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

pub fn membership(group: &str, member: &str, add: bool, admin: bool) -> PgChange {
    PgChange::Membership { group: group.into(), member: member.into(), add, admin }
}

pub fn item(target: GrantTarget, privileges: &[Privilege]) -> GrantItem {
    GrantItem { target, privileges: privileges.to_vec() }
}

pub fn rel(schema: &str, name: &str) -> GrantTarget {
    GrantTarget::Relation { schema: schema.into(), name: name.into() }
}

pub fn all_tables(schema: &str) -> GrantTarget {
    GrantTarget::AllTables { schema: schema.into() }
}

pub fn grant(grantee: &str, add: bool, items: Vec<GrantItem>) -> PgChange {
    PgChange::Grant { database: "appdb".into(), grantee: grantee.into(), add, items }
}

pub fn default_change(creator: &str, schema: Option<&str>, object_type: DefaultObjType, grantee: &str, privileges: &[Privilege], add: bool) -> PgChange {
    PgChange::DefaultPrivilege { database: "appdb".into(), creator: creator.into(), schema: schema.map(Into::into), object_type, grantee: grantee.into(), privileges: privileges.to_vec(), add }
}

/// 속성을 `rec`와 같게 두고 `edit`로 바꾼 변경
pub fn attributes(scene: &Scene, role: &str, edit: impl FnOnce(&mut AttributesSet)) -> PgChange {
    let rec = scene.cluster.roles.iter().find(|r| r.name == role).expect("역할이 없어요");
    let mut set = AttributesSet::of(rec);
    edit(&mut set);
    PgChange::Attributes { role: role.into(), set }
}
