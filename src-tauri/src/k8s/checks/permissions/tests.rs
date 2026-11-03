use super::*;
use crate::k8s::access::engine::{AccessPolicy, Principal};
use crate::k8s::checks::testkit::*;

const ADMIN_POLICY: &str = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy";

fn check(e: &Evaluation) -> Vec<Finding> {
    check_permissions(e, None)
}

fn who(f: &Finding) -> String {
    match &f.target {
        Target::Subject { subject } => subject.key(),
        Target::Object { kind, namespace, name } => format!("{}:{}/{}", kind.kind, namespace.as_deref().unwrap_or(""), name),
        Target::Aws { name, .. } => name.clone(),
    }
}

fn subjects_of(findings: &[Finding], id: CheckId) -> Vec<String> {
    of(findings, id).into_iter().map(who).collect()
}

fn sa_facts(namespace: &str, name: &str) -> SaFacts {
    SaFacts { namespace: namespace.into(), name: name.into(), automount: None, bound: None }
}

// ── cluster-admin / system:masters ──

#[test]
fn a_user_bound_to_cluster_admin_is_high_with_the_binding_path() {
    let e = eval(vec![], vec![], vec![], vec![clusterbinding("alice-admin", "cluster-admin", vec![user("alice")])]);
    let found = check(&e);
    let admins = of(&found, CheckId::AdminSubject);
    assert_eq!(admins.len(), 1);
    assert_eq!(who(admins[0]), "user:alice");
    assert_eq!(admins[0].severity, Severity::High);
    assert!(admins[0].evidence[0].contains("ClusterRoleBinding alice-admin → ClusterRole cluster-admin"), "{:?}", admins[0].evidence);
}

#[test]
fn cluster_admin_bound_by_a_rolebinding_is_only_medium_and_names_the_namespace() {
    let e = eval(vec![], vec![], vec![rolebinding("dev", "dev-admin", cluster_ref("cluster-admin"), vec![user("bob")])], vec![]);
    let found = check(&e);
    let admins = of(&found, CheckId::AdminSubject);
    assert_eq!(admins.len(), 1);
    assert_eq!(admins[0].severity, Severity::Medium);
    assert!(admins[0].message.contains("네임스페이스 dev"), "{}", admins[0].message);
    assert_eq!(admins[0].namespace.as_deref(), Some("dev"));
}

#[test]
fn the_system_masters_group_is_listed_as_low_because_it_is_the_default() {
    let e = eval(vec![], vec![], vec![], vec![clusterbinding("cluster-admin", "cluster-admin", vec![Subject::group("system:masters")])]);
    let found = check(&e);
    let admins = of(&found, CheckId::AdminSubject);
    assert_eq!(admins.len(), 1);
    assert_eq!(admins[0].severity, Severity::Low);
    assert!(admins[0].message.contains("system:masters"));
}

#[test]
fn bindings_created_by_kubernetes_or_eks_are_not_reported() {
    let e = eval(
        vec![],
        vec![],
        vec![],
        vec![
            clusterbinding("kubeadm:cluster-admins", "cluster-admin", vec![Subject::group("kubeadm:cluster-admins")]),
            clusterbinding("system:node-admin", "cluster-admin", vec![user("system:admin")]),
            clusterbinding("eks:something", "cluster-admin", vec![sa("kube-system", "eks-thing")]),
        ],
    );
    assert!(of(&check(&e), CheckId::AdminSubject).is_empty());
}

#[test]
fn an_iam_principal_with_the_cluster_admin_access_policy_is_high_and_names_the_policy() {
    let arn = "arn:aws:iam::1:role/ops";
    let principal = Principal {
        arn: arn.into(),
        label: Some("ops".into()),
        username: "ops".into(),
        groups: vec![],
        policies: vec![AccessPolicy { policy_arn: ADMIN_POLICY.into(), scope: crate::k8s::access::engine::PolicyScope::Cluster }],
    };
    let e = eval_with(vec![], vec![], vec![], vec![], vec![principal]);
    let found = check(&e);
    let admins = of(&found, CheckId::AdminSubject);
    assert_eq!(admins.len(), 1);
    assert_eq!(who(admins[0]), format!("iam:{arn}"));
    assert!(admins[0].evidence[0].contains("access policy AmazonEKSClusterAdminPolicy"), "{:?}", admins[0].evidence);
}

#[test]
fn an_iam_principal_mapped_into_system_masters_is_high_via_the_builtin_group() {
    let arn = "arn:aws:iam::1:role/legacy";
    let principal = Principal { arn: arn.into(), label: None, username: "legacy".into(), groups: vec!["system:masters".into()], policies: vec![] };
    let e = eval_with(vec![], vec![], vec![], vec![], vec![principal]);
    let found = check(&e);
    let admins = of(&found, CheckId::AdminSubject);
    assert_eq!(admins.len(), 1);
    assert_eq!(admins[0].severity, Severity::High);
    assert!(admins[0].evidence[0].contains("API 서버 내장"));
}

#[test]
fn a_service_account_admin_carries_its_namespace_for_the_system_filter() {
    let e = eval(vec![], vec![], vec![], vec![clusterbinding("ci-admin", "cluster-admin", vec![sa("kube-system", "ci")])]);
    let found = check(&e);
    let admins = of(&found, CheckId::AdminSubject);
    assert_eq!(admins[0].namespace.as_deref(), Some("kube-system"));
    assert!(admins[0].system);
}

// ── 권한 상승 ──

fn single(name: &str, rules: Vec<Rule>, who: Subject) -> Evaluation {
    eval(vec![cluster_role(name, rules)], vec![], vec![], vec![clusterbinding("b", name, vec![who])])
}

#[test]
fn bind_or_escalate_on_roles_is_an_escalation_path() {
    let e = single("binder", vec![rule(&["bind"], &["rbac.authorization.k8s.io"], &["clusterroles"])], user("carol"));
    assert_eq!(subjects_of(&check(&e), CheckId::EscalateBind), ["user:carol"]);
    let e = single("escalator", vec![rule(&["escalate"], &["rbac.authorization.k8s.io"], &["roles"])], user("carol"));
    assert_eq!(subjects_of(&check(&e), CheckId::EscalateBind), ["user:carol"]);
}

#[test]
fn a_bind_limited_to_named_roles_is_not_an_open_escalation() {
    let e = single("binder", vec![named(rule(&["bind"], &["rbac.authorization.k8s.io"], &["clusterroles"]), &["view"])], user("carol"));
    assert!(of(&check(&e), CheckId::EscalateBind).is_empty());
}

#[test]
fn impersonation_and_token_creation_both_count_as_impersonate() {
    let e = single("imp", vec![rule(&["impersonate"], &[""], &["users", "groups"])], user("dave"));
    assert_eq!(subjects_of(&check(&e), CheckId::Impersonate), ["user:dave"]);
    let e = single("tok", vec![rule(&["create"], &[""], &["serviceaccounts/token"])], user("dave"));
    let found = check(&e);
    assert_eq!(subjects_of(&found, CheckId::Impersonate), ["user:dave"]);
    assert!(of(&found, CheckId::Impersonate)[0].evidence[0].contains("serviceaccounts/token"));
}

#[test]
fn nodes_proxy_and_cluster_wide_secret_reads_are_flagged() {
    let e = single("proxy", vec![rule(&["get"], &[""], &["nodes/proxy"])], user("erin"));
    assert_eq!(subjects_of(&check(&e), CheckId::NodesProxy), ["user:erin"]);
    let e = single("secrets", vec![rule(&["list"], &[""], &["secrets"])], user("erin"));
    assert_eq!(subjects_of(&check(&e), CheckId::SecretsReadAll), ["user:erin"]);
}

#[test]
fn reading_secrets_in_one_namespace_is_not_reading_all_secrets() {
    let e = eval(vec![], vec![], vec![rolebinding("dev", "dev-edit", cluster_ref("edit"), vec![user("frank")])], vec![]);
    assert!(of(&check(&e), CheckId::SecretsReadAll).is_empty());
    // 같은 edit이어도 ClusterRoleBinding이면 모든 네임스페이스다
    let e = eval(vec![], vec![], vec![], vec![clusterbinding("all-edit", "edit", vec![user("frank")])]);
    assert_eq!(subjects_of(&check(&e), CheckId::SecretsReadAll), ["user:frank"]);
}

#[test]
fn a_cluster_admin_is_reported_once_as_admin_not_once_per_escalation_path() {
    let e = eval(vec![], vec![], vec![], vec![clusterbinding("root", "cluster-admin", vec![user("root")])]);
    let found = check(&e);
    assert_eq!(subjects_of(&found, CheckId::AdminSubject), ["user:root"]);
    for id in [CheckId::EscalateBind, CheckId::Impersonate, CheckId::NodesProxy, CheckId::SecretsReadAll] {
        assert!(of(&found, id).is_empty(), "{id:?}");
    }
}

#[test]
fn one_subject_with_two_paths_gets_two_findings_with_distinct_ids() {
    let e = single(
        "both",
        vec![rule(&["impersonate"], &[""], &["users"]), rule(&["get"], &[""], &["nodes/proxy"])],
        user("gina"),
    );
    let found = check(&e);
    let ids: Vec<&str> = found.iter().map(|f| f.id.as_str()).collect();
    assert_eq!(ids.len(), 2);
    assert_ne!(ids[0], ids[1]);
}

// ── Pod 생성 + 강한 ServiceAccount ──

fn strong_sa_cluster(extra_bindings: Vec<Binding>) -> Evaluation {
    let mut bindings = vec![rolebinding("ci", "runner-edit", cluster_ref("edit"), vec![user("dev")])];
    bindings.extend(extra_bindings);
    eval(vec![], vec![], bindings, vec![clusterbinding("runner-admin", "cluster-admin", vec![sa("ci", "runner")])])
}

#[test]
fn someone_who_can_create_pods_next_to_a_cluster_admin_service_account_is_flagged() {
    let found = check(&strong_sa_cluster(vec![]));
    let hits = of(&found, CheckId::PodCreateStrongSa);
    assert_eq!(hits.len(), 1);
    assert_eq!(who(hits[0]), "user:dev");
    assert_eq!(hits[0].severity, Severity::High);
    assert_eq!(hits[0].namespace.as_deref(), Some("ci"));
    assert!(hits[0].evidence[0].contains("ci/runner(클러스터 전체 모든 권한)"), "{:?}", hits[0].evidence);
    assert!(hits[0].evidence[0].contains("pods 생성 가능"));
}

#[test]
fn the_same_permission_in_another_namespace_is_not_a_path() {
    let e = eval(
        vec![],
        vec![],
        vec![rolebinding("other", "other-edit", cluster_ref("edit"), vec![user("dev")])],
        vec![clusterbinding("runner-admin", "cluster-admin", vec![sa("ci", "runner")])],
    );
    assert!(of(&check(&e), CheckId::PodCreateStrongSa).is_empty());
}

#[test]
fn read_only_access_in_the_namespace_cannot_create_pods() {
    let e = eval(
        vec![],
        vec![],
        vec![rolebinding("ci", "viewer", cluster_ref("view"), vec![user("viewer")])],
        vec![clusterbinding("runner-admin", "cluster-admin", vec![sa("ci", "runner")])],
    );
    assert!(of(&check(&e), CheckId::PodCreateStrongSa).is_empty());
}

#[test]
fn deployments_count_as_a_way_to_run_pods_and_the_strong_service_account_itself_is_not_flagged() {
    let e = eval(
        vec![cluster_role("deployer", vec![rule(&["create"], &["apps"], &["deployments"])])],
        vec![],
        vec![rolebinding("ci", "deploy", cluster_ref("deployer"), vec![user("deployer"), sa("ci", "runner")])],
        vec![clusterbinding("runner-admin", "cluster-admin", vec![sa("ci", "runner")])],
    );
    let found = check(&e);
    assert_eq!(subjects_of(&found, CheckId::PodCreateStrongSa), ["user:deployer"]);
}

#[test]
fn a_service_account_strong_only_through_secret_reads_also_counts_as_strong() {
    let e = eval(
        vec![cluster_role("secret-reader", vec![rule(&["get", "list"], &[""], &["secrets"])])],
        vec![],
        vec![rolebinding("ci", "runner-edit", cluster_ref("edit"), vec![user("dev")])],
        vec![clusterbinding("reader", "secret-reader", vec![sa("ci", "reader")])],
    );
    let found = check(&e);
    // edit도 Pod를 만들 수 있는 사용자(dev)는 클러스터 전체 Secret을 읽는 SA의 토큰을 쓸 수 있다
    assert_eq!(subjects_of(&found, CheckId::PodCreateStrongSa), ["user:dev"]);
    assert!(of(&found, CheckId::PodCreateStrongSa)[0].evidence[0].contains("모든 Secret 읽기"));
}

#[test]
fn an_admin_of_the_namespace_does_not_need_a_pod_to_reach_its_service_account() {
    let e = eval(
        vec![],
        vec![],
        vec![rolebinding("ci", "ns-admin", cluster_ref("cluster-admin"), vec![user("owner")])],
        vec![clusterbinding("runner-admin", "cluster-admin", vec![sa("ci", "runner")])],
    );
    assert!(of(&check(&e), CheckId::PodCreateStrongSa).is_empty());
}

// ── 익명·인증된 모든 주체 ──

#[test]
fn permissions_given_to_unauthenticated_users_are_high() {
    let e = eval(
        vec![cluster_role("peek", vec![rule(&["get", "list"], &[""], &["configmaps"])])],
        vec![],
        vec![],
        vec![clusterbinding("peek-anon", "peek", vec![Subject::group("system:unauthenticated")])],
    );
    let found = check(&e);
    let hits = of(&found, CheckId::AnonymousAccess);
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].severity, Severity::High);
    assert_eq!(who(hits[0]), "ClusterRoleBinding:/peek-anon");
    assert!(hits[0].evidence[0].contains("get,list configmaps"), "{:?}", hits[0].evidence);
}

#[test]
fn permissions_given_to_the_anonymous_user_count_like_unauthenticated() {
    let e = eval(
        vec![cluster_role("peek", vec![rule(&["get"], &[""], &["pods"])])],
        vec![],
        vec![],
        vec![clusterbinding("peek-anon", "peek", vec![user("system:anonymous")])],
    );
    assert_eq!(subjects_of(&check(&e), CheckId::AnonymousAccess), ["ClusterRoleBinding:/peek-anon"]);
}

#[test]
fn permissions_given_to_every_authenticated_identity_are_medium_unless_they_are_everything() {
    let e = eval(
        vec![cluster_role("peek", vec![rule(&["get"], &[""], &["configmaps"])])],
        vec![],
        vec![],
        vec![clusterbinding("peek-all", "peek", vec![Subject::group("system:authenticated")])],
    );
    assert_eq!(of(&check(&e), CheckId::AnonymousAccess)[0].severity, Severity::Medium);
    let e = eval(vec![], vec![], vec![], vec![clusterbinding("oops", "cluster-admin", vec![Subject::group("system:authenticated")])]);
    assert_eq!(of(&check(&e), CheckId::AnonymousAccess)[0].severity, Severity::High);
}

#[test]
fn the_default_public_bindings_are_not_reported() {
    let e = eval(
        vec![cluster_role("system:public-info-viewer", vec![rule(&["get"], &[""], &["configmaps"])]), cluster_role("system:basic-user", vec![rule(&["create"], &["authorization.k8s.io"], &["selfsubjectaccessreviews"])])],
        vec![],
        vec![],
        vec![
            clusterbinding("system:public-info-viewer", "system:public-info-viewer", vec![Subject::group("system:authenticated"), Subject::group("system:unauthenticated")]),
            clusterbinding("system:basic-user", "system:basic-user", vec![Subject::group("system:authenticated")]),
        ],
    );
    assert!(of(&check(&e), CheckId::AnonymousAccess).is_empty());
}

#[test]
fn a_rolebinding_to_authenticated_reports_the_binding_with_its_namespace() {
    let e = eval(vec![], vec![], vec![rolebinding("dev", "dev-all", cluster_ref("view"), vec![Subject::group("system:authenticated")])], vec![]);
    let found = check(&e);
    let hits = of(&found, CheckId::AnonymousAccess);
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].namespace.as_deref(), Some("dev"));
    assert_eq!(who(hits[0]), "RoleBinding:dev/dev-all");
}

#[test]
fn one_binding_for_both_groups_is_one_finding_listing_both() {
    let e = eval(
        vec![cluster_role("peek", vec![rule(&["get"], &[""], &["pods"])])],
        vec![],
        vec![],
        vec![clusterbinding("peek-everyone", "peek", vec![Subject::group("system:authenticated"), Subject::group("system:unauthenticated")])],
    );
    let found = check(&e);
    let hits = of(&found, CheckId::AnonymousAccess);
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].severity, Severity::High);
    assert!(hits[0].message.contains("system:unauthenticated"));
}

// ── 쓰이지 않는 역할 ──

#[test]
fn a_role_without_any_binding_is_unused_and_a_bound_one_is_not() {
    let e = eval(
        vec![cluster_role("orphan-cluster", vec![rule(&["get"], &[""], &["pods"])]), cluster_role("used-cluster", vec![rule(&["get"], &[""], &["pods"])])],
        vec![role("dev", "orphan", vec![rule(&["get"], &[""], &["pods"])]), role("dev", "used", vec![rule(&["get"], &[""], &["pods"])])],
        vec![rolebinding("dev", "b", role_ref("used"), vec![user("u")])],
        vec![clusterbinding("c", "used-cluster", vec![user("u")])],
    );
    let found = check(&e);
    assert_eq!(subjects_of(&found, CheckId::UnusedRole), ["ClusterRole:/orphan-cluster", "Role:dev/orphan"]);
    assert!(of(&found, CheckId::UnusedRole).iter().all(|f| f.severity == Severity::Low));
}

#[test]
fn a_role_is_used_only_by_bindings_in_its_own_namespace() {
    let e = eval(vec![], vec![role("a", "shared-name", vec![])], vec![rolebinding("b", "bind", role_ref("shared-name"), vec![user("u")])], vec![]);
    assert_eq!(subjects_of(&check(&e), CheckId::UnusedRole), ["Role:a/shared-name"]);
}

#[test]
fn a_cluster_role_used_through_a_rolebinding_is_used() {
    let e = eval(
        vec![cluster_role("team-read", vec![rule(&["get"], &[""], &["pods"])])],
        vec![],
        vec![rolebinding("dev", "b", cluster_ref("team-read"), vec![user("u")])],
        vec![],
    );
    assert!(of(&check(&e), CheckId::UnusedRole).is_empty());
}

#[test]
fn cluster_roles_merged_by_an_aggregation_rule_count_as_used() {
    let mut part = cluster_role("part", vec![rule(&["get"], &[""], &["pods"])]);
    part.labels.insert("team/agg".into(), "true".into());
    let aggregator = Role {
        aggregation: Some(vec![crate::k8s::access::rbac::Selector { match_labels: BTreeMap::from([("team/agg".to_string(), "true".to_string())]), match_expressions: vec![] }]),
        ..cluster_role("agg", vec![])
    };
    let e = eval(vec![part, aggregator], vec![], vec![], vec![clusterbinding("c", "agg", vec![user("u")])]);
    assert!(of(&check(&e), CheckId::UnusedRole).is_empty());
}

#[test]
fn built_in_and_default_roles_are_never_reported_as_unused() {
    let mut labelled = cluster_role("custom-default", vec![]);
    labelled.labels.insert("kubernetes.io/bootstrapping".into(), "rbac-defaults".into());
    let e = eval(vec![cluster_role("system:thing", vec![]), cluster_role("eks:thing", vec![]), labelled], vec![role("kube-system", "system:leader-locking", vec![])], vec![], vec![]);
    // 기본 집합(cluster-admin·edit·view)도 바인딩이 없지만 EKS access policy가 쓴다
    assert!(of(&check(&e), CheckId::UnusedRole).is_empty());
}

// ── 없는 역할·주체를 가리키는 바인딩 ──

#[test]
fn a_binding_to_a_missing_role_is_found_and_explains_the_risk() {
    let e = eval(vec![], vec![], vec![rolebinding("dev", "ghost", role_ref("gone"), vec![user("u")])], vec![clusterbinding("ghost-c", "gone-cluster", vec![user("u")])]);
    let found = check(&e);
    assert_eq!(subjects_of(&found, CheckId::BindingMissingRole), ["ClusterRoleBinding:/ghost-c", "RoleBinding:dev/ghost"]);
    assert!(of(&found, CheckId::BindingMissingRole)[0].evidence.iter().any(|l| l.contains("나중에 만들면")));
}

#[test]
fn a_built_in_binding_to_a_missing_role_is_not_reported() {
    let e = eval(vec![], vec![], vec![], vec![clusterbinding("system:controller:x", "system:controller:x", vec![user("u")])]);
    assert!(of(&check(&e), CheckId::BindingMissingRole).is_empty());
}

#[test]
fn a_binding_to_a_service_account_that_does_not_exist_is_medium() {
    let e = eval(vec![], vec![], vec![rolebinding("dev", "b", cluster_ref("view"), vec![sa("dev", "alive"), sa("dev", "gone")])], vec![]);
    let sas = [sa_facts("dev", "alive")];
    let found = check_permissions(&e, Some(&sas));
    let hits = of(&found, CheckId::BindingMissingSubject);
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].severity, Severity::Medium);
    assert!(hits[0].message.contains("dev/gone") && !hits[0].message.contains("dev/alive"), "{}", hits[0].message);
}

#[test]
fn without_a_complete_service_account_list_missing_subjects_are_not_judged() {
    let e = eval(vec![], vec![], vec![rolebinding("dev", "b", cluster_ref("view"), vec![sa("dev", "gone")])], vec![]);
    assert!(of(&check_permissions(&e, None), CheckId::BindingMissingSubject).is_empty());
}

#[test]
fn users_and_groups_cannot_be_checked_for_existence() {
    let e = eval(vec![], vec![], vec![], vec![clusterbinding("c", "view", vec![user("nobody"), Subject::group("nobody-group")])]);
    assert!(of(&check_permissions(&e, Some(&[])), CheckId::BindingMissingSubject).is_empty());
}

// ── 기본 SA에 붙은 권한 ──

#[test]
fn only_service_accounts_with_non_default_grants_are_bound() {
    let e = eval(vec![], vec![], vec![rolebinding("dev", "b", cluster_ref("view"), vec![sa("dev", "app")])], vec![]);
    let bound = bound_service_accounts(&e);
    assert!(bound.contains(&("dev".to_string(), "app".to_string())));
    assert!(!bound.contains(&("dev".to_string(), "default".to_string())));
}

#[test]
fn a_binding_to_the_service_accounts_group_is_not_a_binding_of_one_service_account() {
    let e = eval(vec![], vec![], vec![], vec![clusterbinding("all-sa", "view", vec![Subject::group("system:serviceaccounts")])]);
    assert!(bound_service_accounts(&e).is_empty());
}
