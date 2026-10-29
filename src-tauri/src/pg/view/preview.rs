//! 변경(2단계) 미리보기의 계약. 모양만 있고, 만드는 일은 `change::preview`가 한다.
//! 값이 없는 칸은 생략하지 않고 `null`로, 목록과 개수는 비어 있어도 빈 배열과 0으로 보낸다.

use serde::Serialize;

use super::{PgDefaultAclRow, PgObjectKind};
use crate::pg::change::model::PgChange;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PgWarnLevel {
    Block,
    Confirm,
    Warn,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgWarning {
    pub level: PgWarnLevel,
    pub message: String,
    /// "기본 권한도 담기"가 장바구니에 담는 변경. 대개 비어 있다
    pub add: Vec<PgChange>,
}

/// 같은 (데이터베이스, 스키마, 객체 종류, 권한)에 속한 객체들이 얻거나 잃는 권한
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgPrivDelta {
    pub database: String,
    /// 데이터베이스와 스키마 객체는 None
    pub schema: Option<String>,
    pub object_kind: PgObjectKind,
    pub privilege: String,
    pub count: usize,
    /// 이름순으로 처음 5개
    pub sample: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgImpact {
    pub role: String,
    pub gained: Vec<PgPrivDelta>,
    pub lost: Vec<PgPrivDelta>,
}

/// 기본 권한 기록 하나의 전과 후
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgDefaultDelta {
    pub before: Option<PgDefaultAclRow>,
    pub after: Option<PgDefaultAclRow>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgAttributeDelta {
    pub name: String,
    pub before: String,
    pub after: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgRoleDelta {
    pub role: String,
    pub created: bool,
    pub dropped: bool,
    pub attributes: Vec<PgAttributeDelta>,
    pub groups_added: Vec<String>,
    pub groups_removed: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgPreview {
    pub change: PgChange,
    pub database: String,
    pub summary: String,
    /// 이 변경을 실행할 DB 사용자
    pub login_user: String,
    /// 실행 순서. 비밀번호는 가려져 있다
    pub sql: Vec<String>,
    pub impacts: Vec<PgImpact>,
    pub impacts_omitted: usize,
    pub roles: Vec<PgRoleDelta>,
    pub defaults: Vec<PgDefaultDelta>,
    /// 막힘, 확인, 알림 순서
    pub warnings: Vec<PgWarning>,
    pub confirm_text: Option<String>,
    pub reversible: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgBatchItem {
    pub change: PgChange,
    pub summary: String,
    pub sql: Vec<String>,
    pub warnings: Vec<PgWarning>,
}

/// 장바구니 전체의 미리보기. `warnings`에는 묶음 전체의 경고만 있고, 변경마다의 경고는 `items[].warnings`에 있다
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgBatchPreview {
    pub database: String,
    pub login_user: String,
    pub items: Vec<PgBatchItem>,
    pub sql: Vec<String>,
    pub impacts: Vec<PgImpact>,
    pub impacts_omitted: usize,
    pub roles: Vec<PgRoleDelta>,
    pub defaults: Vec<PgDefaultDelta>,
    pub warnings: Vec<PgWarning>,
    pub confirm_text: Option<String>,
    pub reversible: bool,
}
