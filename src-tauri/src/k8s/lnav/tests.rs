use std::os::unix::fs::PermissionsExt;
use std::sync::{Arc, Mutex};

use base64::Engine;

use super::*;

fn decode(m: &LnavMessage) -> String {
    let LnavMessage::Output { data } = m else { panic!("not output: {m:?}") };
    String::from_utf8(base64::engine::general_purpose::STANDARD.decode(data).unwrap()).unwrap()
}

#[test]
fn find_in_path_takes_the_first_executable_and_skips_plain_files() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    fs::write(a.path().join("lnav"), "not executable").unwrap();
    let exe = b.path().join("lnav");
    fs::write(&exe, "#!/bin/sh\n").unwrap();
    fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).unwrap();
    let path = format!("{}::{}", a.path().display(), b.path().display());
    assert_eq!(find_in_path("lnav", &path), Some(exe));
    assert_eq!(find_in_path("lnav", a.path().to_str().unwrap()), None);
    assert_eq!(find_in_path("nope", &path), None);
}

#[test]
fn log_files_are_private_per_process_and_never_reused() {
    let root = tempfile::tempdir().unwrap();
    let logs = root.path().join("logs");
    let (p1, _) = log_file(&logs).unwrap();
    let (p2, _) = log_file(&logs).unwrap();
    assert_ne!(p1, p2);
    assert_eq!(p1.parent().unwrap(), process_dir(&logs));
    assert_eq!(fs::metadata(&logs).unwrap().permissions().mode() & 0o777, 0o700);
    assert_eq!(fs::metadata(process_dir(&logs)).unwrap().permissions().mode() & 0o777, 0o700);
    assert_eq!(fs::metadata(&p1).unwrap().permissions().mode() & 0o777, 0o600);
}

#[test]
fn sweeping_removes_folders_of_ended_apps_and_loose_files_but_keeps_running_ones() {
    let root = tempfile::tempdir().unwrap();
    let logs = root.path();
    let (mine, _) = log_file(logs).unwrap();
    // 1(launchd)은 늘 살아 있다. 4000000은 macOS의 프로세스 번호 범위 밖이라 없는 프로세스다.
    fs::create_dir(logs.join("1")).unwrap();
    fs::create_dir(logs.join("4000000")).unwrap();
    fs::write(logs.join("4000000").join("0-1.log"), "secret").unwrap();
    fs::write(logs.join("123-0-1.log"), "old layout").unwrap();
    sweep_stale(logs);
    assert!(mine.exists());
    assert!(logs.join("1").exists());
    assert!(!logs.join("4000000").exists());
    assert!(!logs.join("123-0-1.log").exists());
}

#[test]
fn log_lines_go_to_the_file_and_only_errors_and_the_end_go_to_the_screen() {
    let mut out: Vec<u8> = Vec::new();
    assert_eq!(write_log(&mut out, LogMessage::Lines { lines: vec!["a".into(), "b".into()] }).unwrap(), None);
    assert_eq!(write_log(&mut out, LogMessage::Lines { lines: vec!["c".into()] }).unwrap(), None);
    assert_eq!(out, b"a\nb\nc\n");
    let error = AppError::other("x");
    assert_eq!(write_log(&mut out, LogMessage::Error { error: error.clone() }).unwrap(), Some(LnavMessage::LogError { error }));
    assert_eq!(write_log(&mut out, LogMessage::End).unwrap(), Some(LnavMessage::LogEnd));
}

#[test]
fn pump_forwards_output_then_exit_and_stops_when_the_screen_is_gone() {
    let got = Arc::new(Mutex::new(Vec::new()));
    let sink = got.clone();
    pump(&b"hello"[..], move |m| {
        sink.lock().unwrap().push(m);
        true
    });
    let got = got.lock().unwrap();
    assert_eq!(decode(&got[0]), "hello");
    assert_eq!(got.last(), Some(&LnavMessage::Exit));

    let mut calls = 0;
    pump(&b"hello"[..], |_| {
        calls += 1;
        false
    });
    assert_eq!(calls, 1);
}

#[test]
fn a_program_runs_in_a_pty_and_cleanup_kills_it_and_removes_the_file() {
    let root = tempfile::tempdir().unwrap();
    let (path, _) = log_file(root.path()).unwrap();
    fs::write(&path, "from the log file\n").unwrap();
    // lnav 대신 파일을 보여 주는 cat. PTY의 출력이 그대로 온다.
    let s = spawn(Path::new("/bin/cat"), &[path.as_path()], 80, 24, "/usr/bin:/bin").unwrap();
    let got = Arc::new(Mutex::new(Vec::new()));
    let sink = got.clone();
    let reader = s.reader;
    let t = std::thread::spawn(move || {
        pump(reader, move |m| {
            sink.lock().unwrap().push(m);
            true
        })
    });
    t.join().unwrap();
    let text: String = got.lock().unwrap().iter().filter(|m| matches!(m, LnavMessage::Output { .. })).map(decode).collect();
    assert!(text.contains("from the log file"), "{text:?}");
    assert_eq!(got.lock().unwrap().last(), Some(&LnavMessage::Exit));
    Cleanup::new(s.child, path.clone()).finish_now();
    assert!(!path.exists());
}

#[test]
fn dropping_the_cleanup_stops_a_program_that_would_run_forever_off_the_calling_thread() {
    let root = tempfile::tempdir().unwrap();
    let (path, _) = log_file(root.path()).unwrap();
    let mut s = spawn(Path::new("/bin/sleep"), &[Path::new("600")], 80, 24, "/usr/bin:/bin").unwrap();
    assert!(s.child.try_wait().unwrap().is_none());
    let reader = s.reader;
    let pumped = std::thread::spawn(move || pump(reader, |_| true));
    drop(Cleanup::new(s.child, path.clone()));
    // 죽으면 PTY가 닫혀 읽기도 끝난다
    pumped.join().unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while path.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(!path.exists());
}

#[test]
fn keys_reach_the_program_through_the_input_worker() {
    // cat은 받은 입력을 그대로 PTY에 되돌려 준다
    let s = spawn(Path::new("/bin/cat"), &[], 80, 24, "/usr/bin:/bin").unwrap();
    let input = input_worker(s.writer);
    let (tx, rx) = std::sync::mpsc::channel();
    let reader = s.reader;
    std::thread::spawn(move || pump(reader, move |m| tx.send(m).is_ok()));
    input.send(b"typed-keys\r".to_vec()).unwrap();
    let mut seen = String::new();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !seen.contains("typed-keys") && std::time::Instant::now() < deadline {
        if let Ok(m @ LnavMessage::Output { .. }) = rx.recv_timeout(std::time::Duration::from_millis(200)) {
            seen.push_str(&decode(&m));
        }
    }
    let root = tempfile::tempdir().unwrap();
    Cleanup::new(s.child, root.path().join("none")).finish_now();
    assert!(seen.contains("typed-keys"), "{seen:?}");
}
