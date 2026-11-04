//! kind에서 앱 출력과 독립적으로 실행한 kubectl 출력을 대조한다.
use std::process::Command;

use super::{base, build, kubeconfig_path, PRIVATE};
use crate::k8s::connect::client_for;
use crate::k8s::describe;
use crate::k8s::rows::KindRef;
use crate::k8s_commands::Session;

#[tokio::test]
#[ignore]
async fn describe_matches_kubectl() {
    let (context, value) = base();
    let kubeconfig = build(&value);
    let client = client_for(&kubeconfig, &context, PRIVATE).await.unwrap();
    let session = Session { client, endpoint: PRIVATE, context: context.clone(), kubeconfig, kubeconfig_paths: vec![kubeconfig_path()] };
    let kind = KindRef { group: "apps".into(), version: "v1".into(), kind: "Deployment".into(), plural: "deployments".into(), namespaced: true };
    let actual = describe::describe(&session, &kind, Some("mm-k2"), "web").await.unwrap();
    let expected = Command::new("kubectl").arg("--kubeconfig").arg(kubeconfig_path()).args(["--context", &context, "describe", "deployments.apps", "web", "-n", "mm-k2"]).output().unwrap();
    assert!(expected.status.success(), "{}", String::from_utf8_lossy(&expected.stderr));
    assert_eq!(actual, String::from_utf8_lossy(&expected.stdout));
}
