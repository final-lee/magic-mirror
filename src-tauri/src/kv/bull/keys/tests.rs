use super::*;

#[test]
fn queue_names_are_the_part_between_prefix_and_suffix() {
    assert_eq!(queue_name_of("bull", "bull:emails:meta", "meta").as_deref(), Some("emails"));
    assert_eq!(queue_name_of("bull", "bull:a:b:id", "id").as_deref(), Some("a:b"));
    assert_eq!(queue_name_of("{bull}", "{bull}:q:meta", "meta").as_deref(), Some("q"));
    assert_eq!(queue_name_of("bull", "other:q:meta", "meta"), None);
    assert_eq!(queue_name_of("bull", "bull::meta", "meta"), None);
    assert_eq!(queue_name_of("bull", "bull:q:meta", "id"), None);
}

#[test]
fn glob_characters_in_a_prefix_are_escaped() {
    assert_eq!(glob_escape("a*b?[c]\\"), "a\\*b\\?\\[c\\]\\\\");
    assert_eq!(discovery_pattern("{bull}"), "{bull}:*:[im][de]*");
}

#[test]
fn only_meta_and_id_keys_name_a_queue_among_what_the_pattern_lets_through() {
    assert_eq!(discovered_queue("bull", "bull:emails:meta").as_deref(), Some("emails"));
    assert_eq!(discovered_queue("bull", "bull:legacy:id").as_deref(), Some("legacy"));
    // 패턴(`me…`·`id…`)에는 걸리지만 큐 표시가 아닌 키들
    for key in ["bull:q:metrics:completed", "bull:q:meta-paused", "bull:q:member-7", "bull:q:idle", "bull:q:12:dependencies"] {
        assert_eq!(discovered_queue("bull", key), None, "{key}");
    }
}

#[test]
fn a_prefix_loses_surrounding_spaces_and_trailing_colons() {
    assert_eq!(normalize_prefix(" bull: "), Some("bull"));
    assert_eq!(normalize_prefix("{bull}"), Some("{bull}"));
    assert_eq!(normalize_prefix("app:bull::"), Some("app:bull"));
    assert_eq!(normalize_prefix(" : "), None);
    // prefix가 정말 `:`로 끝나는 큐(`a::q:meta`)는 이름이 `:q`가 되어 같은 키로 이어진다
    let name = discovered_queue(normalize_prefix("a:").unwrap(), "a::q:meta").unwrap();
    assert_eq!(queue_key("a", &name, "wait"), "a::q:wait");
}

#[test]
fn state_keys_differ_for_the_legacy_priority_set() {
    assert_eq!(state_suffix(KvBullState::Prioritized, KvBullFlavor::Bullmq), "prioritized");
    assert_eq!(state_suffix(KvBullState::Prioritized, KvBullFlavor::Bull), "priority");
    assert_eq!(state_suffix(KvBullState::WaitingChildren, KvBullFlavor::Bullmq), "waiting-children");
    assert_eq!(queue_key("bull", "q", "wait"), "bull:q:wait");
    assert_eq!(job_key("bull", "q", "12"), "bull:q:12");
}

#[test]
fn workers_are_recognised_by_their_connection_name() {
    let base = worker_base("bull", "queue");
    assert_eq!(base, "bull:cXVldWU=");
    assert_eq!(worker_name(&format!("{base}:w:mailer-1"), "N", "get", "bull", "queue").as_deref(), Some("mailer-1"));
    // 큐 객체(생산자)와 같은 이름은 블로킹 중일 때만 워커다
    assert_eq!(worker_name(&base, "b", "bzpopmin", "bull", "queue").as_deref(), Some(""));
    assert_eq!(worker_name(&base, "N", "get", "bull", "queue"), None);
    assert_eq!(worker_name("bull:other", "b", "bzpopmin", "bull", "queue"), None);
}
