//! 화면으로 나가는 계약. Tauri 명령이 돌려주는 값의 모양이고, 프런트엔드의 `src/pg/types.ts`와 필드마다 맞는다(시험이 JSON으로 지킨다).
//! 필드 이름은 camelCase고, 값이 없는 칸은 생략하지 않고 `null`로 보낸다. 대상 정보(`PgTargetInfo`)는 `target`에 있다.
//!
//! 이 모듈에는 모양만 있다. 만드는 일은 `summary`(역할·권한 표·칸·검색·누가 할 수 있나)와 `checks`(점검)가 한다.
//! 권한의 출처(`PgSource`)는 평가기의 `Source`가 이미 계약의 모양이라 그대로 쓴다.

use serde::{Deserialize, Serialize};

use super::eval::{Coverage, SchemaCell, Source};
use super::model::{FunctionRec, RelKind, RelationRec};
use super::target::PgTargetInfo;

pub type PgSource = Source;

// ───────────────────────── 역할과 개요 ─────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PgRoleKind {
    User,
    Group,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PgBadgeKind {
    Admin,
    IamAuth,
    CreateRole,
    CreateDb,
    BypassRls,
    Replication,
    Expired,
    ExpiringSoon,
    LoginRole,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PgBadgeLevel {
    High,
    Medium,
    Info,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgBadge {
    pub kind: PgBadgeKind,
    pub label: String,
    pub level: PgBadgeLevel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgAttributes {
    pub login: bool,
    pub create_db: bool,
    pub create_role: bool,
    pub inherit: bool,
    pub replication: bool,
    pub bypass_rls: bool,
    /// -1은 제한 없음
    pub connection_limit: i32,
    /// ISO 8601 UTC. None이면 없음
    pub valid_until: Option<String>,
}

/// 역할이 속한 그룹 하나
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgMembership {
    pub group: String,
    /// 이 관계로 그룹의 권한을 쓰는가
    pub inherit: bool,
    /// 이 관계로 그룹에 `SET ROLE`을 할 수 있는가. PG16부터 관계마다 SET 옵션이 있고, 그 전에는 늘 참이다
    pub set: bool,
    pub admin: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgRoleSummary {
    pub name: String,
    pub kind: PgRoleKind,
    pub system: bool,
    pub attributes: PgAttributes,
    pub member_of: Vec<PgMembership>,
    /// 직접 구성원의 수
    pub member_count: usize,
    pub session_count: usize,
    pub badges: Vec<PgBadge>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgDatabaseInfo {
    pub name: String,
    pub owner: String,
    pub allow_conn: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgOverview {
    pub target: PgTargetInfo,
    pub login_user: String,
    pub server_version: String,
    pub server_version_num: i32,
    pub password_encryption: String,
    pub fetched_at: String,
    pub roles: Vec<PgRoleSummary>,
    pub databases: Vec<PgDatabaseInfo>,
    pub can_manage: bool,
    pub manage_reason: Option<String>,
}

// ───────────────────────── 권한 표 ─────────────────────────

/// 스키마 안의 테이블 가운데 권한을 가진 정도
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PgCoverage {
    All,
    Some,
    None,
}

impl From<Coverage> for PgCoverage {
    fn from(coverage: Coverage) -> PgCoverage {
        match coverage {
            Coverage::All => PgCoverage::All,
            Coverage::Some => PgCoverage::Some,
            Coverage::None => PgCoverage::None,
        }
    }
}

/// 역할 하나와 스키마 하나의 칸
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgSchemaCell {
    pub role: String,
    pub schema: String,
    pub usage: bool,
    pub create: bool,
    pub read: PgCoverage,
    pub write: PgCoverage,
    /// 보이는 권한의 출처가 그룹·PUBLIC·미리 정의된 역할뿐이다
    pub inherited_only: bool,
    /// "CONNECT 없음" 또는 "USAGE 없음". 잃을 것이 있는 칸에만 채운다
    pub unusable: Option<String>,
}

impl From<SchemaCell> for PgSchemaCell {
    fn from(cell: SchemaCell) -> PgSchemaCell {
        PgSchemaCell {
            role: cell.role,
            schema: cell.schema,
            usage: cell.usage,
            create: cell.create,
            read: cell.read.into(),
            write: cell.write.into(),
            inherited_only: cell.inherited_only,
            unusable: cell.unusable.map(str::to_string),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgDbPrivilegeRow {
    pub role: String,
    pub connect: bool,
    pub create: bool,
    pub temp: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgSchemaInfo {
    pub name: String,
    pub owner: String,
    /// 테이블과 파티션 테이블의 수
    pub table_count: usize,
}

/// 선언 순서(테이블, 시퀀스, 함수, 타입, 스키마)가 화면에 나열하는 순서다
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PgDefaultObjectType {
    Tables,
    Sequences,
    Functions,
    Types,
    Schemas,
}

/// 기본 권한을 받는 쪽 하나
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgDefaultGrant {
    /// "PUBLIC"은 모든 역할
    pub grantee: String,
    pub privileges: Vec<String>,
    pub grantable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgDefaultAclRow {
    pub creator: String,
    /// None이면 모든 스키마
    pub schema: Option<String>,
    pub object_type: PgDefaultObjectType,
    pub grants: Vec<PgDefaultGrant>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgDatabaseView {
    pub database: String,
    pub fetched_at: String,
    pub truncated: bool,
    pub db_privileges: Vec<PgDbPrivilegeRow>,
    pub schemas: Vec<PgSchemaInfo>,
    /// 시스템 역할을 포함한 모든 역할 × 모든 스키마
    pub cells: Vec<PgSchemaCell>,
    pub default_privileges: Vec<PgDefaultAclRow>,
}

// ───────────────────────── 객체, 칸 상세, 누가 할 수 있나 ─────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PgObjectKind {
    Database,
    Schema,
    Table,
    View,
    Matview,
    Partitioned,
    Foreign,
    Sequence,
    Function,
}

impl PgObjectKind {
    pub fn of(kind: RelKind) -> PgObjectKind {
        match kind {
            RelKind::Table => PgObjectKind::Table,
            RelKind::View => PgObjectKind::View,
            RelKind::MatView => PgObjectKind::Matview,
            RelKind::Partitioned => PgObjectKind::Partitioned,
            RelKind::Foreign => PgObjectKind::Foreign,
            RelKind::Sequence => PgObjectKind::Sequence,
        }
    }
}

/// 객체를 가리키는 값. 프런트엔드가 `pg_objects`의 결과를 `pg_who_can`에 그대로 돌려보내므로 받는 쪽(`Deserialize`)이기도 하다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PgObjectRef {
    pub kind: PgObjectKind,
    /// 데이터베이스와 스키마는 None
    pub schema: Option<String>,
    pub name: String,
    /// 함수의 인자 목록(`a integer, b text`). 함수가 아니면 None
    pub signature: Option<String>,
}

impl PgObjectRef {
    pub fn database(name: &str) -> PgObjectRef {
        PgObjectRef { kind: PgObjectKind::Database, schema: None, name: name.to_string(), signature: None }
    }

    pub fn schema(name: &str) -> PgObjectRef {
        PgObjectRef { kind: PgObjectKind::Schema, schema: None, name: name.to_string(), signature: None }
    }

    pub fn relation(relation: &RelationRec) -> PgObjectRef {
        PgObjectRef { kind: PgObjectKind::of(relation.kind), schema: Some(relation.schema.clone()), name: relation.name.clone(), signature: None }
    }

    pub fn function(function: &FunctionRec) -> PgObjectRef {
        PgObjectRef {
            kind: PgObjectKind::Function,
            schema: Some(function.schema.clone()),
            name: function.name.clone(),
            signature: Some(function.signature.clone()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgPrivilegeGrant {
    pub privilege: String,
    pub sources: Vec<PgSource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgCellObject {
    pub object: PgObjectRef,
    pub owner: String,
    /// 행 수준 보안이 켜져 있다
    pub rls: bool,
    /// 가진 권한만
    pub privileges: Vec<PgPrivilegeGrant>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgCellDetail {
    pub role: String,
    pub schema: String,
    pub objects: Vec<PgCellObject>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgWhoCanRow {
    pub role: String,
    pub kind: PgRoleKind,
    pub system: bool,
    pub sources: Vec<PgSource>,
    pub unusable: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgWhoCan {
    pub object: PgObjectRef,
    pub privilege: String,
    pub allowed: Vec<PgWhoCanRow>,
}

// ───────────────────────── 세션, 역할 상세 ─────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgSession {
    pub pid: i32,
    pub role: Option<String>,
    pub database: Option<String>,
    pub client_addr: Option<String>,
    pub application_name: String,
    pub state: Option<String>,
    pub backend_start: Option<String>,
    pub query_start: Option<String>,
    pub wait_event: Option<String>,
    /// 이 앱이 연 연결이다
    pub own: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgRoleSetting {
    /// None이면 모든 데이터베이스
    pub database: Option<String>,
    /// `이름=값`
    pub setting: String,
    /// 이 역할만의 설정이 아니라 모든 역할에 걸린 설정이다(`ALTER DATABASE … SET`, `ALTER ROLE ALL SET`)
    pub all_roles: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgRoleMember {
    pub role: String,
    /// 이 관계로 구성원이 이 그룹의 권한을 쓰는가
    pub inherit: bool,
    /// 이 관계로 구성원이 이 그룹에 `SET ROLE`을 할 수 있는가. PG16 전에는 늘 참이다
    pub set: bool,
    pub admin: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgRoleDatabase {
    pub database: String,
    /// 이 데이터베이스의 스냅숏을 이미 읽었다. 아니면 나머지 칸은 비어 있다
    pub loaded: bool,
    /// 읽은 스냅숏이 객체가 너무 많아 일부만 읽은 것이다(칸과 소유 객체가 일부만 본 것이다). 읽지 않았으면 false
    pub truncated: bool,
    /// 이 역할에게 보이는 권한이 있는 칸만
    pub cells: Vec<PgSchemaCell>,
    pub owned: Vec<PgObjectRef>,
    /// 목록에 못 넣은 소유 객체의 수
    pub owned_omitted: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgRoleView {
    pub summary: PgRoleSummary,
    pub settings: Vec<PgRoleSetting>,
    pub members: Vec<PgRoleMember>,
    /// 연결할 수 있는 모든 데이터베이스
    pub databases: Vec<PgRoleDatabase>,
    pub sessions: Vec<PgSession>,
    /// 상속하지 않는 구성원 관계로만 닿는 역할
    pub set_role_only: Vec<String>,
}

// ───────────────────────── 점검 ─────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PgFindingKind {
    PublicSchemaCreate,
    PublicObjectGrant,
    RdsSuperuser,
    CreateRole,
    BypassRls,
    ExpiringLogin,
    EmptyLogin,
    DefaultPrivilegeGap,
    SecurityDefinerPath,
    Md5Encryption,
}

/// 선언 순서(높음, 중간, 낮음)가 심각도 높은 순이다
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PgFindingLevel {
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgFinding {
    pub database: Option<String>,
    pub role: Option<String>,
    pub object: Option<PgObjectRef>,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgFindingGroup {
    pub kind: PgFindingKind,
    pub title: String,
    pub level: PgFindingLevel,
    pub items: Vec<PgFinding>,
}

/// 읽지 못해서 점검하지 못한 데이터베이스와 그 이유
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgSkippedDatabase {
    pub database: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgFindings {
    /// 항목이 있는 그룹만, 심각도 높은 순
    pub groups: Vec<PgFindingGroup>,
    pub skipped: Vec<PgSkippedDatabase>,
    /// 객체가 너무 많아 일부만 읽고 점검한 데이터베이스들의 이름(이름순). 그 데이터베이스의 항목은 읽은 만큼만 찾은 것이다
    pub truncated: Vec<String>,
    pub fetched_at: String,
}

#[cfg(test)]
mod tests;
