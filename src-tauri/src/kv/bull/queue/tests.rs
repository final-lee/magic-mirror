use super::*;

#[test]
fn the_discovery_cursor_round_trips() {
    let scan = ScanCursor { nodes: vec![("-".into(), "123".into())] };
    assert_eq!(decode_cursor(&encode_cursor(&scan)).unwrap(), scan);
}

#[test]
fn a_bad_discovery_cursor_is_refused() {
    // `b1.`은 두 번 훑던 예전 찾기의 커서다
    for bad in ["", "b2", "b2.", "b1.0.s1.W10", "x.s1.W10", "b2.garbage"] {
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
