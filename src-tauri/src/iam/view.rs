//! 화면으로 나가는 값(계약의 JSON). 키는 camelCase, 열거형은 소문자(`BadgeKind`만 camelCase)다.
//! 계산 결과 타입(`ActionEval`, `PrincipalEval`)은 `eval`에 있고 직렬화하지 않는다.

use std::collections::BTreeMap;

use serde::Serialize;

use super::catalog::AccessLevel;
use super::model::Scope;
use super::policy::Effect;

/// 배지와 점검의 심각도.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Danger,
    Warn,
    Info,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BadgeKind {
    Admin,
    Privesc,
    NoMfa,
    OldKey,
    UnusedKey,
    Inactive,
    ExternalTrust,
    Cfn,
    Sso,
    ServiceLinked,
    Boundary,
    Unattached,
    AwsManaged,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Badge {
    pub kind: BadgeKind,
    pub label: String,
    pub level: Level,
}

impl Badge {
    pub fn new(kind: BadgeKind, label: &str, level: Level) -> Badge {
        Badge { kind, label: label.to_string(), level }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PrincipalKind {
    User,
    Group,
    Role,
}

/// 작업 하나에 대한 판정.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Allowed,
    Conditional,
    Denied,
    Boundary,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrincipalSummary {
    pub arn: String,
    pub name: String,
    pub kind: PrincipalKind,
    pub path: String,
    pub created_at: Option<String>,
    /// 역할은 마지막 사용 시각, 사용자는 자격 증명 보고서에서 나중에 채운다
    pub last_used: Option<String>,
    /// 직접 붙은 정책 수(인라인 + 관리형). 그룹에서 상속한 것과 권한 경계는 세지 않는다
    pub policy_count: usize,
    /// 그룹만
    pub member_count: Option<usize>,
    pub badges: Vec<Badge>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicySummary {
    /// 관리형 정책의 ARN
    pub id: String,
    pub arn: String,
    pub name: String,
    pub scope: Scope,
    pub attachment_count: i32,
    pub default_version_id: Option<String>,
    pub updated_at: Option<String>,
    pub badges: Vec<Badge>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AttachedKind {
    Managed,
    Inline,
    Boundary,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachedPolicy {
    /// 관리형은 ARN, 인라인은 `inline:<소유자 ARN>:<이름>`
    pub id: String,
    pub name: String,
    pub kind: AttachedKind,
    /// 인라인은 None
    pub scope: Option<Scope>,
    /// 그룹에서 상속됐으면 그룹 이름
    pub via: Option<String>,
    pub badges: Vec<Badge>,
    /// 이 주체에 직접 붙은 관리형 정책이라 [떼기]로 뗄 수 있다
    pub detachable: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelCell {
    /// 카탈로그에서 이 서비스의 이 수준 작업 수
    pub total: usize,
    pub allowed: usize,
    pub conditional: usize,
    /// 거부 + 권한 경계 차단
    pub denied: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServicePermissions {
    pub prefix: String,
    pub name: String,
    /// 다섯 수준이 항상 모두 들어 있다
    pub levels: BTreeMap<AccessLevel, LevelCell>,
    /// 허용된 작업 중 위험한 것이 있다
    pub danger: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantSource {
    pub policy_id: String,
    pub policy_name: String,
    pub via: Option<String>,
    pub effect: Effect,
    pub sid: Option<String>,
    pub statement_index: usize,
    pub conditional: bool,
    pub boundary: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionGrant {
    /// `s3:GetObject`
    pub action: String,
    pub status: Status,
    pub resources: Vec<String>,
    pub sources: Vec<GrantSource>,
    /// 위험한 작업이면 이유(한국어)
    pub danger: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TrustKind {
    Service,
    Account,
    Federated,
    Anyone,
    Principal,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustEntry {
    pub kind: TrustKind,
    pub value: String,
    pub actions: Vec<String>,
    pub conditional: bool,
    /// 이 계정 밖(다른 계정, 누구나)에 열려 있다
    pub external: bool,
    pub warning: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrincipalView {
    pub summary: PrincipalSummary,
    pub policies: Vec<AttachedPolicy>,
    /// 사용자: 소속 그룹 이름, 그룹: 구성원 사용자 이름, 역할: 빈 목록
    pub groups: Vec<String>,
    /// 역할만
    pub trust: Vec<TrustEntry>,
    /// 허용·조건부·거부가 하나라도 있는 서비스, 이름순
    pub services: Vec<ServicePermissions>,
    pub admin_like: bool,
    pub unknown_actions: Vec<String>,
    pub tags: BTreeMap<String, String>,
    pub notes: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PolicyScope {
    Aws,
    Local,
    Inline,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionView {
    pub id: String,
    pub is_default: bool,
    pub created_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachedTo {
    pub arn: String,
    pub name: String,
    pub kind: PrincipalKind,
}

/// 문장이 허용·거부하는 작업의 서비스별 요약.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementService {
    pub prefix: String,
    pub name: String,
    pub levels: Vec<AccessLevel>,
    pub count: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementView {
    pub sid: Option<String>,
    pub effect: Effect,
    pub not_action: bool,
    pub action_patterns: Vec<String>,
    pub services: Vec<StatementService>,
    pub not_resource: bool,
    pub resources: Vec<String>,
    /// `aws:SourceIp · IpAddress · 10.0.0.0/8`
    pub conditions: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyView {
    pub id: String,
    pub name: String,
    pub scope: PolicyScope,
    pub arn: Option<String>,
    /// 디코드해서 들여쓴 JSON
    pub document: String,
    pub statements: Vec<StatementView>,
    pub versions: Vec<VersionView>,
    pub attached_to: Vec<AttachedTo>,
    pub editable: bool,
    pub badges: Vec<Badge>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhoCanHit {
    pub principal: PrincipalSummary,
    pub status: Status,
    pub sources: Vec<GrantSource>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhoCanResult {
    pub action: String,
    pub resource: Option<String>,
    pub hits: Vec<WhoCanHit>,
    pub notes: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn to_json<T: Serialize>(value: &T) -> serde_json::Value {
        serde_json::to_value(value).unwrap()
    }

    #[test]
    fn enums_serialize_to_contract_names() {
        assert_eq!(to_json(&Level::Danger), json!("danger"));
        assert_eq!(to_json(&Status::Boundary), json!("boundary"));
        assert_eq!(to_json(&PrincipalKind::Role), json!("role"));
        assert_eq!(to_json(&AttachedKind::Inline), json!("inline"));
        assert_eq!(to_json(&TrustKind::Federated), json!("federated"));
        assert_eq!(to_json(&PolicyScope::Inline), json!("inline"));
        assert_eq!(to_json(&Effect::Deny), json!("Deny"));
        let kinds = [
            (BadgeKind::Admin, "admin"),
            (BadgeKind::Privesc, "privesc"),
            (BadgeKind::NoMfa, "noMfa"),
            (BadgeKind::OldKey, "oldKey"),
            (BadgeKind::UnusedKey, "unusedKey"),
            (BadgeKind::Inactive, "inactive"),
            (BadgeKind::ExternalTrust, "externalTrust"),
            (BadgeKind::Cfn, "cfn"),
            (BadgeKind::Sso, "sso"),
            (BadgeKind::ServiceLinked, "serviceLinked"),
            (BadgeKind::Boundary, "boundary"),
            (BadgeKind::Unattached, "unattached"),
            (BadgeKind::AwsManaged, "awsManaged"),
        ];
        for (kind, name) in kinds {
            assert_eq!(to_json(&kind), json!(name));
        }
    }

    #[test]
    fn structs_serialize_camel_case_and_keep_nulls() {
        let badge = Badge::new(BadgeKind::ServiceLinked, "서비스 연결", Level::Info);
        assert_eq!(to_json(&badge), json!({ "kind": "serviceLinked", "label": "서비스 연결", "level": "info" }));

        let source = GrantSource {
            policy_id: "inline:arn:aws:iam::1:user/a:p".into(),
            policy_name: "p".into(),
            via: None,
            effect: Effect::Allow,
            sid: Some("S1".into()),
            statement_index: 2,
            conditional: false,
            boundary: true,
        };
        assert_eq!(
            to_json(&source),
            json!({
                "policyId": "inline:arn:aws:iam::1:user/a:p", "policyName": "p", "via": null, "effect": "Allow",
                "sid": "S1", "statementIndex": 2, "conditional": false, "boundary": true
            })
        );

        let hit = WhoCanResult { action: "s3:GetObject".into(), resource: None, hits: vec![], notes: vec![] };
        assert_eq!(to_json(&hit), json!({ "action": "s3:GetObject", "resource": null, "hits": [], "notes": [] }));

        let cell = LevelCell { total: 5, allowed: 1, conditional: 2, denied: 3 };
        assert_eq!(to_json(&cell), json!({ "total": 5, "allowed": 1, "conditional": 2, "denied": 3 }));
    }

    #[test]
    fn service_levels_are_keyed_by_access_level_names() {
        let mut levels = BTreeMap::new();
        for level in super::super::catalog::LEVELS {
            levels.insert(level, LevelCell::default());
        }
        let service = ServicePermissions { prefix: "s3".into(), name: "S3".into(), levels, danger: false };
        let value = to_json(&service);
        let keys: Vec<&str> = value["levels"].as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, vec!["list", "permissions", "read", "tagging", "write"]);
        assert_eq!(value["levels"]["read"], json!({ "total": 0, "allowed": 0, "conditional": 0, "denied": 0 }));
    }
}
