use super::*;

#[test]
fn a_scan_cursor_round_trips_through_its_opaque_text() {
    let cursor = ScanCursor { nodes: vec![("10.0.1.5:6379".into(), "18446744073709551615".into()), ("[::1]:6380".into(), "0".into()), ("a.b.cache.amazonaws.com:6379".into(), "42".into())] };
    let text = cursor.encode();
    assert!(text.starts_with("s1."));
    assert!(text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_'), "{text}");
    assert_eq!(ScanCursor::decode(&text).unwrap(), cursor);
}

#[test]
fn a_damaged_scan_cursor_is_refused() {
    for bad in ["", "s1.", "s1.!!!", "x1.W10", "s1.W10", "nonsense", "s1.W1siYSIsIi0xIl1d"] {
        assert!(ScanCursor::decode(bad).is_err(), "{bad:?}");
    }
    // 서버 커서가 아닌 글(명령에 끼어들 수 있는 것)은 거절한다
    let evil = ScanCursor { nodes: vec![("n:1".into(), "0 MATCH x".into())] }.encode();
    assert!(ScanCursor::decode(&evil).is_err());
    let empty = ScanCursor { nodes: vec![] }.encode();
    assert!(ScanCursor::decode(&empty).is_err());
}

#[test]
fn page_cursors_round_trip() {
    for cursor in [PageCursor::Scan("123".into()), PageCursor::Index(400), PageCursor::After("1700000000000-5".into()), PageCursor::After("17".into())] {
        assert_eq!(PageCursor::decode(&cursor.encode()).unwrap(), cursor);
    }
    assert_eq!(PageCursor::Scan("7".into()).encode(), "scan:7");
    assert_eq!(PageCursor::Index(200).encode(), "idx:200");
    assert_eq!(PageCursor::After("1-0".into()).encode(), "id:1-0");
}

#[test]
fn page_cursors_only_accept_the_expected_shapes() {
    for bad in ["", "scan:", "scan:abc", "scan:1 2", "idx:-1", "idx:x", "id:", "id:1-", "id:a-b", "id:1-2-3", "foo:1", "123"] {
        assert!(PageCursor::decode(bad).is_err(), "{bad:?}");
    }
}
