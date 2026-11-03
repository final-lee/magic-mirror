use super::*;
use crate::k8s::access::rbac::Subject;
use crate::k8s::change::Operation;
use crate::k8s::rbac::tests::fixtures::*;
use crate::k8s::rbac::tests::{binding, change, entry_change, group, user, ARN};
use crate::k8s::change::clean_object;
use crate::k8s::rbac::SubjectSpec;
use crate::k8s::review::IdentitySource;

fn dev_entry(groups: &[&str]) -> EntryInput {
    EntryInput {
        principal_arn: ARN.into(),
        entry_type: Some("STANDARD".into()),
        username: Some("dev-user".into()),
        groups: groups.iter().map(|g| g.to_string()).collect(),
        policies: vec![],
        read_error: None,
    }
}

/// `objects`는 클러스터에 있는 바인딩(서버에서 읽은 모양). 같은 것이 RBAC 객체 모음에도 들어간다.
fn world(objects: Vec<serde_json::Value>, entries: Vec<EntryInput>) -> World {
    let mut world = World {
        cluster: "c".into(),
        rbac: rbac_with(vec![cluster_role("pods-reader", vec![rule(&["get", "list"], &[""], &["pods"])])], vec![], vec![], vec![]),
        entries,
        entries_error: None,
        aws_auth: None,
        mode: AuthMode::ApiAndConfigMap,
        bindings: BTreeMap::new(),
        gaps: vec![],
    };
    for object in objects {
        let key: BindingKey = (
            object["kind"].as_str().unwrap().to_string(),
            object["metadata"]["namespace"].as_str().unwrap_or_default().to_string(),
            object["metadata"]["name"].as_str().unwrap().to_string(),
        );
        world.set_binding(&key, Some(&object));
        world.bindings.insert(key, Some(object));
    }
    world
}

fn missing(world: &mut World, namespace: Option<&str>, name: &str) {
    let kind = if namespace.is_some() { "RoleBinding" } else { "ClusterRoleBinding" };
    world.bindings.insert((kind.into(), namespace.unwrap_or_default().into(), name.into()), None);
}

fn add_subject(namespace: Option<&str>, name: &str, subject: SubjectSpec) -> Change {
    change(namespace, name, Operation::BindingSubjects { add: vec![subject], remove: vec![] })
}

fn readers() -> serde_json::Value {
    binding(None, "readers", "ClusterRole", "pods-reader", &[user("alice")])
}

fn gains(plan: &Plan) -> Vec<Subject> {
    plan.preview.effect.as_ref().unwrap().subjects.iter().map(|s| s.subject.clone()).collect()
}

#[test]
fn a_plan_carries_who_gains_what_from_the_change() {
    let mut planner = Planner::new(world(vec![readers()], vec![]), None, false);
    let plan = planner.plan(&add_subject(None, "readers", user("bob"))).unwrap();
    assert_eq!(gains(&plan), vec![Subject::user("bob")]);
    let effect = plan.preview.effect.unwrap();
    assert!(effect.subjects[0].gained.iter().any(|c| c.resource == "pods" && c.verbs == vec!["get".to_string(), "list".to_string()]));
    assert!(effect.escalated.is_empty());
    assert_eq!(plan.preview.confirm_name, None);
}

#[test]
fn a_change_is_planned_on_top_of_the_earlier_ones() {
    // 방금 만든 바인딩에 이어서 주체를 더해도 계획이 서고, 둘째 변경의 영향은 첫째 변경이 적용된 상태에서 잰다
    let created = binding(None, "ops", "ClusterRole", "pods-reader", &[user("alice")]);
    let mut start = world(vec![], vec![]);
    missing(&mut start, None, "ops");
    let mut planner = Planner::new(start, None, true);
    let create = change(None, "ops", Operation::BindingCreate { object: clean_object(created) });
    let first = planner.plan(&create).unwrap();
    assert_eq!(gains(&first), vec![Subject::user("alice")]);
    let second = planner.plan(&add_subject(None, "ops", user("bob"))).unwrap();
    assert_eq!(gains(&second), vec![Subject::user("bob")]);
    // 둘째 변경의 되돌리기는 방금 더한 주체만 뺀다
    assert_eq!(second.inverse, Some(change(None, "ops", Operation::BindingSubjects { add: vec![], remove: vec![user("bob")] })));
    let total = planner.total().unwrap();
    assert_eq!(total.subjects.iter().map(|s| s.subject.clone()).collect::<Vec<_>>(), vec![Subject::user("alice"), Subject::user("bob")]);
}

#[test]
fn two_edits_to_the_same_binding_accumulate() {
    let mut planner = Planner::new(world(vec![readers()], vec![]), None, false);
    planner.plan(&add_subject(None, "readers", user("bob"))).unwrap();
    // bob은 이미 더해졌으니 다시 더해도 바뀌는 것이 없다
    let again = planner.plan(&add_subject(None, "readers", user("bob"))).unwrap();
    assert!(again.preview.diff.is_empty());
    assert!(again.preview.effect.unwrap().subjects.is_empty());
    let remove = planner.plan(&change(None, "readers", Operation::BindingSubjects { add: vec![], remove: vec![user("alice"), user("bob")] })).unwrap();
    assert_eq!(remove.preview.diff.len(), 2);
}

#[test]
fn a_change_that_fails_to_plan_leaves_the_state_as_it_was() {
    let mut planner = Planner::new(world(vec![readers()], vec![]), None, true);
    let bad = add_subject(None, "readers", SubjectSpec { namespace: None, ..crate::k8s::rbac::tests::sa("dev", "web") });
    assert!(planner.plan(&bad).is_err());
    // 읽어 두지 않은 바인딩도 계획하지 못한다
    assert!(planner.plan(&add_subject(None, "never-read", user("x"))).is_err());
    let ok = planner.plan(&add_subject(None, "readers", user("bob"))).unwrap();
    assert_eq!(gains(&ok), vec![Subject::user("bob")]);
    assert_eq!(planner.total().unwrap().total, 1);
}

#[test]
fn creating_then_deleting_the_same_binding_changes_nothing_overall() {
    let mut start = world(vec![], vec![]);
    missing(&mut start, None, "tmp");
    let mut planner = Planner::new(start, None, true);
    let object = clean_object(binding(None, "tmp", "ClusterRole", "pods-reader", &[user("alice")]));
    planner.plan(&change(None, "tmp", Operation::BindingCreate { object })).unwrap();
    let removal = planner.plan(&change(None, "tmp", Operation::Delete)).unwrap();
    assert_eq!(gains(&removal), vec![Subject::user("alice")]);
    assert!(planner.total().unwrap().subjects.is_empty());
}

#[test]
fn adding_a_subject_to_a_cluster_admin_binding_flags_the_escalation_and_requires_the_name() {
    let admin = binding(None, "ops", "ClusterRole", "cluster-admin", &[user("alice")]);
    let mut planner = Planner::new(world(vec![admin], vec![]), None, false);
    let plan = planner.plan(&add_subject(None, "ops", user("bob"))).unwrap();
    assert_eq!(plan.preview.effect.unwrap().escalated, vec![Subject::user("bob")]);
    assert_eq!(plan.preview.confirm_name.as_deref(), Some("ops"));
}

#[test]
fn an_unreadable_cluster_still_plans_but_asks_for_the_name_and_says_why() {
    let mut w = world(vec![readers()], vec![]);
    w.gaps.push("RBAC 객체를 읽지 못해 영향을 계산하지 못했어요: denied".into());
    let plan = Planner::new(w, None, false).plan(&add_subject(None, "readers", user("bob"))).unwrap();
    assert_eq!(plan.preview.confirm_name.as_deref(), Some("readers"));
    assert!(plan.preview.effect.unwrap().unavailable.unwrap().contains("denied"));
}

fn identity() -> Identity {
    Identity { username: "dev-user".into(), groups: vec!["system:authenticated".into()], arn: Some("arn:aws:sts::111122223333:assumed-role/dev/jane".into()), source: IdentitySource::SelfSubjectReview }
}

#[test]
fn a_change_that_removes_the_apps_own_access_requires_the_name() {
    let devs = binding(None, "devs-read", "ClusterRole", "pods-reader", &[group("devs")]);
    let mut planner = Planner::new(world(vec![devs], vec![dev_entry(&["devs"])]), Some(&identity()), false);
    let plan = planner.plan(&change(None, "devs-read", Operation::Delete)).unwrap();
    let effect = plan.preview.effect.unwrap();
    assert!(effect.loses_own_access);
    assert_eq!(plan.preview.confirm_name.as_deref(), Some("devs-read"));
}

#[test]
fn a_change_that_only_affects_others_does_not_ask_the_apps_identity_to_confirm() {
    let readers = binding(None, "readers", "ClusterRole", "pods-reader", &[user("alice")]);
    let mut planner = Planner::new(world(vec![readers], vec![dev_entry(&["devs"])]), Some(&identity()), false);
    let plan = planner.plan(&change(None, "readers", Operation::Delete)).unwrap();
    assert!(!plan.preview.effect.unwrap().loses_own_access);
    assert_eq!(plan.preview.confirm_name, None);
}

#[test]
fn dropping_the_group_from_the_apps_own_access_entry_is_an_own_access_loss_too() {
    let devs = binding(None, "devs-read", "ClusterRole", "pods-reader", &[group("devs")]);
    let mut planner = Planner::new(world(vec![devs], vec![dev_entry(&["devs"])]), Some(&identity()), false);
    let plan = planner.plan(&entry_change(ARN, Operation::AccessEntryGroups { groups: vec![] })).unwrap();
    assert!(plan.preview.effect.unwrap().loses_own_access);
    assert_eq!(plan.preview.confirm_name.as_deref(), Some("dev"));
}

#[test]
fn an_access_entry_change_is_refused_when_the_entries_could_not_be_read() {
    let mut w = world(vec![], vec![dev_entry(&[])]);
    w.entries_error = Some("eks:ListAccessEntries 권한이 없어요".into());
    let mut planner = Planner::new(w, None, false);
    let error = planner.plan(&entry_change(ARN, Operation::AccessEntryGroups { groups: vec!["a".into()] })).unwrap_err();
    assert!(error.to_string().contains("ListAccessEntries"));
}

#[test]
fn a_cart_is_limited_in_size_and_may_not_repeat_a_change() {
    let one = add_subject(None, "readers", user("bob"));
    assert!(check_batch(&[one.clone(), add_subject(None, "readers", user("carol"))]).is_ok());
    assert_eq!(check_batch(&[one.clone(), one.clone()]).unwrap_err(), AppError::other(BATCH_DUPLICATE));
    let many: Vec<Change> = (0..=BATCH_MAX).map(|i| add_subject(None, "readers", user(&format!("u{i}")))).collect();
    assert_eq!(check_batch(&many).unwrap_err(), AppError::other(BATCH_TOO_LARGE));
    assert!(check_batch(&many[..BATCH_MAX]).is_ok());
}

#[test]
fn only_binding_changes_name_a_binding_to_read() {
    assert!(binding_target(&add_subject(None, "readers", user("bob"))).is_some());
    assert!(binding_target(&entry_change(ARN, Operation::AccessEntryDelete)).is_none());
    let key = binding_key(&add_subject(Some("dev"), "b", user("x")).target);
    assert_eq!(key, ("RoleBinding".to_string(), "dev".to_string(), "b".to_string()));
}
