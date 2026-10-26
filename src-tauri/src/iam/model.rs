//! IAM 스냅숏: 계정의 사용자·그룹·역할·정책을 한 번에 읽어 둔 값. 채우는 쪽은 AWS 읽기 코드, 읽는 쪽은 평가 코드다.

use std::collections::BTreeMap;

use serde::Serialize;

use super::policy::PolicyDocument;

/// 관리형 정책의 출처. 기본값은 수정할 수 없는 쪽(Aws)이다.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    #[default]
    Aws,
    Local,
}

/// 주체에 직접 붙은 인라인 정책.
#[derive(Clone, Debug, Default)]
pub struct InlinePolicy {
    pub name: String,
    /// 문서 원문. URL 인코딩일 수 있어 보여 줄 때는 `policy::pretty`를 쓴다
    pub raw: String,
    /// `policy::parse_document(raw)` 결과. 읽지 못했으면 None
    pub document: Option<PolicyDocument>,
}

/// 시각은 ISO 8601 문자열이다.
#[derive(Clone, Debug, Default)]
pub struct UserRec {
    pub arn: String,
    pub name: String,
    pub path: String,
    pub created_at: Option<String>,
    pub inline: Vec<InlinePolicy>,
    /// 붙은 관리형 정책 ARN
    pub attached: Vec<String>,
    /// 소속 그룹 이름
    pub groups: Vec<String>,
    /// 권한 경계 정책 ARN
    pub boundary: Option<String>,
    pub tags: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default)]
pub struct GroupRec {
    pub arn: String,
    pub name: String,
    pub path: String,
    pub created_at: Option<String>,
    pub inline: Vec<InlinePolicy>,
    /// 붙은 관리형 정책 ARN
    pub attached: Vec<String>,
}

#[derive(Clone, Debug, Default)]
pub struct RoleRec {
    pub arn: String,
    pub name: String,
    pub path: String,
    pub created_at: Option<String>,
    pub description: Option<String>,
    pub inline: Vec<InlinePolicy>,
    /// 붙은 관리형 정책 ARN
    pub attached: Vec<String>,
    /// 권한 경계 정책 ARN
    pub boundary: Option<String>,
    pub tags: BTreeMap<String, String>,
    /// 신뢰 정책 원문과 읽은 결과
    pub trust_raw: Option<String>,
    pub trust: Option<PolicyDocument>,
    pub last_used: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct VersionRec {
    pub id: String,
    pub is_default: bool,
    pub created_at: Option<String>,
}

/// 고객 관리형 또는 AWS 관리형 정책. `Snapshot::policies`에 ARN으로 담긴다.
#[derive(Clone, Debug, Default)]
pub struct ManagedPolicyRec {
    pub arn: String,
    pub name: String,
    pub scope: Scope,
    pub description: Option<String>,
    pub default_version_id: Option<String>,
    pub attachment_count: i32,
    pub updated_at: Option<String>,
    /// 기본 버전 문서 원문(URL 인코딩일 수 있다)과 읽은 결과. 문서를 못 가져왔으면 둘 다 None
    pub raw: Option<String>,
    pub document: Option<PolicyDocument>,
    pub versions: Vec<VersionRec>,
}

/// 자격 증명 보고서의 한 줄(사용자 하나). 값이 `N/A`·`no_information`이면 None이다.
#[derive(Clone, Debug, Default)]
pub struct CredRow {
    pub user: String,
    pub arn: String,
    pub created_at: Option<String>,
    pub password_enabled: bool,
    pub password_last_used: Option<String>,
    pub mfa_active: bool,
    pub key1_active: bool,
    pub key1_rotated: Option<String>,
    pub key1_last_used: Option<String>,
    pub key2_active: bool,
    pub key2_rotated: Option<String>,
    pub key2_last_used: Option<String>,
}

/// 한 계정의 IAM 상태. 한 번 읽어 캐시하고, 평가 코드는 이 값만 본다.
#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub account_id: String,
    pub caller_arn: String,
    /// 앱이 쓰는 자격 증명의 IAM 사용자·역할 ARN. 알 수 없으면 None
    pub caller_principal_arn: Option<String>,
    pub fetched_at: String,
    pub users: Vec<UserRec>,
    pub groups: Vec<GroupRec>,
    pub roles: Vec<RoleRec>,
    /// 관리형 정책 ARN → 정책
    pub policies: BTreeMap<String, ManagedPolicyRec>,
    pub cred_report: Option<Vec<CredRow>>,
    pub cred_generated_at: Option<String>,
    pub warnings: Vec<String>,
}

impl Snapshot {
    /// 이름(경로 제외) 또는 ARN이 정확히 같은 사용자.
    pub fn user(&self, name_or_arn: &str) -> Option<&UserRec> {
        self.users.iter().find(|u| u.name == name_or_arn || u.arn == name_or_arn)
    }

    pub fn group(&self, name_or_arn: &str) -> Option<&GroupRec> {
        self.groups.iter().find(|g| g.name == name_or_arn || g.arn == name_or_arn)
    }

    pub fn role(&self, name_or_arn: &str) -> Option<&RoleRec> {
        self.roles.iter().find(|r| r.name == name_or_arn || r.arn == name_or_arn)
    }

    /// 스냅숏에 있는 주체의 종류: "user" | "group" | "role". 모르는 ARN은 None.
    pub fn principal_kind(&self, arn: &str) -> Option<&'static str> {
        if self.users.iter().any(|u| u.arn == arn) {
            Some("user")
        } else if self.groups.iter().any(|g| g.arn == arn) {
            Some("group")
        } else if self.roles.iter().any(|r| r.arn == arn) {
            Some("role")
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ACCOUNT: &str = "111111111111";

    fn snapshot() -> Snapshot {
        Snapshot {
            account_id: ACCOUNT.into(),
            users: vec![
                UserRec { arn: format!("arn:aws:iam::{ACCOUNT}:user/alice"), name: "alice".into(), path: "/".into(), ..Default::default() },
                UserRec { arn: format!("arn:aws:iam::{ACCOUNT}:user/dev/team/bob"), name: "bob".into(), path: "/dev/team/".into(), ..Default::default() },
            ],
            groups: vec![GroupRec { arn: format!("arn:aws:iam::{ACCOUNT}:group/admins"), name: "admins".into(), path: "/".into(), ..Default::default() }],
            roles: vec![
                RoleRec { arn: format!("arn:aws:iam::{ACCOUNT}:role/deploy"), name: "deploy".into(), path: "/".into(), ..Default::default() },
                RoleRec {
                    arn: format!("arn:aws:iam::{ACCOUNT}:role/aws-service-role/x.amazonaws.com/AWSServiceRoleForX"),
                    name: "AWSServiceRoleForX".into(),
                    path: "/aws-service-role/x.amazonaws.com/".into(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        }
    }

    #[test]
    fn find_by_name_or_arn() {
        let s = snapshot();
        assert_eq!(s.user("alice").map(|u| u.name.as_str()), Some("alice"));
        assert_eq!(s.user("arn:aws:iam::111111111111:user/alice").map(|u| u.name.as_str()), Some("alice"));
        assert_eq!(s.user("bob").map(|u| u.path.as_str()), Some("/dev/team/"));
        assert_eq!(s.user("arn:aws:iam::111111111111:user/dev/team/bob").map(|u| u.name.as_str()), Some("bob"));
        assert_eq!(s.group("admins").map(|g| g.name.as_str()), Some("admins"));
        assert_eq!(s.group("arn:aws:iam::111111111111:group/admins").map(|g| g.name.as_str()), Some("admins"));
        assert_eq!(s.role("deploy").map(|r| r.name.as_str()), Some("deploy"));
        assert_eq!(
            s.role("arn:aws:iam::111111111111:role/aws-service-role/x.amazonaws.com/AWSServiceRoleForX").map(|r| r.name.as_str()),
            Some("AWSServiceRoleForX")
        );
    }

    #[test]
    fn lookups_do_not_cross_kinds_or_guess() {
        let s = snapshot();
        assert!(s.user("nobody").is_none());
        assert!(s.user("admins").is_none());
        assert!(s.group("alice").is_none());
        assert!(s.role("alice").is_none());
        assert!(s.user("Alice").is_none());
        assert!(s.user("arn:aws:iam::111111111111:user/bob").is_none());
        assert!(Snapshot::default().user("alice").is_none());
    }

    #[test]
    fn principal_kind_by_arn() {
        let s = snapshot();
        assert_eq!(s.principal_kind("arn:aws:iam::111111111111:user/alice"), Some("user"));
        assert_eq!(s.principal_kind("arn:aws:iam::111111111111:user/dev/team/bob"), Some("user"));
        assert_eq!(s.principal_kind("arn:aws:iam::111111111111:group/admins"), Some("group"));
        assert_eq!(s.principal_kind("arn:aws:iam::111111111111:role/deploy"), Some("role"));
        assert_eq!(s.principal_kind("arn:aws:iam::111111111111:role/missing"), None);
        assert_eq!(s.principal_kind("alice"), None);
        assert_eq!(s.principal_kind(""), None);
    }

    #[test]
    fn defaults_are_empty() {
        let s = Snapshot::default();
        assert!(s.users.is_empty() && s.groups.is_empty() && s.roles.is_empty() && s.policies.is_empty());
        assert!(s.cred_report.is_none() && s.warnings.is_empty());
        let p = ManagedPolicyRec::default();
        assert_eq!(p.scope, Scope::Aws);
        assert_eq!(p.attachment_count, 0);
        assert_eq!(serde_json::to_string(&Scope::Local).unwrap(), "\"local\"");
        assert_eq!(serde_json::to_string(&Scope::Aws).unwrap(), "\"aws\"");
    }
}
