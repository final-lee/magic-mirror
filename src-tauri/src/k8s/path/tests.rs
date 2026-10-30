use super::*;

#[test]
fn shell_path_first_then_missing_fallback_entries() {
    assert_eq!(merge_path(Some("/Users/me/bin:/usr/bin\n")), "/Users/me/bin:/usr/bin:/opt/homebrew/bin:/usr/local/bin:/bin:/usr/sbin:/sbin");
    assert_eq!(merge_path(None), FALLBACK_PATH);
    assert_eq!(merge_path(Some("   ")), FALLBACK_PATH);
}

#[test]
fn only_the_marked_value_is_taken() {
    assert_eq!(parse_marked("welcome!\n__MM_PATH__/a:/b__MM_PATH__\nbye"), Some("/a:/b"));
    assert_eq!(parse_marked("__MM_PATH__/a__MM_PATH__"), Some("/a"));
    assert_eq!(parse_marked("noise only"), None);
    assert_eq!(parse_marked("__MM_PATH__/a:/b"), None);
}
