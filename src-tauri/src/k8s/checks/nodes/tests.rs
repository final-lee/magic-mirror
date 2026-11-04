use super::*;
use crate::k8s::checks::LaunchTemplateImds;

fn group(name: &str, hop: Option<i32>) -> NodegroupImds {
    NodegroupImds { name: name.into(), launch_template: Some(LaunchTemplateImds { label: "lt-0abc v3".into(), hop_limit: hop }) }
}

fn node(name: &str, hop: Option<i32>, group: Option<&str>, pool: Option<&str>) -> NodeImds {
    NodeImds { name: name.into(), instance_id: format!("i-{name}"), nodegroup: group.map(str::to_string), nodepool: pool.map(str::to_string), hop_limit: hop }
}

#[test]
fn a_launch_template_with_hop_limit_two_flags_its_nodegroup() {
    let found = check_imds(Some(&[group("ng-a", Some(2)), group("ng-b", Some(1))]), None);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].check, CheckId::ImdsHopLimit);
    assert_eq!(found[0].severity, Severity::High);
    assert_eq!(found[0].target, Target::Aws { resource: "nodegroup".into(), name: "ng-a".into() });
    assert!(found[0].evidence[0].contains("lt-0abc v3") && found[0].evidence[0].contains("HttpPutResponseHopLimit=2"), "{:?}", found[0].evidence);
    assert!(found[0].message.contains("노드그룹 ng-a"));
}

#[test]
fn hop_limit_one_unknown_and_no_template_are_all_fine() {
    let no_template = NodegroupImds { name: "ng-c".into(), launch_template: None };
    assert!(check_imds(Some(&[group("a", Some(1)), group("b", None), no_template]), Some(&[node("n1", Some(1), Some("a"), None), node("n2", None, Some("b"), None)])).is_empty());
}

#[test]
fn larger_hop_limits_count_and_the_message_shows_the_highest() {
    let found = check_imds(Some(&[group("ng-a", Some(3))]), Some(&[node("n1", Some(2), Some("ng-a"), None)]));
    assert_eq!(found.len(), 1);
    assert!(found[0].message.contains("hop limit이 3"), "{}", found[0].message);
}

#[test]
fn instances_of_one_nodegroup_merge_with_its_template_into_one_finding() {
    let found = check_imds(Some(&[group("ng-a", Some(2))]), Some(&[node("n1", Some(2), Some("ng-a"), None), node("n2", Some(2), Some("ng-a"), None), node("n3", Some(1), Some("ng-a"), None)]));
    assert_eq!(found.len(), 1);
    let evidence = &found[0].evidence;
    assert!(evidence.iter().any(|e| e.contains("시작 템플릿")));
    assert!(evidence.iter().any(|e| e.contains("n1")) && evidence.iter().any(|e| e.contains("n2")));
    assert!(!evidence.iter().any(|e| e.contains("n3")), "hop limit 1인 노드는 증거에 없다");
}

#[test]
fn instance_settings_flag_a_group_even_when_its_template_says_one() {
    // 시작 템플릿을 고쳤지만 이미 떠 있는 노드는 그대로인 경우
    let found = check_imds(Some(&[group("ng-a", Some(1))]), Some(&[node("n1", Some(2), Some("ng-a"), None)]));
    assert_eq!(found.len(), 1);
    assert!(found[0].evidence[0].contains("노드 n1(i-n1)"));
}

#[test]
fn karpenter_nodes_group_by_nodepool_and_unmanaged_nodes_stand_alone() {
    let found = check_imds(None, Some(&[node("k1", Some(2), None, Some("default")), node("k2", Some(2), None, Some("default")), node("solo", Some(2), None, None)]));
    let targets: Vec<Target> = found.iter().map(|f| f.target.clone()).collect();
    assert_eq!(targets, [Target::Aws { resource: "instance".into(), name: "i-solo".into() }, Target::Aws { resource: "nodepool".into(), name: "default".into() }]);
    assert!(found[1].message.contains("NodePool default"));
}

#[test]
fn unreadable_inputs_produce_nothing() {
    assert!(check_imds(None, None).is_empty());
}
