//! 변경(2단계) 미리보기의 계약. 모양만 있고, 만드는 일은 `change::preview`가 한다. 프리셋 제안과 역할 삭제 계획의 계약도 여기 있다(`pg::preset`, `pg::drop`이 만든다).
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

/// 변경 하나의 적용 결과. 새 비밀번호의 평문은 만들거나 다시 정한 이 결과에만, 한 번 들어간다.
/// `Debug`를 파생하지 않는다: 로그나 오류에 찍혀도 비밀번호가 새지 않게 가려서 찍는다(검사 테스트 `pg::hygiene`이 본다)
#[derive(PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgApplyResult {
    pub log_id: String,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    /// 적용은 됐지만 그 뒤에 하지 못한 일, 알아둘 일. 비면 보내지 않는다
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

impl std::fmt::Debug for PgApplyResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let password = self.password.as_ref().map(|_| crate::pg::password::MASK);
        f.debug_struct("PgApplyResult").field("log_id", &self.log_id).field("summary", &self.summary).field("password", &password).field("notes", &self.notes).finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgBatchResult {
    pub batch_id: String,
    pub log_ids: Vec<String>,
    pub summary: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

/// 기록을 되돌리는 변경들과 되돌리는 기록의 id
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgUndo {
    pub database: String,
    pub changes: Vec<PgChange>,
    pub undo_of: Vec<String>,
}

// ───────────────────────── 프리셋 제안, 역할 삭제 ─────────────────────────

/// 프리셋을 고르고 데이터베이스와 스키마를 정했을 때 화면에 보이는 제안
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgPresetSuggestion {
    /// 같은 권한을 이미 가진 그룹(이름순)
    pub matching: Vec<String>,
    /// 새 그룹에 붙일 이름. 관리자 프리셋은 빈 글
    pub proposed_name: String,
    /// 만드는 역할 후보: 고른 스키마의 테이블과 시퀀스 소유자들(이름순)
    pub creators: Vec<String>,
    pub blocked_creators: Vec<PgBlockedCreator>,
}

/// 로그인한 역할이 기본 권한을 바꿀 수 없는 만드는 역할과 막힘의 글
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgBlockedCreator {
    pub role: String,
    pub reason: String,
}

/// 삭제 계획의 단계 하나: 데이터베이스 하나에서 도는 문장들(트랜잭션 하나). 마지막 `DROP ROLE` 단계는 `database`가 None(기본 데이터베이스)이다
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgDropStep {
    pub database: Option<String>,
    pub sql: Vec<String>,
    /// 이 데이터베이스에서 역할이 소유한 객체의 수
    pub owned: usize,
    /// 역할의 이름이 든 ACL 항목의 수(소유하지 않은 객체에서)
    pub privileges: usize,
    /// 역할이 만들거나 ACL에 이름이 든 기본 권한 기록의 수
    pub defaults: usize,
}

/// 160000부터: 삭제하는 역할이 준 구성원 관계. `DROP OWNED`가 클러스터 전체에서 지운다
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgGrantedMembership {
    pub member: String,
    pub group: String,
    /// 다른 부여자의 줄이 없어서 구성원이 그룹에서 빠진다
    pub lost: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgDropPlan {
    pub role: String,
    pub reassign_to: String,
    /// 삭제를 돌리는 DB 사용자. 계획에 들어 있어서 미리보기와 적용 사이에 로그인이 바뀌면 달라진 계획이다
    pub login_user: String,
    /// 데이터베이스마다 하나(이름순), 마지막이 `DROP ROLE`
    pub steps: Vec<PgDropStep>,
    pub warnings: Vec<PgWarning>,
    pub confirm_text: String,
    /// 이 역할로 접속한 세션의 수
    pub sessions: usize,
    pub granted_memberships: Vec<PgGrantedMembership>,
}

/// 삭제 결과. `done`은 `PgDropPlan::steps`의 앞에서부터 `done`개 단계가 끝났다는 뜻이다(데이터베이스 단계만 센다)
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgDropResult {
    pub log_id: String,
    /// 데이터베이스 단계의 수
    pub total: usize,
    pub done: usize,
    /// 멈췄으면 삭제 결과의 글
    pub stopped: Option<String>,
    /// 삭제는 됐지만 그 뒤에 하지 못한 일(변경 기록을 저장하지 못함). 비면 보내지 않는다
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}
