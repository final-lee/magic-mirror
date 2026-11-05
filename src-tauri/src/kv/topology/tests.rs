use fred::types::Value;

use super::*;

fn s(text: &str) -> Value {
    Value::from(text)
}

fn i(n: i64) -> Value {
    Value::Integer(n)
}

fn arr(items: Vec<Value>) -> Value {
    Value::Array(items)
}

/// CLUSTER SHARDS의 노드 하나(RESP2: 평평한 배열)
fn shard_node(id: &str, endpoint: &str, ip: &str, port: i64, role: &str) -> Value {
    arr(vec![
        s("id"), s(id), s("port"), i(port), s("ip"), s(ip), s("endpoint"), s(endpoint), s("hostname"), s(""), s("role"), s(role), s("replication-offset"), i(100), s("health"), s("online"),
    ])
}

fn shard(slots: &[(i64, i64)], nodes: Vec<Value>) -> Value {
    let flat: Vec<Value> = slots.iter().flat_map(|(a, b)| [i(*a), i(*b)]).collect();
    arr(vec![s("slots"), arr(flat), s("nodes"), arr(nodes)])
}

#[test]
#[allow(clippy::type_complexity)]
fn shards_become_nodes_sorted_by_first_slot() {
    let reply = arr(vec![
        shard(&[(10923, 16383)], vec![shard_node("c1", "c1.cache.amazonaws.com", "10.0.0.3", 6379, "master"), shard_node("c2", "c2.cache.amazonaws.com", "10.0.0.6", 6379, "replica")]),
        shard(
            &[(0, 5460), (7000, 7000)],
            vec![shard_node("a2", "a2.cache.amazonaws.com", "10.0.0.5", 6379, "replica"), shard_node("a1", "a1.cache.amazonaws.com", "10.0.0.1", 6379, "master")],
        ),
        shard(&[(5461, 10922)], vec![shard_node("b1", "b1.cache.amazonaws.com", "10.0.0.2", 6379, "master")]),
    ]);
    let nodes = nodes_from_shards(&reply, true);
    let summary: Vec<(&str, &str, KvRole, Option<&str>, Option<&str>)> =
        nodes.iter().map(|n| (n.id.as_str(), n.address.as_str(), n.role, n.shard.as_deref(), n.slots.as_deref())).collect();
    assert_eq!(
        summary,
        vec![
            ("a1", "a1.cache.amazonaws.com:6379", KvRole::Primary, Some("0001"), Some("0-5460,7000")),
            ("a2", "a2.cache.amazonaws.com:6379", KvRole::Replica, Some("0001"), None),
            ("b1", "b1.cache.amazonaws.com:6379", KvRole::Primary, Some("0002"), Some("5461-10922")),
            ("c1", "c1.cache.amazonaws.com:6379", KvRole::Primary, Some("0003"), Some("10923-16383")),
            ("c2", "c2.cache.amazonaws.com:6379", KvRole::Replica, Some("0003"), None),
        ]
    );
}

#[test]
fn a_node_without_a_preferred_endpoint_falls_back_to_hostname_then_ip() {
    let unknown = arr(vec![s("id"), s("n"), s("port"), i(7000), s("ip"), s("10.1.1.1"), s("endpoint"), s("?"), s("hostname"), s("h.example"), s("role"), s("master")]);
    let ip_only = arr(vec![s("id"), s("m"), s("port"), i(7001), s("ip"), s("10.1.1.2"), s("endpoint"), s(""), s("role"), s("replica")]);
    let nodes = nodes_from_shards(&arr(vec![shard(&[(0, 16383)], vec![unknown, ip_only])]), false);
    assert_eq!(nodes.iter().map(|n| n.address.as_str()).collect::<Vec<_>>(), vec!["h.example:7000", "10.1.1.2:7001"]);
}

#[test]
fn tls_clusters_prefer_the_tls_port() {
    let node = arr(vec![s("id"), s("n"), s("port"), i(6379), s("tls-port"), i(6380), s("endpoint"), s("h"), s("role"), s("master")]);
    let reply = arr(vec![shard(&[(0, 16383)], vec![node])]);
    assert_eq!(nodes_from_shards(&reply, true)[0].address, "h:6380");
    assert_eq!(nodes_from_shards(&reply, false)[0].address, "h:6379");
}

#[test]
fn nodes_without_an_address_are_skipped_and_garbage_gives_no_nodes() {
    let broken = arr(vec![s("id"), s("x"), s("role"), s("master")]);
    assert!(nodes_from_shards(&arr(vec![shard(&[(0, 1)], vec![broken])]), false).is_empty());
    assert!(nodes_from_shards(&Value::Null, false).is_empty());
    assert!(nodes_from_shards(&arr(vec![s("nonsense")]), false).is_empty());
}

fn slot_entry(start: i64, end: i64, nodes: Vec<(&str, i64, &str)>) -> Value {
    let mut parts = vec![i(start), i(end)];
    parts.extend(nodes.into_iter().map(|(host, port, id)| arr(vec![s(host), i(port), s(id)])));
    arr(parts)
}

#[test]
fn slots_become_the_same_nodes_when_shards_are_unknown() {
    let reply = arr(vec![
        slot_entry(5461, 10922, vec![("10.0.0.2", 6379, "b1")]),
        slot_entry(0, 100, vec![("10.0.0.1", 6379, "a1"), ("10.0.0.5", 6379, "a2")]),
        // 같은 기본 노드의 다른 범위는 같은 샤드에 모인다
        slot_entry(101, 5460, vec![("10.0.0.1", 6379, "a1"), ("10.0.0.5", 6379, "a2")]),
    ]);
    let nodes = nodes_from_slots(&reply, "seed.example");
    assert_eq!(nodes.len(), 3);
    assert_eq!((nodes[0].id.as_str(), nodes[0].slots.as_deref(), nodes[0].shard.as_deref()), ("a1", Some("0-100,101-5460"), Some("0001")));
    assert_eq!((nodes[1].id.as_str(), nodes[1].role, nodes[1].slots.clone()), ("a2", KvRole::Replica, None));
    assert_eq!((nodes[2].address.as_str(), nodes[2].shard.as_deref()), ("10.0.0.2:6379", Some("0002")));
}

#[test]
fn an_empty_slots_host_means_the_seed_host() {
    let nodes = nodes_from_slots(&arr(vec![slot_entry(0, 16383, vec![("", 6379, "only")])]), "seed.example");
    assert_eq!(nodes[0].address, "seed.example:6379");
}

#[test]
fn addresses_split_at_the_last_colon() {
    assert_eq!(split_address("host.example:6379"), Some(("host.example".to_string(), 6379)));
    assert_eq!(split_address("[::1]:6380"), Some(("::1".to_string(), 6380)));
    assert_eq!(split_address("nohost"), None);
    assert_eq!(split_address("h:notaport"), None);
}
