use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::io::Cursor;
use futures::stream;

use super::*;
use crate::k8s::failure::UNREACHABLE_PUBLIC;

const PUBLIC: Endpoint = Endpoint { public: true, private: false };

fn collect() -> (Arc<Mutex<Vec<LogMessage>>>, impl FnMut(LogMessage) -> bool + Send) {
    let got = Arc::new(Mutex::new(Vec::new()));
    let sink = got.clone();
    (got, move |m| {
        sink.lock().unwrap().push(m);
        true
    })
}

fn lines(items: Vec<io::Result<String>>) -> BoxStream<'static, io::Result<String>> {
    stream::iter(items).boxed()
}

#[test]
fn params_clamp_the_tail_and_drop_non_positive_since() {
    let p = params(&LogOptions { container: Some("app".into()), follow: true, tail_lines: Some(1_000_000), since_seconds: Some(0), previous: true, timestamps: false });
    assert_eq!(p.container.as_deref(), Some("app"));
    assert!(p.follow && p.previous);
    assert_eq!(p.tail_lines, Some(KEEP_LINES));
    assert_eq!(p.since_seconds, None);
    assert_eq!(params(&LogOptions::default()).tail_lines, Some(KEEP_LINES));
    assert_eq!(params(&LogOptions { tail_lines: Some(500), since_seconds: Some(60), ..Default::default() }).tail_lines, Some(500));
}

#[test]
fn line_of_strips_a_carriage_return_replaces_bad_bytes_and_marks_clipped_lines() {
    assert_eq!(line_of(b"hello\r".to_vec(), false), "hello");
    assert_eq!(line_of(vec![b'a', 0xff, b'b'], false), "a\u{fffd}b");
    assert_eq!(line_of(b"cut\r".to_vec(), true), "cut\r…");
}

#[tokio::test]
async fn lines_of_keeps_going_past_invalid_utf8_and_across_small_reads() {
    // 7바이트씩 읽게 해 줄이 여러 번에 걸쳐 들어오게 한다
    let reader = futures::io::BufReader::with_capacity(7, Cursor::new(b"one\r\n\xff\xfe\na longer line here\nthree".to_vec()));
    let got: Vec<String> = lines_of(reader).map(|l| l.unwrap()).collect().await;
    assert_eq!(got, ["one", "\u{fffd}\u{fffd}", "a longer line here", "three"]);
}

#[tokio::test]
async fn a_huge_line_keeps_only_its_head_and_the_next_line_is_whole() {
    let mut bytes = vec![b'x'; MAX_LINE * 40];
    bytes.extend_from_slice(b"\nnext\n");
    let reader = futures::io::BufReader::with_capacity(4096, Cursor::new(bytes));
    let got: Vec<String> = lines_of(reader).map(|l| l.unwrap()).collect().await;
    assert_eq!(got.len(), 2);
    assert_eq!(got[0].len(), MAX_LINE + '…'.len_utf8());
    assert!(got[0].starts_with("xxx") && got[0].ends_with('…'));
    assert_eq!(got[1], "next");
}

#[tokio::test(start_paused = true)]
async fn a_finished_log_is_sent_in_one_batch_then_end() {
    let (got, send) = collect();
    run_with(lines(vec![Ok("a".into()), Ok("b".into())]), PUBLIC, send).await;
    assert_eq!(*got.lock().unwrap(), [LogMessage::Lines { lines: vec!["a".into(), "b".into()] }, LogMessage::End]);
}

#[tokio::test(start_paused = true)]
async fn a_full_batch_goes_out_at_once() {
    let (got, send) = collect();
    let many: Vec<io::Result<String>> = (0..FLUSH_ROWS + 3).map(|i| Ok(i.to_string())).collect();
    run_with(lines(many), PUBLIC, send).await;
    let got = got.lock().unwrap();
    let sizes: Vec<usize> = got.iter().filter_map(|m| if let LogMessage::Lines { lines } = m { Some(lines.len()) } else { None }).collect();
    assert_eq!(sizes, [FLUSH_ROWS, 3]);
    assert_eq!(got.last(), Some(&LogMessage::End));
}

#[tokio::test(start_paused = true)]
async fn a_quiet_follow_flushes_on_the_tick_and_keeps_waiting() {
    let (got, send) = collect();
    let s = stream::iter(vec![Ok("first".to_string())]).chain(stream::pending()).boxed();
    let task = tokio::spawn(run_with(s, PUBLIC, send));
    tokio::time::sleep(FLUSH_EVERY + Duration::from_millis(10)).await;
    assert_eq!(*got.lock().unwrap(), [LogMessage::Lines { lines: vec!["first".into()] }]);
    tokio::time::sleep(Duration::from_secs(600)).await;
    assert_eq!(got.lock().unwrap().len(), 1);
    assert!(!task.is_finished());
    task.abort();
}

#[tokio::test(start_paused = true)]
async fn a_broken_stream_sends_what_it_has_then_an_unreachable_error() {
    let (got, send) = collect();
    run_with(lines(vec![Ok("a".into()), Err(io::Error::new(io::ErrorKind::ConnectionReset, "reset"))]), PUBLIC, send).await;
    assert_eq!(
        *got.lock().unwrap(),
        [LogMessage::Lines { lines: vec!["a".into()] }, LogMessage::Error { error: AppError::Network { message: UNREACHABLE_PUBLIC.into() } }]
    );
}

#[tokio::test(start_paused = true)]
async fn a_closed_channel_stops_the_stream() {
    let mut calls = 0;
    let s = stream::iter((0..FLUSH_ROWS * 3).map(|i| Ok(i.to_string()))).boxed();
    run_with(s, PUBLIC, |_| {
        calls += 1;
        false
    })
    .await;
    assert_eq!(calls, 1);
}
