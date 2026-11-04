use std::cell::RefCell;

use serde_json::{json, Value};

use super::*;
use crate::k8s::change::{clean_object, Operation};
use crate::k8s::rbac::mock_eks::FakeEks;
use crate::k8s::rbac::mock_kube::{FakeKube, PUBLIC};
use crate::k8s::rbac::tests::{binding, change, entry_change, group, user, ARN};
use crate::k8s::rbac::{PolicySpec, ScopeSpec, SubjectSpec, BATCH_DUPLICATE, BATCH_TOO_LARGE, BINDING_MISSING};

const VIEW: &str = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy";
const ADMIN: &str = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy";

fn cluster_role(name: &str, rules: Value) -> Value {
    json!({"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "ClusterRole", "metadata": {"name": name}, "rules": rules})
}

fn roles() -> Vec<Value> {
    vec![
        cluster_role("cluster-admin", json!([{"apiGroups": ["*"], "resources": ["*"], "verbs": ["*"]}, {"nonResourceURLs": ["*"], "verbs": ["*"]}])),
        cluster_role("pods-reader", json!([{"apiGroups": [""], "resources": ["pods"], "verbs": ["get", "list"]}])),
        cluster_role("view", json!([{"apiGroups": [""], "resources": ["pods", "services"], "verbs": ["get", "list", "watch"]}])),
    ]
}

/// 가짜 쿠버네티스·EKS로 만든 연결. `auth_mode`가 None이면 access entry가 없는 CONFIG_MAP 클러스터다.
async fn setup(auth_mode: Option<&str>) -> (FakeKube, FakeEks, Ctx) {
    let (kube, client) = FakeKube::start(roles()).await;
    let eks = FakeEks::new(auth_mode);
    let ctx = Ctx { client, endpoint: PUBLIC, eks: eks.client(), cluster: "c".into() };
    (kube, eks, ctx)
}

fn add(namespace: Option<&str>, name: &str, subject: SubjectSpec) -> Change {
    change(namespace, name, Operation::BindingSubjects { add: vec![subject], remove: vec![] })
}

fn readers() -> Value {
    binding(None, "readers", "ClusterRole", "pods-reader", &[user("alice")])
}

fn names(kube: &FakeKube, plural: &str, namespace: &str, name: &str) -> Vec<String> {
    kube.subjects_of(plural, namespace, name).iter().map(|s| s["name"].as_str().unwrap().to_string()).collect()
}

fn gained(plan: &Plan) -> Vec<String> {
    plan.preview.effect.as_ref().unwrap().subjects.iter().map(|s| s.subject.name.clone()).collect()
}

#[tokio::test]
async fn a_preview_dry_runs_the_change_and_changes_nothing() {
    let (kube, _eks, ctx) = setup(None).await;
    kube.put(readers());
    let plan = dry_plan(&ctx, &add(None, "readers", user("bob"))).await.unwrap();
    let writes = kube.writes();
    assert_eq!(writes.len(), 1);
    assert!(writes[0].dry_run && writes[0].method == "PATCH");
    assert!(kube.applied().is_empty());
    assert_eq!(names(&kube, "clusterrolebindings", "", "readers"), vec!["alice"]);
    assert_eq!(gained(&plan), vec!["bob"]);
}

#[tokio::test]
async fn applying_sends_the_previewed_patch_under_the_current_resource_version() {
    let (kube, _eks, ctx) = setup(None).await;
    kube.put(readers());
    let c = add(None, "readers", user("bob"));
    let seen = dry_plan(&ctx, &c).await.unwrap();
    let (plan, result) = apply_plan(&ctx, &c, &seen, None).await.unwrap();
    assert_eq!(result, Ok(()));
    assert_eq!(names(&kube, "clusterrolebindings", "", "readers"), vec!["alice", "bob"]);
    let applied = kube.applied();
    assert_eq!(applied.len(), 1);
    assert_eq!(applied[0].body["metadata"]["resourceVersion"], json!(plan.version));
    assert_eq!(plan.inverse, Some(change(None, "readers", Operation::BindingSubjects { add: vec![], remove: vec![user("bob")] })));
}

#[tokio::test]
async fn a_binding_edited_by_someone_else_after_the_preview_stops_the_apply() {
    let (kube, _eks, ctx) = setup(None).await;
    kube.put(readers());
    let c = add(None, "readers", user("bob"));
    let seen = dry_plan(&ctx, &c).await.unwrap();
    kube.tamper("clusterrolebindings", "", "readers", |o| o["subjects"] = json!([group("devs").to_value()]));
    let error = apply_plan(&ctx, &c, &seen, None).await.unwrap_err();
    assert_eq!(error, AppError::other(STALE));
    assert!(kube.applied().is_empty());
}

#[tokio::test]
async fn a_change_to_unrelated_fields_after_the_preview_does_not_stop_the_apply() {
    let (kube, _eks, ctx) = setup(None).await;
    kube.put(readers());
    let c = add(None, "readers", user("bob"));
    let seen = dry_plan(&ctx, &c).await.unwrap();
    kube.tamper("clusterrolebindings", "", "readers", |o| o["metadata"]["labels"] = json!({"team": "ops"}));
    let (_, result) = apply_plan(&ctx, &c, &seen, None).await.unwrap();
    assert_eq!(result, Ok(()));
    assert_eq!(names(&kube, "clusterrolebindings", "", "readers"), vec!["alice", "bob"]);
}

#[tokio::test]
async fn a_role_edited_after_the_preview_changes_the_effect_and_stops_the_apply() {
    // 영향(누가 무엇을 얻는지)이 미리보기와 달라지면 같은 변경이라도 적용하지 않는다
    let (kube, _eks, ctx) = setup(None).await;
    kube.put(readers());
    let c = add(None, "readers", user("bob"));
    let seen = dry_plan(&ctx, &c).await.unwrap();
    kube.tamper("clusterrolebindings", "", "readers", |o| o["roleRef"]["name"] = json!("cluster-admin"));
    assert_eq!(apply_plan(&ctx, &c, &seen, None).await.unwrap_err(), AppError::other(STALE));
}

#[tokio::test]
async fn a_dangerous_change_is_applied_only_with_the_exact_name() {
    let (kube, _eks, ctx) = setup(None).await;
    kube.put(binding(None, "ops", "ClusterRole", "cluster-admin", &[user("alice")]));
    let c = add(None, "ops", user("bob"));
    let seen = dry_plan(&ctx, &c).await.unwrap();
    assert_eq!(seen.preview.confirm_name.as_deref(), Some("ops"));
    assert_eq!(apply_plan(&ctx, &c, &seen, None).await.unwrap_err(), AppError::other(CONFIRM_REQUIRED));
    assert_eq!(apply_plan(&ctx, &c, &seen, Some("OPS")).await.unwrap_err(), AppError::other(CONFIRM_REQUIRED));
    assert!(kube.applied().is_empty());
    let (_, result) = apply_plan(&ctx, &c, &seen, Some("ops")).await.unwrap();
    assert_eq!(result, Ok(()));
}

#[tokio::test]
async fn deleting_a_binding_and_undoing_it_restores_the_original_object() {
    let (kube, _eks, ctx) = setup(None).await;
    kube.put(binding(Some("dev"), "devs-view", "ClusterRole", "pods-reader", &[group("devs"), user("alice")]));
    let original = kube.get("rolebindings", "dev", "devs-view").unwrap();
    let delete = change(Some("dev"), "devs-view", Operation::Delete);
    let seen = dry_plan(&ctx, &delete).await.unwrap();
    let (plan, result) = apply_plan(&ctx, &delete, &seen, None).await.unwrap();
    assert_eq!(result, Ok(()));
    assert!(kube.get("rolebindings", "dev", "devs-view").is_none());
    let undo = plan.inverse.unwrap();
    let seen = dry_plan(&ctx, &undo).await.unwrap();
    let (again, result) = apply_plan(&ctx, &undo, &seen, None).await.unwrap();
    assert_eq!(result, Ok(()));
    let restored = kube.get("rolebindings", "dev", "devs-view").unwrap();
    assert_eq!(clean_object(restored), clean_object(original));
    // 되돌린 것을 다시 되돌리면 지우는 변경이다
    assert_eq!(again.inverse, Some(delete));
}

#[tokio::test]
async fn a_dry_run_the_server_refuses_is_the_previews_error() {
    let (kube, _eks, ctx) = setup(None).await;
    kube.put(readers());
    kube.fail("PATCH", "clusterrolebindings/readers", 403);
    let error = dry_plan(&ctx, &add(None, "readers", user("bob"))).await.unwrap_err();
    assert_eq!(error, AppError::AccessDenied { action: "patch clusterrolebindings".into() });
}

#[tokio::test]
async fn when_rbac_cannot_be_read_the_change_is_still_planned_but_the_name_is_required() {
    let (kube, _eks, ctx) = setup(None).await;
    kube.put(readers());
    kube.fail("GET", "/rolebindings", 403);
    let plan = dry_plan(&ctx, &add(None, "readers", user("bob"))).await.unwrap();
    assert_eq!(plan.preview.confirm_name.as_deref(), Some("readers"));
    assert!(plan.preview.effect.unwrap().unavailable.unwrap().contains("RBAC 객체를 읽지 못해"));
}

#[tokio::test]
async fn a_config_map_cluster_never_has_its_access_entries_read() {
    let (kube, eks, ctx) = setup(None).await;
    kube.put(readers());
    dry_plan(&ctx, &add(None, "readers", user("bob"))).await.unwrap();
    assert!(eks.sent().iter().all(|s| !s.path.contains("access-entries")));
    // 그래서 그 클러스터에서 access entry를 바꾸려는 시도는 이유와 함께 거절된다
    let error = dry_plan(&ctx, &entry_change(ARN, Operation::AccessEntryGroups { groups: vec!["a".into()] })).await.unwrap_err();
    assert!(error.to_string().contains("CONFIG_MAP"));
}

// ── 일괄 ──

fn batch() -> Vec<Change> {
    let created = clean_object(binding(None, "ops", "ClusterRole", "pods-reader", &[user("carol")]));
    vec![
        change(None, "ops", Operation::BindingCreate { object: created }),
        // 방금 만들 바인딩에 이어서 주체를 더한다
        add(None, "ops", user("dave")),
        change(None, "readers", Operation::Delete),
    ]
}

#[tokio::test]
async fn a_batch_preview_plans_each_change_on_top_of_the_earlier_ones_and_sums_up_who_gains_and_loses() {
    let (kube, _eks, ctx) = setup(None).await;
    kube.put(readers());
    let planned = plan_batch(&ctx, &batch()).await.unwrap();
    let plans: Vec<&Plan> = planned.items.iter().map(|i| i.plan.as_ref().unwrap()).collect();
    assert_eq!([gained(plans[0]), gained(plans[1]), gained(plans[2])], [vec!["carol"], vec!["dave"], vec!["alice"]]);
    // 전체: carol·dave는 얻고 alice는 잃는다
    let total = planned.total.unwrap();
    let mut who: Vec<(String, bool, bool)> = total.subjects.iter().map(|s| (s.subject.name.clone(), !s.gained.is_empty(), !s.lost.is_empty())).collect();
    who.sort();
    assert_eq!(who, vec![("alice".into(), false, true), ("carol".into(), true, false), ("dave".into(), true, false)]);
    // 서버 dry-run은 앞 변경에 기대지 않는 변경에만(만들기와 지우기). 아무것도 적용되지 않았다
    let writes = kube.writes();
    assert_eq!(writes.iter().map(|w| w.method.as_str()).collect::<Vec<_>>(), vec!["POST", "DELETE"]);
    assert!(writes.iter().all(|w| w.dry_run));
}

#[tokio::test]
async fn one_change_that_cannot_be_planned_does_not_hide_the_others() {
    let (kube, _eks, ctx) = setup(None).await;
    kube.put(readers());
    let changes = vec![add(None, "readers", user("bob")), change(None, "missing", Operation::Delete), add(None, "readers", user("carol"))];
    let planned = plan_batch(&ctx, &changes).await.unwrap();
    assert!(planned.items[0].plan.is_ok() && planned.items[2].plan.is_ok());
    assert_eq!(planned.items[1].plan.as_ref().unwrap_err().to_string(), BINDING_MISSING);
    // 실패한 항목은 상태를 바꾸지 않아서 셋째는 첫째 뒤의 상태에서 계획된다
    assert_eq!(gained(planned.items[2].plan.as_ref().unwrap()), vec!["carol"]);
}

#[tokio::test]
async fn a_batch_is_limited_to_fifty_changes_without_repeats_and_never_takes_access_entries() {
    let (_kube, _eks, ctx) = setup(None).await;
    let many: Vec<Change> = (0..51).map(|i| add(None, "readers", user(&format!("u{i}")))).collect();
    assert_eq!(plan_batch(&ctx, &many).await.err(), Some(AppError::other(BATCH_TOO_LARGE)));
    let twice = vec![add(None, "readers", user("a")), add(None, "readers", user("a"))];
    assert_eq!(plan_batch(&ctx, &twice).await.err(), Some(AppError::other(BATCH_DUPLICATE)));
    assert_eq!(plan_batch(&ctx, &[entry_change(ARN, Operation::AccessEntryDelete)]).await.err(), Some(AppError::other(BATCH_NO_EKS)));
}

fn seen_of(planned: &BatchPlan) -> Vec<Plan> {
    planned.items.iter().map(|i| i.plan.clone().unwrap()).collect()
}

#[tokio::test]
async fn a_batch_applies_in_order_including_a_change_that_builds_on_an_earlier_one() {
    let (kube, _eks, ctx) = setup(None).await;
    kube.put(readers());
    let changes = batch();
    let seen = seen_of(&plan_batch(&ctx, &changes).await.unwrap());
    recheck_batch(&ctx, &changes, &seen).await.unwrap();
    let recorded = RefCell::new(Vec::new());
    let outcomes = apply_items(&ctx, &changes, &seen, |i, plan, outcome| {
        recorded.borrow_mut().push((i, plan.inverse.is_some(), outcome.is_ok()));
        true
    })
    .await;
    assert_eq!(outcomes, vec![ItemOutcome::Applied, ItemOutcome::Applied, ItemOutcome::Applied]);
    assert_eq!(names(&kube, "clusterrolebindings", "", "ops"), vec!["carol", "dave"]);
    assert!(kube.get("clusterrolebindings", "", "readers").is_none());
    assert_eq!(recorded.into_inner(), vec![(0, true, true), (1, true, true), (2, true, true)]);
    assert_eq!(kube.applied().iter().map(|w| w.method.as_str()).collect::<Vec<_>>(), vec!["POST", "PATCH", "DELETE"]);
}

#[tokio::test]
async fn a_batch_stops_at_the_first_failure_leaves_the_rest_alone_and_what_was_applied_can_be_undone() {
    let (kube, _eks, ctx) = setup(None).await;
    kube.put(readers());
    kube.put(binding(None, "extra", "ClusterRole", "pods-reader", &[user("zed")]));
    let changes = vec![add(None, "readers", user("bob")), add(None, "extra", user("carol")), add(None, "readers", user("dave"))];
    let seen = seen_of(&plan_batch(&ctx, &changes).await.unwrap());
    // 둘째 항목을 보내는 순간 서버가 거절한다
    kube.fail("PATCH", "clusterrolebindings/extra", 403);
    let mut inverses = Vec::new();
    let outcomes = apply_items(&ctx, &changes, &seen, |i, plan, outcome| {
        if outcome.is_ok() {
            inverses.push((i, plan.inverse.clone().unwrap()));
        }
        true
    })
    .await;
    assert_eq!(outcomes[0], ItemOutcome::Applied);
    assert!(matches!(outcomes[1], ItemOutcome::Failed(AppError::AccessDenied { .. })), "{:?}", outcomes[1]);
    assert_eq!(outcomes[2], ItemOutcome::Skipped);
    assert_eq!(names(&kube, "clusterrolebindings", "", "readers"), vec!["alice", "bob"]);
    assert_eq!(names(&kube, "clusterrolebindings", "", "extra"), vec!["zed"]);
    // 적용한 것의 되돌리기(기록의 역변경)를 적용하면 처음으로 돌아온다
    let (index, undo) = inverses.pop().unwrap();
    assert_eq!(index, 0);
    let seen_undo = seen_of(&plan_batch(&ctx, std::slice::from_ref(&undo)).await.unwrap());
    let outcomes = apply_items(&ctx, std::slice::from_ref(&undo), &seen_undo, |_, _, _| true).await;
    assert_eq!(outcomes, vec![ItemOutcome::Applied]);
    assert_eq!(names(&kube, "clusterrolebindings", "", "readers"), vec!["alice"]);
}

#[tokio::test]
async fn a_failure_to_record_stops_the_batch_after_that_item() {
    let (kube, _eks, ctx) = setup(None).await;
    kube.put(readers());
    let changes = vec![add(None, "readers", user("bob")), add(None, "readers", user("carol"))];
    let seen = seen_of(&plan_batch(&ctx, &changes).await.unwrap());
    let outcomes = apply_items(&ctx, &changes, &seen, |_, _, _| false).await;
    assert_eq!(outcomes, vec![ItemOutcome::Applied, ItemOutcome::Skipped]);
    assert_eq!(names(&kube, "clusterrolebindings", "", "readers"), vec!["alice", "bob"]);
}

#[tokio::test]
async fn nothing_is_applied_when_the_cluster_changed_since_the_batch_preview() {
    let (kube, _eks, ctx) = setup(None).await;
    kube.put(readers());
    let changes = batch();
    let seen = seen_of(&plan_batch(&ctx, &changes).await.unwrap());
    kube.tamper("clusterrolebindings", "", "readers", |o| o["subjects"] = json!([user("alice").to_value(), user("mallory").to_value()]));
    assert_eq!(recheck_batch(&ctx, &changes, &seen).await.unwrap_err(), AppError::other(STALE));
    assert!(kube.applied().is_empty());
}

#[tokio::test]
async fn an_item_whose_binding_changed_while_the_batch_was_applying_fails_instead_of_overwriting() {
    let (kube, _eks, ctx) = setup(None).await;
    kube.put(readers());
    let changes = vec![add(None, "readers", user("bob"))];
    let seen = seen_of(&plan_batch(&ctx, &changes).await.unwrap());
    // 미리보기 뒤 확인(recheck)은 지났지만 항목을 보내기 전에 다른 사람이 주체를 바꿨다
    kube.tamper("clusterrolebindings", "", "readers", |o| o["subjects"] = json!([]));
    let outcomes = apply_items(&ctx, &changes, &seen, |_, _, _| true).await;
    assert_eq!(outcomes, vec![ItemOutcome::Failed(AppError::other(STALE))]);
    assert!(kube.applied().is_empty());
}

// ── access entry ──

fn view_policy() -> (&'static str, Value) {
    (VIEW, json!({"type": "namespace", "namespaces": ["dev"]}))
}

#[tokio::test]
async fn an_access_entry_preview_shows_the_eks_calls_the_engine_effect_and_sends_nothing() {
    let (_kube, eks, ctx) = setup(Some("API_AND_CONFIG_MAP")).await;
    let create = entry_change(ARN, Operation::AccessEntryCreate { username: None, groups: vec!["devs".into()], policies: vec![], entry_type: None });
    let plan = dry_plan(&ctx, &create).await.unwrap();
    assert_eq!(plan.preview.calls[0].path, "/clusters/c/access-entries");
    assert!(eks.writes().is_empty());
    // 새 IAM 주체가 엔진에 나타난다(바인딩이 없어서 얻는 규칙은 없지만 기본 그룹 권한은 그대로다)
    assert!(plan.preview.effect.is_some());
}

#[tokio::test]
async fn creating_an_access_entry_with_a_policy_creates_then_associates_and_the_change_can_be_undone() {
    let (_kube, eks, ctx) = setup(Some("API_AND_CONFIG_MAP")).await;
    let create = entry_change(ARN, Operation::AccessEntryCreate { username: None, groups: vec!["devs".into()], policies: vec![PolicySpec { policy_arn: VIEW.into(), scope: ScopeSpec::Namespaces { namespaces: vec!["dev".into()] } }], entry_type: None });
    let seen = dry_plan(&ctx, &create).await.unwrap();
    let (plan, result) = apply_plan(&ctx, &create, &seen, None).await.unwrap();
    assert_eq!(result, Ok(()));
    let writes: Vec<(String, String)> = eks.writes().iter().map(|w| (w.method.clone(), w.path.clone())).collect();
    assert_eq!(writes, vec![("POST".into(), "/clusters/c/access-entries".into()), ("POST".into(), format!("/clusters/c/access-entries/{ARN}/access-policies"))]);
    let stored = eks.entries();
    assert_eq!(stored[ARN].groups, vec!["devs".to_string()]);
    assert_eq!(stored[ARN].policies, vec![view_policy().0.to_string()].into_iter().zip([view_policy().1]).collect::<Vec<_>>());
    // 되돌리기는 만든 entry를 지운다
    let undo = plan.inverse.unwrap();
    let seen = dry_plan(&ctx, &undo).await.unwrap();
    assert_eq!(apply_plan(&ctx, &undo, &seen, None).await.unwrap().1, Ok(()));
    assert!(eks.entries().is_empty());
}

#[tokio::test]
async fn deleting_an_access_entry_and_undoing_it_restores_its_groups_policies_and_username() {
    let (_kube, eks, ctx) = setup(Some("API_AND_CONFIG_MAP")).await;
    let eks_state = eks.clone().with_entry(ARN, &["devs", "qa"], &[view_policy(), (ADMIN, json!({"type": "cluster"}))]);
    let before = eks_state.entries();
    let delete = entry_change(ARN, Operation::AccessEntryDelete);
    let seen = dry_plan(&ctx, &delete).await.unwrap();
    // 클러스터 관리자 정책이 붙은 entry의 삭제는 이름 입력이 필요하지 않다(권한을 주는 것이 아니라 거두는 것이다)
    assert_eq!(seen.preview.confirm_name, None);
    let (plan, result) = apply_plan(&ctx, &delete, &seen, None).await.unwrap();
    assert_eq!(result, Ok(()));
    assert!(eks.entries().is_empty());
    let undo = plan.inverse.unwrap();
    // 되돌리기 안의 정책 하나가 클러스터 관리자 정책이라 이름을 입력해야 다시 만든다
    let seen = dry_plan(&ctx, &undo).await.unwrap();
    assert_eq!(seen.preview.confirm_name.as_deref(), Some("dev"));
    assert_eq!(apply_plan(&ctx, &undo, &seen, None).await.unwrap_err(), AppError::other(CONFIRM_REQUIRED));
    assert_eq!(apply_plan(&ctx, &undo, &seen, Some("dev")).await.unwrap().1, Ok(()));
    assert_eq!(eks.entries(), before);
}

#[tokio::test]
async fn changing_groups_and_policies_applies_through_the_matching_eks_calls_and_undoes_to_the_old_state() {
    let (_kube, eks, ctx) = setup(Some("API_AND_CONFIG_MAP")).await;
    let eks = eks.with_entry(ARN, &["devs"], &[view_policy()]);
    let before = eks.entries();
    let steps = [
        Operation::AccessEntryGroups { groups: vec!["qa".into()] },
        Operation::AccessPolicyAssociate { policy_arn: VIEW.into(), scope: ScopeSpec::Cluster },
        Operation::AccessPolicyDisassociate { policy_arn: VIEW.into() },
    ];
    let mut undos = Vec::new();
    for step in steps {
        let c = entry_change(ARN, step);
        let seen = dry_plan(&ctx, &c).await.unwrap();
        let (plan, result) = apply_plan(&ctx, &c, &seen, None).await.unwrap();
        assert_eq!(result, Ok(()));
        undos.push(plan.inverse.unwrap());
    }
    let methods: Vec<String> = eks.writes().iter().map(|w| format!("{} {}", w.method, w.path.rsplit_once(ARN).unwrap().1)).collect();
    assert_eq!(methods, vec!["POST ".to_string(), "POST /access-policies".into(), format!("DELETE /access-policies/{VIEW}")]);
    assert_eq!(eks.entries()[ARN].groups, vec!["qa".to_string()]);
    assert!(eks.entries()[ARN].policies.is_empty());
    for undo in undos.into_iter().rev() {
        let seen = dry_plan(&ctx, &undo).await.unwrap();
        assert_eq!(apply_plan(&ctx, &undo, &seen, None).await.unwrap().1, Ok(()));
    }
    assert_eq!(eks.entries(), before);
}

#[tokio::test]
async fn associating_the_cluster_admin_policy_requires_the_name() {
    let (_kube, eks, ctx) = setup(Some("API_AND_CONFIG_MAP")).await;
    let _eks = eks.with_entry(ARN, &[], &[]);
    let c = entry_change(ARN, Operation::AccessPolicyAssociate { policy_arn: ADMIN.into(), scope: ScopeSpec::Cluster });
    let seen = dry_plan(&ctx, &c).await.unwrap();
    assert_eq!(seen.preview.confirm_name.as_deref(), Some("dev"));
    // 클러스터 전체 관리자가 새로 생기는 것으로 엔진도 본다
    assert_eq!(seen.preview.effect.as_ref().unwrap().escalated.len(), 1);
    assert_eq!(apply_plan(&ctx, &c, &seen, Some("nope")).await.unwrap_err(), AppError::other(CONFIRM_REQUIRED));
}

#[tokio::test]
async fn removing_the_apps_own_access_entry_requires_the_name() {
    let (kube, eks, ctx) = setup(Some("API_AND_CONFIG_MAP")).await;
    let _eks = eks.with_entry(ARN, &["devs"], &[(VIEW, json!({"type": "cluster"}))]);
    kube.set_identity("dev-user", &["devs", "system:authenticated"], Some("arn:aws:sts::111122223333:assumed-role/dev/jane"));
    let c = entry_change(ARN, Operation::AccessPolicyDisassociate { policy_arn: VIEW.into() });
    let seen = dry_plan(&ctx, &c).await.unwrap();
    assert!(seen.preview.effect.as_ref().unwrap().loses_own_access);
    assert_eq!(seen.preview.confirm_name.as_deref(), Some("dev"));
    // 다른 주체의 entry를 고치는 것은 이 앱의 권한과 상관없다
    let other = "arn:aws:iam::111122223333:role/other";
    let _ = _eks.with_entry(other, &[], &[(VIEW, json!({"type": "cluster"}))]);
    let c = entry_change(other, Operation::AccessPolicyDisassociate { policy_arn: VIEW.into() });
    let seen = dry_plan(&ctx, &c).await.unwrap();
    assert!(!seen.preview.effect.unwrap().loses_own_access);
    assert_eq!(seen.preview.confirm_name, None);
}

#[tokio::test]
async fn an_access_entry_created_by_someone_else_after_the_preview_stops_the_apply() {
    let (_kube, eks, ctx) = setup(Some("API_AND_CONFIG_MAP")).await;
    let create = entry_change(ARN, Operation::AccessEntryCreate { username: None, groups: vec![], policies: vec![], entry_type: None });
    let seen = dry_plan(&ctx, &create).await.unwrap();
    let _eks = eks.with_entry(ARN, &[], &[]);
    // 다시 계획하면 이미 있는 주체라서 계획 자체가 거절된다
    let error = apply_plan(&ctx, &create, &seen, None).await.unwrap_err();
    assert_eq!(error, AppError::other(crate::k8s::rbac::eks::ENTRY_EXISTS));
}

#[tokio::test]
async fn a_policy_that_fails_to_associate_removes_the_entry_it_just_created() {
    let (_kube, eks, ctx) = setup(Some("API_AND_CONFIG_MAP")).await;
    eks.fail("POST", "/access-policies", 400, "InvalidParameterException");
    let create = entry_change(ARN, Operation::AccessEntryCreate { username: None, groups: vec![], policies: vec![PolicySpec { policy_arn: VIEW.into(), scope: ScopeSpec::Cluster }], entry_type: None });
    let seen = dry_plan(&ctx, &create).await.unwrap();
    let (_, result) = apply_plan(&ctx, &create, &seen, None).await.unwrap();
    let message = result.unwrap_err().to_string();
    assert!(message.contains("다시 지웠어요"), "{message}");
    assert!(eks.entries().is_empty());
    let writes = eks.writes();
    assert_eq!(writes.iter().map(|w| w.method.as_str()).collect::<Vec<_>>(), vec!["POST", "POST", "DELETE"]);
}

#[tokio::test]
async fn a_denied_eks_write_comes_back_as_access_denied_with_the_action() {
    let (_kube, eks, ctx) = setup(Some("API_AND_CONFIG_MAP")).await;
    let eks = eks.with_entry(ARN, &["devs"], &[]);
    eks.fail("POST", ARN, 403, "AccessDeniedException");
    let c = entry_change(ARN, Operation::AccessEntryGroups { groups: vec!["qa".into()] });
    let seen = dry_plan(&ctx, &c).await.unwrap();
    let (_, result) = apply_plan(&ctx, &c, &seen, None).await.unwrap();
    assert_eq!(result, Err(AppError::AccessDenied { action: "eks:UpdateAccessEntry".into() }));
    assert_eq!(eks.entries()[ARN].groups, vec!["devs".to_string()]);
}

#[tokio::test]
async fn when_access_entries_cannot_be_listed_rbac_changes_still_plan_and_entry_changes_are_refused() {
    let (kube, eks, ctx) = setup(Some("API_AND_CONFIG_MAP")).await;
    kube.put(readers());
    eks.fail("GET", "/clusters/c/access-entries", 403, "AccessDeniedException");
    let rbac_plan = dry_plan(&ctx, &add(None, "readers", user("bob"))).await.unwrap();
    assert!(rbac_plan.preview.effect.unwrap().unavailable.unwrap().contains("access entry를 읽지 못해"));
    assert_eq!(rbac_plan.preview.confirm_name.as_deref(), Some("readers"));
    let error = dry_plan(&ctx, &entry_change(ARN, Operation::AccessEntryDelete)).await.unwrap_err();
    assert!(error.to_string().contains("eks:ListAccessEntries"), "{error}");
}
