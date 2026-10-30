use super::*;

#[test]
fn shell_path_first_then_missing_fallback_entries() {
    assert_eq!(merge_path(Some("/Users/me/bin:/usr/bin\n")), "/Users/me/bin:/usr/bin:/opt/homebrew/bin:/usr/local/bin:/bin:/usr/sbin:/sbin");
    assert_eq!(merge_path(None), FALLBACK_PATH);
    assert_eq!(merge_path(Some("   ")), FALLBACK_PATH);
}
