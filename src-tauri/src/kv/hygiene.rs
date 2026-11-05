//! 읽기 전용 보장을 지키는 검사 테스트(시험 전용). 약속은 "캐시에 아무것도 쓰지 않는다"이고, 그것은 `command.rs`의 허용 목록 관문 하나에 기댄다.
//! 이 검사는 글자로 그 관문이 우회되지 않았음을 지킨다:
//! - fred의 `custom`·`custom_raw`와 연결 관리 밖의 명령 길(`pipeline`, `multi`, `flushall` …)을 `command.rs` 밖에서 부르지 않는다.
//! - `fred::interfaces`에서 가져오는 것은 `ClientLike` 하나다(`i-*` 명령 모음 기능은 빌드에서 꺼 두었으므로 `set`·`del` 같은 메서드도 없다).
//! - 명령을 만드는 `cmd(…)`의 이름은 허용 목록에 있는 글이거나 허용 목록에서 온 변수(`command`)다.
//! - 알려진 쓰기 명령의 이름이 글 상수로 소스에 있으면 안 된다.
//!
//! 검사는 `src/kv.rs`, `src/kv/` 아래 제품 파일, `src/kv_commands.rs`를 읽는다. 시험 전용 파일(`tests.rs`, `fake_server.rs`, `live_tests.rs`, `hygiene.rs`)은 건너뛴다.
//! 제품 파일 안에 `#[cfg(test)] mod 이름 { … }`처럼 시험을 인라인으로 두면 제품 코드로 읽혀 버리므로 그것은 거절한다(파일로 옮긴다).

use std::fs;
use std::path::{Path, PathBuf};

use super::command::allowed;

/// 시험 전용 파일 이름
const TEST_FILES: [&str; 4] = ["tests.rs", "fake_server.rs", "live_tests.rs", "hygiene.rs"];

/// 알려진 쓰기·위험 명령. 글 상수로 소스에 나오면 안 된다
const WRITE_COMMANDS: [&str; 60] = [
    "SET", "SETEX", "SETNX", "MSET", "GETSET", "GETDEL", "GETEX", "APPEND", "INCR", "DECR", "INCRBY", "DEL", "UNLINK", "EXPIRE", "PEXPIRE", "PERSIST", "RENAME", "COPY", "MOVE", "HSET",
    "HDEL", "LPUSH", "RPUSH", "LPOP", "RPOP", "LREM", "SADD", "SREM", "SPOP", "ZADD", "ZREM", "XADD", "XDEL", "XGROUP", "FLUSHALL", "FLUSHDB", "EVAL", "EVALSHA", "SCRIPT", "FUNCTION",
    "CONFIG", "ACL", "DEBUG", "SHUTDOWN", "FAILOVER", "REPLICAOF", "SLAVEOF", "PUBLISH", "SUBSCRIBE", "MULTI", "EXEC", "WATCH", "MIGRATE", "RESTORE", "SORT", "KEYS", "MONITOR", "SAVE",
    "BGSAVE", "SETNAME",
];

/// `command.rs` 밖에서 부르면 안 되는 fred 메서드 이름
const FRED_ESCAPES: [&str; 9] = ["custom_raw", ".custom(", "flushall", "shutdown(", ".pipeline(", ".multi(", "send_command", "client_setname", "with_options("];

fn src_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn rust_files(dir: &Path, found: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, found);
        } else if path.extension().is_some_and(|e| e == "rs") {
            found.push(path);
        }
    }
}

/// 검사할 제품 파일들
fn production_files() -> Vec<PathBuf> {
    let src = src_dir();
    let mut files = vec![src.join("kv.rs"), src.join("kv_commands.rs")];
    rust_files(&src.join("kv"), &mut files);
    files.retain(|f| !f.file_name().is_some_and(|n| TEST_FILES.contains(&n.to_string_lossy().as_ref())));
    files.sort();
    files
}

/// 주석 줄을 뺀 소스
fn code_of(text: &str) -> String {
    text.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n")
}

/// 소스의 글 상수들(`"…"`). 이스케이프(`\"`)는 건너뛴다
fn literals(code: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut chars = code.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '"' {
            continue;
        }
        let mut literal = String::new();
        while let Some(n) = chars.next() {
            match n {
                '\\' => {
                    chars.next();
                }
                '"' => break,
                other => literal.push(other),
            }
        }
        found.push(literal);
    }
    found
}

/// `cmd(` 호출의 첫 인자: 글 상수면 `Ok(글)`, 아니면 식별자 `Err(식별자)`
fn cmd_calls(code: &str) -> Vec<Result<String, String>> {
    let mut calls = Vec::new();
    let bytes = code.as_bytes();
    let mut from = 0;
    while let Some(at) = code[from..].find("cmd(") {
        let start = from + at;
        from = start + 4;
        let prev = code[..start].chars().next_back();
        if prev.is_some_and(|p| p.is_alphanumeric() || p == '_') {
            continue;
        }
        let rest = code[from..].trim_start();
        if let Some(literal) = rest.strip_prefix('"') {
            calls.push(Ok(literal.split('"').next().unwrap_or_default().to_string()));
        } else {
            let ident: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
            calls.push(Err(ident));
        }
        let _ = bytes;
    }
    calls
}

/// 한 파일에서 찾은 위반들
fn violations(name: &str, text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let code = code_of(text);
    let is_gate = name.ends_with("kv/command.rs");
    if code.contains("#[cfg(test)]\nmod ") && code.contains("mod tests {") {
        found.push(format!("{name}: 인라인 시험 모듈이 제품 파일에 있어요(파일로 옮기세요)"));
    }
    if !is_gate {
        for escape in FRED_ESCAPES {
            if code.contains(escape) {
                found.push(format!("{name}: 관문 밖에서 `{escape}`를 불러요"));
            }
        }
        for line in code.lines().filter(|l| l.contains("fred::interfaces")) {
            let allowed_import = line.trim() == "use fred::interfaces::ClientLike;";
            if !(allowed_import && name.ends_with("kv/connect.rs")) {
                found.push(format!("{name}: `fred::interfaces`는 connect.rs의 `ClientLike`만 가져올 수 있어요: {}", line.trim()));
            }
        }
        for call in cmd_calls(&code) {
            match call {
                Ok(literal) if allowed(&literal).is_some() => {}
                Ok(literal) => found.push(format!("{name}: 허용 목록에 없는 명령 `{literal}`")),
                Err(ident) if ident == "command" => {}
                Err(ident) => found.push(format!("{name}: `cmd({ident}…)`는 글 상수나 `command`여야 해요")),
            }
        }
    }
    for literal in literals(&code) {
        if WRITE_COMMANDS.contains(&literal.as_str()) {
            found.push(format!("{name}: 쓰기 명령 이름 `{literal}`이 글 상수로 있어요"));
        }
    }
    found
}

#[test]
fn kv_sources_only_send_allow_listed_commands_through_the_gate() {
    let files = production_files();
    assert!(files.len() > 20, "제품 파일을 못 찾았어요: {files:?}");
    let mut all = Vec::new();
    for file in &files {
        let text = fs::read_to_string(file).unwrap();
        all.extend(violations(&file.display().to_string(), &text));
    }
    assert!(all.is_empty(), "{}", all.join("\n"));
}

#[test]
fn the_gate_is_the_only_file_that_calls_custom() {
    let mut users = Vec::new();
    for file in production_files() {
        let text = code_of(&fs::read_to_string(&file).unwrap());
        if text.contains(".custom") {
            users.push(file.file_name().unwrap().to_string_lossy().into_owned());
        }
    }
    assert_eq!(users, vec!["command.rs".to_string()]);
}

#[test]
fn fred_command_interfaces_are_not_built_in() {
    // `i-*` 명령 모음 기능이 켜지면 `set`·`del` 같은 메서드가 생긴다: 켜지지 않았음을 Cargo.toml로 지킨다
    let manifest = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml")).unwrap();
    let fred = manifest.lines().find(|l| l.starts_with("fred = ")).expect("fred 의존성");
    assert!(!fred.contains("\"i-") && !fred.contains("default-features = true") && fred.contains("default-features = false"), "{fred}");
    assert!(!fred.contains("transactions") && !fred.contains("mocks"), "{fred}");
}

#[test]
fn the_checker_itself_catches_the_violations_it_promises_to() {
    let bad = "fn x() {\n    let a = cmd(\"SET\");\n    let b = cmd(name);\n    client.flushall(false);\n    let c = \"FLUSHALL\";\n}\nuse fred::interfaces::KeysInterface;\n";
    let found = violations("kv/other.rs", bad);
    assert!(found.iter().any(|v| v.contains("허용 목록에 없는 명령 `SET`")), "{found:?}");
    assert!(found.iter().any(|v| v.contains("cmd(name")), "{found:?}");
    assert!(found.iter().any(|v| v.contains("flushall")), "{found:?}");
    assert!(found.iter().any(|v| v.contains("쓰기 명령 이름 `FLUSHALL`")), "{found:?}");
    assert!(found.iter().any(|v| v.contains("KeysInterface")), "{found:?}");
    let good = "fn x() {\n    let a = cmd(\"SCAN\").arg(0);\n    let b = cmd(command);\n    // cmd(\"SET\") 주석은 건너뛴다\n}\n";
    assert!(violations("kv/other.rs", good).is_empty());
    let inline = "#[cfg(test)]\nmod tests {\n}\n";
    assert!(!violations("kv/other.rs", inline).is_empty());
}
