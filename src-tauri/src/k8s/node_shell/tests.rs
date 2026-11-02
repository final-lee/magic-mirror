use serde_json::json;

use super::*;
use crate::k8s::change::node_shell_pod;

fn pod_with(labels: serde_json::Value) -> Pod {
    serde_json::from_value(json!({ "metadata": { "name": "x", "labels": labels } })).unwrap()
}

#[test]
fn only_pods_the_app_made_for_a_node_shell_are_recognised() {
    let made: Pod = serde_json::from_value(node_shell_pod("mm-node-shell-1", "default", "node-1", "busybox:1.36")).unwrap();
    assert!(is_node_shell_pod(&made));
    assert!(is_node_shell_json(&node_shell_pod("mm-node-shell-1", "default", "node-1", "busybox:1.36")));
    // 한쪽 표시만 있거나 값이 다르거나 표시가 없는 Pod는 지우지 않는다
    assert!(!is_node_shell_pod(&pod_with(json!({ "app.kubernetes.io/managed-by": "magic-mirror" }))));
    assert!(!is_node_shell_pod(&pod_with(json!({ "magic-mirror.io/node-shell": "true" }))));
    assert!(!is_node_shell_pod(&pod_with(json!({ "app.kubernetes.io/managed-by": "helm", "magic-mirror.io/node-shell": "true" }))));
    assert!(!is_node_shell_pod(&pod_with(json!({}))));
    assert!(!is_node_shell_json(&json!({ "metadata": { "name": "web" } })));
}
