use super::*;
use futures::io::Cursor;
use serde_json::json;

#[test]
fn options_always_request_timestamps_and_bound_tail() {
    let p = params(&LogOptions { container: Some("app".into()), follow: true, tail_lines: Some(1_000_000), since_seconds: Some(0), previous: true });
    assert!(p.timestamps && p.follow && p.previous);
    assert_eq!(p.tail_lines, Some(KEEP_LINES));
    assert_eq!(p.since_seconds, None);
    assert_eq!(params(&LogOptions { since_seconds: Some(60), ..Default::default() }).since_seconds, Some(60));
}

#[test]
fn timestamp_prefix_is_split_only_when_valid() {
    assert_eq!(split_line("2026-11-03T02:11:22.123456789Z hello world".into()), LogLine { ts: Some("2026-11-03T02:11:22.123456789Z".into()), text: "hello world".into() });
    assert_eq!(split_line("not-a-time hello".into()), LogLine { ts: None, text: "not-a-time hello".into() });
    assert_eq!(split_line("hello".into()), LogLine { ts: None, text: "hello".into() });
}

#[tokio::test]
async fn clipped_lines_keep_timestamp_and_next_line() {
    let mut bytes = b"2026-11-03T02:11:22Z ".to_vec();
    bytes.extend(vec![b'x'; MAX_LINE * 2]);
    bytes.extend_from_slice(b"\nnext\n");
    let reader = futures::io::BufReader::with_capacity(7, Cursor::new(bytes));
    let got: Vec<_> = lines_of(reader).map(|l| split_line(l.unwrap())).collect().await;
    assert_eq!(got[0].ts.as_deref(), Some("2026-11-03T02:11:22Z"));
    assert!(got[0].text.ends_with('…'));
    assert_eq!(got[1].text, "next");
}

#[test]
fn selectors_include_all_expression_operators() {
    let v = json!({"matchLabels":{"app":"web"},"matchExpressions":[{"key":"a","operator":"In","values":["x","y"]},{"key":"b","operator":"NotIn","values":["z"]},{"key":"c","operator":"Exists"},{"key":"d","operator":"DoesNotExist"}]});
    assert_eq!(selector(&v, false).unwrap(), "app=web,a in (x,y),b notin (z),c,!d");
    assert_eq!(selector(&json!({"app":"web"}), true).unwrap(), "app=web");
    assert!(selector(&json!({}), true).is_err());
    assert!(selector(&json!({"matchExpressions":[{"key":"x","operator":"In"}]}), false).is_err());
}

#[test]
fn filenames_cannot_escape_downloads() {
    assert_eq!(safe_filename("../../a:b.log"), "_.._a_b.log");
    assert_eq!(safe_filename("..."), "logs.log");
    assert_eq!(safe_filename("hello.log"), "hello.log");
}
