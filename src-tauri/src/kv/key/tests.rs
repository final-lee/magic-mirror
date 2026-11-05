use super::*;

#[test]
fn the_next_stream_id_follows_the_last_read_one() {
    assert_eq!(next_stream_id("1700000000000-5").as_deref(), Some("1700000000000-6"));
    assert_eq!(next_stream_id("17").as_deref(), Some("17-1"));
    assert_eq!(next_stream_id(&format!("5-{}", u64::MAX)).as_deref(), Some("6-0"));
    assert_eq!(next_stream_id("x-1"), None);
}

#[test]
fn text_is_cut_on_a_character_boundary() {
    assert_eq!(truncate_utf8("abc".to_string(), 10), ("abc".to_string(), false));
    assert_eq!(truncate_utf8("가나다".to_string(), 4), ("가".to_string(), true));
}

#[test]
fn length_commands_are_reads() {
    assert_eq!(length_command(KvType::Zset), Some("ZCARD"));
    assert_eq!(length_command(KvType::Json), None);
}

#[test]
fn pages_continue_until_the_total_is_reached() {
    assert_eq!(next_index(0, 200, Some(450)), Some(PageCursor::Index(200)));
    assert_eq!(next_index(400, 50, Some(450)), None);
    assert_eq!(next_index(0, 0, None), None);
}
