//! 실효 권한 엔진(순수). RBAC 객체와 신원 매핑을 받아 주체별 권한(규칙 + 출처 경로)을 계산한다.
//!
//! # API
//! - `evaluate(rbac, principals) -> Evaluation`: 입력은 Role·ClusterRole(`aggregationRule` 포함)·RoleBinding·ClusterRoleBinding(`Rbac`)과, 유효한 신원 매핑(`Principal`: IAM 주체의
//!   쿠버네티스 사용자 이름·그룹·EKS access policy). 출력은 주체별 `SubjectRules`: 규칙마다 `Grant`(범위 + 규칙 + 출처 `Source`).
//! - `Evaluation::can(subject, &Query) -> Decision`: 이 주체가 요청 하나(동사·API 그룹·리소스·하위 리소스·네임스페이스·이름)를 할 수 있는지와, 허용하는 `Grant`(바인딩 경로) 전부.
//! - `Evaluation::can_non_resource(subject, verb, path)`: `/healthz` 같은 비리소스 URL.
//! - `Evaluation::who_can(&Query) -> Vec<WhoCan>`: 요청을 할 수 있는 주체와 경로. 기본 그룹(`system:authenticated` 등)에서 물려받은 권한은 개별 사용자·ServiceAccount 항목에
//!   넣지 않고 그 그룹 항목 하나로 보인다(모두가 물려받으니 줄마다 되풀이하지 않는다).
//! - `diff::diff(before, after)`: 두 시점에서 누가 무엇을 얻고 잃는지(`diff.rs`).
//! - `matrix.rs`: 권한 표 칸(읽기·쓰기·삭제 …)을 같은 `Grant` 위에서 계산한다.
//!
//! # 의미(API 서버의 RBAC 인가와 같다)
//! - 동사·API 그룹·리소스에 `*`가 있으면 모두에 맞는다. 리소스는 `pods`, `pods/exec`, `*/exec`로 쓰고 `pods`는 `pods/exec`에 맞지 않는다(`*`만 모든 하위 리소스에 맞는다). `pods/*`는 맞지 않는다.
//! - `resourceNames`가 있는 규칙은 이름을 지정한 요청에만 맞는다(목록·생성 같은 이름 없는 요청에는 맞지 않는다).
//! - RoleBinding은 그 네임스페이스의 요청에만, ClusterRoleBinding은 모든 네임스페이스와 클러스터 범위 리소스, 비리소스 URL에 적용된다.
//!   RoleBinding이 ClusterRole을 가리켜도 그 네임스페이스에만 적용되고 `nonResourceURLs`는 무시한다.
//! - 요청의 네임스페이스가 `None`이면 클러스터 범위 요청이다(`kubectl get pods -A` 포함): ClusterRoleBinding으로 받은 권한만 맞는다.
//! - 모든 주체는 `system:authenticated`(익명 `system:anonymous`는 `system:unauthenticated`)를, ServiceAccount는 `system:serviceaccounts`와 `system:serviceaccounts:<ns>`도 가진다.
//!   `system:masters` 그룹은 API 서버가 RBAC과 상관없이 모두 허용한다(`Via::Builtin`).
//! - EKS access policy는 정해진 ClusterRole(`identity::policy_role`)의 규칙을 그 범위(클러스터 또는 네임스페이스 목록)에 주는 것으로 계산한다.
//! - IAM 사용자 이름이 `{{SessionName}}` 같은 템플릿이면, 그 템플릿에 맞는 이름의 User 바인딩은 `session_dependent`로 표시해 적용한다.
use std::borrow::Cow;
use std::collections::{BTreeSet, HashMap};

use serde::Serialize;

use super::identity::policy_role;
use super::rbac::{resolve_cluster_roles, Binding, Rbac, Role, RoleKind, Rule, SourcedRule, Subject, SubjectKind};

pub const AUTHENTICATED: &str = "system:authenticated";
pub const UNAUTHENTICATED: &str = "system:unauthenticated";
pub const ANONYMOUS: &str = "system:anonymous";
pub const SERVICE_ACCOUNTS: &str = "system:serviceaccounts";
pub const MASTERS: &str = "system:masters";
const SA_PREFIX: &str = "system:serviceaccount:";

/// EKS access policy 연결 하나의 범위
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PolicyScope {
    Cluster,
    Namespaces { namespaces: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessPolicy {
    pub policy_arn: String,
    pub scope: PolicyScope,
}

/// 신원 매핑 하나를 계산에 맞게 줄인 것. 유효한 매핑만 넣는다.
#[derive(Debug, Clone, PartialEq)]
pub struct Principal {
    pub arn: String,
    /// 화면에 보일 이름(SSO 권한 세트 이름 등)
    pub label: Option<String>,
    /// 쿠버네티스 사용자 이름. `{{SessionName}}` 같은 템플릿이 들어 있을 수 있다.
    pub username: String,
    pub groups: Vec<String>,
    pub policies: Vec<AccessPolicy>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingRef {
    /// `RoleBinding` 또는 `ClusterRoleBinding`
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleView {
    pub kind: RoleKind,
    pub namespace: Option<String>,
    pub name: String,
}

/// 주체가 이 권한을 받은 방법
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Via {
    /// 바인딩이 이 주체를 직접 가리킨다
    Direct,
    /// 매핑이 준 그룹을 바인딩이 가리킨다
    Group { group: String },
    /// 모든 주체가 가지는 기본 그룹(`system:authenticated`, `system:serviceaccounts*`)을 바인딩이 가리킨다
    DefaultGroup { group: String },
    /// EKS access policy
    AccessPolicy { policy: String },
    /// API 서버 내장(`system:masters`)
    Builtin { group: String },
}

/// 권한이 어디서 왔는지: 바인딩 → 역할(→ 합쳐 준 ClusterRole)
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub via: Via,
    pub binding: Option<BindingRef>,
    pub role: Option<RoleView>,
    /// `aggregationRule`로 이 규칙을 합쳐 준 ClusterRole
    pub aggregated_from: Option<String>,
    /// 사용자 이름 템플릿(`{{SessionName}}`)에 맞는 User 바인딩이라 특정 세션에서만 적용된다
    pub session_dependent: bool,
}

/// 규칙 하나가 적용되는 범위와 출처
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    /// None이면 클러스터 전체
    pub namespace: Option<String>,
    pub rule: Rule,
    pub source: Source,
}

/// 요청 하나. `namespace`가 None이면 클러스터 범위 요청이다.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Default, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    pub verb: String,
    /// API 그룹. 코어 그룹은 빈 글
    pub group: String,
    pub resource: String,
    #[serde(default)]
    pub subresource: Option<String>,
    #[serde(default)]
    pub namespace: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

impl Query {
    pub fn new(verb: &str, group: &str, resource: &str) -> Query {
        Query { verb: verb.to_string(), group: group.to_string(), resource: resource.to_string(), ..Query::default() }
    }

    pub fn subres(mut self, subresource: &str) -> Query {
        self.subresource = Some(subresource.to_string());
        self
    }

    pub fn ns(mut self, namespace: &str) -> Query {
        self.namespace = Some(namespace.to_string());
        self
    }

    pub fn named(mut self, name: &str) -> Query {
        self.name = Some(name.to_string());
        self
    }

    fn combined(&self) -> String {
        match self.subresource.as_deref().filter(|s| !s.is_empty()) {
            Some(sub) => format!("{}/{}", self.resource, sub),
            None => self.resource.clone(),
        }
    }
}

/// 이름 조건을 어떻게 볼지. `Ignore`는 권한 표가 "이름이 정해진 권한만 있어도 일부"를 가려내는 데 쓴다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Names {
    Strict,
    Ignore,
}

fn any_or_equal(list: &[String], want: &str) -> bool {
    list.iter().any(|v| v == "*" || v == want)
}

fn resource_matches(rule: &Rule, combined: &str, subresource: &str) -> bool {
    rule.resources.iter().any(|r| {
        if r == "*" || r == combined {
            return true;
        }
        // `*/log` 꼴만 하위 리소스에 맞는다
        !subresource.is_empty() && r.len() == subresource.len() + 2 && r.starts_with("*/") && r.ends_with(subresource)
    })
}

/// 규칙이 리소스 요청에 맞는지(범위는 `Grant::matches`가 본다)
pub fn rule_allows(rule: &Rule, q: &Query, names: Names) -> bool {
    let sub = q.subresource.as_deref().unwrap_or("");
    if !any_or_equal(&rule.verbs, &q.verb) || !any_or_equal(&rule.api_groups, &q.group) || !resource_matches(rule, &q.combined(), sub) {
        return false;
    }
    names == Names::Ignore || rule.resource_names.is_empty() || q.name.as_ref().is_some_and(|n| rule.resource_names.contains(n))
}

/// 규칙이 비리소스 URL 요청에 맞는지. `*`, 정확히 같음, 끝이 `*`인 접두사.
pub fn rule_allows_url(rule: &Rule, verb: &str, path: &str) -> bool {
    any_or_equal(&rule.verbs, verb)
        && rule.non_resource_urls.iter().any(|u| match u.strip_suffix('*') {
            Some(prefix) => u == "*" || path.starts_with(prefix),
            None => u == path,
        })
}

impl Grant {
    pub fn matches(&self, q: &Query, names: Names) -> bool {
        let in_scope = match &self.namespace {
            None => true,
            Some(ns) => q.namespace.as_deref() == Some(ns.as_str()),
        };
        in_scope && rule_allows(&self.rule, q, names)
    }

    pub fn matches_url(&self, verb: &str, path: &str) -> bool {
        self.namespace.is_none() && rule_allows_url(&self.rule, verb, path)
    }
}

/// 주체 하나의 계산 결과
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubjectRules {
    pub subject: Subject,
    /// 화면에 보일 이름(IAM 주체의 권한 세트 이름 등)
    pub label: Option<String>,
    /// IAM 주체가 쿠버네티스에서 쓰는 사용자 이름과 그룹(매핑이 준 것)
    pub username: Option<String>,
    pub groups: Vec<String>,
    pub grants: Vec<Grant>,
    /// 계산하지 못한 것(알 수 없는 access policy, 없는 ClusterRole 등)
    pub unevaluated: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub allowed: bool,
    /// 이 요청을 허용하는 권한과 그 경로 전부(허용이 아니면 비어 있다)
    pub grants: Vec<Grant>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhoCan {
    pub subject: Subject,
    pub label: Option<String>,
    pub grants: Vec<Grant>,
}

/// 없는 역할을 가리키는 바인딩
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dangling {
    pub binding: BindingRef,
    pub role: RoleView,
}

/// 계산이 쓰는 사용자·그룹 한 벌
struct Actor {
    username: Option<String>,
    groups: Vec<String>,
    defaults: Vec<String>,
    label: Option<String>,
    policies: Vec<AccessPolicy>,
}

struct Indexed {
    binding: Binding,
    cluster: bool,
}

pub struct Evaluation {
    rbac: Rbac,
    principals: HashMap<String, Principal>,
    cluster_roles: HashMap<String, Vec<SourcedRule>>,
    roles: HashMap<(String, String), Vec<SourcedRule>>,
    bindings: Vec<Indexed>,
    by_user: HashMap<String, Vec<usize>>,
    by_group: HashMap<String, Vec<usize>>,
    subjects: Vec<SubjectRules>,
    lookup: HashMap<String, usize>,
    dangling: Vec<Dangling>,
}

fn binding_ref(b: &Indexed) -> BindingRef {
    BindingRef {
        kind: if b.cluster { "ClusterRoleBinding" } else { "RoleBinding" }.to_string(),
        namespace: b.binding.namespace.clone(),
        name: b.binding.name.clone(),
    }
}

fn role_view(b: &Indexed) -> RoleView {
    RoleView {
        kind: b.binding.role_ref.kind,
        namespace: if b.binding.role_ref.kind == RoleKind::Role { b.binding.namespace.clone() } else { None },
        name: b.binding.role_ref.name.clone(),
    }
}

/// 템플릿(`{{…}}` 자리표시자)에 이름이 맞는지. 자리표시자는 아무 글(빈 글 포함)에 맞는다.
pub fn template_matches(template: &str, name: &str) -> bool {
    let mut pieces: Vec<&str> = Vec::new();
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        let Some(end) = rest[start..].find("}}") else {
            break;
        };
        pieces.push(&rest[..start]);
        rest = &rest[start + end + 2..];
    }
    pieces.push(rest);
    if pieces.len() == 1 {
        return template == name;
    }
    let first = pieces[0];
    let last = pieces[pieces.len() - 1];
    if name.len() < first.len() + last.len() || !name.starts_with(first) || !name.ends_with(last) {
        return false;
    }
    let mut cursor = first.len();
    let limit = name.len() - last.len();
    for piece in &pieces[1..pieces.len() - 1] {
        match name[cursor..limit].find(piece) {
            Some(at) => cursor += at + piece.len(),
            None => return false,
        }
    }
    true
}

pub fn has_template(text: &str) -> bool {
    text.contains("{{") && text.contains("}}")
}

fn masters_grants() -> Vec<Grant> {
    let source = Source { via: Via::Builtin { group: MASTERS.to_string() }, binding: None, role: None, aggregated_from: None, session_dependent: false };
    let all = |resource: bool| Rule {
        verbs: vec!["*".to_string()],
        api_groups: if resource { vec!["*".to_string()] } else { vec![] },
        resources: if resource { vec!["*".to_string()] } else { vec![] },
        resource_names: vec![],
        non_resource_urls: if resource { vec![] } else { vec!["*".to_string()] },
    };
    vec![Grant { namespace: None, rule: all(true), source: source.clone() }, Grant { namespace: None, rule: all(false), source }]
}

impl Evaluation {
    fn build(rbac: Rbac, principals: Vec<Principal>) -> Evaluation {
        let cluster_roles = resolve_cluster_roles(&rbac.cluster_roles);
        let roles: HashMap<(String, String), Vec<SourcedRule>> = rbac
            .roles
            .iter()
            .map(|r: &Role| ((r.namespace.clone().unwrap_or_default(), r.name.clone()), r.rules.iter().map(|rule| SourcedRule { rule: rule.clone(), aggregated_from: None }).collect()))
            .collect();
        let mut bindings: Vec<Indexed> = Vec::new();
        bindings.extend(rbac.cluster_bindings.iter().map(|b| Indexed { binding: b.clone(), cluster: true }));
        bindings.extend(rbac.bindings.iter().map(|b| Indexed { binding: b.clone(), cluster: false }));
        let mut by_user: HashMap<String, Vec<usize>> = HashMap::new();
        let mut by_group: HashMap<String, Vec<usize>> = HashMap::new();
        let mut dangling = Vec::new();
        for (i, b) in bindings.iter().enumerate() {
            for s in &b.binding.subjects {
                match s.kind {
                    SubjectKind::User => by_user.entry(s.name.clone()).or_default().push(i),
                    SubjectKind::Group => by_group.entry(s.name.clone()).or_default().push(i),
                    SubjectKind::ServiceAccount => by_user.entry(format!("{SA_PREFIX}{}:{}", s.namespace.as_deref().unwrap_or(""), s.name)).or_default().push(i),
                    SubjectKind::Iam => {}
                }
            }
            let resolved = match (b.binding.role_ref.kind, b.cluster) {
                (RoleKind::ClusterRole, _) => cluster_roles.contains_key(&b.binding.role_ref.name),
                (RoleKind::Role, false) => roles.contains_key(&(b.binding.namespace.clone().unwrap_or_default(), b.binding.role_ref.name.clone())),
                (RoleKind::Role, true) => false,
            };
            if !resolved {
                dangling.push(Dangling { binding: binding_ref(b), role: role_view(b) });
            }
        }
        let principals: HashMap<String, Principal> = principals.into_iter().map(|p| (p.arn.clone(), p)).collect();
        let mut evaluation = Evaluation { rbac, principals, cluster_roles, roles, bindings, by_user, by_group, subjects: Vec::new(), lookup: HashMap::new(), dangling };
        let mut subjects: BTreeSet<Subject> = BTreeSet::new();
        for b in &evaluation.bindings {
            subjects.extend(b.binding.subjects.iter().cloned());
        }
        subjects.extend(evaluation.principals.keys().map(|arn| Subject::iam(arn)));
        let rules: Vec<SubjectRules> = subjects.iter().map(|s| evaluation.compute(s)).collect();
        evaluation.lookup = rules.iter().enumerate().map(|(i, r)| (r.subject.key(), i)).collect();
        evaluation.subjects = rules;
        evaluation
    }

    fn actor(&self, subject: &Subject) -> Actor {
        let mut defaults = Vec::new();
        let (username, groups, label, policies) = match subject.kind {
            SubjectKind::User => {
                if let Some(rest) = subject.name.strip_prefix(SA_PREFIX) {
                    if let Some((ns, _)) = rest.split_once(':') {
                        defaults.extend([SERVICE_ACCOUNTS.to_string(), format!("{SERVICE_ACCOUNTS}:{ns}")]);
                    }
                }
                (Some(subject.name.clone()), vec![], None, vec![])
            }
            SubjectKind::ServiceAccount => {
                let ns = subject.namespace.clone().unwrap_or_default();
                defaults.extend([SERVICE_ACCOUNTS.to_string(), format!("{SERVICE_ACCOUNTS}:{ns}")]);
                (Some(format!("{SA_PREFIX}{ns}:{}", subject.name)), vec![], None, vec![])
            }
            // 그룹 주체는 이 그룹을 가리키는 바인딩만 본다(`compute`의 Direct)
            SubjectKind::Group => (None, vec![], None, vec![]),
            SubjectKind::Iam => match self.principals.get(&subject.name) {
                Some(p) => (Some(p.username.clone()).filter(|u| !u.is_empty()), p.groups.clone(), p.label.clone(), p.policies.clone()),
                None => (None, vec![], None, vec![]),
            },
        };
        if subject.kind != SubjectKind::Group {
            let anonymous = username.as_deref() == Some(ANONYMOUS);
            defaults.push(if anonymous { UNAUTHENTICATED } else { AUTHENTICATED }.to_string());
        }
        Actor { username, groups, defaults, label, policies }
    }

    /// 바인딩 하나가 주는 규칙들. 없는 역할이면 빈 목록.
    fn role_rules(&self, b: &Indexed) -> Vec<SourcedRule> {
        let found = match b.binding.role_ref.kind {
            RoleKind::ClusterRole => self.cluster_roles.get(&b.binding.role_ref.name),
            RoleKind::Role => {
                if b.cluster {
                    None
                } else {
                    self.roles.get(&(b.binding.namespace.clone().unwrap_or_default(), b.binding.role_ref.name.clone()))
                }
            }
        };
        found.cloned().unwrap_or_default()
    }

    fn push_binding_grants(&self, out: &mut Vec<Grant>, index: usize, via: Via, session_dependent: bool) {
        let b = &self.bindings[index];
        for sourced in self.role_rules(b) {
            // RoleBinding이 준 권한에서 비리소스 URL은 아무 데도 적용되지 않는다
            if !b.cluster && sourced.rule.resources.is_empty() && !sourced.rule.non_resource_urls.is_empty() {
                continue;
            }
            out.push(Grant {
                namespace: if b.cluster { None } else { b.binding.namespace.clone() },
                rule: sourced.rule,
                source: Source { via: via.clone(), binding: Some(binding_ref(b)), role: Some(role_view(b)), aggregated_from: sourced.aggregated_from, session_dependent },
            });
        }
    }

    fn compute(&self, subject: &Subject) -> SubjectRules {
        let actor = self.actor(subject);
        let mut grants: Vec<Grant> = Vec::new();
        let mut unevaluated: Vec<String> = Vec::new();
        if actor.groups.iter().any(|g| g == MASTERS) {
            grants.extend(masters_grants());
        }
        // 같은 바인딩이 같은 방법으로 두 번 맞아도(User와 Group 주체를 함께 적은 경우 등) 한 번만 센다
        let mut seen: Vec<(usize, Via, bool)> = Vec::new();
        let mut take = |index: usize, via: Via, session: bool, out: &mut Vec<Grant>| {
            if seen.iter().any(|(i, v, s)| *i == index && *v == via && *s == session) {
                return;
            }
            seen.push((index, via.clone(), session));
            self.push_binding_grants(out, index, via, session);
        };
        if let Some(username) = &actor.username {
            if let Some(list) = self.by_user.get(username) {
                for &i in list {
                    take(i, Via::Direct, false, &mut grants);
                }
            }
            if has_template(username) {
                let mut names: Vec<&String> = self.by_user.keys().filter(|n| n.as_str() != username && template_matches(username, n)).collect();
                names.sort();
                for name in names {
                    for &i in &self.by_user[name] {
                        take(i, Via::Direct, true, &mut grants);
                    }
                }
            }
        }
        for group in &actor.groups {
            if let Some(list) = self.by_group.get(group) {
                for &i in list {
                    take(i, Via::Group { group: group.clone() }, false, &mut grants);
                }
            }
        }
        if subject.kind == SubjectKind::Group {
            if let Some(list) = self.by_group.get(&subject.name) {
                for &i in list {
                    take(i, Via::Direct, false, &mut grants);
                }
            }
        }
        for group in &actor.defaults {
            if let Some(list) = self.by_group.get(group) {
                for &i in list {
                    take(i, Via::DefaultGroup { group: group.clone() }, false, &mut grants);
                }
            }
        }
        for policy in &actor.policies {
            self.push_policy(&mut grants, &mut unevaluated, policy);
        }
        SubjectRules {
            subject: subject.clone(),
            label: actor.label,
            username: if subject.kind == SubjectKind::Iam { actor.username } else { None },
            groups: if subject.kind == SubjectKind::Iam { actor.groups } else { vec![] },
            grants,
            unevaluated,
        }
    }

    fn push_policy(&self, out: &mut Vec<Grant>, unevaluated: &mut Vec<String>, policy: &AccessPolicy) {
        let Some(role) = policy_role(&policy.policy_arn) else {
            unevaluated.push(policy.policy_arn.clone());
            return;
        };
        let Some(rules) = self.cluster_roles.get(role) else {
            unevaluated.push(format!("{}: 이 클러스터에 ClusterRole {role}이 없어요", policy.policy_arn));
            return;
        };
        let scopes: Vec<Option<String>> = match &policy.scope {
            PolicyScope::Cluster => vec![None],
            PolicyScope::Namespaces { namespaces } => namespaces.iter().cloned().map(Some).collect(),
        };
        for scope in scopes {
            for sourced in rules {
                if scope.is_some() && sourced.rule.resources.is_empty() {
                    continue;
                }
                out.push(Grant {
                    namespace: scope.clone(),
                    rule: sourced.rule.clone(),
                    source: Source {
                        via: Via::AccessPolicy { policy: policy.policy_arn.clone() },
                        binding: None,
                        role: Some(RoleView { kind: RoleKind::ClusterRole, namespace: None, name: role.to_string() }),
                        aggregated_from: sourced.aggregated_from.clone(),
                        session_dependent: false,
                    },
                });
            }
        }
    }

    /// 이 평가에 들어 있는 주체(바인딩에 이름이 나온 것과 유효한 IAM 주체), 종류·이름 순
    pub fn subjects(&self) -> &[SubjectRules] {
        &self.subjects
    }

    /// 이 주체의 계산 결과. 목록에 없는 주체(바인딩에 이름이 없는 ServiceAccount 등)는 그 자리에서 계산한다.
    pub fn rules_of(&self, subject: &Subject) -> Cow<'_, SubjectRules> {
        match self.lookup.get(&subject.key()) {
            Some(&i) => Cow::Borrowed(&self.subjects[i]),
            None => Cow::Owned(self.compute(subject)),
        }
    }

    pub fn dangling(&self) -> &[Dangling] {
        &self.dangling
    }

    pub fn rbac(&self) -> &Rbac {
        &self.rbac
    }

    /// 이 주체가 쿠버네티스에서 쓰는 사용자 이름과 그룹(기본 그룹 포함). SubjectAccessReview 대조에 쓴다.
    pub fn identity_of(&self, subject: &Subject) -> (Option<String>, Vec<String>) {
        let actor = self.actor(subject);
        let mut groups = actor.groups;
        groups.extend(actor.defaults);
        (actor.username, groups)
    }

    pub fn can(&self, subject: &Subject, q: &Query) -> Decision {
        let rules = self.rules_of(subject);
        let grants: Vec<Grant> = rules.grants.iter().filter(|g| g.matches(q, Names::Strict)).cloned().collect();
        Decision { allowed: !grants.is_empty(), grants }
    }

    pub fn can_non_resource(&self, subject: &Subject, verb: &str, path: &str) -> Decision {
        let rules = self.rules_of(subject);
        let grants: Vec<Grant> = rules.grants.iter().filter(|g| g.matches_url(verb, path)).cloned().collect();
        Decision { allowed: !grants.is_empty(), grants }
    }

    /// 이 요청을 할 수 있는 주체와 경로. 기본 그룹에서 물려받은 권한은 그 그룹 항목에만 둔다(모듈 문서 참고).
    pub fn who_can(&self, q: &Query) -> Vec<WhoCan> {
        self.subjects
            .iter()
            .filter_map(|s| {
                let grants: Vec<Grant> = s.grants.iter().filter(|g| !matches!(g.source.via, Via::DefaultGroup { .. }) && g.matches(q, Names::Strict)).cloned().collect();
                (!grants.is_empty()).then(|| WhoCan { subject: s.subject.clone(), label: s.label.clone(), grants })
            })
            .collect()
    }
}

/// 입력을 받아 모든 주체의 권한을 계산한다
pub fn evaluate(rbac: Rbac, principals: Vec<Principal>) -> Evaluation {
    Evaluation::build(rbac, principals)
}

#[cfg(test)]
mod tests;
