use super::*;

fn client(name: &str, flags: &str, cmd: &str, addr: &str) -> KvClient {
    KvClient { node: "n".into(), id: "1".into(), addr: addr.into(), name: name.into(), user: String::new(), db: 0, age: 9, idle: 2, cmd: cmd.into(), flags: flags.into(), own: false }
}

#[test]
fn worker_names_decode_to_their_queue() {
    let base = STANDARD.encode("emails");
    assert_eq!(decode_worker_queue("bull", &format!("bull:{base}")).as_deref(), Some("emails"));
    assert_eq!(decode_worker_queue("bull", &format!("bull:{base}:w:mailer-1")).as_deref(), Some("emails"));
    let tagged = STANDARD.encode("a:b");
    assert_eq!(decode_worker_queue("{bull}", &format!("{{bull}}:{tagged}:w:x")).as_deref(), Some("a:b"));
    assert_eq!(decode_worker_queue("bull", &format!("other:{base}")), None);
    assert_eq!(decode_worker_queue("bull", "bull:!!!not-base64"), None);
    assert_eq!(decode_worker_queue("bull", "bull:"), None);
    assert_eq!(decode_worker_queue("bull", ""), None);
}

#[test]
fn hosts_drop_the_port() {
    assert_eq!(host_of("10.0.0.5:51234"), "10.0.0.5");
    assert_eq!(host_of("[::1]:6379"), "::1");
    assert_eq!(host_of("nohostport"), "nohostport");
}

#[test]
fn workers_come_from_named_connections_and_blocked_queue_connections() {
    let emails = STANDARD.encode("emails");
    let reports = STANDARD.encode("reports");
    let list = vec![
        client(&format!("bull:{emails}:w:mailer"), "N", "get", "10.0.0.5:1"),
        client(&format!("bull:{emails}"), "b", "bzpopmin", "10.0.0.6:2"),
        client(&format!("bull:{emails}"), "N", "get", "10.0.0.7:3"),
        client(&format!("bull:{reports}:w:"), "N", "get", "10.0.0.5:4"),
        client("unrelated", "b", "blpop", "10.0.0.8:5"),
    ];
    let workers = workers_of(&list, "bull");
    let flat: Vec<(&str, &str, &str)> = workers.iter().map(|w| (w.queue.as_str(), w.name.as_str(), w.host.as_str())).collect();
    assert_eq!(flat, vec![("emails", "mailer", "10.0.0.5"), ("emails", "", "10.0.0.6"), ("reports", "", "10.0.0.5")]);
    assert_eq!((workers[0].age, workers[0].idle, workers[0].addr.as_str()), (9, 2, "10.0.0.5:1"));
}

#[test]
fn the_sample_takes_turns_between_sources_and_stops_at_the_cap() {
    let a: Vec<String> = ["a1", "a2", "a3"].map(String::from).to_vec();
    let b: Vec<String> = ["b1"].map(String::from).to_vec();
    let c: Vec<String> = ["c1", "a1", "c3"].map(String::from).to_vec();
    assert_eq!(take_balanced(vec![a.clone(), b.clone(), vec![], c.clone()], 10), vec!["a1", "b1", "c1", "a2", "a3", "c3"]);
    assert_eq!(take_balanced(vec![a, b, c], 3), vec!["a1", "b1", "c1"]);
    assert!(take_balanced(vec![], 5).is_empty());
}

#[test]
fn parent_queues_are_named_relative_to_the_prefix() {
    assert_eq!(parent_queue_name("bull", "bull:parents:1").as_deref(), Some("parents"));
    assert_eq!(parent_queue_name("bull", "other:billing:9").as_deref(), Some("other:billing"));
    assert_eq!(parent_queue_name("bull", "garbage"), None);
}

#[test]
fn links_are_counted_per_queue_pair_most_jobs_first() {
    let pair = |a: &str, b: &str| (a.to_string(), b.to_string());
    let links = aggregate_links(&[pair("orders", "emails"), pair("orders", "emails"), pair("orders", "billing"), pair("orders", "emails"), pair("emails", "emails")]);
    let flat: Vec<(&str, &str, u64)> = links.iter().map(|l| (l.from.as_str(), l.to.as_str(), l.jobs)).collect();
    assert_eq!(flat, vec![("orders", "emails", 3), ("emails", "emails", 1), ("orders", "billing", 1)]);
    assert!(aggregate_links(&[]).is_empty());
}

#[test]
fn the_sample_per_queue_follows_the_design() {
    assert_eq!(SAMPLE_PER_QUEUE, 50);
}
