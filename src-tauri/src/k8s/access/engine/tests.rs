use super::*;
use crate::k8s::access::fixtures::*;
use crate::k8s::access::rbac::Rbac;

fn user(name: &str) -> Subject {
    Subject::user(name)
}

fn sa(ns: &str, name: &str) -> Subject {
    Subject::service_account(ns, name)
}

fn allowed(e: &Evaluation, s: &Subject, q: &Query) -> bool {
    e.can(s, q).allowed
}

fn eval_with(roles: Vec<Role>, bindings: Vec<Binding>, cluster_bindings: Vec<Binding>) -> Evaluation {
    evaluate(rbac_with(vec![], roles, bindings, cluster_bindings), vec![])
}

fn only(extra: Vec<Role>, cluster_bindings: Vec<Binding>) -> Evaluation {
    evaluate(Rbac { cluster_roles: extra, cluster_bindings, ..Rbac::default() }, vec![])
}

// ── 규칙 맞춤 ──

#[test]
fn wildcards_match_any_verb_group_and_resource_including_subresources() {
    let e = only(vec![cluster_role("all", vec![rule(&["*"], &["*"], &["*"])])], vec![clusterbinding("b", "all", vec![user("root")])]);
    for q in [Query::new("get", "", "pods"), Query::new("delete", "apps", "deployments").ns("x"), Query::new("create", "", "pods").subres("exec").ns("x"), Query::new("bind", "rbac.authorization.k8s.io", "clusterroles")] {
        assert!(allowed(&e, &user("root"), &q), "{q:?}");
    }
}

#[test]
fn verbs_groups_and_resources_must_all_match() {
    let e = only(vec![cluster_role("r", vec![rule(&["get", "list"], &["apps"], &["deployments"])])], vec![clusterbinding("b", "r", vec![user("u")])]);
    assert!(allowed(&e, &user("u"), &Query::new("list", "apps", "deployments")));
    assert!(!allowed(&e, &user("u"), &Query::new("delete", "apps", "deployments")));
    assert!(!allowed(&e, &user("u"), &Query::new("get", "", "deployments")), "그룹이 다르다");
    assert!(!allowed(&e, &user("u"), &Query::new("get", "apps", "statefulsets")));
}

#[test]
fn a_plain_resource_does_not_cover_its_subresources_but_star_and_star_slash_sub_do() {
    let q = Query::new("create", "", "pods").subres("exec").ns("n");
    let case = |resources: &[&str]| {
        let e = only(vec![cluster_role("r", vec![rule(&["create"], &[""], resources)])], vec![clusterbinding("b", "r", vec![user("u")])]);
        allowed(&e, &user("u"), &q)
    };
    assert!(!case(&["pods"]));
    assert!(case(&["pods/exec"]));
    assert!(case(&["*/exec"]));
    assert!(case(&["*"]));
    assert!(!case(&["*/attach"]));
    // `pods/*`는 API 서버도 맞추지 않는다
    assert!(!case(&["pods/*"]));
    assert!(!case(&["pods/execx"]));
}

#[test]
fn resource_names_only_match_requests_that_name_the_object() {
    let r = cluster_role("r", vec![named(rule(&["get", "update"], &[""], &["configmaps"]), &["app-config"])]);
    let e = only(vec![r], vec![clusterbinding("b", "r", vec![user("u")])]);
    assert!(allowed(&e, &user("u"), &Query::new("get", "", "configmaps").ns("n").named("app-config")));
    assert!(!allowed(&e, &user("u"), &Query::new("get", "", "configmaps").ns("n").named("other")));
    // 목록처럼 이름이 없는 요청은 맞지 않는다
    assert!(!allowed(&e, &user("u"), &Query::new("get", "", "configmaps").ns("n")));
}

#[test]
fn non_resource_urls_match_exactly_by_prefix_star_or_everything() {
    let url = |patterns: &[&str], verb: &str, path: &str| {
        let e = only(vec![cluster_role("r", vec![urls(&["get"], patterns)])], vec![clusterbinding("b", "r", vec![user("u")])]);
        e.can_non_resource(&user("u"), verb, path).allowed
    };
    assert!(url(&["/healthz"], "get", "/healthz"));
    assert!(!url(&["/healthz"], "get", "/healthz/ping"));
    assert!(url(&["/healthz*"], "get", "/healthz/ping"));
    assert!(url(&["/api*"], "get", "/apis/apps/v1"));
    assert!(url(&["*"], "get", "/anything"));
    assert!(!url(&["/healthz"], "post", "/healthz"));
}

#[test]
fn a_role_binding_never_grants_non_resource_urls_even_through_a_cluster_role() {
    let cr = cluster_role("r", vec![urls(&["get"], &["/healthz"]), rule(&["get"], &[""], &["pods"])]);
    let e = evaluate(Rbac { cluster_roles: vec![cr], bindings: vec![rolebinding("ns", "b", cluster_ref("r"), vec![user("u")])], ..Rbac::default() }, vec![]);
    assert!(!e.can_non_resource(&user("u"), "get", "/healthz").allowed);
    assert!(allowed(&e, &user("u"), &Query::new("get", "", "pods").ns("ns")));
}

// ── 범위 ──

#[test]
fn a_role_binding_applies_only_in_its_namespace_and_never_to_cluster_scope_requests() {
    let r = role("dev", "pod-reader", vec![rule(&["get", "list"], &[""], &["pods"])]);
    let e = eval_with(vec![r], vec![rolebinding("dev", "b", role_ref("pod-reader"), vec![user("u")])], vec![]);
    assert!(allowed(&e, &user("u"), &Query::new("list", "", "pods").ns("dev")));
    assert!(!allowed(&e, &user("u"), &Query::new("list", "", "pods").ns("prod")));
    // `kubectl get pods -A`는 클러스터 범위 요청이다
    assert!(!allowed(&e, &user("u"), &Query::new("list", "", "pods")));
}

#[test]
fn a_role_binding_to_a_cluster_role_is_limited_to_that_namespace() {
    let e = eval_with(vec![], vec![rolebinding("dev", "b", cluster_ref("view"), vec![user("u")])], vec![]);
    assert!(allowed(&e, &user("u"), &Query::new("get", "", "pods").ns("dev")));
    assert!(!allowed(&e, &user("u"), &Query::new("get", "", "pods").ns("prod")));
    let grants = e.can(&user("u"), &Query::new("get", "", "pods").ns("dev")).grants;
    assert_eq!(grants[0].source.binding, Some(BindingRef { kind: "RoleBinding".into(), namespace: Some("dev".into()), name: "b".into() }));
    assert_eq!(grants[0].source.role, Some(RoleView { kind: RoleKind::ClusterRole, namespace: None, name: "view".into() }));
}

#[test]
fn a_cluster_role_binding_applies_to_every_namespace_and_cluster_scope() {
    let e = eval_with(vec![], vec![], vec![clusterbinding("b", "view", vec![user("u")])]);
    assert!(allowed(&e, &user("u"), &Query::new("get", "", "pods").ns("any")));
    assert!(allowed(&e, &user("u"), &Query::new("get", "", "pods")));
}

// ── aggregation ──

#[test]
fn aggregated_rules_come_with_the_cluster_role_that_provided_them() {
    let e = eval_with(vec![], vec![], vec![clusterbinding("b", "view", vec![user("u")])]);
    let decision = e.can(&user("u"), &Query::new("get", "", "pods").subres("log").ns("n"));
    assert!(decision.allowed);
    assert_eq!(decision.grants[0].source.aggregated_from.as_deref(), Some("system:aggregate-to-view"));
    assert!(!allowed(&e, &user("u"), &Query::new("get", "", "secrets").ns("n")), "view는 Secret을 읽지 못한다");
}

#[test]
fn a_new_aggregated_rule_shows_up_for_everyone_bound_to_the_aggregating_role() {
    let widgets = labeled(cluster_role("widget-viewer", vec![rule(&["get", "list"], &["mm.example.com"], &["widgets"])]), "rbac.authorization.k8s.io/aggregate-to-view", "true");
    let e = evaluate(rbac_with(vec![widgets], vec![], vec![], vec![clusterbinding("b", "view", vec![user("u")])]), vec![]);
    assert!(allowed(&e, &user("u"), &Query::new("list", "mm.example.com", "widgets").ns("x")));
}

// ── 기본 그룹과 주체 ──

#[test]
fn everyone_authenticated_inherits_the_system_authenticated_group() {
    let e = eval_with(
        vec![],
        vec![],
        vec![clusterbinding("basic", "view", vec![Subject::group(AUTHENTICATED)]), clusterbinding("other", "view", vec![user("u"), sa("ns", "robot")])],
    );
    let q = Query::new("get", "", "pods").ns("n");
    // 바인딩에 이름이 없는 주체도 물려받는다
    assert!(allowed(&e, &user("stranger"), &q));
    assert!(allowed(&e, &sa("ns", "unlisted"), &q));
    let via = e.can(&user("stranger"), &q).grants[0].source.via.clone();
    assert_eq!(via, Via::DefaultGroup { group: AUTHENTICATED.into() });
    // 그룹 주체 자신의 항목은 직접 받은 것으로 보인다
    assert_eq!(e.can(&Subject::group(AUTHENTICATED), &q).grants[0].source.via, Via::Direct);
}

#[test]
fn service_accounts_inherit_their_namespace_group_but_not_other_namespaces() {
    let creator = cluster_role("pod-creator", vec![rule(&["create"], &[""], &["pods"])]);
    let e = evaluate(
        rbac_with(
            vec![creator],
            vec![],
            vec![],
            vec![clusterbinding("a", "view", vec![Subject::group("system:serviceaccounts:team-a")]), clusterbinding("all", "pod-creator", vec![Subject::group(SERVICE_ACCOUNTS)])],
        ),
        vec![],
    );
    let read = Query::new("get", "", "pods").ns("n");
    let write = Query::new("create", "", "pods").ns("n");
    assert!(allowed(&e, &sa("team-a", "x"), &read));
    assert!(!allowed(&e, &sa("team-b", "x"), &read));
    assert!(allowed(&e, &sa("team-b", "x"), &write));
    assert!(!allowed(&e, &user("human"), &write), "사용자는 ServiceAccount 그룹이 아니다");
    // 사용자 이름이 ServiceAccount 형식이면 ServiceAccount와 같다
    assert!(allowed(&e, &user("system:serviceaccount:team-b:x"), &write));
}

#[test]
fn a_user_subject_named_like_a_service_account_username_matches_that_service_account() {
    let e = eval_with(vec![], vec![], vec![clusterbinding("b", "view", vec![user("system:serviceaccount:ns:robot")])]);
    assert!(allowed(&e, &sa("ns", "robot"), &Query::new("get", "", "pods").ns("x")));
    assert!(!allowed(&e, &sa("ns", "other"), &Query::new("get", "", "pods").ns("x")));
}

#[test]
fn anonymous_gets_the_unauthenticated_group_and_not_the_authenticated_one() {
    let e = eval_with(
        vec![],
        vec![],
        vec![clusterbinding("pub", "view", vec![Subject::group(UNAUTHENTICATED)]), clusterbinding("auth", "edit", vec![Subject::group(AUTHENTICATED)])],
    );
    assert!(allowed(&e, &user(ANONYMOUS), &Query::new("get", "", "pods").ns("n")));
    assert!(!allowed(&e, &user(ANONYMOUS), &Query::new("create", "", "pods").ns("n")));
}

#[test]
fn a_group_subject_does_not_inherit_the_default_groups() {
    let creator = cluster_role("pod-creator", vec![rule(&["create"], &[""], &["pods"])]);
    let e = evaluate(rbac_with(vec![creator], vec![], vec![], vec![clusterbinding("auth", "view", vec![Subject::group(AUTHENTICATED)]), clusterbinding("devs", "pod-creator", vec![Subject::group("devs")])]), vec![]);
    assert!(!allowed(&e, &Subject::group("devs"), &Query::new("get", "", "pods").ns("n")));
    assert!(allowed(&e, &Subject::group("devs"), &Query::new("create", "", "pods").ns("n")));
}

#[test]
fn system_masters_is_allowed_everything_by_the_api_server_itself() {
    let principal = Principal { arn: "arn:aws:iam::1:role/boss".into(), label: None, username: "boss".into(), groups: vec![MASTERS.into()], policies: vec![] };
    let e = evaluate(Rbac::default(), vec![principal]);
    let who = Subject::iam("arn:aws:iam::1:role/boss");
    assert!(allowed(&e, &who, &Query::new("delete", "", "nodes")));
    assert!(e.can_non_resource(&who, "get", "/metrics").allowed);
    assert!(matches!(e.can(&who, &Query::new("get", "", "pods")).grants[0].source.via, Via::Builtin { .. }));
}

// ── 바인딩 ──

#[test]
fn bindings_to_missing_roles_are_reported_and_grant_nothing() {
    let e = evaluate(
        Rbac {
            cluster_roles: vec![cluster_role("here", vec![])],
            cluster_bindings: vec![clusterbinding("lost", "gone", vec![user("u")])],
            bindings: vec![rolebinding("ns", "lost2", role_ref("nope"), vec![user("u")]), rolebinding("ns", "ok", cluster_ref("here"), vec![user("u")])],
            ..Rbac::default()
        },
        vec![],
    );
    let names: Vec<&str> = e.dangling().iter().map(|d| d.binding.name.as_str()).collect();
    assert_eq!(names, vec!["lost", "lost2"]);
    assert!(!allowed(&e, &user("u"), &Query::new("get", "", "pods").ns("ns")));
}

#[test]
fn a_role_ref_to_a_role_is_looked_up_in_the_bindings_own_namespace() {
    let r = role("a", "r", vec![rule(&["get"], &[""], &["pods"])]);
    let e = eval_with(vec![r], vec![rolebinding("b", "bind", role_ref("r"), vec![user("u")])], vec![]);
    assert_eq!(e.dangling().len(), 1, "b에는 Role r이 없다");
    assert!(!allowed(&e, &user("u"), &Query::new("get", "", "pods").ns("a")));
}

#[test]
fn the_same_binding_reaching_a_subject_twice_counts_once() {
    let e = eval_with(vec![], vec![], vec![clusterbinding("b", "view", vec![user("u"), user("u")])]);
    let grants = &e.rules_of(&user("u")).grants;
    let get_pods = grants.iter().filter(|g| g.rule.resources.contains(&"pods".to_string())).count();
    assert_eq!(get_pods, 1);
}

#[test]
fn subjects_come_from_bindings_and_effective_mappings_in_a_stable_order() {
    let principal = Principal { arn: "arn:aws:iam::1:role/dev".into(), label: Some("dev".into()), username: "dev".into(), groups: vec![], policies: vec![] };
    let e = evaluate(rbac_with(vec![], vec![], vec![rolebinding("n", "b", cluster_ref("view"), vec![sa("n", "z"), user("a")])], vec![clusterbinding("c", "view", vec![Subject::group("g")])]), vec![principal]);
    let keys: Vec<String> = e.subjects().iter().map(|s| s.subject.key()).collect();
    assert_eq!(keys, vec!["user:a", "group:g", "sa:n/z", "iam:arn:aws:iam::1:role/dev"]);
}

// ── IAM 주체 ──

fn principal(arn: &str, username: &str, groups: &[&str], policies: Vec<AccessPolicy>) -> Principal {
    Principal { arn: arn.into(), label: None, username: username.into(), groups: groups.iter().map(|g| g.to_string()).collect(), policies }
}

#[test]
fn an_iam_principal_gets_what_its_mapped_user_and_groups_are_bound_to() {
    let p = principal("arn:aws:iam::1:role/dev", "dev-user", &["devs"], vec![]);
    let e = evaluate(rbac_with(vec![], vec![], vec![], vec![clusterbinding("g", "view", vec![Subject::group("devs")]), clusterbinding("u", "edit", vec![user("dev-user")])]), vec![p]);
    let who = Subject::iam("arn:aws:iam::1:role/dev");
    let read = e.can(&who, &Query::new("get", "", "pods").ns("n"));
    assert!(read.allowed);
    assert!(read.grants.iter().any(|g| g.source.via == Via::Group { group: "devs".into() }));
    assert!(e.can(&who, &Query::new("create", "", "pods").ns("n")).grants.iter().any(|g| g.source.via == Via::Direct));
}

#[test]
fn a_session_name_template_matches_user_bindings_that_fit_and_marks_them_session_dependent() {
    let p = principal("arn:aws:iam::1:role/ops", "ops:{{SessionName}}", &[], vec![]);
    let e = evaluate(rbac_with(vec![], vec![], vec![], vec![clusterbinding("a", "view", vec![user("ops:alice")]), clusterbinding("b", "edit", vec![user("other:bob")])]), vec![p]);
    let who = Subject::iam("arn:aws:iam::1:role/ops");
    let d = e.can(&who, &Query::new("get", "", "pods").ns("n"));
    assert!(d.allowed && d.grants[0].source.session_dependent);
    assert!(!allowed(&e, &who, &Query::new("create", "", "pods").ns("n")));
}

#[test]
fn template_matching_treats_placeholders_as_anything() {
    assert!(template_matches("ops:{{SessionName}}", "ops:alice"));
    assert!(template_matches("ops:{{SessionName}}", "ops:"));
    assert!(!template_matches("ops:{{SessionName}}", "ops"));
    assert!(template_matches("a-{{X}}-b-{{Y}}-c", "a-1-b-2-c"));
    assert!(!template_matches("a-{{X}}-b-{{Y}}-c", "a-1-c-2-b"));
    assert!(template_matches("plain", "plain") && !template_matches("plain", "plainer"));
}

fn policy(name: &str, scope: PolicyScope) -> AccessPolicy {
    AccessPolicy { policy_arn: format!("arn:aws:eks::aws:cluster-access-policy/{name}"), scope }
}

#[test]
fn access_policies_become_the_mapped_cluster_role_in_their_scope() {
    let p = principal(
        "arn:aws:iam::1:role/a",
        "a",
        &[],
        vec![policy("AmazonEKSViewPolicy", PolicyScope::Cluster), policy("AmazonEKSEditPolicy", PolicyScope::Namespaces { namespaces: vec!["dev".into(), "qa".into()] })],
    );
    let e = evaluate(rbac_with(vec![], vec![], vec![], vec![]), vec![p]);
    let who = Subject::iam("arn:aws:iam::1:role/a");
    assert!(allowed(&e, &who, &Query::new("get", "", "pods").ns("prod")), "view는 클러스터 전체");
    assert!(allowed(&e, &who, &Query::new("create", "", "pods").ns("dev")));
    assert!(allowed(&e, &who, &Query::new("create", "", "pods").ns("qa")));
    assert!(!allowed(&e, &who, &Query::new("create", "", "pods").ns("prod")), "edit는 dev·qa에만");
    assert!(!allowed(&e, &who, &Query::new("create", "", "pods")), "네임스페이스 범위는 클러스터 요청에 맞지 않는다");
    let grant = &e.can(&who, &Query::new("create", "", "pods").ns("dev")).grants[0];
    assert_eq!(grant.source.via, Via::AccessPolicy { policy: "arn:aws:eks::aws:cluster-access-policy/AmazonEKSEditPolicy".into() });
    assert_eq!(grant.source.role.as_ref().unwrap().name, "edit");
}

#[test]
fn cluster_admin_policy_is_everything_and_unknown_policies_are_reported_not_guessed() {
    let p = principal(
        "arn:aws:iam::1:role/a",
        "a",
        &[],
        vec![policy("AmazonEKSClusterAdminPolicy", PolicyScope::Cluster), policy("AmazonEKSAdminViewPolicy", PolicyScope::Cluster)],
    );
    let e = evaluate(rbac_with(vec![], vec![], vec![], vec![]), vec![p]);
    let who = Subject::iam("arn:aws:iam::1:role/a");
    assert!(allowed(&e, &who, &Query::new("delete", "", "nodes")));
    assert!(e.can_non_resource(&who, "get", "/healthz").allowed);
    assert_eq!(e.rules_of(&who).unevaluated, vec!["arn:aws:eks::aws:cluster-access-policy/AmazonEKSAdminViewPolicy".to_string()]);
}

#[test]
fn a_policy_whose_cluster_role_is_missing_is_reported() {
    let p = principal("arn:aws:iam::1:role/a", "a", &[], vec![policy("AmazonEKSViewPolicy", PolicyScope::Cluster)]);
    let e = evaluate(Rbac::default(), vec![p]);
    let who = Subject::iam("arn:aws:iam::1:role/a");
    assert!(!allowed(&e, &who, &Query::new("get", "", "pods").ns("n")));
    assert!(e.rules_of(&who).unevaluated[0].contains("ClusterRole view"));
}

// ── who-can ──

#[test]
fn who_can_lists_subjects_with_paths_and_leaves_default_group_inheritance_to_the_group() {
    let p = principal("arn:aws:iam::1:role/dev", "dev", &["devs"], vec![]);
    let e = evaluate(
        rbac_with(
            vec![],
            vec![],
            vec![rolebinding("n", "rb", cluster_ref("edit"), vec![user("alice")])],
            vec![clusterbinding("auth", "view", vec![Subject::group(AUTHENTICATED)]), clusterbinding("devs", "edit", vec![Subject::group("devs")])],
        ),
        vec![p],
    );
    let q = Query::new("create", "", "pods").ns("n");
    let who: Vec<String> = e.who_can(&q).iter().map(|w| w.subject.key()).collect();
    assert_eq!(who, vec!["user:alice", "group:devs", "iam:arn:aws:iam::1:role/dev"]);
    // system:authenticated의 view는 읽기만: 읽기에는 그 그룹만 나오고 모든 사용자를 줄마다 늘어놓지 않는다
    let readers: Vec<String> = e.who_can(&Query::new("get", "", "pods").ns("n")).iter().map(|w| w.subject.key()).collect();
    assert!(readers.contains(&"group:system:authenticated".to_string()));
    assert_eq!(readers.iter().filter(|k| k.starts_with("user:")).count(), 1, "{readers:?}");
}

#[test]
fn who_can_respects_the_namespace_and_the_name() {
    let r = role("n", "r", vec![named(rule(&["get"], &[""], &["secrets"]), &["db"])]);
    let e = eval_with(vec![r], vec![rolebinding("n", "b", role_ref("r"), vec![user("u")])], vec![]);
    assert_eq!(e.who_can(&Query::new("get", "", "secrets").ns("n").named("db")).len(), 1);
    assert!(e.who_can(&Query::new("get", "", "secrets").ns("n").named("other")).is_empty());
    assert!(e.who_can(&Query::new("get", "", "secrets").ns("m").named("db")).is_empty());
}

#[test]
fn can_computes_unlisted_subjects_on_the_fly() {
    let e = eval_with(vec![], vec![], vec![clusterbinding("a", "view", vec![Subject::group(SERVICE_ACCOUNTS)])]);
    assert!(allowed(&e, &sa("brand", "new"), &Query::new("get", "", "pods").ns("x")));
    assert!(e.subjects().iter().all(|s| s.subject != sa("brand", "new")));
}

#[test]
fn identity_of_reports_the_user_and_groups_including_the_defaults() {
    let e = evaluate(Rbac::default(), vec![principal("arn:aws:iam::1:role/a", "a-user", &["g1"], vec![])]);
    let (user, groups) = e.identity_of(&Subject::iam("arn:aws:iam::1:role/a"));
    assert_eq!(user.as_deref(), Some("a-user"));
    assert_eq!(groups, vec!["g1".to_string(), AUTHENTICATED.to_string()]);
    let (user, groups) = e.identity_of(&sa("ns", "x"));
    assert_eq!(user.as_deref(), Some("system:serviceaccount:ns:x"));
    assert_eq!(groups, vec![SERVICE_ACCOUNTS.to_string(), "system:serviceaccounts:ns".to_string(), AUTHENTICATED.to_string()]);
}
