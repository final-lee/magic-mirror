//! RBAC 객체를 계산에 쓰는 평평한 모양으로 옮긴다. `k8s_openapi` 타입에서 바꾸는 함수와, `aggregationRule` ClusterRole 합치기를 둔다.
//! 이 파일은 순수 코드다(클러스터를 부르지 않는다).
use std::collections::{BTreeMap, HashMap, HashSet};

use k8s_openapi::api::rbac::v1 as k;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::LabelSelector;
use serde::{Deserialize, Serialize};

/// RBAC 규칙 하나. API 서버의 `PolicyRule`과 같은 뜻이다.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub verbs: Vec<String>,
    pub api_groups: Vec<String>,
    pub resources: Vec<String>,
    pub resource_names: Vec<String>,
    pub non_resource_urls: Vec<String>,
}

/// 라벨 선택 조건 하나(`matchExpressions`의 항목)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Requirement {
    pub key: String,
    pub operator: String,
    pub values: Vec<String>,
}

/// 라벨 선택자. 조건이 하나도 없으면 모든 것에 맞는다(API 서버의 빈 선택자와 같다).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Selector {
    pub match_labels: BTreeMap<String, String>,
    pub match_expressions: Vec<Requirement>,
}

/// Role(네임스페이스가 있다) 또는 ClusterRole(없다)
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Role {
    pub namespace: Option<String>,
    pub name: String,
    pub rules: Vec<Rule>,
    pub labels: BTreeMap<String, String>,
    /// `aggregationRule`이 있는 ClusterRole이면 그 선택자들. 있으면 `rules`는 쓰지 않고(컨트롤러가 덮어쓴다) 선택자에 맞는 ClusterRole의 규칙을 합친다.
    pub aggregation: Option<Vec<Selector>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RoleKind {
    Role,
    ClusterRole,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleRef {
    pub kind: RoleKind,
    pub name: String,
}

/// 바인딩에 이름이 나오는 주체와, 계산이 다루는 주체 종류. `Iam`은 신원 매핑으로 알게 된 IAM 주체(ARN)다. 바인딩에는 나오지 않는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SubjectKind {
    User,
    Group,
    ServiceAccount,
    Iam,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subject {
    pub kind: SubjectKind,
    pub name: String,
    /// ServiceAccount만 가진다
    pub namespace: Option<String>,
}

impl Subject {
    pub fn user(name: &str) -> Subject {
        Subject { kind: SubjectKind::User, name: name.to_string(), namespace: None }
    }

    pub fn group(name: &str) -> Subject {
        Subject { kind: SubjectKind::Group, name: name.to_string(), namespace: None }
    }

    pub fn service_account(namespace: &str, name: &str) -> Subject {
        Subject { kind: SubjectKind::ServiceAccount, name: name.to_string(), namespace: Some(namespace.to_string()) }
    }

    pub fn iam(arn: &str) -> Subject {
        Subject { kind: SubjectKind::Iam, name: arn.to_string(), namespace: None }
    }

    /// 목록·캐시에서 주체를 가리키는 안정된 글. 종류 접두사가 있어서 이름이 같은 사용자와 그룹을 구별한다.
    pub fn key(&self) -> String {
        match self.kind {
            SubjectKind::User => format!("user:{}", self.name),
            SubjectKind::Group => format!("group:{}", self.name),
            SubjectKind::ServiceAccount => format!("sa:{}/{}", self.namespace.as_deref().unwrap_or(""), self.name),
            SubjectKind::Iam => format!("iam:{}", self.name),
        }
    }
}

/// RoleBinding(네임스페이스가 있다) 또는 ClusterRoleBinding(없다)
#[derive(Debug, Clone, PartialEq)]
pub struct Binding {
    pub namespace: Option<String>,
    pub name: String,
    pub role_ref: RoleRef,
    pub subjects: Vec<Subject>,
}

/// 한 시점의 RBAC 객체 전부
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Rbac {
    pub roles: Vec<Role>,
    pub cluster_roles: Vec<Role>,
    pub bindings: Vec<Binding>,
    pub cluster_bindings: Vec<Binding>,
}

/// 합친 규칙 하나와 그 출처
#[derive(Debug, Clone, PartialEq)]
pub struct SourcedRule {
    pub rule: Rule,
    /// `aggregationRule`로 합친 규칙이면 그 규칙을 가진 ClusterRole의 이름
    pub aggregated_from: Option<String>,
}

fn rule_of(r: &k::PolicyRule) -> Rule {
    Rule {
        verbs: r.verbs.clone(),
        api_groups: r.api_groups.clone().unwrap_or_default(),
        resources: r.resources.clone().unwrap_or_default(),
        resource_names: r.resource_names.clone().unwrap_or_default(),
        non_resource_urls: r.non_resource_urls.clone().unwrap_or_default(),
    }
}

fn selector_of(s: &LabelSelector) -> Selector {
    Selector {
        match_labels: s.match_labels.clone().unwrap_or_default(),
        match_expressions: s
            .match_expressions
            .iter()
            .flatten()
            .map(|e| Requirement { key: e.key.clone(), operator: e.operator.clone(), values: e.values.clone().unwrap_or_default() })
            .collect(),
    }
}

pub fn role_of(r: &k::Role) -> Role {
    Role {
        namespace: r.metadata.namespace.clone(),
        name: r.metadata.name.clone().unwrap_or_default(),
        rules: r.rules.iter().flatten().map(rule_of).collect(),
        labels: r.metadata.labels.clone().unwrap_or_default(),
        aggregation: None,
    }
}

pub fn cluster_role_of(r: &k::ClusterRole) -> Role {
    Role {
        namespace: None,
        name: r.metadata.name.clone().unwrap_or_default(),
        rules: r.rules.iter().flatten().map(rule_of).collect(),
        labels: r.metadata.labels.clone().unwrap_or_default(),
        aggregation: r.aggregation_rule.as_ref().map(|a| a.cluster_role_selectors.iter().flatten().map(selector_of).collect()),
    }
}

fn subjects_of(subjects: &Option<Vec<k::Subject>>) -> Vec<Subject> {
    subjects
        .iter()
        .flatten()
        .filter_map(|s| {
            let kind = match s.kind.as_str() {
                "User" => SubjectKind::User,
                "Group" => SubjectKind::Group,
                "ServiceAccount" => SubjectKind::ServiceAccount,
                _ => return None,
            };
            // ServiceAccount는 네임스페이스가 있어야 뜻이 있다(API 서버도 이름만으로는 어떤 사용자에도 맞추지 못한다)
            if kind == SubjectKind::ServiceAccount && s.namespace.as_deref().unwrap_or("").is_empty() {
                return None;
            }
            Some(Subject { kind, name: s.name.clone(), namespace: if kind == SubjectKind::ServiceAccount { s.namespace.clone() } else { None } })
        })
        .collect()
}

fn role_ref_of(r: &k::RoleRef) -> Option<RoleRef> {
    let kind = match r.kind.as_str() {
        "Role" => RoleKind::Role,
        "ClusterRole" => RoleKind::ClusterRole,
        _ => return None,
    };
    Some(RoleRef { kind, name: r.name.clone() })
}

/// roleRef의 종류를 알아볼 수 없는 바인딩은 건너뛴다
pub fn binding_of(b: &k::RoleBinding) -> Option<Binding> {
    Some(Binding {
        namespace: b.metadata.namespace.clone(),
        name: b.metadata.name.clone().unwrap_or_default(),
        role_ref: role_ref_of(&b.role_ref)?,
        subjects: subjects_of(&b.subjects),
    })
}

pub fn cluster_binding_of(b: &k::ClusterRoleBinding) -> Option<Binding> {
    Some(Binding { namespace: None, name: b.metadata.name.clone().unwrap_or_default(), role_ref: role_ref_of(&b.role_ref)?, subjects: subjects_of(&b.subjects) })
}

/// 쿠버네티스 `LabelSelectorAsSelector`와 같다: 조건이 모두 맞아야 하고, 조건이 없으면 모든 것에 맞는다.
pub fn selector_matches(selector: &Selector, labels: &BTreeMap<String, String>) -> bool {
    if selector.match_labels.iter().any(|(key, value)| labels.get(key) != Some(value)) {
        return false;
    }
    selector.match_expressions.iter().all(|e| {
        let have = labels.get(&e.key);
        match e.operator.as_str() {
            "In" => have.is_some_and(|v| e.values.contains(v)),
            "NotIn" => have.is_none_or(|v| !e.values.contains(v)),
            "Exists" => have.is_some(),
            "DoesNotExist" => have.is_none(),
            // 알 수 없는 연산자는 API 서버가 만들 때 거절한다. 여기서는 맞지 않는 것으로 본다.
            _ => false,
        }
    })
}

/// 모든 ClusterRole의 규칙을 이름별로 구한다. `aggregationRule`이 있으면 선택자에 맞는 다른 ClusterRole의 규칙을 이름 순서대로 합친다(스스로는 뺀다).
/// 합친 ClusterRole이 다시 합쳐진 것이어도(여러 단계) 끝까지 풀고, 순환은 끊는다.
pub fn resolve_cluster_roles(cluster_roles: &[Role]) -> HashMap<String, Vec<SourcedRule>> {
    let by_name: HashMap<&str, &Role> = cluster_roles.iter().map(|r| (r.name.as_str(), r)).collect();
    let mut sorted: Vec<&Role> = cluster_roles.iter().collect();
    sorted.sort_by(|a, b| a.name.cmp(&b.name));
    let mut done: HashMap<String, Vec<SourcedRule>> = HashMap::new();
    for role in cluster_roles {
        resolve_one(role, &by_name, &sorted, &mut done, &mut HashSet::new());
    }
    done
}

fn resolve_one<'a>(role: &'a Role, by_name: &HashMap<&str, &'a Role>, sorted: &[&'a Role], done: &mut HashMap<String, Vec<SourcedRule>>, visiting: &mut HashSet<String>) -> Vec<SourcedRule> {
    if let Some(known) = done.get(&role.name) {
        return known.clone();
    }
    let Some(selectors) = &role.aggregation else {
        let own: Vec<SourcedRule> = role.rules.iter().map(|rule| SourcedRule { rule: rule.clone(), aggregated_from: None }).collect();
        done.insert(role.name.clone(), own.clone());
        return own;
    };
    if !visiting.insert(role.name.clone()) {
        // 순환: 이 고리 안에서는 더 합치지 않는다
        return Vec::new();
    }
    let mut out: Vec<SourcedRule> = Vec::new();
    for other in sorted {
        if other.name == role.name || !selectors.iter().any(|s| selector_matches(s, &other.labels)) {
            continue;
        }
        let Some(other) = by_name.get(other.name.as_str()) else {
            continue;
        };
        for sourced in resolve_one(other, by_name, sorted, done, visiting) {
            if !out.iter().any(|have| have.rule == sourced.rule) {
                out.push(SourcedRule { rule: sourced.rule, aggregated_from: Some(other.name.clone()) });
            }
        }
    }
    visiting.remove(&role.name);
    done.insert(role.name.clone(), out.clone());
    out
}

#[cfg(test)]
mod tests;
