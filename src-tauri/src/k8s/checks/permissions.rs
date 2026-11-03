//! 권한 점검(순수): 접근 화면(K4)의 실효 권한 엔진(`Evaluation`)이 계산한 권한(`Grant`)에서 위험한 경로를 찾는다.
//! RBAC 평가는 엔진이 하고 여기서는 `Grant::matches`로 요청 몇 개가 허용되는지만 본다.
//!
//! 점검 대상 권한은 주체가 직접 받은 것이다: 기본 그룹(`system:authenticated` 등)에서 물려받은 권한은 그 그룹 주체가 따로 점검받고(`who_can`과 같다),
//! 쿠버네티스·EKS가 만든 내장 바인딩(`system:`·`kubeadm:`·`eks:`로 시작하는 이름)이 준 권한은 기본 구성이라 빼 둔다.
use std::collections::{BTreeMap, BTreeSet, HashSet};

use super::{CheckId, Finding, SaFacts, Severity, Target};
use crate::k8s::access::engine::{BindingRef, Evaluation, Grant, Names, Query, SubjectRules, Via, ANONYMOUS, AUTHENTICATED, MASTERS, UNAUTHENTICATED};
use crate::k8s::access::identity::policy_name;
use crate::k8s::access::rbac::{selector_matches, Binding, Role, RoleKind, Rule, Subject, SubjectKind};
use crate::k8s::rows::KindRef;

const RBAC_GROUP: &str = "rbac.authorization.k8s.io";
/// 증거에 늘어놓는 줄의 최대 수
const EVIDENCE_MAX: usize = 8;
/// 이 접두사로 시작하는 바인딩·역할은 쿠버네티스·EKS가 만든 기본 구성이다
const BUILTIN_PREFIXES: [&str; 3] = ["system:", "kubeadm:", "eks:"];
/// EKS access policy가 가리키는 ClusterRole이라 바인딩이 없어도 쓰인다
const ACCESS_POLICY_ROLES: [&str; 4] = ["cluster-admin", "admin", "edit", "view"];
const BOOTSTRAP_LABEL: &str = "kubernetes.io/bootstrapping";
/// Pod를 만들 수 있는 리소스(만든 Pod가 같은 네임스페이스의 ServiceAccount 토큰을 쓴다)
const POD_CREATORS: [(&str, &str); 8] = [
    ("", "pods"),
    ("apps", "deployments"),
    ("apps", "statefulsets"),
    ("apps", "daemonsets"),
    ("apps", "replicasets"),
    ("batch", "jobs"),
    ("batch", "cronjobs"),
    ("", "replicationcontrollers"),
];

fn builtin_name(name: &str) -> bool {
    BUILTIN_PREFIXES.iter().any(|p| name.starts_with(p))
}

fn builtin_grant(g: &Grant) -> bool {
    g.source.binding.as_ref().is_some_and(|b| builtin_name(&b.name))
}

/// 이 주체의 권한 중 점검할 것
fn own_grants(rules: &SubjectRules) -> Vec<&Grant> {
    rules.grants.iter().filter(|g| !matches!(g.source.via, Via::DefaultGroup { .. }) && !builtin_grant(g)).collect()
}

fn has_star(list: &[String]) -> bool {
    list.iter().any(|v| v == "*")
}

/// 모든 동사·API 그룹·리소스(이름 제한 없음): `cluster-admin`의 규칙
fn full_wildcard(rule: &Rule) -> bool {
    has_star(&rule.verbs) && has_star(&rule.api_groups) && has_star(&rule.resources) && rule.resource_names.is_empty()
}

fn rbac_kind(kind: &str, plural: &str, namespaced: bool) -> KindRef {
    KindRef { group: RBAC_GROUP.into(), version: "v1".into(), kind: kind.into(), plural: plural.into(), namespaced }
}

fn role_kind_ref(kind: RoleKind) -> KindRef {
    match kind {
        RoleKind::Role => rbac_kind("Role", "roles", true),
        RoleKind::ClusterRole => rbac_kind("ClusterRole", "clusterroles", false),
    }
}

fn binding_target(b: &BindingRef) -> Target {
    let namespaced = b.kind == "RoleBinding";
    let kind = if namespaced { rbac_kind("RoleBinding", "rolebindings", true) } else { rbac_kind("ClusterRoleBinding", "clusterrolebindings", false) };
    Target::Object { kind, namespace: b.namespace.clone(), name: b.name.clone() }
}

fn binding_text(b: &BindingRef) -> String {
    match &b.namespace {
        Some(ns) => format!("{} {ns}/{}", b.kind, b.name),
        None => format!("{} {}", b.kind, b.name),
    }
}

fn role_text(kind: RoleKind, name: &str) -> String {
    format!("{} {name}", if kind == RoleKind::Role { "Role" } else { "ClusterRole" })
}

/// 권한이 어디서 왔는지 한 줄
fn path(g: &Grant) -> String {
    let s = &g.source;
    match &s.via {
        Via::AccessPolicy { policy } => format!("access policy {}", policy_name(policy)),
        Via::Builtin { group } => format!("{group} 그룹(API 서버 내장)"),
        via => {
            let mut parts = Vec::new();
            if let Some(b) = &s.binding {
                parts.push(binding_text(b));
            }
            if let Some(r) = &s.role {
                parts.push(role_text(r.kind, &r.name));
            }
            let text = parts.join(" → ");
            match via {
                Via::Group { group } => format!("{text} (그룹 {group})"),
                _ => text,
            }
        }
    }
}

fn subject_text(rules: &SubjectRules) -> String {
    let s = &rules.subject;
    match s.kind {
        SubjectKind::User => format!("사용자 {}", s.name),
        SubjectKind::Group => format!("그룹 {}", s.name),
        SubjectKind::ServiceAccount => format!("ServiceAccount {}/{}", s.namespace.as_deref().unwrap_or(""), s.name),
        SubjectKind::Iam => match &rules.label {
            Some(label) => format!("IAM 주체 {label}({})", s.name),
            None => format!("IAM 주체 {}", s.name),
        },
    }
}

fn subject_namespace(s: &Subject) -> Option<String> {
    if s.kind == SubjectKind::ServiceAccount {
        s.namespace.clone()
    } else {
        None
    }
}

fn limited(mut lines: Vec<String>) -> Vec<String> {
    if lines.len() > EVIDENCE_MAX {
        let more = lines.len() - EVIDENCE_MAX;
        lines.truncate(EVIDENCE_MAX);
        lines.push(format!("…외 {more}개"));
    }
    lines
}

/// 규칙을 `get,list pods`, `* apps/deployments`, `get /metrics` 꼴로
fn rule_text(rule: &Rule) -> String {
    let verbs = rule.verbs.join(",");
    let mut targets: Vec<String> = Vec::new();
    for group in if rule.api_groups.is_empty() { vec![String::new()] } else { rule.api_groups.clone() } {
        for resource in &rule.resources {
            targets.push(if group.is_empty() { resource.clone() } else { format!("{group}/{resource}") });
        }
    }
    targets.extend(rule.non_resource_urls.iter().cloned());
    let names = if rule.resource_names.is_empty() { String::new() } else { format!(" (이름: {})", rule.resource_names.join(", ")) };
    format!("{verbs} {}{names}", targets.join(","))
}

fn allowed<'a>(grants: &[&'a Grant], q: &Query) -> Option<&'a Grant> {
    grants.iter().find(|g| g.matches(q, Names::Strict)).copied()
}

/// 한 주체의 계산 결과를 점검에 쓰기 좋게 정리한 것
struct Profile<'a> {
    rules: &'a SubjectRules,
    grants: Vec<&'a Grant>,
    /// 클러스터 전체에서 모든 권한
    admin_cluster: bool,
    /// 네임스페이스 안에서만 모든 권한(`cluster-admin`을 RoleBinding으로 묶은 경우 등)
    admin_namespaces: BTreeSet<String>,
    /// 클러스터 전체에서 가능한 권한 상승 경로: (점검, 증거)
    escalations: Vec<(CheckId, Vec<String>)>,
}

impl Profile<'_> {
    fn strong(&self) -> bool {
        self.admin_cluster || !self.admin_namespaces.is_empty() || !self.escalations.is_empty()
    }
}

/// `(동사, API 그룹, 리소스, 하위 리소스)` 요청 목록 중 허용되는 것의 증거 줄
fn evidence_of(grants: &[&Grant], requests: &[(&str, &str, &str, Option<&str>)]) -> Vec<String> {
    requests
        .iter()
        .filter_map(|(verb, group, resource, sub)| {
            let mut q = Query::new(verb, group, resource);
            if let Some(sub) = sub {
                q = q.subres(sub);
            }
            let g = allowed(grants, &q)?;
            let what = match sub {
                Some(sub) => format!("{resource}/{sub}"),
                None => resource.to_string(),
            };
            let what = if group.is_empty() { what } else { format!("{group}/{what}") };
            Some(format!("{verb} {what}: {}", path(g)))
        })
        .collect()
}

fn escalations(grants: &[&Grant]) -> Vec<(CheckId, Vec<String>)> {
    let table: [(CheckId, Vec<(&str, &str, &str, Option<&str>)>); 4] = [
        (
            CheckId::EscalateBind,
            vec![
                ("escalate", RBAC_GROUP, "clusterroles", None),
                ("escalate", RBAC_GROUP, "roles", None),
                ("bind", RBAC_GROUP, "clusterroles", None),
                ("bind", RBAC_GROUP, "roles", None),
            ],
        ),
        (
            CheckId::Impersonate,
            vec![
                ("impersonate", "", "users", None),
                ("impersonate", "", "groups", None),
                ("impersonate", "", "serviceaccounts", None),
                ("create", "", "serviceaccounts", Some("token")),
            ],
        ),
        (CheckId::NodesProxy, vec![("get", "", "nodes", Some("proxy")), ("create", "", "nodes", Some("proxy"))]),
        (CheckId::SecretsReadAll, vec![("get", "", "secrets", None), ("list", "", "secrets", None)]),
    ];
    table
        .into_iter()
        .filter_map(|(check, requests)| {
            let evidence = evidence_of(grants, &requests);
            (!evidence.is_empty()).then_some((check, evidence))
        })
        .collect()
}

fn profile(rules: &SubjectRules) -> Profile<'_> {
    let grants = own_grants(rules);
    let mut admin_cluster = false;
    let mut admin_namespaces = BTreeSet::new();
    for g in &grants {
        if !full_wildcard(&g.rule) {
            continue;
        }
        match &g.namespace {
            None => admin_cluster = true,
            Some(ns) => {
                admin_namespaces.insert(ns.clone());
            }
        }
    }
    let escalations = if admin_cluster { vec![] } else { escalations(&grants) };
    Profile { rules, grants, admin_cluster, admin_namespaces, escalations }
}

fn admin_finding(p: &Profile) -> Option<Finding> {
    if !p.admin_cluster && p.admin_namespaces.is_empty() {
        return None;
    }
    let mut evidence: Vec<String> = Vec::new();
    for g in p.grants.iter().filter(|g| full_wildcard(&g.rule)) {
        let scope = g.namespace.as_ref().map_or("클러스터 전체".to_string(), |ns| format!("네임스페이스 {ns}"));
        let line = format!("{scope}: {}", path(g));
        if !evidence.contains(&line) {
            evidence.push(line);
        }
    }
    let who = subject_text(p.rules);
    let is_masters = p.rules.subject.kind == SubjectKind::Group && p.rules.subject.name == MASTERS;
    let (severity, message) = if p.admin_cluster {
        if is_masters {
            (Severity::Low, format!("{who}은 API 서버가 항상 모든 권한을 허용하는 그룹이에요(이 그룹에 누가 속하는지 확인하세요)"))
        } else {
            (Severity::High, format!("{who}에게 클러스터 전체의 모든 권한(cluster-admin 상당)이 있어요"))
        }
    } else {
        (Severity::Medium, format!("{who}에게 네임스페이스 {} 안의 모든 권한이 있어요", p.admin_namespaces.iter().cloned().collect::<Vec<_>>().join(", ")))
    };
    let namespace = subject_namespace(&p.rules.subject).or_else(|| if p.admin_cluster { None } else { p.admin_namespaces.iter().next().cloned() });
    Some(Finding::new(CheckId::AdminSubject, severity, Target::Subject { subject: p.rules.subject.clone() }, namespace, message, limited(evidence)))
}

fn escalation_message(check: CheckId, who: &str) -> String {
    match check {
        CheckId::EscalateBind => format!("{who}이(가) RBAC 역할을 스스로 키우거나 묶을 수 있어요(escalate·bind)"),
        CheckId::Impersonate => format!("{who}이(가) 다른 사용자·그룹·ServiceAccount로 가장하거나 ServiceAccount 토큰을 만들 수 있어요"),
        CheckId::NodesProxy => format!("{who}이(가) kubelet API(nodes/proxy)로 노드의 모든 Pod에 명령을 보낼 수 있어요"),
        _ => format!("{who}이(가) 모든 네임스페이스의 Secret을 읽을 수 있어요"),
    }
}

fn escalation_findings(p: &Profile) -> Vec<Finding> {
    let who = subject_text(p.rules);
    p.escalations
        .iter()
        .map(|(check, evidence)| {
            Finding::new(*check, Severity::High, Target::Subject { subject: p.rules.subject.clone() }, subject_namespace(&p.rules.subject), escalation_message(*check, &who), limited(evidence.clone()))
        })
        .collect()
}

/// 주체의 강한 정도를 설명하는 글(강한 ServiceAccount의 증거)
fn strong_reason(p: &Profile) -> String {
    if p.admin_cluster {
        return "클러스터 전체 모든 권한".into();
    }
    if !p.admin_namespaces.is_empty() {
        return format!("네임스페이스 {} 안 모든 권한", p.admin_namespaces.iter().cloned().collect::<Vec<_>>().join(", "));
    }
    let checks: Vec<&str> = p
        .escalations
        .iter()
        .map(|(c, _)| match c {
            CheckId::EscalateBind => "escalate·bind",
            CheckId::Impersonate => "impersonate",
            CheckId::NodesProxy => "nodes/proxy",
            _ => "모든 Secret 읽기",
        })
        .collect();
    checks.join(", ")
}

/// 이 네임스페이스에서 Pod를 만들 수 있는 가장 먼저 맞는 권한
fn pod_creation<'a>(grants: &[&'a Grant], namespace: &str) -> Option<(&'static str, &'a Grant)> {
    POD_CREATORS.iter().find_map(|(group, resource)| allowed(grants, &Query::new("create", group, resource).ns(namespace)).map(|g| (*resource, g)))
}

/// 강한 ServiceAccount가 있는 네임스페이스에서 Pod를 만들 수 있는 주체: 그 ServiceAccount의 토큰을 마운트한 Pod를 만들어 권한을 얻는다
fn pod_create_findings(profiles: &[Profile]) -> Vec<Finding> {
    let mut strong: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    for p in profiles.iter().filter(|p| p.rules.subject.kind == SubjectKind::ServiceAccount && p.strong()) {
        if let Some(ns) = &p.rules.subject.namespace {
            strong.entry(ns.clone()).or_default().push((p.rules.subject.name.clone(), strong_reason(p)));
        }
    }
    if strong.is_empty() {
        return vec![];
    }
    let mut out = Vec::new();
    for p in profiles.iter().filter(|p| !p.strong()) {
        let mut evidence = Vec::new();
        let mut first_namespace: Option<&str> = None;
        let mut any_user_namespace: Option<&str> = None;
        for (ns, sas) in &strong {
            let Some((resource, grant)) = pod_creation(&p.grants, ns) else { continue };
            let names: Vec<String> = sas.iter().map(|(name, reason)| format!("{ns}/{name}({reason})")).collect();
            evidence.push(format!("네임스페이스 {ns}: {resource} 생성 가능({}) → 강한 ServiceAccount {}", path(grant), names.join(", ")));
            first_namespace.get_or_insert(ns);
            if !super::is_system_namespace(ns) {
                any_user_namespace.get_or_insert(ns);
            }
        }
        let Some(ns) = any_user_namespace.or(first_namespace) else { continue };
        out.push(Finding::new(
            CheckId::PodCreateStrongSa,
            Severity::High,
            Target::Subject { subject: p.rules.subject.clone() },
            Some(ns.to_string()),
            format!("{}이(가) Pod를 만들어 같은 네임스페이스의 강한 ServiceAccount 권한을 쓸 수 있어요", subject_text(p.rules)),
            limited(evidence),
        ));
    }
    out
}

/// 익명·인증된 모든 주체에게 준 권한(기본 구성 제외). 바인딩마다 하나.
fn anonymous_findings(eval: &Evaluation) -> Vec<Finding> {
    struct Hit {
        binding: BindingRef,
        groups: BTreeSet<String>,
        unauthenticated: bool,
        wildcard: bool,
        lines: Vec<String>,
    }
    let mut hits: BTreeMap<String, Hit> = BTreeMap::new();
    let subjects = [(Subject::group(UNAUTHENTICATED), true), (Subject::user(ANONYMOUS), true), (Subject::group(AUTHENTICATED), false)];
    for (subject, unauthenticated) in subjects {
        let rules = eval.rules_of(&subject);
        for g in own_grants(&rules) {
            let Some(binding) = &g.source.binding else { continue };
            let key = binding_text(binding);
            let hit = hits.entry(key).or_insert_with(|| Hit { binding: binding.clone(), groups: BTreeSet::new(), unauthenticated: false, wildcard: false, lines: vec![] });
            hit.groups.insert(subject.name.clone());
            hit.unauthenticated |= unauthenticated;
            hit.wildcard |= full_wildcard(&g.rule);
            let role = g.source.role.as_ref().map(|r| role_text(r.kind, &r.name)).unwrap_or_default();
            hit.lines.push(format!("{} {}: {}", subject.name, role, rule_text(&g.rule)));
        }
    }
    hits.into_values()
        .map(|h| {
            let severity = if h.unauthenticated || h.wildcard { Severity::High } else { Severity::Medium };
            let groups: Vec<String> = h.groups.iter().cloned().collect();
            let message = if h.unauthenticated {
                format!("로그인하지 않은 누구나(익명: {}) 쓸 수 있는 권한이 있어요", groups.join(", "))
            } else {
                format!("인증된 모든 주체({})에게 권한을 줬어요(클러스터에 접속할 수 있는 모든 신원이 쓸 수 있어요)", groups.join(", "))
            };
            let namespace = h.binding.namespace.clone();
            Finding::new(CheckId::AnonymousAccess, severity, binding_target(&h.binding), namespace, message, limited(h.lines))
        })
        .collect()
}

fn is_default_role(role: &Role) -> bool {
    builtin_name(&role.name) || ACCESS_POLICY_ROLES.contains(&role.name.as_str()) || role.labels.get(BOOTSTRAP_LABEL).is_some_and(|v| v == "rbac-defaults")
}

fn unused_roles(eval: &Evaluation) -> Vec<Finding> {
    let rbac = eval.rbac();
    let bindings: Vec<&Binding> = rbac.bindings.iter().chain(rbac.cluster_bindings.iter()).collect();
    // 바인딩이 가리키는 역할(ClusterRole은 네임스페이스 없이, Role은 바인딩의 네임스페이스와 함께)
    let mut used_cluster: HashSet<&str> = HashSet::new();
    let mut used_roles: HashSet<(&str, &str)> = HashSet::new();
    for b in &bindings {
        match b.role_ref.kind {
            RoleKind::ClusterRole => {
                used_cluster.insert(&b.role_ref.name);
            }
            RoleKind::Role => {
                if let Some(ns) = &b.namespace {
                    used_roles.insert((ns, &b.role_ref.name));
                }
            }
        }
    }
    // aggregationRule이 합치는 ClusterRole은 합치는 쪽을 통해 쓰인다
    let selectors: Vec<_> = rbac.cluster_roles.iter().filter_map(|r| r.aggregation.as_ref()).flatten().collect();
    let aggregated = |role: &Role| selectors.iter().any(|s| selector_matches(s, &role.labels));
    let mut out = Vec::new();
    for role in rbac.cluster_roles.iter().filter(|r| !is_default_role(r) && !used_cluster.contains(r.name.as_str()) && !aggregated(r)) {
        out.push(unused_finding(role));
    }
    for role in rbac.roles.iter().filter(|r| !is_default_role(r) && !r.namespace.as_deref().is_some_and(|ns| used_roles.contains(&(ns, r.name.as_str())))) {
        out.push(unused_finding(role));
    }
    out
}

fn unused_finding(role: &Role) -> Finding {
    let kind = if role.namespace.is_some() { RoleKind::Role } else { RoleKind::ClusterRole };
    let name = role_text(kind, &role.name);
    let rules: Vec<String> = role.rules.iter().take(EVIDENCE_MAX).map(rule_text).collect();
    let mut evidence = vec!["이 역할을 가리키는 바인딩이 없어요".to_string()];
    if role.aggregation.is_some() {
        evidence.push("aggregationRule로 다른 ClusterRole의 규칙을 합치는 역할이에요".into());
    }
    evidence.extend(rules);
    Finding::new(
        CheckId::UnusedRole,
        Severity::Low,
        Target::Object { kind: role_kind_ref(kind), namespace: role.namespace.clone(), name: role.name.clone() },
        role.namespace.clone(),
        format!("{name}을(를) 쓰는 바인딩이 없어요"),
        evidence,
    )
}

fn dangling_findings(eval: &Evaluation) -> Vec<Finding> {
    eval.dangling()
        .iter()
        .filter(|d| !builtin_name(&d.binding.name))
        .map(|d| {
            Finding::new(
                CheckId::BindingMissingRole,
                Severity::Low,
                binding_target(&d.binding),
                d.binding.namespace.clone(),
                format!("{}이(가) 없는 {}을(를) 가리켜요", binding_text(&d.binding), role_text(d.role.kind, &d.role.name)),
                vec![
                    format!("roleRef: {}", role_text(d.role.kind, &d.role.name)),
                    "같은 이름의 역할을 나중에 만들면 이 바인딩의 주체가 그 권한을 얻어요".into(),
                ],
            )
        })
        .collect()
}

/// ServiceAccount 주체가 가리키는 ServiceAccount가 없는 바인딩. 목록을 끝까지 읽은 때만 점검한다.
fn missing_subject_findings(eval: &Evaluation, sas: &[SaFacts]) -> Vec<Finding> {
    let existing: HashSet<(&str, &str)> = sas.iter().map(|s| (s.namespace.as_str(), s.name.as_str())).collect();
    let rbac = eval.rbac();
    let cluster = rbac.cluster_bindings.iter().map(|b| (b, true));
    let namespaced = rbac.bindings.iter().map(|b| (b, false));
    cluster
        .chain(namespaced)
        .filter(|(b, _)| !builtin_name(&b.name))
        .filter_map(|(b, is_cluster)| {
            let missing: Vec<String> = b
                .subjects
                .iter()
                .filter(|s| s.kind == SubjectKind::ServiceAccount)
                .filter(|s| !existing.contains(&(s.namespace.as_deref().unwrap_or(""), s.name.as_str())))
                .map(|s| format!("ServiceAccount {}/{}", s.namespace.as_deref().unwrap_or(""), s.name))
                .collect();
            if missing.is_empty() {
                return None;
            }
            let reference = BindingRef { kind: if is_cluster { "ClusterRoleBinding" } else { "RoleBinding" }.into(), namespace: b.namespace.clone(), name: b.name.clone() };
            let mut evidence = missing.clone();
            evidence.push(format!("roleRef: {}", role_text(b.role_ref.kind, &b.role_ref.name)));
            evidence.push("같은 이름의 ServiceAccount를 나중에 만들면 그 권한을 얻어요".into());
            Some(Finding::new(
                CheckId::BindingMissingSubject,
                Severity::Medium,
                binding_target(&reference),
                b.namespace.clone(),
                format!("{}이(가) 없는 주체를 가리켜요: {}", binding_text(&reference), missing.join(", ")),
                limited(evidence),
            ))
        })
        .collect()
}

/// 바인딩에 이름이 나와 기본 그룹 말고 다른 권한을 받은 ServiceAccount((네임스페이스, 이름)). 기본 SA를 자동으로 고쳐도 되는지 가리는 데 쓴다.
pub fn bound_service_accounts(eval: &Evaluation) -> HashSet<(String, String)> {
    eval.subjects()
        .iter()
        .filter(|r| r.subject.kind == SubjectKind::ServiceAccount && r.grants.iter().any(|g| !matches!(g.source.via, Via::DefaultGroup { .. })))
        .map(|r| (r.subject.namespace.clone().unwrap_or_default(), r.subject.name.clone()))
        .collect()
}

/// 권한 점검 전체. `service_accounts`가 None이면(읽지 못했거나 잘림) 없는 주체 점검은 하지 않는다.
pub fn check_permissions(eval: &Evaluation, service_accounts: Option<&[SaFacts]>) -> Vec<Finding> {
    let profiles: Vec<Profile> = eval.subjects().iter().map(profile).collect();
    let mut out: Vec<Finding> = Vec::new();
    out.extend(profiles.iter().filter_map(admin_finding));
    out.extend(profiles.iter().flat_map(escalation_findings));
    out.extend(pod_create_findings(&profiles));
    out.extend(anonymous_findings(eval));
    out.extend(unused_roles(eval));
    out.extend(dangling_findings(eval));
    if let Some(sas) = service_accounts {
        out.extend(missing_subject_findings(eval, sas));
    }
    out
}

#[cfg(test)]
mod tests;
