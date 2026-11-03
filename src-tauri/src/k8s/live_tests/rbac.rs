//! 권한 변경(K8 D)을 실제 kind 클러스터에서 확인한다: 바인딩 만들기·주체 편집·삭제와 되돌리기, 장바구니 일괄 미리보기·적용·중간 실패.
//! 픽스처는 `scripts/k8s-live/rbac.sh`(네임스페이스 `mm-rbac`와 바인딩 `base`). EKS는 닫힌 로컬 포트를 가리키는 클라이언트라 읽기에 실패하고,
//! 그래서 영향 계산이 끝까지 되지 않은 것으로 보고 모든 변경이 바인딩 이름 입력을 요구한다(실제 AWS에는 닿지 않는다).
use serde_json::{json, Value};

use super::*;
use crate::k8s::change::{Change, ChangeObject, Operation};
use crate::k8s::commit::current;
use crate::k8s::rbac::commit::{apply_items, apply_plan, dry_plan, plan_batch, recheck_batch, Ctx, ItemOutcome};
use crate::k8s::rbac::{binding_kind, SubjectSpec};

const NS: &str = "mm-rbac";

async fn ctx() -> Ctx {
    let config = aws_sdk_eks::Config::builder()
        .behavior_version(aws_sdk_eks::config::BehaviorVersion::latest())
        .region(aws_sdk_eks::config::Region::new("ap-northeast-2"))
        .credentials_provider(aws_sdk_eks::config::Credentials::new("AKIDTEST", "secret", None, None, "test"))
        .endpoint_url("http://127.0.0.1:1")
        .retry_config(aws_sdk_eks::config::retry::RetryConfig::disabled())
        .build();
    Ctx { client: admin().await, endpoint: PRIVATE, eks: aws_sdk_eks::Client::from_conf(config), cluster: "none".into() }
}

fn target(name: &str) -> ChangeObject {
    ChangeObject { kind: binding_kind(false), namespace: Some(NS.into()), name: name.into() }
}

fn user(name: &str) -> SubjectSpec {
    SubjectSpec { kind: "User".into(), name: name.into(), namespace: None }
}

fn edit(name: &str, add: Vec<SubjectSpec>, remove: Vec<SubjectSpec>) -> Change {
    Change { target: target(name), operation: Operation::BindingSubjects { add, remove } }
}

async fn subjects(ctx: &Ctx, name: &str) -> Option<Vec<String>> {
    let object = current(ctx.client.clone(), ctx.endpoint, &target(name)).await.unwrap()?;
    Some(object["subjects"].as_array().map(|a| a.iter().map(|s| s["name"].as_str().unwrap().to_string()).collect()).unwrap_or_default())
}

/// 미리보기(서버 dry-run 포함) → 적용. 영향을 계산하지 못한 계획은 바인딩 이름을 입력해야 한다.
async fn run(ctx: &Ctx, change: &Change) -> Change {
    let seen = dry_plan(ctx, change).await.expect("preview");
    assert_eq!(seen.preview.confirm_name.as_deref(), Some(change.target.name.as_str()), "{:?}", seen.preview.warnings);
    let (plan, result) = apply_plan(ctx, change, &seen, Some(&change.target.name)).await.expect("apply");
    result.expect("서버가 받아야 해요");
    plan.inverse.expect("되돌리기가 있어야 해요")
}

fn created() -> Value {
    json!({
        "apiVersion": "rbac.authorization.k8s.io/v1", "kind": "RoleBinding",
        "metadata": {"name": "made", "namespace": NS, "labels": {"by": "test"}},
        "roleRef": {"apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": "view"},
        "subjects": [{"apiGroup": "rbac.authorization.k8s.io", "kind": "User", "name": "mm-rbac-bob"}],
    })
}

#[tokio::test]
#[ignore]
async fn a_binding_is_created_edited_and_removed_and_each_step_is_undone() {
    let ctx = ctx().await;
    kubectl(&["-n", NS, "delete", "rolebinding", "made", "--ignore-not-found"]);
    let make = Change { target: target("made"), operation: Operation::BindingCreate { object: created() } };
    let undo_make = run(&ctx, &make).await;
    assert_eq!(subjects(&ctx, "made").await, Some(vec!["mm-rbac-bob".into()]));
    let undo_edit = run(&ctx, &edit("made", vec![user("mm-rbac-carol")], vec![user("mm-rbac-bob")])).await;
    assert_eq!(subjects(&ctx, "made").await, Some(vec!["mm-rbac-carol".into()]));
    let delete = Change { target: target("made"), operation: Operation::Delete };
    let undo_delete = run(&ctx, &delete).await;
    assert_eq!(subjects(&ctx, "made").await, None);
    // 지운 것을 되돌리면 원본(라벨 포함)이 돌아오고, 이어서 편집과 만들기도 되돌린다
    run(&ctx, &undo_delete).await;
    let restored = current(ctx.client.clone(), ctx.endpoint, &target("made")).await.unwrap().unwrap();
    assert_eq!(restored["metadata"]["labels"], json!({"by": "test"}));
    run(&ctx, &undo_edit).await;
    assert_eq!(subjects(&ctx, "made").await, Some(vec!["mm-rbac-bob".into()]));
    run(&ctx, &undo_make).await;
    assert_eq!(subjects(&ctx, "made").await, None);
}

#[tokio::test]
#[ignore]
async fn a_cart_batch_previews_gains_and_losses_applies_in_order_and_stops_at_a_failure() {
    let ctx = ctx().await;
    kubectl(&["-n", NS, "delete", "rolebinding", "cart", "base2", "--ignore-not-found"]);
    kubectl(&["-n", NS, "create", "rolebinding", "base2", "--clusterrole=view", "--user=mm-rbac-alice"]);
    let make = Change { target: target("cart"), operation: Operation::BindingCreate { object: json!({
        "apiVersion": "rbac.authorization.k8s.io/v1", "kind": "RoleBinding", "metadata": {"name": "cart", "namespace": NS},
        "roleRef": {"apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": "view"},
        "subjects": [{"apiGroup": "rbac.authorization.k8s.io", "kind": "User", "name": "mm-rbac-dave"}],
    }) } };
    let changes = vec![make, edit("cart", vec![user("mm-rbac-erin")], vec![]), edit("base2", vec![], vec![user("mm-rbac-alice")]), edit("base2", vec![user("mm-rbac-zed")], vec![])];
    let planned = plan_batch(&ctx, &changes).await.unwrap();
    let seen: Vec<_> = planned.items.iter().map(|i| i.plan.clone().unwrap()).collect();
    // 누가 무엇을 얻고 잃는지: dave·erin·zed는 얻고 alice는 잃는다
    let total = planned.total.unwrap();
    let who = |gain: bool| {
        let mut names: Vec<String> = total.subjects.iter().filter(|s| if gain { !s.gained.is_empty() } else { !s.lost.is_empty() }).map(|s| s.subject.name.clone()).collect();
        names.sort();
        names
    };
    assert_eq!(who(true), ["mm-rbac-dave", "mm-rbac-erin", "mm-rbac-zed"]);
    assert_eq!(who(false), ["mm-rbac-alice"]);
    recheck_batch(&ctx, &changes, &seen).await.unwrap();
    // 셋째 항목을 보내기 전에 누군가 base를 지우면 그 항목에서 멈추고 넷째는 건너뛴다
    kubectl(&["-n", NS, "delete", "rolebinding", "base2"]);
    let mut inverses = Vec::new();
    let outcomes = apply_items(&ctx, &changes, &seen, |i, plan, outcome| {
        if outcome.is_ok() {
            inverses.push((i, plan.inverse.clone().unwrap()));
        }
        true
    })
    .await;
    assert_eq!(outcomes[..2], [ItemOutcome::Applied, ItemOutcome::Applied]);
    assert!(matches!(outcomes[2], ItemOutcome::Failed(_)), "{:?}", outcomes[2]);
    assert_eq!(outcomes[3], ItemOutcome::Skipped);
    assert_eq!(subjects(&ctx, "cart").await, Some(vec!["mm-rbac-dave".into(), "mm-rbac-erin".into()]));
    // 적용한 것을 거꾸로 되돌린다: 편집을 되돌리고 만든 바인딩을 지운다
    for (_, undo) in inverses.into_iter().rev() {
        let seen = dry_plan(&ctx, &undo).await.unwrap();
        let (_, result) = apply_plan(&ctx, &undo, &seen, Some(&undo.target.name)).await.unwrap();
        result.unwrap();
    }
    assert_eq!(subjects(&ctx, "cart").await, None);
}
