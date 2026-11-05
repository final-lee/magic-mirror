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
