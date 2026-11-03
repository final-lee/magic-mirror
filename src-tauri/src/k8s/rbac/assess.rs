//! 변경이 실효 권한에 주는 영향과 위험 판단(순수). 계산은 K4 엔진(`access::engine`, `access::diff`, `access::matrix`)을 그대로 쓴다.
//!
//! - 영향: 변경 전후의 `Evaluation`을 `diff::diff`로 비교한 "누가 무엇을 얻고 잃는지".
//! - 위험(이름 입력을 받는 경우): cluster-admin을 주는 바인딩, 권한 상승 경로를 새로 얻는 주체, `kube-system`·`prod`를 건드림,
//!   앱의 현재 신원이 권한을 잃음, `AmazonEKSClusterAdminPolicy` 연결, 영향을 계산하지 못함.
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::eks::{is_cluster_admin_policy, short_name};
use crate::k8s::access::diff::{diff, SubjectDiff};
use crate::k8s::access::engine::{Evaluation, Principal};
use crate::k8s::access::identity::{parse_arn, PrincipalKind};
use crate::k8s::access::matrix::{level, Cell, Level};
use crate::k8s::access::rbac::Subject;
use crate::k8s::change::{binds_cluster_admin, dangerous, Change, Operation, Plan};
use crate::k8s::review::Identity;

/// 영향에 실어 보내는 주체 수의 한도(더 있으면 `total`로 알린다)
pub const SUBJECTS_MAX: usize = 100;

pub const CLUSTER_ADMIN_BINDING: &str = "cluster-admin 권한을 주는 바인딩이에요";
pub const ESCALATION: &str = "클러스터 관리자 권한이나 권한 상승 경로를 새로 얻는 주체가 있어요";
pub const SYSTEM_OR_PROD: &str = "kube-system이나 prod를 건드리는 변경이에요";
pub const OWN_ACCESS: &str = "이 앱이 쓰는 신원이 권한을 잃어요";
pub const CLUSTER_ADMIN_POLICY: &str = "AmazonEKSClusterAdminPolicy는 클러스터 관리자 권한이에요";
pub const UNAVAILABLE: &str = "권한 영향을 끝까지 계산하지 못했어요";

/// 변경이 실효 권한에 주는 영향
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Effect {
    /// 권한이 달라지는 주체(권한 상승 주체와 이 앱의 신원이 앞). `SUBJECTS_MAX`까지
    pub subjects: Vec<SubjectDiff>,
    /// 권한이 달라지는 주체의 전체 수
    pub total: usize,
    /// 클러스터 관리자 권한이나 직접 권한 상승 경로를 새로 얻는 주체
    pub escalated: Vec<Subject>,
    /// 이 앱이 쓰는 신원이 잃는 권한이 있다
    pub loses_own_access: bool,
    /// 이 앱의 신원 주체(권한이 달라지는 주체 가운데 있을 때만). 화면이 그 줄에 표시를 단다.
    #[serde(default)]
    pub own: Option<Subject>,
    /// 계산하지 못한 부분의 이유(있으면 이름 입력을 받는다)
    pub unavailable: Option<String>,
}

/// 엔진 안에서 이 앱의 신원을 가리키는 주체. 신원 매핑에 없는 신원(kubeconfig 인증서 등)은 사용자·그룹으로 만든 주체를 양쪽 계산에 더한다.
#[derive(Clone, Debug)]
pub struct Own {
    pub subject: Subject,
    pub extra: Option<Principal>,
}

/// 신원 ARN의 (계정, 종류, 이름). `assumed-role/<역할>/<세션>`은 그 역할로 본다.
fn identity_key(arn: &str) -> Option<(String, PrincipalKind, String)> {
    if let Some(key) = parse_arn(arn) {
        return Some(key);
    }
    let mut parts = arn.splitn(6, ':');
    let account = parts.nth(4)?.to_string();
    let resource = parts.next()?;
    let role = resource.strip_prefix("assumed-role/")?.split('/').next()?;
    Some((account, PrincipalKind::Role, role.to_string()))
}

/// 앱의 신원이 신원 매핑의 어느 주체인지 찾는다. 없으면 사용자 이름·그룹으로 만든 주체를 돌려준다.
pub fn locate_own(identity: &Identity, principals: &[Principal]) -> Own {
    let key = identity.arn.as_deref().and_then(identity_key);
    if let Some(key) = key {
        if let Some(found) = principals.iter().find(|p| parse_arn(&p.arn).as_ref() == Some(&key)) {
            return Own { subject: Subject::iam(&found.arn), extra: None };
        }
    }
    let arn = format!("identity:{}", identity.username);
    let groups = identity.groups.iter().filter(|g| g.as_str() != "system:authenticated").cloned().collect();
    Own { subject: Subject::iam(&arn), extra: Some(Principal { arn, label: Some(identity.username.clone()), username: identity.username.clone(), groups, policies: vec![] }) }
}

/// 이 주체가 얻은 권한 중 직접 권한 상승 경로(클러스터 관리자 포함)가 새로 생긴 열이 있는가
fn gained_escalation(before: &Evaluation, after: &Evaluation, change: &SubjectDiff) -> bool {
    if change.gained.is_empty() && change.gained_urls.is_empty() {
        return false;
    }
    let mut columns: Vec<Option<&str>> = vec![None];
    for capability in &change.gained {
        if let Some(namespace) = capability.namespace.as_deref() {
            if !columns.contains(&Some(namespace)) {
                columns.push(Some(namespace));
            }
        }
    }
    let was = before.rules_of(&change.subject);
    let is = after.rules_of(&change.subject);
    columns.into_iter().any(|column| level(&is.grants, Cell::Escalate, column) == Level::Full && level(&was.grants, Cell::Escalate, column) != Level::Full)
}

/// 두 시점의 영향. `own`은 이 앱의 신원 주체이고 그 주체가 잃는 것이 있으면 `loses_own_access`가 켜진다.
pub fn effect_between(before: &Evaluation, after: &Evaluation, own: Option<&Subject>) -> Effect {
    let mut changes = diff(before, after);
    let total = changes.len();
    let escalated: Vec<Subject> = changes.iter().filter(|c| gained_escalation(before, after, c)).map(|c| c.subject.clone()).collect();
    let loses_own_access = own.is_some_and(|own| changes.iter().any(|c| &c.subject == own && (!c.lost.is_empty() || !c.lost_urls.is_empty())));
    let own_changed = own.filter(|own| changes.iter().any(|c| &c.subject == *own)).cloned();
    // 눈에 띄어야 하는 주체(권한 상승, 이 앱의 신원)를 앞에 둔다. 나머지 순서는 그대로다.
    changes.sort_by_key(|c| !(escalated.contains(&c.subject) || own == Some(&c.subject)));
    changes.truncate(SUBJECTS_MAX);
    Effect { subjects: changes, total, escalated, loses_own_access, own: own_changed, unavailable: None }
}

/// 이름 입력을 받아야 하는 이유
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    ClusterAdminBinding,
    Escalation,
    SystemOrProd,
    OwnAccess,
    ClusterAdminPolicy,
    Unavailable,
}

impl Reason {
    pub fn text(self) -> &'static str {
        match self {
            Reason::ClusterAdminBinding => CLUSTER_ADMIN_BINDING,
            Reason::Escalation => ESCALATION,
            Reason::SystemOrProd => SYSTEM_OR_PROD,
            Reason::OwnAccess => OWN_ACCESS,
            Reason::ClusterAdminPolicy => CLUSTER_ADMIN_POLICY,
            Reason::Unavailable => UNAVAILABLE,
        }
    }
}

/// 이 변경에 연결되는 access policy가 클러스터 관리자 정책인가
fn grants_cluster_admin_policy(operation: &Operation) -> bool {
    match operation {
        Operation::AccessPolicyAssociate { policy_arn, .. } => is_cluster_admin_policy(policy_arn),
        Operation::AccessEntryCreate { policies, .. } => policies.iter().any(|p| is_cluster_admin_policy(&p.policy_arn)),
        _ => false,
    }
}

/// 이름 입력이 필요한 이유들. `object`는 변경이 만들거나 고치는 바인딩(있으면)이다.
pub fn reasons(change: &Change, object: Option<&Value>, effect: &Effect) -> Vec<Reason> {
    let target = &change.target;
    let mut out = Vec::new();
    if object.is_some_and(binds_cluster_admin) {
        out.push(Reason::ClusterAdminBinding);
    }
    if !effect.escalated.is_empty() {
        out.push(Reason::Escalation);
    }
    let touched = if super::is_access_entry(target) { dangerous(None, &short_name(&target.name)) } else { dangerous(target.namespace.as_deref(), &target.name) };
    if touched {
        out.push(Reason::SystemOrProd);
    }
    if effect.loses_own_access {
        out.push(Reason::OwnAccess);
    }
    if grants_cluster_admin_policy(&change.operation) {
        out.push(Reason::ClusterAdminPolicy);
    }
    if effect.unavailable.is_some() {
        out.push(Reason::Unavailable);
    }
    out
}

/// 입력해야 하는 이름. access entry는 ARN 전체 대신 마지막 마디다.
pub fn confirm_name(change: &Change) -> String {
    if super::is_access_entry(&change.target) {
        short_name(&change.target.name)
    } else {
        change.target.name.clone()
    }
}

/// 계획에 영향과 위험 판단을 붙인다: 이유마다 경고를 더하고, 이유가 있으면 이름 입력을 요구한다.
pub fn finish(plan: &mut Plan, change: &Change, object: Option<&Value>, effect: Effect) {
    let why = reasons(change, object, &effect);
    for reason in &why {
        plan.preview.warnings.push(reason.text().to_string());
    }
    if let Some(message) = &effect.unavailable {
        plan.preview.warnings.push(message.clone());
    }
    if !why.is_empty() {
        plan.preview.confirm_name = Some(confirm_name(change));
    }
    plan.preview.effect = Some(effect);
}

#[cfg(test)]
mod tests;
