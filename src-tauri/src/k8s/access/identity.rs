//! 신원 연결(순수): IAM 주체가 쿠버네티스에서 어떤 사용자·그룹이 되는가.
//! 출처는 둘이다: EKS access entry(`ListAccessEntries` 등)와 `kube-system/aws-auth` ConfigMap(`mapRoles`, `mapUsers`).
//! 클러스터 인증 모드가 어느 쪽이 유효한지 정한다: `API`는 access entry만, `CONFIG_MAP`(access 설정이 없는 옛 클러스터 포함)은 aws-auth만,
//! `API_AND_CONFIG_MAP`은 둘 다 보되 같은 주체가 양쪽에 있으면 access entry가 먼저다.
use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

use super::engine::{AccessPolicy, PolicyScope, Principal};

/// EKS access policy → 쿠버네티스 ClusterRole 고정 대응표. 표에 없는 정책은 계산하지 못한다("평가하지 못함").
const POLICY_TABLE: [(&str, &str); 4] = [
    ("AmazonEKSClusterAdminPolicy", "cluster-admin"),
    ("AmazonEKSAdminPolicy", "admin"),
    ("AmazonEKSEditPolicy", "edit"),
    ("AmazonEKSViewPolicy", "view"),
];

/// 정책 ARN(`arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy`)의 이름
pub fn policy_name(arn: &str) -> &str {
    arn.rsplit('/').next().unwrap_or(arn)
}

/// 정책 ARN에 대응하는 ClusterRole 이름. 표에 없으면 None.
pub fn policy_role(arn: &str) -> Option<&'static str> {
    let name = policy_name(arn);
    POLICY_TABLE.iter().find(|(policy, _)| *policy == name).map(|(_, role)| *role)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthMode {
    Api,
    ApiAndConfigMap,
    ConfigMap,
}

/// `DescribeCluster`의 인증 모드. 값이 없으면(access 설정이 없던 옛 클러스터) `CONFIG_MAP`이다. 모르는 값은 둘 다 유효하다고 보고 보여 준다.
pub fn parse_mode(mode: Option<&str>) -> AuthMode {
    match mode {
        Some("API") => AuthMode::Api,
        Some("CONFIG_MAP") | None => AuthMode::ConfigMap,
        Some(_) => AuthMode::ApiAndConfigMap,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MappingSource {
    AccessEntry,
    AwsAuth,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PrincipalKind {
    Role,
    User,
    Other,
}

/// 연결된 access policy 하나
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyGrant {
    pub policy_arn: String,
    pub policy_name: String,
    /// 대응하는 ClusterRole. None이면 "평가하지 못함"
    pub role: Option<String>,
    pub scope: PolicyScope,
}

/// access entry 하나를 읽은 결과(모의 AWS 응답으로 시험한다)
#[derive(Debug, Clone, PartialEq)]
pub struct EntryInput {
    pub principal_arn: String,
    pub entry_type: Option<String>,
    pub username: Option<String>,
    pub groups: Vec<String>,
    pub policies: Vec<(String, PolicyScope)>,
    /// 자세히 읽지 못했을 때의 오류 글. 이 항목은 계산에서 빼고 이유를 보인다.
    pub read_error: Option<String>,
}

/// aws-auth의 매핑 하나
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AwsAuthEntry {
    pub arn: String,
    pub username: Option<String>,
    pub groups: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AwsAuth {
    pub roles: Vec<AwsAuthEntry>,
    pub users: Vec<AwsAuthEntry>,
    /// `mapAccounts`: 이 계정의 모든 IAM 주체를 허용하는 옛 방식
    pub accounts: Vec<String>,
    /// 읽지 못한 키의 이유(나머지는 그대로 쓴다)
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityMapping {
    pub source: MappingSource,
    pub principal_arn: String,
    pub kind: PrincipalKind,
    /// 쿠버네티스 사용자 이름. `{{SessionName}}` 같은 자리표시자가 남아 있을 수 있다(`{{AccountID}}`는 채운다).
    pub username: String,
    pub groups: Vec<String>,
    /// access entry의 종류(`STANDARD`, `EC2_LINUX` …)
    pub access_type: Option<String>,
    pub policies: Vec<PolicyGrant>,
    /// `AWSReservedSSO_<권한 세트>_<해시>` 역할이면 권한 세트 이름
    pub permission_set: Option<String>,
    /// 화면에 보일 이름
    pub label: String,
    /// 인증 모드와 우선순위를 따졌을 때 실제로 쓰이는지
    pub effective: bool,
    pub inactive_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawEntry {
    #[serde(alias = "userarn")]
    rolearn: Option<String>,
    username: Option<String>,
    groups: Option<Vec<String>>,
}

fn parse_entries(text: &str, key: &str, errors: &mut Vec<String>) -> Vec<AwsAuthEntry> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return vec![];
    }
    match serde_saphyr::from_str::<Option<Vec<RawEntry>>>(trimmed) {
        Ok(list) => list
            .unwrap_or_default()
            .into_iter()
            .filter_map(|e| {
                let arn = e.rolearn?;
                Some(AwsAuthEntry { arn, username: e.username.filter(|u| !u.is_empty()), groups: e.groups.unwrap_or_default() })
            })
            .collect(),
        Err(_) => {
            errors.push(format!("aws-auth의 {key}를 해석하지 못했어요"));
            vec![]
        }
    }
}

/// `kube-system/aws-auth`의 `data`를 읽는다. 한 키가 깨져 있어도 나머지는 쓴다.
pub fn parse_aws_auth(data: &BTreeMap<String, String>) -> AwsAuth {
    let mut auth = AwsAuth::default();
    // mapRoles는 `rolearn`, mapUsers는 `userarn`을 쓴다. 같은 모양으로 읽고 키별로 나눈다
    if let Some(text) = data.get("mapRoles") {
        auth.roles = parse_entries(text, "mapRoles", &mut auth.errors);
    }
    if let Some(text) = data.get("mapUsers") {
        auth.users = parse_entries(text, "mapUsers", &mut auth.errors);
    }
    if let Some(text) = data.get("mapAccounts") {
        match serde_saphyr::from_str::<Option<Vec<String>>>(text.trim()) {
            Ok(list) => auth.accounts = list.unwrap_or_default(),
            Err(_) => auth.errors.push("aws-auth의 mapAccounts를 해석하지 못했어요".to_string()),
        }
    }
    auth
}

/// ARN을 (계정, 종류, 이름)으로 나눈다. 경로는 버린다(`role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_X_1` → 이름 `AWSReservedSSO_X_1`).
/// aws-auth의 `rolearn`은 경로 없이 쓰고 access entry는 경로를 포함하니, 같은 주체인지는 이 값으로 비교한다.
pub fn parse_arn(arn: &str) -> Option<(String, PrincipalKind, String)> {
    let mut parts = arn.splitn(6, ':');
    if parts.next()? != "arn" {
        return None;
    }
    let account = parts.nth(3)?.to_string();
    let resource = parts.next()?;
    let (kind, rest) = resource.split_once('/')?;
    let kind = match kind {
        "role" => PrincipalKind::Role,
        "user" => PrincipalKind::User,
        _ => return None,
    };
    let name = rest.rsplit('/').next().unwrap_or(rest).to_string();
    Some((account, kind, name))
}

/// `AWSReservedSSO_<권한 세트>_<해시>` 역할의 권한 세트 이름. 해시는 마지막 `_` 뒤다.
pub fn permission_set(arn: &str) -> Option<String> {
    let (_, kind, name) = parse_arn(arn)?;
    if kind != PrincipalKind::Role {
        return None;
    }
    let rest = name.strip_prefix("AWSReservedSSO_")?;
    let (set, hash) = rest.rsplit_once('_')?;
    (!set.is_empty() && !hash.is_empty()).then(|| set.to_string())
}

fn kind_of(arn: &str) -> PrincipalKind {
    parse_arn(arn).map_or(PrincipalKind::Other, |(_, kind, _)| kind)
}

fn label_of(arn: &str, set: &Option<String>) -> String {
    match set {
        Some(set) => set.clone(),
        None => parse_arn(arn).map_or_else(|| arn.to_string(), |(_, _, name)| name),
    }
}

fn render(template: &str, arn: &str) -> String {
    match parse_arn(arn) {
        Some((account, _, _)) => template.replacen("{{AccountID}}", &account, usize::MAX),
        None => template.to_string(),
    }
}

fn principal_key(arn: &str) -> String {
    parse_arn(arn).map_or_else(|| arn.to_string(), |(account, kind, name)| format!("{account}:{kind:?}:{name}"))
}

fn grant_of(arn: &str, scope: &PolicyScope) -> PolicyGrant {
    PolicyGrant { policy_arn: arn.to_string(), policy_name: policy_name(arn).to_string(), role: policy_role(arn).map(str::to_string), scope: scope.clone() }
}

fn from_entry(e: &EntryInput) -> IdentityMapping {
    let set = permission_set(&e.principal_arn);
    IdentityMapping {
        source: MappingSource::AccessEntry,
        principal_arn: e.principal_arn.clone(),
        kind: kind_of(&e.principal_arn),
        username: e.username.clone().map(|u| render(&u, &e.principal_arn)).unwrap_or_else(|| e.principal_arn.clone()),
        groups: e.groups.clone(),
        access_type: e.entry_type.clone(),
        policies: e.policies.iter().map(|(arn, scope)| grant_of(arn, scope)).collect(),
        label: label_of(&e.principal_arn, &set),
        permission_set: set,
        effective: e.read_error.is_none(),
        inactive_reason: e.read_error.as_ref().map(|m| format!("자세히 읽지 못했어요: {m}")),
    }
}

fn from_aws_auth(e: &AwsAuthEntry, kind: PrincipalKind) -> IdentityMapping {
    let set = permission_set(&e.arn);
    IdentityMapping {
        source: MappingSource::AwsAuth,
        principal_arn: e.arn.clone(),
        kind,
        // 이름을 비우면 인증기는 ARN을 사용자 이름으로 쓴다
        username: render(e.username.as_deref().unwrap_or(&e.arn), &e.arn),
        groups: e.groups.clone(),
        access_type: None,
        policies: vec![],
        label: label_of(&e.arn, &set),
        permission_set: set,
        effective: true,
        inactive_reason: None,
    }
}

pub const NOT_USED_API: &str = "인증 모드가 API라서 aws-auth는 쓰이지 않아요";
pub const NOT_USED_CONFIG_MAP: &str = "인증 모드가 CONFIG_MAP이라서 access entry는 쓰이지 않아요";
pub const SHADOWED: &str = "같은 주체의 access entry가 먼저 쓰여요";

/// 두 출처를 모아 매핑 목록을 만들고 인증 모드에 따라 유효한 것을 가른다. 목록은 access entry가 먼저, 그 안에서는 입력 순서다.
pub fn resolve(mode: AuthMode, entries: &[EntryInput], aws_auth: Option<&AwsAuth>) -> Vec<IdentityMapping> {
    let mut out: Vec<IdentityMapping> = entries.iter().map(from_entry).collect();
    if mode == AuthMode::ConfigMap {
        for m in out.iter_mut() {
            m.effective = false;
            m.inactive_reason = Some(NOT_USED_CONFIG_MAP.to_string());
        }
    }
    let entry_keys: HashSet<String> = out.iter().filter(|m| m.effective).map(|m| principal_key(&m.principal_arn)).collect();
    if let Some(auth) = aws_auth {
        let all = auth.roles.iter().map(|e| (e, PrincipalKind::Role)).chain(auth.users.iter().map(|e| (e, PrincipalKind::User)));
        for (entry, kind) in all {
            let mut mapping = from_aws_auth(entry, kind);
            if mode == AuthMode::Api {
                mapping.effective = false;
                mapping.inactive_reason = Some(NOT_USED_API.to_string());
            } else if entry_keys.contains(&principal_key(&entry.arn)) {
                mapping.effective = false;
                mapping.inactive_reason = Some(SHADOWED.to_string());
            }
            out.push(mapping);
        }
    }
    out
}

/// 엔진에 넣을 주체: 유효한 매핑만. 같은 ARN이 둘이면 먼저 나온 것(access entry)만 쓴다.
pub fn principals(mappings: &[IdentityMapping]) -> Vec<Principal> {
    let mut seen: HashSet<&str> = HashSet::new();
    mappings
        .iter()
        .filter(|m| m.effective && seen.insert(m.principal_arn.as_str()))
        .map(|m| Principal {
            arn: m.principal_arn.clone(),
            label: Some(m.label.clone()),
            username: m.username.clone(),
            groups: m.groups.clone(),
            policies: m.policies.iter().map(|p| AccessPolicy { policy_arn: p.policy_arn.clone(), scope: p.scope.clone() }).collect(),
        })
        .collect()
}

/// 같은 권한 세트의 SSO 역할 묶음
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsoGroup {
    pub permission_set: String,
    pub principals: Vec<String>,
}

/// `AWSReservedSSO_<권한 세트>_<해시>` 역할을 권한 세트 이름으로 묶는다(이름 순)
pub fn sso_groups(mappings: &[IdentityMapping]) -> Vec<SsoGroup> {
    let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for m in mappings {
        if let Some(set) = &m.permission_set {
            let list = groups.entry(set.clone()).or_default();
            if !list.contains(&m.principal_arn) {
                list.push(m.principal_arn.clone());
            }
        }
    }
    groups.into_iter().map(|(permission_set, principals)| SsoGroup { permission_set, principals }).collect()
}

#[cfg(test)]
mod tests;
