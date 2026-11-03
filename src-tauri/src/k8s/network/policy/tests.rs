use serde_json::json;

use super::*;

fn policy(namespace: &str, name: &str, spec: Value) -> DynamicObject {
    serde_json::from_value(json!({
        "apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy",
        "metadata": { "namespace": namespace, "name": name }, "spec": spec,
    }))
    .unwrap()
}

#[test]
fn selectors_are_written_in_the_kubectl_label_syntax() {
    let s = json!({
        "matchLabels": { "tier": "web", "app": "shop" },
        "matchExpressions": [
            { "key": "env", "operator": "In", "values": ["prod", "stg"] },
            { "key": "legacy", "operator": "NotIn", "values": ["true"] },
            { "key": "canary", "operator": "DoesNotExist" },
            { "key": "managed", "operator": "Exists" },
        ],
    });
    // matchLabels는 키 순서로, 그 뒤에 표현식
    assert_eq!(selector_text(&s), "app=shop, tier=web, env in (prod,stg), legacy notin (true), !canary, managed");
}

#[test]
fn an_empty_selector_selects_everything_and_is_an_empty_text() {
    assert_eq!(selector_text(&json!({})), "");
    assert_eq!(selector_text(&json!({ "matchLabels": {}, "matchExpressions": [] })), "");
}

#[test]
fn policy_types_default_to_ingress_plus_egress_only_when_egress_rules_exist() {
    let only_ingress = policy_view(&policy("a", "p", json!({ "podSelector": {} })));
    assert_eq!(only_ingress.types, ["Ingress"]);
    // egress가 빈 목록이면 규칙이 없는 것이다
    assert_eq!(policy_view(&policy("a", "p", json!({ "podSelector": {}, "egress": [] }))).types, ["Ingress"]);
    let with_egress = policy_view(&policy("a", "p", json!({ "podSelector": {}, "egress": [{ "to": [{ "ipBlock": { "cidr": "0.0.0.0/0" } }] }] })));
    assert_eq!(with_egress.types, ["Ingress", "Egress"]);
}

#[test]
fn explicit_policy_types_win_even_without_rules() {
    // Egress만 고르고 규칙을 비우면 나가는 트래픽을 모두 막는 정책이다
    let v = policy_view(&policy("a", "deny-egress", json!({ "podSelector": {}, "policyTypes": ["Egress"] })));
    assert_eq!(v.types, ["Egress"]);
    assert!(v.egress.is_empty());
    assert!(v.ingress.is_empty());
}

#[test]
fn ingress_rules_keep_peers_and_ports_apart() {
    let v = policy_view(&policy(
        "shop",
        "allow-web",
        json!({
            "podSelector": { "matchLabels": { "app": "api" } },
            "ingress": [{
                "from": [
                    { "podSelector": { "matchLabels": { "app": "web" } } },
                    { "namespaceSelector": { "matchLabels": { "team": "edge" } }, "podSelector": {} },
                    { "ipBlock": { "cidr": "10.0.0.0/8", "except": ["10.1.0.0/16"] } },
                ],
                "ports": [{ "protocol": "TCP", "port": 8080 }, { "port": "metrics" }, { "port": 9000, "endPort": 9100, "protocol": "UDP" }],
            }],
        }),
    ));
    assert_eq!(v.pod_selector, "app=api");
    let rule = &v.ingress[0];
    assert_eq!(rule.peers[0], Peer { pod_selector: Some("app=web".into()), namespace_selector: None, ip_block: None });
    // 같은 항목의 두 셀렉터는 함께 적용된다(AND)
    assert_eq!(rule.peers[1], Peer { pod_selector: Some(String::new()), namespace_selector: Some("team=edge".into()), ip_block: None });
    assert_eq!(rule.peers[2].ip_block, Some(IpBlock { cidr: "10.0.0.0/8".into(), except: vec!["10.1.0.0/16".into()] }));
    assert_eq!(
        rule.ports,
        [
            PortRule { protocol: "TCP".into(), port: Some("8080".into()), end_port: None },
            // 프로토콜을 비우면 TCP, 이름 있는 포트는 그대로
            PortRule { protocol: "TCP".into(), port: Some("metrics".into()), end_port: None },
            PortRule { protocol: "UDP".into(), port: Some("9000".into()), end_port: Some(9100) },
        ]
    );
}

#[test]
fn egress_peers_are_read_from_to_not_from() {
    let v = policy_view(&policy(
        "a",
        "p",
        json!({ "podSelector": {}, "egress": [{ "to": [{ "ipBlock": { "cidr": "1.2.3.0/24" } }], "from": [{ "podSelector": {} }] }] }),
    ));
    assert_eq!(v.egress[0].peers.len(), 1);
    assert_eq!(v.egress[0].peers[0].ip_block.as_ref().unwrap().cidr, "1.2.3.0/24");
}

#[test]
fn a_rule_without_peers_or_ports_allows_everything_and_is_kept() {
    // `ingress: [{}]`는 모두 허용, `ingress` 없음(Ingress 종류)은 모두 차단. 둘을 가를 수 있어야 한다.
    let allow_all = policy_view(&policy("a", "allow-all", json!({ "podSelector": {}, "ingress": [{}], "policyTypes": ["Ingress"] })));
    assert_eq!(allow_all.ingress, [PolicyRule { peers: vec![], ports: vec![] }]);
    let deny_all = policy_view(&policy("a", "deny-all", json!({ "podSelector": {}, "policyTypes": ["Ingress"] })));
    assert!(deny_all.ingress.is_empty());
    assert_eq!(deny_all.types, ["Ingress"]);
}

#[test]
fn namespaces_without_any_policy_are_counted_as_zero_and_system_ones_are_marked() {
    let policies = [
        policy_view(&policy("shop", "a", json!({}))),
        policy_view(&policy("shop", "b", json!({}))),
        policy_view(&policy("kube-system", "c", json!({}))),
        // 목록에 없는 네임스페이스(지워졌거나 권한이 없는)의 정책은 새 항목을 만들지 않는다
        policy_view(&policy("ghost", "d", json!({}))),
    ];
    let names: Vec<String> = ["zeta", "shop", "kube-system", "amazon-cloudwatch", "kube-node-lease", "kube-public", "team-amazon"].iter().map(|s| s.to_string()).collect();
    let out = namespace_policies(&names, &policies);
    let view: Vec<(&str, usize, bool)> = out.iter().map(|n| (n.name.as_str(), n.policies, n.system)).collect();
    assert_eq!(
        view,
        [
            ("amazon-cloudwatch", 0, true),
            ("kube-node-lease", 0, true),
            ("kube-public", 0, true),
            ("kube-system", 1, true),
            ("shop", 2, false),
            // `amazon-` 접두만 시스템이다
            ("team-amazon", 0, false),
            ("zeta", 0, false),
        ]
    );
}
