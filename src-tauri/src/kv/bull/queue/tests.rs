use super::*;

#[test]
fn the_discovery_cursor_round_trips() {
    let scan = ScanCursor { nodes: vec![("-".into(), "123".into())] };
    let text = encode_cursor(1, &scan);
    let (phase, back) = decode_cursor(&text).unwrap();
    assert_eq!(phase, 1);
    assert_eq!(back, scan);
}

#[test]
fn a_bad_discovery_cursor_is_refused() {
    for bad in ["", "b1", "b1.0", "b1.2.s1.W10", "x.0.s1.W10", "b1.0.garbage"] {
        assert!(decode_cursor(bad).is_err(), "{bad:?}");
    }
}

#[test]
fn workers_are_listed_from_the_client_list() {
    let client = |name: &str, flags: &str, cmd: &str| KvClient {
        node: "n".into(), id: "1".into(), addr: "10.0.0.1:1".into(), name: name.into(), user: String::new(), db: 0, age: 5, idle: 1, cmd: cmd.into(), flags: flags.into(), own: false,
    };
    let base = crate::kv::bull::keys::worker_base("bull", "q");
    let list = vec![client(&format!("{base}:w:a"), "N", "get"), client(&base, "b", "bzpopmin"), client(&base, "N", "get"), client("other", "b", "bzpopmin")];
    let workers = workers_of(&list, "bull", "q");
    assert_eq!(workers.iter().map(|w| w.name.as_str()).collect::<Vec<_>>(), vec!["a", ""]);
}
