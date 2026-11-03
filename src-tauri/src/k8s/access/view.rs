//! 화면에 보낼 접근 요약(`k8s_access`의 응답). 순수 코드: 읽은 것(`Loaded`)과 계산 결과(`Evaluation`)를 합친다.
use serde::Serialize;

use super::engine::{Dangling, Evaluation};
use super::identity::{sso_groups, AuthMode, IdentityMapping, SsoGroup};
use super::matrix::levels;
use super::rbac::Subject;
use super::read::{AwsAuthSummary, Gap, Loaded};

/// 매핑 한 줄: 매핑과 그 주체가 클러스터 전체에서 받는 권한 요약
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MappingRow {
    #[serde(flatten)]
    pub mapping: IdentityMapping,
    /// 유효한 매핑이면 이 주체(권한 표의 IAM 주체)
    pub subject: Option<Subject>,
    /// 클러스터 전체 열의 일곱 칸(`matrix::CELLS` 순서). 유효하지 않은 매핑은 None
    pub levels: Option<Vec<u8>>,
    /// 계산하지 못한 access policy와 이유
    pub unevaluated: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessView {
    /// `DescribeCluster`의 인증 모드 원문. 읽지 못하면 None
    pub auth_mode: Option<String>,
    pub mode: Option<AuthMode>,
    pub mappings: Vec<MappingRow>,
    pub sso_groups: Vec<SsoGroup>,
    pub aws_auth: AwsAuthSummary,
    pub namespaces: Vec<String>,
    /// 권한 표에 들어가는 주체 수
    pub subject_count: usize,
    pub dangling: Vec<Dangling>,
    /// RBAC 객체를 읽었는지(못 읽었으면 권한 계산은 IAM 매핑과 access policy만 반영한다)
    pub rbac_available: bool,
    pub gaps: Vec<Gap>,
    pub fetched_at: String,
}

pub fn build(loaded: &Loaded, eval: &Evaluation, fetched_at: &str) -> AccessView {
    let mappings = loaded
        .mappings
        .iter()
        .map(|m| {
            if !m.effective {
                return MappingRow { mapping: m.clone(), subject: None, levels: None, unevaluated: vec![] };
            }
            let subject = Subject::iam(&m.principal_arn);
            let rules = eval.rules_of(&subject);
            MappingRow { mapping: m.clone(), levels: Some(levels(&rules.grants, None)), unevaluated: rules.unevaluated.clone(), subject: Some(subject) }
        })
        .collect();
    AccessView {
        auth_mode: loaded.mode_raw.clone(),
        mode: loaded.mode,
        mappings,
        sso_groups: sso_groups(&loaded.mappings),
        aws_auth: loaded.aws_auth.clone(),
        namespaces: loaded.namespaces.clone(),
        subject_count: eval.subjects().len(),
        dangling: eval.dangling().to_vec(),
        rbac_available: loaded.rbac_available,
        gaps: loaded.gaps.clone(),
        fetched_at: fetched_at.to_string(),
    }
}

#[cfg(test)]
mod tests;
