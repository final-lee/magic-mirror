use std::sync::atomic::{AtomicUsize, Ordering};

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

fn target(cluster: &str) -> K8sTarget {
    K8sTarget { profile: "p".into(), region: "r".into(), cluster: cluster.into() }
}

/// 몇 번 불렸는지 세는 가짜 지우기
fn counting() -> (Remover, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    let remove: Remover = Arc::new(move || {
        let seen = seen.clone();
        Box::pin(async move {
            seen.fetch_add(1, Ordering::SeqCst);
        })
    });
    (remove, calls)
}

#[test]
fn only_the_pod_with_the_recorded_uid_is_ours_even_when_the_labels_match() {
    let mut forged = node_shell_pod("mm-node-shell-1", "default", "node-1", "busybox:1.36");
    forged["metadata"]["uid"] = json!("attacker-uid");
    assert!(is_ours(&forged, Some("attacker-uid")));
    assert!(!is_ours(&forged, Some("created-uid")));
    // UID를 모르는 때(만든 직후 읽지 못함)는 표시만 본다
    assert!(is_ours(&forged, None));
    // 표시가 없으면 UID가 같아도 아니다
    assert!(!is_ours(&json!({ "metadata": { "uid": "u", "labels": {} } }), Some("u")));
}

#[test]
fn a_pod_nobody_confirmed_cannot_be_claimed_for_a_terminal() {
    let shells = NodeShells::default();
    // 같은 표시를 단 Pod를 YAML 적용 따위로 만들어도 등록돼 있지 않으니 열 수 없다
    assert_eq!(shells.claim(&target("a"), "default", "forged").err(), Some(AppError::other(NOT_NODE_SHELL)));
    let (remove, _) = counting();
    shells.track(target("a"), "default", "mine", "uid-1".into(), remove);
    assert_eq!(shells.claim(&target("a"), "other-ns", "mine").err(), Some(AppError::other(NOT_NODE_SHELL)));
    assert_eq!(shells.claim(&target("b"), "default", "mine").err(), Some(AppError::other(NOT_NODE_SHELL)));
    let claimed = shells.claim(&target("a"), "default", "mine").unwrap();
    assert_eq!(claimed.uid, "uid-1");
    // 한 번만 가져갈 수 있다
    assert!(shells.claim(&target("a"), "default", "mine").is_err());
}

#[tokio::test]
async fn closing_the_tab_removes_unclaimed_pods_of_that_target_only() {
    let shells = NodeShells::default();
    let (mine, mine_calls) = counting();
    let (other, other_calls) = counting();
    shells.track(target("a"), "default", "p1", "u1".into(), mine);
    shells.track(target("b"), "default", "p2", "u2".into(), other);
    shells.close_target(&target("a"));
    shells.settle(Duration::from_secs(5)).await;
    assert_eq!((mine_calls.load(Ordering::SeqCst), other_calls.load(Ordering::SeqCst)), (1, 0));
    // 지운 Pod는 더 열 수 없다
    assert!(shells.claim(&target("a"), "default", "p1").is_err());
    assert!(shells.claim(&target("b"), "default", "p2").is_ok());
}

#[tokio::test]
async fn app_exit_removes_every_unclaimed_pod_but_leaves_claimed_ones_to_their_session() {
    let shells = NodeShells::default();
    let (pending, pending_calls) = counting();
    let (claimed, claimed_calls) = counting();
    shells.track(target("a"), "default", "waiting", "u1".into(), pending);
    shells.track(target("b"), "default", "open", "u2".into(), claimed);
    shells.claim(&target("b"), "default", "open").unwrap();
    shells.close_all();
    shells.close_all();
    shells.settle(Duration::from_secs(5)).await;
    assert_eq!((pending_calls.load(Ordering::SeqCst), claimed_calls.load(Ordering::SeqCst)), (1, 0));
}

#[tokio::test]
async fn a_pod_whose_apply_record_failed_is_removed_at_once() {
    let shells = NodeShells::default();
    let (remove, calls) = counting();
    shells.track(target("a"), "default", "p1", "u1".into(), remove);
    shells.discard("default", "p1");
    // 없는 Pod를 또 버려도 두 번 지우지 않는다
    shells.discard("default", "p1");
    shells.settle(Duration::from_secs(5)).await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(shells.claim(&target("a"), "default", "p1").is_err());
}
