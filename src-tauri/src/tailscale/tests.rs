use super::*;

#[test]
fn target_supports_urls_and_bare_hosts() {
    assert_eq!(target("https://example.com/path").unwrap(), ("example.com".into(), 443));
    assert_eq!(target("http://example.com").unwrap(), ("example.com".into(), 80));
    assert_eq!(target("example.com:8443").unwrap(), ("example.com".into(), 8443));
    assert_eq!(target("[fd7a:115c:a1e0::1]:123").unwrap(), ("fd7a:115c:a1e0::1".into(), 123));
    assert!(target("ftp://example.com").is_err());
}
