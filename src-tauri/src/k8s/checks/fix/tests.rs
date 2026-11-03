use serde_json::json;

use super::*;
use crate::k8s::checks::testkit::{deployment, workload};

fn names(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

fn spec() -> serde_json::Value {
    json!({ "containers": [{ "name": "app", "image": "a:1" }] })
}

#[test]
fn the_object_holds_only_the_identity_and_the_changed_fields() {
    let w = deployment("dev", "web", spec());
    let fix = privilege_escalation_fix(&w, &names(&["app", "side"]), &[]).unwrap();
    assert_eq!(
        fix.object,
        json!({
            "apiVersion": "apps/v1",
            "kind": "Deployment",
            "metadata": { "name": "web", "namespace": "dev" },
            "spec": { "template": { "spec": { "containers": [
                { "name": "app", "securityContext": { "allowPrivilegeEscalation": false } },
                { "name": "side", "securityContext": { "allowPrivilegeEscalation": false } },
            ] } } },
        })
    );
    assert_eq!((fix.kind.kind.as_str(), fix.namespace.as_deref(), fix.name.as_str()), ("Deployment", Some("dev"), "web"));
    assert!(fix.summary.contains("app, side"));
}

#[test]
fn each_template_kind_uses_its_own_path_and_api_version() {
    let at = |kind: WorkloadKind| privilege_escalation_fix(&workload(kind, "dev", "x", spec()), &names(&["app"]), &[]);
    for kind in [WorkloadKind::Deployment, WorkloadKind::StatefulSet, WorkloadKind::DaemonSet] {
        let fix = at(kind).unwrap();
        assert_eq!(fix.object["apiVersion"], "apps/v1");
        assert!(fix.object["spec"]["template"]["spec"]["containers"].is_array(), "{kind:?}");
    }
    let cron = at(WorkloadKind::CronJob).unwrap();
    assert_eq!(cron.object["apiVersion"], "batch/v1");
    assert!(cron.object["spec"]["jobTemplate"]["spec"]["template"]["spec"]["containers"].is_array());
}

#[test]
fn pods_and_jobs_have_no_fix_because_their_template_is_immutable() {
    for kind in [WorkloadKind::Pod, WorkloadKind::Job] {
        assert!(privilege_escalation_fix(&workload(kind, "dev", "x", spec()), &names(&["app"]), &[]).is_none(), "{kind:?}");
    }
}

#[test]
fn nothing_to_fix_gives_no_fix() {
    assert!(privilege_escalation_fix(&deployment("dev", "web", spec()), &[], &[]).is_none());
}

#[test]
fn a_rollout_caution_is_always_given_and_the_managing_tool_is_named() {
    let mut w = deployment("dev", "web", spec());
    assert!(privilege_escalation_fix(&w, &names(&["app"]), &[]).unwrap().caution.unwrap().contains("롤아웃"));
    w.labels.insert("app.kubernetes.io/managed-by".into(), "Helm".into());
    assert!(privilege_escalation_fix(&w, &names(&["app"]), &[]).unwrap().caution.unwrap().contains("Helm"));
}

#[test]
fn managing_tools_are_recognised_by_their_markers() {
    let mut w = deployment("dev", "web", spec());
    assert_eq!(managed_by(&w), None);
    w.labels.insert("argocd.argoproj.io/instance".into(), "app".into());
    assert_eq!(managed_by(&w), Some("ArgoCD"));
    w.labels.clear();
    w.annotations.insert("argocd.argoproj.io/tracking-id".into(), "x".into());
    assert_eq!(managed_by(&w), Some("ArgoCD"));
    w.annotations.clear();
    w.labels.insert("kustomize.toolkit.fluxcd.io/name".into(), "x".into());
    assert_eq!(managed_by(&w), Some("Flux"));
    w.labels.clear();
    // Helm이 아닌 다른 관리자는 Helm으로 보지 않는다
    w.labels.insert("app.kubernetes.io/managed-by".into(), "Tiller".into());
    assert_eq!(managed_by(&w), None);
}

#[test]
fn the_service_account_fix_is_a_minimal_object_with_a_warning() {
    let fix = automount_fix("dev");
    assert_eq!(fix.object, json!({ "apiVersion": "v1", "kind": "ServiceAccount", "metadata": { "name": "default", "namespace": "dev" }, "automountServiceAccountToken": false }));
    assert!(fix.caution.unwrap().contains("API를 호출"));
    assert_eq!(fix.kind.plural, "serviceaccounts");
}
