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
    assert_eq!(discovery_pattern("{bull}", "meta"), "{bull}:*:meta");
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
