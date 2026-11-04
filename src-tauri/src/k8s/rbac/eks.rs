//! EKS access entry 변경(생성·삭제·그룹 변경·정책 연결과 해제)의 EKS API 호출·필드 차이·역변경을 계산한다(순수).
//! 변경 대상의 이름은 IAM 주체 ARN이다. EKS API에는 dry-run이 없어 미리보기는 지금 항목(`EntryInput`)과 보낼 호출만 보여 준다.
//! 호출은 `exec::eks`만 보낸다.
use serde_json::{json, Value};

use super::{is_access_entry, PolicySpec, ScopeSpec};
use crate::error::AppError;
use crate::k8s::access::engine::PolicyScope;
use crate::k8s::access::identity::{parse_arn, policy_name, AuthMode, EntryInput, PrincipalKind};
use crate::k8s::change::{ApiCall, Change, FieldDiff, Operation, Plan, Preview, INVALID_CHANGE, NOOP_WARNING};

pub const INVALID_SCOPE: &str = "네임스페이스 범위에는 네임스페이스가 하나 이상 있어야 해요";
pub const MODE_CONFIG_MAP: &str = "이 클러스터의 인증 모드가 CONFIG_MAP이라 access entry를 쓰지 않아요. 인증 모드를 API_AND_CONFIG_MAP이나 API로 바꿔야 해요";
pub const INVALID_PRINCIPAL: &str = "IAM 주체 ARN(arn:aws:iam::<계정>:role/<이름> 또는 user/<이름>)을 입력해 주세요";
pub const INVALID_GROUP: &str = "쿠버네티스 그룹 이름이 비어 있어요";
pub const INVALID_POLICY: &str = "access policy ARN(arn:aws:eks::aws:cluster-access-policy/<이름>)을 입력해 주세요";
pub const DUPLICATE_POLICY: &str = "같은 access policy가 두 번 들어 있어요";
pub const ENTRY_EXISTS: &str = "이 주체의 access entry가 이미 있어요";
pub const ENTRY_MISSING: &str = "이 주체의 access entry를 찾을 수 없어요";
pub const ENTRY_UNREADABLE: &str = "이 access entry를 자세히 읽지 못해서 바꿀 수 없어요. 접근 화면을 다시 읽어 주세요";
pub const NOT_ASSOCIATED: &str = "이 access entry에 연결된 정책이 아니에요";
pub const NOT_STANDARD: &str = "access policy는 STANDARD 종류의 access entry에만 연결할 수 있어요";
pub const SYSTEM_GROUP_WARNING: &str = "system: 으로 시작하는 그룹은 쿠버네티스 내장 그룹이에요(system:masters는 RBAC과 상관없이 모든 권한을 가져요)";
pub const NODE_ENTRY_WARNING: &str = "노드 역할용 access entry라 바꾸면 노드가 클러스터에 접근하지 못할 수 있어요";
pub const POLICIES_GONE_WARNING: &str = "연결된 access policy도 함께 사라져요";
pub const NO_DRY_RUN_WARNING: &str = "EKS API에는 dry-run이 없어서 미리보기는 보낼 호출만 보여 줘요. 적용한 뒤에는 변경 기록에서 되돌릴 수 있어요";
pub const CREATE_IMPACT: &str = "access entry를 만듭니다";
pub const DELETE_IMPACT: &str = "access entry를 삭제합니다. 이 주체는 클러스터에 접근하지 못해요";
pub const GROUPS_IMPACT: &str = "access entry의 쿠버네티스 그룹을 바꿉니다";
pub const ASSOCIATE_IMPACT: &str = "access policy를 연결합니다";
pub const DISASSOCIATE_IMPACT: &str = "access policy 연결을 풉니다";
/// 클러스터 관리자 권한을 주는 access policy
pub const CLUSTER_ADMIN_POLICY: &str = "AmazonEKSClusterAdminPolicy";

/// 기본으로 만들어지는 쿠버네티스 사용자 이름. 역할은 `assumed-role` 세션 이름 자리표시자를 쓰고, 사용자는 ARN 그대로다.
pub fn default_username(principal_arn: &str) -> Option<String> {
    let (account, kind, name) = parse_arn(principal_arn)?;
    match kind {
        PrincipalKind::Role => {
            let partition = principal_arn.split(':').nth(1)?;
            Some(format!("arn:{partition}:sts::{account}:assumed-role/{name}/{{{{SessionName}}}}"))
        }
        PrincipalKind::User => Some(principal_arn.to_string()),
        PrincipalKind::Other => None,
    }
}

/// 이름 입력에 쓰는 짧은 이름(ARN의 마지막 마디)
pub fn short_name(principal_arn: &str) -> String {
    principal_arn.rsplit('/').next().filter(|name| !name.is_empty()).unwrap_or(principal_arn).to_string()
}

pub fn is_cluster_admin_policy(policy_arn: &str) -> bool {
    policy_name(policy_arn) == CLUSTER_ADMIN_POLICY
}

pub fn scope_of(scope: &PolicyScope) -> ScopeSpec {
    match scope {
        PolicyScope::Cluster => ScopeSpec::Cluster,
        PolicyScope::Namespaces { namespaces } => ScopeSpec::Namespaces { namespaces: namespaces.clone() },
    }
}

pub fn engine_scope(scope: &ScopeSpec) -> PolicyScope {
    match scope {
        ScopeSpec::Cluster => PolicyScope::Cluster,
        ScopeSpec::Namespaces { namespaces } => PolicyScope::Namespaces { namespaces: namespaces.clone() },
    }
}

/// EKS API의 `accessScope` 모양
pub fn scope_body(scope: &ScopeSpec) -> Value {
    match scope {
        ScopeSpec::Cluster => json!({"type": "cluster"}),
        ScopeSpec::Namespaces { namespaces } => json!({"type": "namespace", "namespaces": namespaces}),
    }
}

fn entry_json(entry: &EntryInput) -> Value {
    json!({
        "username": entry.username,
        "kubernetesGroups": entry.groups,
        "type": entry.entry_type,
        "policies": entry.policies.iter().map(|(arn, scope)| json!({"policyArn": arn, "scope": scope_of(scope)})).collect::<Vec<_>>(),
    })
}

fn entry_path(cluster: &str, principal: &str) -> String {
    format!("/clusters/{cluster}/access-entries/{principal}")
}

fn valid_principal(arn: &str) -> bool {
    arn.starts_with("arn:") && arn.contains(":iam::") && arn.contains('/')
}

fn valid_policy(arn: &str) -> bool {
    arn.starts_with("arn:") && arn.contains("cluster-access-policy/") && !policy_name(arn).is_empty()
}

/// 앞뒤 공백을 뗀 그룹 이름들. 비어 있는 이름은 오류이고 겹치는 이름은 하나로 합친다.
pub fn clean_groups(groups: &[String]) -> Result<Vec<String>, AppError> {
    let mut out: Vec<String> = Vec::new();
    for group in groups {
        let group = group.trim();
        if group.is_empty() {
            return Err(AppError::other(INVALID_GROUP));
        }
        if !out.iter().any(|g| g == group) {
            out.push(group.to_string());
        }
    }
    Ok(out)
}

fn plan_of(calls: Vec<ApiCall>, diff: Vec<FieldDiff>, impact: &str, mut warnings: Vec<String>, inverse: Option<Change>) -> Plan {
    warnings.push(NO_DRY_RUN_WARNING.to_string());
    Plan {
        preview: Preview {
            calls,
            diff,
            impact: vec![impact.to_string()],
            warnings,
            confirm_name: None,
            reversible: inverse.is_some(),
            drain: None,
            conflicts: Vec::new(),
            effect: None,
        },
        inverse,
        version: None,
        fingerprint: None,
    }
}

fn find<'a>(entries: &'a [EntryInput], principal: &str) -> Option<&'a EntryInput> {
    entries.iter().find(|e| e.principal_arn == principal)
}

/// 읽을 수 있는 항목만 바꾼다(자세히 읽지 못한 항목은 되돌리기를 만들 수 없다).
fn readable<'a>(entries: &'a [EntryInput], principal: &str) -> Result<&'a EntryInput, AppError> {
    let entry = find(entries, principal).ok_or_else(|| AppError::other(ENTRY_MISSING))?;
    if entry.read_error.is_some() {
        return Err(AppError::other(ENTRY_UNREADABLE));
    }
    Ok(entry)
}

fn is_standard(entry: &EntryInput) -> bool {
    entry.entry_type.as_deref().is_none_or(|t| t == "STANDARD")
}

fn node_warning(entry: &EntryInput, warnings: &mut Vec<String>) {
    if !is_standard(entry) {
        warnings.push(NODE_ENTRY_WARNING.to_string());
    }
}

fn system_group_warning(groups: &[String], warnings: &mut Vec<String>) {
    if groups.iter().any(|g| g.starts_with("system:")) {
        warnings.push(SYSTEM_GROUP_WARNING.to_string());
    }
}

fn create(change: &Change, cluster: &str, entries: &[EntryInput], username: &Option<String>, groups: &[String], policies: &[PolicySpec], entry_type: &Option<String>) -> Result<(Plan, Vec<EntryInput>), AppError> {
    let principal = change.target.name.as_str();
    if !valid_principal(principal) {
        return Err(AppError::other(INVALID_PRINCIPAL));
    }
    if find(entries, principal).is_some() {
        return Err(AppError::other(ENTRY_EXISTS));
    }
    let groups = clean_groups(groups)?;
    let username = username.as_deref().map(str::trim).filter(|u| !u.is_empty()).map(str::to_string);
    let standard = entry_type.as_deref().is_none_or(|t| t == "STANDARD");
    if !standard && !policies.is_empty() {
        return Err(AppError::other(NOT_STANDARD));
    }
    for (i, policy) in policies.iter().enumerate() {
        if !valid_policy(&policy.policy_arn) {
            return Err(AppError::other(INVALID_POLICY));
        }
        policy.scope.validate()?;
        if policies[..i].iter().any(|p| p.policy_arn == policy.policy_arn) {
            return Err(AppError::other(DUPLICATE_POLICY));
        }
    }
    let mut body = json!({"principalArn": principal});
    if !groups.is_empty() {
        body["kubernetesGroups"] = json!(groups);
    }
    if let Some(username) = &username {
        body["username"] = json!(username);
    }
    if let Some(kind) = entry_type.as_deref().filter(|t| *t != "STANDARD") {
        body["type"] = json!(kind);
    }
    let mut calls = vec![ApiCall { verb: "POST".into(), path: format!("/clusters/{cluster}/access-entries"), body }];
    let mut diff = vec![FieldDiff { path: "accessEntry".into(), before: Value::Null, after: json!({"username": username.clone().or_else(|| default_username(principal)), "kubernetesGroups": groups, "type": entry_type.clone().unwrap_or_else(|| "STANDARD".into())}) }];
    for policy in policies {
        calls.push(ApiCall {
            verb: "POST".into(),
            path: format!("{}/access-policies", entry_path(cluster, principal)),
            body: json!({"policyArn": policy.policy_arn, "accessScope": scope_body(&policy.scope)}),
        });
        diff.push(FieldDiff { path: format!("accessEntry.policies[{}]", policy_name(&policy.policy_arn)), before: Value::Null, after: json!(policy.scope) });
    }
    let mut warnings = Vec::new();
    system_group_warning(&groups, &mut warnings);
    let mut next = entries.to_vec();
    next.push(EntryInput {
        principal_arn: principal.to_string(),
        entry_type: Some(entry_type.clone().unwrap_or_else(|| "STANDARD".into())),
        username: username.or_else(|| default_username(principal)),
        groups,
        policies: policies.iter().map(|p| (p.policy_arn.clone(), engine_scope(&p.scope))).collect(),
        read_error: None,
    });
    let inverse = Change { target: change.target.clone(), operation: Operation::AccessEntryDelete };
    Ok((plan_of(calls, diff, CREATE_IMPACT, warnings, Some(inverse)), next))
}

fn delete(change: &Change, cluster: &str, entries: &[EntryInput]) -> Result<(Plan, Vec<EntryInput>), AppError> {
    let principal = change.target.name.as_str();
    let entry = readable(entries, principal)?;
    let mut warnings = Vec::new();
    node_warning(entry, &mut warnings);
    if !entry.policies.is_empty() {
        warnings.push(POLICIES_GONE_WARNING.to_string());
    }
    // 되돌리기는 그룹과 정책까지 그대로 다시 만든다. 기본 사용자 이름과 STANDARD 종류는 EKS가 채우니 보내지 않는다.
    let standard = is_standard(entry);
    let username = entry.username.clone().filter(|u| standard && default_username(principal).as_deref() != Some(u.as_str()));
    let recreate = Operation::AccessEntryCreate {
        username,
        groups: entry.groups.clone(),
        policies: entry.policies.iter().map(|(arn, scope)| PolicySpec { policy_arn: arn.clone(), scope: scope_of(scope) }).collect(),
        entry_type: entry.entry_type.clone().filter(|t| t != "STANDARD"),
    };
    let diff = vec![FieldDiff { path: "accessEntry".into(), before: entry_json(entry), after: Value::Null }];
    let calls = vec![ApiCall { verb: "DELETE".into(), path: entry_path(cluster, principal), body: Value::Null }];
    let next = entries.iter().filter(|e| e.principal_arn != principal).cloned().collect();
    let inverse = Change { target: change.target.clone(), operation: recreate };
    Ok((plan_of(calls, diff, DELETE_IMPACT, warnings, Some(inverse)), next))
}

fn set_groups(change: &Change, cluster: &str, entries: &[EntryInput], groups: &[String]) -> Result<(Plan, Vec<EntryInput>), AppError> {
    let principal = change.target.name.as_str();
    let entry = readable(entries, principal)?;
    let groups = clean_groups(groups)?;
    let mut warnings = Vec::new();
    node_warning(entry, &mut warnings);
    let same = groups == entry.groups;
    if same {
        warnings.push(NOOP_WARNING.to_string());
    }
    // 새로 더하는 그룹만 내장 그룹 경고 대상이다
    let added: Vec<String> = groups.iter().filter(|g| !entry.groups.contains(g)).cloned().collect();
    system_group_warning(&added, &mut warnings);
    let diff = if same { Vec::new() } else { vec![FieldDiff { path: "kubernetesGroups".into(), before: json!(entry.groups), after: json!(groups) }] };
    let calls = vec![ApiCall { verb: "POST".into(), path: entry_path(cluster, principal), body: json!({"kubernetesGroups": groups}) }];
    let inverse = (!same).then(|| Change { target: change.target.clone(), operation: Operation::AccessEntryGroups { groups: entry.groups.clone() } });
    let next = entries.iter().map(|e| if e.principal_arn == principal { EntryInput { groups: groups.clone(), ..e.clone() } } else { e.clone() }).collect();
    Ok((plan_of(calls, diff, GROUPS_IMPACT, warnings, inverse), next))
}

fn associate(change: &Change, cluster: &str, entries: &[EntryInput], policy_arn: &str, scope: &ScopeSpec) -> Result<(Plan, Vec<EntryInput>), AppError> {
    let principal = change.target.name.as_str();
    let entry = readable(entries, principal)?;
    if !valid_policy(policy_arn) {
        return Err(AppError::other(INVALID_POLICY));
    }
    scope.validate()?;
    if !is_standard(entry) {
        return Err(AppError::other(NOT_STANDARD));
    }
    let engine = engine_scope(scope);
    let previous = entry.policies.iter().find(|(arn, _)| arn == policy_arn).map(|(_, s)| s.clone());
    let mut warnings = Vec::new();
    let same = previous.as_ref() == Some(&engine);
    if same {
        warnings.push(NOOP_WARNING.to_string());
    }
    let name = policy_name(policy_arn);
    let diff = if same { Vec::new() } else { vec![FieldDiff { path: format!("policies[{name}]"), before: previous.as_ref().map_or(Value::Null, |s| json!(scope_of(s))), after: json!(scope) }] };
    let calls = vec![ApiCall {
        verb: "POST".into(),
        path: format!("{}/access-policies", entry_path(cluster, principal)),
        body: json!({"policyArn": policy_arn, "accessScope": scope_body(scope)}),
    }];
    let undo = match &previous {
        Some(old) => Operation::AccessPolicyAssociate { policy_arn: policy_arn.to_string(), scope: scope_of(old) },
        None => Operation::AccessPolicyDisassociate { policy_arn: policy_arn.to_string() },
    };
    let inverse = (!same).then(|| Change { target: change.target.clone(), operation: undo });
    let next = entries
        .iter()
        .map(|e| {
            if e.principal_arn != principal {
                return e.clone();
            }
            let mut policies: Vec<(String, PolicyScope)> = e.policies.iter().filter(|(arn, _)| arn != policy_arn).cloned().collect();
            policies.push((policy_arn.to_string(), engine.clone()));
            EntryInput { policies, ..e.clone() }
        })
        .collect();
    Ok((plan_of(calls, diff, ASSOCIATE_IMPACT, warnings, inverse), next))
}

fn disassociate(change: &Change, cluster: &str, entries: &[EntryInput], policy_arn: &str) -> Result<(Plan, Vec<EntryInput>), AppError> {
    let principal = change.target.name.as_str();
    let entry = readable(entries, principal)?;
    let old = entry.policies.iter().find(|(arn, _)| arn == policy_arn).map(|(_, s)| s.clone()).ok_or_else(|| AppError::other(NOT_ASSOCIATED))?;
    let mut warnings = Vec::new();
    node_warning(entry, &mut warnings);
    let diff = vec![FieldDiff { path: format!("policies[{}]", policy_name(policy_arn)), before: json!(scope_of(&old)), after: Value::Null }];
    let calls = vec![ApiCall { verb: "DELETE".into(), path: format!("{}/access-policies/{policy_arn}", entry_path(cluster, principal)), body: Value::Null }];
    let inverse = Change { target: change.target.clone(), operation: Operation::AccessPolicyAssociate { policy_arn: policy_arn.to_string(), scope: scope_of(&old) } };
    let next = entries
        .iter()
        .map(|e| if e.principal_arn == principal { EntryInput { policies: e.policies.iter().filter(|(arn, _)| arn != policy_arn).cloned().collect(), ..e.clone() } } else { e.clone() })
        .collect();
    Ok((plan_of(calls, diff, DISASSOCIATE_IMPACT, warnings, Some(inverse)), next))
}

/// access entry 변경 하나의 계획과 적용한 뒤의 항목 목록. `entries`는 지금 클러스터의 모든 access entry다.
pub fn plan_entry(change: &Change, cluster: &str, entries: &[EntryInput], mode: AuthMode) -> Result<(Plan, Vec<EntryInput>), AppError> {
    if !is_access_entry(&change.target) || change.target.namespace.is_some() || change.target.name.is_empty() {
        return Err(AppError::other(INVALID_CHANGE));
    }
    if mode == AuthMode::ConfigMap {
        return Err(AppError::other(MODE_CONFIG_MAP));
    }
    match &change.operation {
        Operation::AccessEntryCreate { username, groups, policies, entry_type } => create(change, cluster, entries, username, groups, policies, entry_type),
        Operation::AccessEntryDelete => delete(change, cluster, entries),
        Operation::AccessEntryGroups { groups } => set_groups(change, cluster, entries, groups),
        Operation::AccessPolicyAssociate { policy_arn, scope } => associate(change, cluster, entries, policy_arn, scope),
        Operation::AccessPolicyDisassociate { policy_arn } => disassociate(change, cluster, entries, policy_arn),
        _ => Err(AppError::other(INVALID_CHANGE)),
    }
}

#[cfg(test)]
mod tests;
