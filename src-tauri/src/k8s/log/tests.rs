use super::*;
use crate::k8s::change::{ChangeObject, Operation};
use crate::k8s::rows::KindRef;

#[test]
fn undo_requires_success_and_can_only_be_used_once() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("changes.jsonl");
    let target = K8sTarget { profile: "p".into(), region: "r".into(), cluster: "c".into() };
    let object = ChangeObject {
        kind: KindRef { group: "apps".into(), version: "v1".into(), kind: "Deployment".into(), plural: "deployments".into(), namespaced: true },
        namespace: Some("default".into()), name: "web".into(),
    };
    let change = Change { target: object.clone(), operation: Operation::Scale { replicas: 2 } };
    let inverse = Change { target: object, operation: Operation::Scale { replicas: 1 } };
    let entry = Entry { id: "one".into(), at: "2026-01-01T00:00:00Z".into(), target: target.clone(), change, summary: "변경".into(), ok: true, error: None, inverse: Some(inverse.clone()), undo_of: None, undone: false };
    append(&path, &entry).unwrap();
    let result = undo(&read_all(&path), "one").unwrap();
    assert_eq!(result.target, target);
    assert_eq!(result.change, inverse);
    mark_undone(&path, "one").unwrap();
    assert!(undo(&read_all(&path), "one").is_err());
}
