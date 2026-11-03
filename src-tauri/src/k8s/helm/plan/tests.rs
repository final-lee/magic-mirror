use serde_json::json;

use super::*;
use crate::k8s::change::{ChangeObject, NOOP_WARNING};

const DEPLOY: &str = "---\n# Source: web/templates/deploy.yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  replicas: REPLICAS\n";
const CONFIG: &str = "---\n# Source: web/templates/config.yaml\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: web-config\n";

fn manifest(replicas: u32, with_config: bool) -> String {
    format!("{}{}", DEPLOY.replace("REPLICAS", &replicas.to_string()), if with_config { CONFIG } else { "" })
}

fn release(version: u32, status: &str, manifest: String, config: Value) -> Release {
    serde_json::from_value(json!({
        "name": "web", "namespace": "apps", "version": version,
        "info": {"status": status, "description": "d"},
        "chart": {"metadata": {"name": "web", "version": "1.0.0"}, "values": {"replicas": 1}},
        "config": config, "manifest": manifest,
        "hooks": [{"name": "migrate", "kind": "Job", "events": ["pre-upgrade", "pre-rollback", "pre-delete", "pre-install"]}],
    }))
    .unwrap()
}

fn current() -> Release {
    release(3, "deployed", manifest(1, true), json!({"replicas": 1}))
}

fn change(namespace: &str, name: &str, operation: Operation) -> Change {
    Change { target: ChangeObject { kind: crate::k8s::helm::release_kind(), namespace: Some(namespace.into()), name: name.into() }, operation }
}

fn upgrade_op(values: &str) -> Operation {
    Operation::HelmUpgrade { values: values.into(), chart: None }
}

#[test]
fn values_text_must_be_a_mapping_and_errors_never_quote_the_text() {
    assert_eq!(parse_values("").unwrap(), json!({}));
    assert_eq!(parse_values("  \n").unwrap(), json!({}));
    assert_eq!(parse_values("# 주석만\n").unwrap(), json!({}));
    assert_eq!(parse_values("a: 1\nb:\n  c: [1, 2]\n").unwrap(), json!({"a": 1, "b": {"c": [1, 2]}}));
    assert_eq!(parse_values("- a\n- b\n").unwrap_err(), AppError::other(VALUES_NOT_MAP));
    assert_eq!(parse_values("just text").unwrap_err(), AppError::other(VALUES_NOT_MAP));
    assert_eq!(parse_values("a: [unclosed secret-value\n").unwrap_err(), AppError::other(VALUES_NOT_YAML));
}

#[test]
fn an_upgrade_previews_values_and_object_diffs_and_rolls_back_to_the_current_revision_on_undo() {
    let c = change("apps", "web", upgrade_op("replicas: 3\n"));
    let rendered = release(4, "pending-upgrade", manifest(3, true), json!({"replicas": 3}));
    let plan = plan_upgrade(&c, &current(), &rendered, &json!({"replicas": 3}), "helm upgrade web (리비전 3의 차트)").unwrap();
    let paths: Vec<_> = plan.preview.diff.iter().map(|d| d.path.as_str()).collect();
    assert_eq!(paths, ["values · replicas", "Deployment web · spec.replicas"]);
    assert_eq!(plan.preview.impact[0], "helm upgrade web: 리비전 3 → 4");
    assert!(plan.preview.impact[1].contains("바뀌는 객체 1개(추가 0, 변경 1, 삭제 0)"));
    assert_eq!(plan.inverse.as_ref().unwrap().operation, Operation::HelmRollback { revision: 3 });
    assert_eq!(plan.inverse.as_ref().unwrap().target, c.target);
    assert!(plan.preview.reversible && plan.preview.confirm_name.is_none());
    assert_eq!((plan.preview.calls[0].verb.as_str(), plan.preview.calls[0].path.as_str()), ("helm", "upgrade web (리비전 3의 차트)"));
    assert!(plan.preview.warnings.iter().any(|w| w.contains("훅 1개") && w.contains("pre-upgrade")), "{:?}", plan.preview.warnings);
    assert_eq!(plan.version.as_deref(), Some("3"));
}

#[test]
fn an_upgrade_that_changes_nothing_warns_and_one_that_drops_an_object_says_so() {
    let c = change("apps", "web", upgrade_op(""));
    let same = release(4, "pending-upgrade", manifest(1, true), json!({"replicas": 1}));
    let plan = plan_upgrade(&c, &current(), &same, &json!({"replicas": 1}), "x").unwrap();
    assert!(plan.preview.diff.is_empty() && plan.preview.warnings.contains(&NOOP_WARNING.to_string()));
    assert!(plan.preview.impact[1].contains("바뀌는 객체가 없어요"));
    let dropped = release(4, "pending-upgrade", manifest(1, false), json!({"replicas": 1}));
    let plan = plan_upgrade(&c, &current(), &dropped, &json!({"replicas": 1}), "x").unwrap();
    assert!(plan.preview.warnings.iter().any(|w| w.contains("빠진 객체 1개")));
    assert_eq!(plan.preview.diff[0].path, "ConfigMap web-config");
}

#[test]
fn a_chart_version_change_is_stated_even_when_no_object_changes() {
    let c = change("apps", "web", upgrade_op(""));
    let mut rendered = release(4, "pending-upgrade", manifest(1, true), json!({"replicas": 1}));
    rendered.chart.metadata["version"] = json!("1.1.0");
    let plan = plan_upgrade(&c, &current(), &rendered, &json!({"replicas": 1}), "x").unwrap();
    assert!(plan.preview.impact.contains(&"차트 web-1.0.0 → web-1.1.0".to_string()), "{:?}", plan.preview.impact);
    assert!(!plan.preview.warnings.contains(&NOOP_WARNING.to_string()));
}

#[test]
fn a_release_in_a_failed_or_pending_state_warns_that_helm_may_refuse() {
    let c = change("apps", "web", upgrade_op(""));
    let stuck = release(3, "pending-upgrade", manifest(1, true), json!({}));
    let rendered = release(4, "pending-upgrade", manifest(2, true), json!({}));
    let plan = plan_upgrade(&c, &stuck, &rendered, &json!({}), "x").unwrap();
    assert!(plan.preview.warnings.iter().any(|w| w.contains("pending-upgrade 상태")));
}

#[test]
fn confirmation_names_follow_the_shared_danger_rule_for_upgrade_and_install() {
    let rendered = release(4, "pending-upgrade", manifest(2, true), json!({}));
    for (namespace, name, expected) in [("apps", "web", None), ("kube-system", "web", Some("web")), ("apps", "web-prod", Some("web-prod")), ("prod-apps", "web", Some("web"))] {
        let c = change(namespace, name, upgrade_op(""));
        let plan = plan_upgrade(&c, &current(), &rendered, &json!({}), "x").unwrap();
        assert_eq!(plan.preview.confirm_name.as_deref(), expected, "{namespace}/{name}");
        let install = change(namespace, name, Operation::HelmInstall { chart: ChartSource::default(), values: String::new(), create_namespace: false });
        let plan = plan_install(&install, &rendered, &json!({}), false, "x").unwrap();
        assert_eq!(plan.preview.confirm_name.as_deref(), expected, "install {namespace}/{name}");
    }
}

#[test]
fn a_rollback_diffs_the_target_revision_against_the_current_one_and_undoes_by_rolling_forward() {
    let target = release(1, "superseded", manifest(1, false), json!({}));
    let c = change("apps", "web", Operation::HelmRollback { revision: 1 });
    let plan = plan_rollback(&c, &current(), &target, "rollback web 1").unwrap();
    assert_eq!(plan.preview.diff.iter().map(|d| d.path.as_str()).collect::<Vec<_>>(), ["values · replicas", "ConfigMap web-config"]);
    assert_eq!(plan.preview.diff[1].after, Value::Null);
    assert!(plan.preview.impact[0].contains("리비전 1 내용으로 되돌려요") && plan.preview.impact[0].contains("새 리비전 4"));
    assert_eq!(plan.inverse.unwrap().operation, Operation::HelmRollback { revision: 3 });
    assert!(plan.preview.warnings.iter().any(|w| w.contains("그 리비전에 없는 객체 1개")));
    assert!(plan.preview.warnings.iter().any(|w| w.contains("pre-rollback")));
}

#[test]
fn rolling_back_to_the_current_revision_is_refused_and_a_failed_target_is_flagged() {
    let c = change("apps", "web", Operation::HelmRollback { revision: 3 });
    assert_eq!(plan_rollback(&c, &current(), &current(), "x").unwrap_err(), AppError::other(ALREADY_CURRENT));
    let failed = release(2, "failed", manifest(1, true), json!({}));
    let plan = plan_rollback(&change("apps", "web", Operation::HelmRollback { revision: 2 }), &current(), &failed, "x").unwrap();
    assert!(plan.preview.warnings.iter().any(|w| w.contains("리비전 2은 실패했던")));
}

#[test]
fn an_uninstalled_release_is_restored_by_rolling_back_to_its_own_revision_and_that_is_undone_by_uninstalling() {
    let gone = release(3, "uninstalled", manifest(1, true), json!({"replicas": 1}));
    let c = change("apps", "web", Operation::HelmRollback { revision: 3 });
    let plan = plan_rollback(&c, &gone, &gone, "x").unwrap();
    assert!(plan.preview.impact[0].contains("삭제된 릴리스를"));
    assert_eq!(plan.preview.diff.iter().filter(|d| d.before == Value::Null).count(), 2, "모든 객체가 새로 생겨요");
    assert_eq!(plan.inverse.unwrap().operation, Operation::HelmUninstall { keep_history: true });
}

#[test]
fn an_uninstall_always_asks_for_the_release_name_and_lists_every_object_it_deletes() {
    let c = change("apps", "web", Operation::HelmUninstall { keep_history: false });
    let plan = plan_uninstall(&c, &current(), false, "uninstall web").unwrap();
    assert_eq!(plan.preview.confirm_name.as_deref(), Some("web"));
    assert_eq!(plan.preview.diff.len(), 2);
    assert!(plan.preview.diff.iter().all(|d| d.after == Value::Null));
    assert!(plan.preview.impact[0].contains("객체 2개를 삭제"));
    assert!(plan.preview.warnings.contains(&UNINSTALL_FINAL.to_string()));
    assert!(plan.inverse.is_none() && !plan.preview.reversible);
}

#[test]
fn keeping_history_makes_an_uninstall_undoable_by_rollback_and_drops_the_final_warning() {
    let c = change("apps", "web", Operation::HelmUninstall { keep_history: true });
    let plan = plan_uninstall(&c, &current(), true, "uninstall web --keep-history").unwrap();
    assert!(!plan.preview.warnings.contains(&UNINSTALL_FINAL.to_string()));
    assert_eq!(plan.inverse.unwrap().operation, Operation::HelmRollback { revision: 3 });
    assert_eq!(plan.preview.confirm_name.as_deref(), Some("web"));
}

#[test]
fn objects_kept_by_resource_policy_and_delete_hooks_are_called_out() {
    let kept = format!("{}---\napiVersion: v1\nkind: PersistentVolumeClaim\nmetadata:\n  name: data\n  annotations:\n    helm.sh/resource-policy: keep\n", manifest(1, false));
    let release = release(3, "deployed", kept, json!({}));
    let c = change("apps", "web", Operation::HelmUninstall { keep_history: false });
    let plan = plan_uninstall(&c, &release, false, "x").unwrap();
    assert!(plan.preview.warnings.iter().any(|w| w.contains("resource-policy: keep인 객체 1개")));
    assert!(plan.preview.warnings.iter().any(|w| w.contains("pre-delete")));
}

#[test]
fn uninstalling_a_history_only_release_purges_it_without_listing_objects_or_offering_undo() {
    let gone = release(3, "uninstalled", manifest(1, true), json!({}));
    let c = change("apps", "web", Operation::HelmUninstall { keep_history: false });
    let plan = plan_uninstall(&c, &gone, false, "x").unwrap();
    assert!(plan.preview.diff.is_empty() && plan.inverse.is_none());
    assert!(plan.preview.warnings.contains(&PURGE_NOTHING.to_string()));
    let kept = plan_uninstall(&change("apps", "web", Operation::HelmUninstall { keep_history: true }), &gone, true, "x").unwrap();
    assert!(kept.inverse.is_none(), "이미 삭제된 릴리스를 이력 유지로 다시 지워도 되돌릴 것이 없어요");
}

#[test]
fn an_install_lists_new_objects_and_undoes_by_uninstalling_but_leaves_a_created_namespace() {
    let rendered = release(1, "pending-install", manifest(2, true), json!({"replicas": 2}));
    let c = change("apps", "web", Operation::HelmInstall { chart: ChartSource::default(), values: "replicas: 2\n".into(), create_namespace: true });
    let plan = plan_install(&c, &rendered, &json!({"replicas": 2}), true, "install web ./chart").unwrap();
    assert_eq!(plan.preview.diff.iter().map(|d| d.path.as_str()).collect::<Vec<_>>(), ["values · replicas", "ConfigMap web-config", "Deployment web"]);
    assert!(plan.preview.diff[1..].iter().all(|d| d.before == Value::Null));
    assert!(plan.preview.impact[0].contains("web-1.0.0") && plan.preview.impact[0].contains("객체 2개를 만들어요"));
    assert!(plan.preview.warnings.contains(&NAMESPACE_CREATED.to_string()));
    assert_eq!(plan.inverse.unwrap().operation, Operation::HelmUninstall { keep_history: false });
    assert_eq!(plan.version.as_deref(), Some("0"));
}

#[test]
fn applying_requires_the_same_release_state_and_the_typed_name() {
    let c = change("apps", "web-prod", upgrade_op(""));
    let rendered = release(4, "pending-upgrade", manifest(2, true), json!({}));
    let seen = plan_upgrade(&c, &current(), &rendered, &json!({}), "x").unwrap();
    assert!(check(&seen, &seen, Some("web-prod")).is_ok());
    assert_eq!(check(&seen, &seen, None).unwrap_err(), AppError::other(CONFIRM_REQUIRED));
    assert_eq!(check(&seen, &seen, Some("web")).unwrap_err(), AppError::other(CONFIRM_REQUIRED));
    // 미리보기 뒤에 누가 업그레이드했다: 리비전이 올라갔다
    let after_someone_else = release(4, "deployed", manifest(5, true), json!({}));
    let moved = plan_upgrade(&c, &after_someone_else, &rendered, &json!({}), "x").unwrap();
    assert_eq!(check(&seen, &moved, Some("web-prod")).unwrap_err(), AppError::other(STALE));
    // 같은 리비전이라도 내용이 달라졌다(상태가 바뀜)
    let rewritten = release(3, "failed", manifest(1, true), json!({"replicas": 1}));
    let changed = plan_upgrade(&c, &rewritten, &rendered, &json!({}), "x").unwrap();
    assert_eq!(check(&seen, &changed, Some("web-prod")).unwrap_err(), AppError::other(STALE));
}

#[test]
fn an_install_preview_goes_stale_when_a_release_appears_before_applying() {
    let rendered = release(1, "pending-install", manifest(1, true), json!({}));
    let c = change("apps", "web", Operation::HelmInstall { chart: ChartSource::default(), values: String::new(), create_namespace: false });
    let seen = plan_install(&c, &rendered, &json!({}), false, "x").unwrap();
    let appeared = plan_upgrade(&c, &current(), &rendered, &json!({}), "x").unwrap();
    assert_eq!(check(&seen, &appeared, None).unwrap_err(), AppError::other(STALE));
    assert!(check(&seen, &plan_install(&c, &rendered, &json!({}), false, "x").unwrap(), None).is_ok());
}

#[test]
fn the_state_hash_ignores_description_and_notes_but_not_revision_status_manifest_or_values() {
    let base = current();
    let mut described = base.clone();
    described.info.description = "다른 설명".into();
    described.info.notes = "notes".into();
    assert_eq!(state_fingerprint(&base), state_fingerprint(&described));
    for other in [
        release(4, "deployed", manifest(1, true), json!({"replicas": 1})),
        release(3, "failed", manifest(1, true), json!({"replicas": 1})),
        release(3, "deployed", manifest(2, true), json!({"replicas": 1})),
        release(3, "deployed", manifest(1, true), json!({"replicas": 2})),
    ] {
        assert_ne!(state_fingerprint(&base), state_fingerprint(&other));
    }
}

#[test]
fn only_helm_changes_are_handled_by_the_helm_path_and_their_values_never_reach_the_log() {
    use crate::k8s::change::apply::redact;
    let upgrade = change("apps", "web", upgrade_op("password: hunter2\n"));
    let install = change("apps", "web", Operation::HelmInstall { chart: ChartSource { reference: "nginx".into(), repo: None, version: None }, values: "token: abc\n".into(), create_namespace: false });
    for change in [&upgrade, &install] {
        assert!(crate::k8s::helm::handles(change));
        let logged = serde_json::to_string(&redact(change)).unwrap();
        assert!(!logged.contains("hunter2") && !logged.contains("abc"), "{logged}");
    }
    assert!(matches!(redact(&upgrade).operation, Operation::HelmUpgrade { values, .. } if values.is_empty()));
    let scale = change("apps", "web", Operation::Scale { replicas: 1 });
    assert!(!crate::k8s::helm::handles(&scale));
    assert_eq!(redact(&scale), scale);
    let rollback = change("apps", "web", Operation::HelmRollback { revision: 2 });
    assert_eq!(redact(&rollback), rollback);
}
