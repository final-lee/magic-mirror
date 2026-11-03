use super::*;
use crate::k8s::access::engine::{evaluate, AccessPolicy, PolicyScope};
use crate::k8s::access::rbac::{Binding, Rbac, Subject};
use crate::k8s::change::{ApiCall, ChangeObject, Preview};
use crate::k8s::rbac::tests::fixtures::*;
use crate::k8s::rbac::tests::{binding, change, entry_change, user, ARN};
use crate::k8s::rbac::{access_entry_kind, PolicySpec, ScopeSpec};
use crate::k8s::review::IdentitySource;

fn eval(roles: Vec<crate::k8s::access::rbac::Role>, bindings: Vec<Binding>, cluster_bindings: Vec<Binding>, principals: Vec<Principal>) -> Evaluation {
    let rbac: Rbac = rbac_with(roles, vec![], bindings, cluster_bindings);
    evaluate(rbac, principals)
}

fn alice() -> Subject {
    Subject::user("alice")
}

fn pods_reader() -> crate::k8s::access::rbac::Role {
    cluster_role("pods-reader", vec![rule(&["get", "list"], &[""], &["pods"])])
}

fn dev_principal() -> Principal {
    Principal { arn: ARN.into(), label: Some("dev".into()), username: "dev-user".into(), groups: vec!["devs".into()], policies: vec![] }
}

#[test]
fn binding_a_user_to_cluster_admin_flags_the_user_as_escalated() {
    let before = eval(vec![], vec![], vec![], vec![]);
    let after = eval(vec![], vec![], vec![clusterbinding("b", "cluster-admin", vec![alice()])], vec![]);
    let effect = effect_between(&before, &after, None);
    assert_eq!(effect.escalated, vec![alice()]);
    assert_eq!(effect.total, 1);
    assert!(effect.subjects[0].gained.iter().any(|c| c.group == "*" && c.resource == "*" && c.verbs.contains(&"*".to_string())));
    assert!(!effect.loses_own_access && effect.unavailable.is_none());
}

#[test]
fn a_namespaced_view_binding_gains_something_but_is_not_an_escalation() {
    let before = eval(vec![pods_reader()], vec![], vec![], vec![]);
    let after = eval(vec![pods_reader()], vec![rolebinding("dev", "b", cluster_ref("pods-reader"), vec![alice()])], vec![], vec![]);
    let effect = effect_between(&before, &after, None);
    assert_eq!(effect.total, 1);
    assert!(effect.escalated.is_empty());
}

#[test]
fn a_role_that_can_bind_or_escalate_is_a_direct_escalation_path_but_creating_pods_is_not() {
    let binder = cluster_role("binder", vec![rule(&["bind", "escalate"], &["rbac.authorization.k8s.io"], &["clusterroles"])]);
    let maker = cluster_role("pod-maker", vec![rule(&["create"], &[""], &["pods"])]);
    let before = eval(vec![binder.clone(), maker.clone()], vec![], vec![], vec![]);
    let bind_after = eval(vec![binder.clone(), maker.clone()], vec![], vec![clusterbinding("b", "binder", vec![alice()])], vec![]);
    assert_eq!(effect_between(&before, &bind_after, None).escalated, vec![alice()]);
    let pods_after = eval(vec![binder, maker], vec![], vec![clusterbinding("b", "pod-maker", vec![alice()])], vec![]);
    assert!(effect_between(&before, &pods_after, None).escalated.is_empty());
}

#[test]
fn a_subject_that_already_escalated_is_not_flagged_again() {
    let admin = |users: Vec<Subject>| eval(vec![], vec![], vec![clusterbinding("b", "cluster-admin", users)], vec![]);
    let effect = effect_between(&admin(vec![alice()]), &admin(vec![alice(), Subject::user("bob")]), None);
    assert_eq!(effect.escalated, vec![Subject::user("bob")]);
}

#[test]
fn losing_the_binding_that_gives_the_apps_identity_its_access_is_flagged_but_others_losses_are_not() {
    let own = Subject::iam(ARN);
    let bound = |users: Vec<Subject>| {
        eval(
            vec![pods_reader()],
            vec![],
            vec![clusterbinding("devs", "pods-reader", vec![Subject::group("devs")]), clusterbinding("others", "pods-reader", users)],
            vec![dev_principal()],
        )
    };
    let before = bound(vec![alice()]);
    // 앱의 신원은 그룹 devs를 거쳐 읽기 권한을 받는다. alice가 잃는 것은 앱의 신원과 상관없다
    let others = effect_between(&before, &bound(vec![]), Some(&own));
    assert!(!others.loses_own_access);
    assert_eq!((others.total, others.own.clone()), (1, None));
    let without_group = eval(vec![pods_reader()], vec![], vec![clusterbinding("others", "pods-reader", vec![alice()])], vec![dev_principal()]);
    let own_loss = effect_between(&before, &without_group, Some(&own));
    assert!(own_loss.loses_own_access);
    // 앱의 신원이 앞에 온다
    assert_eq!(own_loss.subjects[0].subject, own);
    assert_eq!(own_loss.own, Some(own));
}

#[test]
fn the_effect_lists_escalated_subjects_first_and_keeps_only_a_bounded_number() {
    let mut readers: Vec<Subject> = (0..150).map(|i| Subject::user(&format!("u{i:03}"))).collect();
    readers.push(Subject::user("zed"));
    let before = eval(vec![pods_reader()], vec![], vec![], vec![]);
    let after = eval(
        vec![pods_reader()],
        vec![],
        vec![clusterbinding("readers", "pods-reader", readers[..150].to_vec()), clusterbinding("admin", "cluster-admin", vec![Subject::user("zed")])],
        vec![],
    );
    let effect = effect_between(&before, &after, None);
    assert_eq!(effect.total, 151);
    assert_eq!(effect.subjects.len(), SUBJECTS_MAX);
    // 이름 순으로는 맨 끝인 zed가 권한 상승이라 맨 앞에 온다
    assert_eq!(effect.subjects[0].subject, Subject::user("zed"));
}

#[test]
fn the_apps_identity_is_found_by_its_iam_role_even_when_it_arrives_as_an_assumed_role_session() {
    let principals = vec![
        Principal { arn: "arn:aws:iam::111122223333:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_Admin_0123".into(), label: None, username: "sso".into(), groups: vec![], policies: vec![] },
        dev_principal(),
    ];
    let identity = |arn: Option<&str>| Identity { username: "kubernetes-admin".into(), groups: vec!["system:masters".into(), "system:authenticated".into()], arn: arn.map(str::to_string), source: IdentitySource::SelfSubjectReview };
    let sso = locate_own(&identity(Some("arn:aws:sts::111122223333:assumed-role/AWSReservedSSO_Admin_0123/jane")), &principals);
    assert_eq!(sso.subject, Subject::iam("arn:aws:iam::111122223333:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_Admin_0123"));
    assert!(sso.extra.is_none());
    let plain = locate_own(&identity(Some("arn:aws:iam::111122223333:role/dev")), &principals);
    assert_eq!(plain.subject, Subject::iam(ARN));
    // 다른 계정의 같은 이름은 다른 신원이다
    let other = locate_own(&identity(Some("arn:aws:iam::999999999999:role/dev")), &principals);
    assert!(other.extra.is_some());
}

#[test]
fn an_identity_without_a_mapping_is_evaluated_from_its_user_name_and_groups() {
    let identity = Identity { username: "kubernetes-admin".into(), groups: vec!["system:masters".into(), "system:authenticated".into()], arn: None, source: IdentitySource::Kubeconfig };
    let own = locate_own(&identity, &[]);
    let extra = own.extra.unwrap();
    assert_eq!((extra.username.as_str(), extra.groups.clone()), ("kubernetes-admin", vec!["system:masters".to_string()]));
    assert_eq!(own.subject, Subject::iam(&extra.arn));
}

fn plan_with(calls: Vec<ApiCall>) -> Plan {
    Plan {
        preview: Preview { calls, diff: vec![], impact: vec![], warnings: vec![], confirm_name: None, reversible: true, drain: None, conflicts: vec![], effect: None },
        inverse: None,
        version: None,
        fingerprint: None,
    }
}

fn nothing() -> Effect {
    Effect::default()
}

#[test]
fn a_change_with_no_danger_needs_no_confirmation() {
    let c = change(Some("dev"), "b", Operation::Delete);
    let object = binding(Some("dev"), "b", "ClusterRole", "view", &[]);
    assert_eq!(reasons(&c, Some(&object), &nothing()), vec![]);
    let mut plan = plan_with(vec![]);
    finish(&mut plan, &c, Some(&object), nothing());
    assert_eq!(plan.preview.confirm_name, None);
    assert_eq!(plan.preview.effect, Some(nothing()));
}

#[test]
fn a_cluster_admin_binding_is_dangerous_to_create_edit_or_delete() {
    let object = binding(None, "ops", "ClusterRole", "cluster-admin", &[user("alice")]);
    for op in [Operation::Delete, Operation::BindingSubjects { add: vec![], remove: vec![] }, Operation::BindingCreate { object: object.clone() }] {
        assert_eq!(reasons(&change(None, "ops", op), Some(&object), &nothing()), vec![Reason::ClusterAdminBinding]);
    }
    // 다른 ClusterRole은 위험하지 않고, RoleBinding이어도 cluster-admin ClusterRole을 가리키면 위험하다
    let view = binding(None, "ops", "ClusterRole", "view", &[]);
    assert!(reasons(&change(None, "ops", Operation::Delete), Some(&view), &nothing()).is_empty());
    let scoped = binding(Some("dev"), "ops", "ClusterRole", "cluster-admin", &[]);
    assert_eq!(reasons(&change(Some("dev"), "ops", Operation::Delete), Some(&scoped), &nothing()), vec![Reason::ClusterAdminBinding]);
}

#[test]
fn kube_system_and_prod_names_are_dangerous() {
    let object = binding(Some("kube-system"), "b", "ClusterRole", "view", &[]);
    assert_eq!(reasons(&change(Some("kube-system"), "b", Operation::Delete), Some(&object), &nothing()), vec![Reason::SystemOrProd]);
    assert_eq!(reasons(&change(Some("payments-prod"), "b", Operation::Delete), None, &nothing()), vec![Reason::SystemOrProd]);
    assert_eq!(reasons(&change(None, "prod-readers", Operation::Delete), None, &nothing()), vec![Reason::SystemOrProd]);
    assert!(reasons(&change(Some("dev"), "b", Operation::Delete), None, &nothing()).is_empty());
    // access entry는 역할 이름으로 본다
    let prod = entry_change("arn:aws:iam::111122223333:role/prod-deployer", Operation::AccessEntryDelete);
    assert_eq!(reasons(&prod, None, &nothing()), vec![Reason::SystemOrProd]);
    assert!(reasons(&entry_change(ARN, Operation::AccessEntryDelete), None, &nothing()).is_empty());
}

#[test]
fn escalation_losing_own_access_and_an_incomplete_calculation_each_require_the_name() {
    let c = change(Some("dev"), "b", Operation::Delete);
    let escalated = Effect { escalated: vec![alice()], ..nothing() };
    assert_eq!(reasons(&c, None, &escalated), vec![Reason::Escalation]);
    let own = Effect { loses_own_access: true, ..nothing() };
    assert_eq!(reasons(&c, None, &own), vec![Reason::OwnAccess]);
    let unavailable = Effect { unavailable: Some("RBAC를 읽지 못했어요".into()), ..nothing() };
    assert_eq!(reasons(&c, None, &unavailable), vec![Reason::Unavailable]);
}

#[test]
fn associating_the_cluster_admin_policy_is_dangerous_however_it_is_attached() {
    let admin = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy".to_string();
    let edit = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSEditPolicy".to_string();
    let associate = |arn: &str| entry_change(ARN, Operation::AccessPolicyAssociate { policy_arn: arn.into(), scope: ScopeSpec::Cluster });
    assert_eq!(reasons(&associate(&admin), None, &nothing()), vec![Reason::ClusterAdminPolicy]);
    assert!(reasons(&associate(&edit), None, &nothing()).is_empty());
    let spec = |arn: &str| PolicySpec { policy_arn: arn.into(), scope: ScopeSpec::Cluster };
    let create = |policies: Vec<PolicySpec>| entry_change(ARN, Operation::AccessEntryCreate { username: None, groups: vec![], policies, entry_type: None });
    assert_eq!(reasons(&create(vec![spec(&edit), spec(&admin)]), None, &nothing()), vec![Reason::ClusterAdminPolicy]);
    assert!(reasons(&create(vec![spec(&edit)]), None, &nothing()).is_empty());
}

#[test]
fn finishing_a_dangerous_plan_adds_a_warning_per_reason_and_asks_for_the_target_name() {
    let object = binding(Some("kube-system"), "ops", "ClusterRole", "cluster-admin", &[user("alice")]);
    let c = change(Some("kube-system"), "ops", Operation::Delete);
    let mut plan = plan_with(vec![]);
    let effect = Effect { escalated: vec![alice()], total: 1, ..nothing() };
    finish(&mut plan, &c, Some(&object), effect.clone());
    assert_eq!(plan.preview.confirm_name.as_deref(), Some("ops"));
    assert_eq!(plan.preview.warnings, vec![CLUSTER_ADMIN_BINDING.to_string(), ESCALATION.to_string(), SYSTEM_OR_PROD.to_string()]);
    assert_eq!(plan.preview.effect, Some(effect));
}

#[test]
fn an_incomplete_calculation_shows_why_and_requires_the_name() {
    let c = change(Some("dev"), "b", Operation::Delete);
    let mut plan = plan_with(vec![]);
    finish(&mut plan, &c, None, Effect { unavailable: Some("RBAC 객체를 읽지 못해 영향을 계산하지 못했어요".into()), ..nothing() });
    assert_eq!(plan.preview.confirm_name.as_deref(), Some("b"));
    assert!(plan.preview.warnings.contains(&UNAVAILABLE.to_string()));
    assert!(plan.preview.warnings.iter().any(|w| w.contains("RBAC 객체를 읽지 못해")));
}

#[test]
fn an_access_entry_is_confirmed_by_the_last_segment_of_its_arn() {
    let c = Change { target: ChangeObject { kind: access_entry_kind(), namespace: None, name: "arn:aws:iam::1:role/team/prod-deployer".into() }, operation: Operation::AccessEntryDelete };
    assert_eq!(confirm_name(&c), "prod-deployer");
    assert_eq!(confirm_name(&change(Some("dev"), "b", Operation::Delete)), "b");
}

#[test]
fn removing_an_access_policy_from_the_apps_own_entry_is_an_own_access_loss() {
    let policy = AccessPolicy { policy_arn: "arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy".into(), scope: PolicyScope::Cluster };
    let mapped = |policies: Vec<AccessPolicy>| eval(vec![], vec![], vec![], vec![Principal { policies, ..dev_principal() }]);
    let own = Subject::iam(ARN);
    let effect = effect_between(&mapped(vec![policy]), &mapped(vec![]), Some(&own));
    assert!(effect.loses_own_access);
    assert!(effect.escalated.is_empty());
}
