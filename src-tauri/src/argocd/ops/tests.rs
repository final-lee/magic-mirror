use serde_json::json;

use super::*;

#[test]
fn actions_keep_their_order_params_and_disabled_state() {
    let rows = action_rows(&json!({"actions": [
        {"name": "restart", "displayName": "Restart", "iconClass": "fa-redo"},
        {"name": "scale", "disabled": true, "params": [{"name": "replicas", "value": "1", "type": "number", "default": "1"}, {"name": ""}, {"name": "note"}]},
        {"displayName": "no name"},
    ]}));
    assert_eq!(rows.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["restart", "scale"]);
    assert_eq!(rows[0].display_name.as_deref(), Some("Restart"));
    assert!(!rows[0].disabled && rows[0].params.is_empty());
    assert!(rows[1].disabled);
    assert_eq!(rows[1].params.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["replicas", "note"]);
    assert_eq!(rows[1].params[0].kind.as_deref(), Some("number"));
    assert_eq!(rows[1].params[1].value, None);
    assert!(action_rows(&json!({})).is_empty());
}

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

#[test]
fn eks_cluster_comes_from_the_arn_then_exec_args_then_the_server_host() {
    let by_arn = eks_of("arn:aws:eks:ap-northeast-2:123456789012:cluster/stg", None, &[]).unwrap();
    assert_eq!((by_arn.region.as_str(), by_arn.name.as_str()), ("ap-northeast-2", "stg"));
    let by_args = eks_of("stg-eks", None, &args(&["eks", "get-token", "--cluster-name", "stg", "--region=us-east-1"])).unwrap();
    assert_eq!((by_args.region.as_str(), by_args.name.as_str()), ("us-east-1", "stg"));
    let by_host = eks_of("stg-eks", Some("https://ABC.gr7.eu-west-1.eks.amazonaws.com"), &args(&["-i", "stg"])).unwrap();
    assert_eq!((by_host.region.as_str(), by_host.name.as_str()), ("eu-west-1", "stg"));
    // 이름을 알 수 없으면 EKS 클러스터로 보지 않는다
    assert!(eks_of("kind-local", Some("https://127.0.0.1:6443"), &[]).is_none());
    assert!(eks_of("stg-eks", Some("https://example.test"), &args(&["--cluster-name", "stg"])).is_none());
}

#[test]
fn contexts_carry_server_profile_and_eks_cluster() {
    let config = Kubeconfig::from_yaml(
        r#"
apiVersion: v1
kind: Config
clusters:
- name: arn:aws:eks:ap-northeast-2:123456789012:cluster/stg
  cluster: {server: "https://ABC.gr7.ap-northeast-2.eks.amazonaws.com"}
- name: local
  cluster: {server: "https://127.0.0.1:6443"}
users:
- name: stg-user
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
      args: [eks, get-token, --cluster-name, stg, --profile, stg-profile]
- name: local-user
  user: {token: secret}
contexts:
- name: stg-eks
  context: {cluster: "arn:aws:eks:ap-northeast-2:123456789012:cluster/stg", user: stg-user}
- name: kind
  context: {cluster: local, user: local-user}
current-context: kind
"#,
    )
    .unwrap();
    let rows = kube_contexts(&config);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].name, "stg-eks");
    assert_eq!(rows[0].profile.as_deref(), Some("stg-profile"));
    assert_eq!(rows[0].server.as_deref(), Some("https://ABC.gr7.ap-northeast-2.eks.amazonaws.com"));
    assert_eq!(rows[0].eks.as_ref().map(|e| e.name.as_str()), Some("stg"));
    assert_eq!(rows[1].profile, None);
    assert_eq!(rows[1].eks, None);
}

fn res(group: &str, kind: &str, name: &str) -> ResRef {
    ResRef {
        group: group.into(),
        version: "v1".into(),
        kind: kind.into(),
        namespace: Some("web".into()),
        name: name.into(),
        uid: None,
    }
}

fn action(name: &str, disabled: bool) -> ResourceAction {
    ResourceAction {
        name: name.into(),
        display_name: None,
        disabled,
        icon_class: None,
        params: vec![],
    }
}

#[test]
fn managed_resources_skip_hooks_and_incomplete_rows_and_stop_at_the_limit() {
    let app = json!({"status": {"resources": [
        {"group": "apps", "version": "v1", "kind": "Deployment", "namespace": "web", "name": "web"},
        {"group": "batch", "version": "v1", "kind": "Job", "namespace": "web", "name": "migrate", "hook": true},
        {"version": "v1", "kind": "Service", "name": "svc"},
        {"kind": "Broken", "name": "x"},
    ]}});
    let rows = managed_resources(&app);
    assert_eq!(rows.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["web", "svc"]);
    assert_eq!(rows[1].group, "");
    let many = json!({"status": {"resources": (0..APP_ACTION_LIMIT + 50).map(|i| json!({"version": "v1", "kind": "ConfigMap", "name": format!("c{i}")})).collect::<Vec<_>>()}});
    assert_eq!(managed_resources(&many).len(), APP_ACTION_LIMIT);
}

#[test]
fn actions_group_by_kind_and_name_with_disabled_counted() {
    let groups = group_actions(vec![
        (res("apps", "Deployment", "a"), vec![action("restart", false)]),
        (res("apps", "Deployment", "b"), vec![action("restart", true)]),
        (res("argoproj.io", "Rollout", "r"), vec![action("restart", false), action("pause", false)]),
        (res("apps", "StatefulSet", "s"), vec![action("restart", false)]),
    ]);
    let key: Vec<_> = groups.iter().map(|g| (g.kind.as_str(), g.action.as_str(), g.resources.len(), g.disabled_count)).collect();
    assert_eq!(
        key,
        [
            ("Deployment", "restart", 2, 1),
            ("Rollout", "restart", 1, 0),
            ("Rollout", "pause", 1, 0),
            ("StatefulSet", "restart", 1, 0)
        ]
    );
    assert!(groups[0].resources[1].disabled);
}

#[tokio::test]
async fn only_kinds_with_actions_are_read_in_full_and_failures_are_skipped() {
    use std::sync::Mutex;
    let calls = Mutex::new(Vec::new());
    let resources = vec![
        res("apps", "Deployment", "a"),
        res("", "Service", "svc"),
        res("apps", "Deployment", "b"),
        res("apps", "Deployment", "broken"),
        res("", "Service", "svc2"),
    ];
    let groups = app_actions(resources, |r| {
        calls.lock().unwrap().push(r.name.clone());
        async move {
            match (r.kind.as_str(), r.name.as_str()) {
                ("Deployment", "broken") => Err(AppError::other("boom")),
                ("Deployment", _) => Ok(vec![action("restart", r.name == "b")]),
                _ => Ok(vec![]),
            }
        }
    })
    .await;
    // Service는 첫 리소스만 탐색하고 끝낸다
    let mut seen = calls.into_inner().unwrap();
    seen.sort();
    assert_eq!(seen, ["a", "b", "broken", "svc"]);
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].resources.iter().map(|r| r.res.name.as_str()).collect::<Vec<_>>(), ["a", "b"]);
    assert_eq!(groups[0].disabled_count, 1);
}

#[tokio::test]
async fn a_failed_probe_drops_that_kind_but_not_the_others() {
    let resources = vec![res("apps", "Deployment", "a"), res("apps", "StatefulSet", "s"), res("apps", "StatefulSet", "t")];
    let groups = app_actions(resources, |r| async move {
        if r.kind == "Deployment" {
            Err(AppError::other("no"))
        } else {
            Ok(vec![action("restart", false)])
        }
    })
    .await;
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].kind, "StatefulSet");
    assert_eq!(groups[0].resources.len(), 2);
}
