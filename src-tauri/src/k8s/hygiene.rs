//! 클러스터에 쓰는 호출이 허용된 파일 밖에 없는지 글자로 확인한다(PG의 `pg::hygiene`과 같은 방식).
//! K1에서 허용되는 것은 `review.rs`의 `create`(SelfSubjectReview, SelfSubjectRulesReview) 하나다. 이후 단계가 `exec.rs`, `shell.rs`, `forward.rs`를 더한다.

use std::fs;
use std::path::{Path, PathBuf};

const WRITE_CALLS: &[&str] = &[
    ".create(", "::create(", ".method(", ".patch(", ".replace(", ".delete(", ".delete_collection(", ".create_subresource(", ".patch_subresource(",
    ".replace_subresource(", ".evict(", ".exec(", ".attach(", ".portforward(", "Method::POST", "Method::PUT", "Method::PATCH",
    "Method::DELETE", "Request::post", "Request::put", "Request::patch", "Request::delete",
];
/// (파일, 허용하는 호출)
const ALLOWED: &[(&str, &[&str])] = &[("k8s/review.rs", &[".create(", "::create("])];

/// 시험일 때만 컴파일되는 파일은 스캔하지 않는다: `hygiene.rs`, `live_tests.rs`, 이름이 `tests.rs`인 파일
fn is_test_only(path: &Path) -> bool {
    path.file_name().is_some_and(|n| n == "hygiene.rs" || n == "live_tests.rs" || n == "tests.rs")
}

fn sources() -> Vec<PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut out = vec![root.join("k8s_commands.rs")];
    let mut stack = vec![root.join("k8s")];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|e| e == "rs") && !is_test_only(&path) {
                out.push(path);
            }
        }
    }
    out.into_iter().filter(|p| p.exists()).collect()
}

/// 제품 코드 부분. 테스트 배치 규칙: 스캔하는 파일은 맨 끝에 `#[cfg(test)]`(0열) 다음 줄에 `mod 이름;`(0열) 쌍을 0개 이상 두고, 그 뒤에는
/// 빈 줄과 `//` 주석만 올 수 있다. 시험 코드는 `이름/tests.rs` 같은 파일로 뺀다(`pg/connect.rs`와 `pg/connect/tests.rs`처럼). 중괄호 꼴의
/// 인라인 시험 모듈은 없다. 이 밖의 자리에 있는 `#[cfg(test)]`는(주석 줄은 빼고) 뒤의 제품 코드를 가릴 수 있어 에러로 거절한다.
fn production_part(text: &str) -> Result<&str, String> {
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let mut offset = 0;
    let mut cut = None;
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let bare = line.trim_end_matches(['\n', '\r']);
        let trimmed = bare.trim();
        if bare == "#[cfg(test)]" {
            let next = lines.get(i + 1).map_or("", |l| l.trim_end_matches(['\n', '\r']));
            if !is_mod_decl(next) {
                return Err(format!("`#[cfg(test)]` 다음 줄은 `mod 이름;`이어야 해요: {next}"));
            }
            cut.get_or_insert(offset);
            offset += line.len() + lines[i + 1].len();
            i += 2;
            continue;
        }
        if trimmed.starts_with("//") || (cut.is_some() && trimmed.is_empty()) {
            // 주석은 어디서든 괜찮다
        } else if trimmed.contains("#[cfg(test)]") {
            return Err(format!("`#[cfg(test)]`는 0열에서 파일 끝의 `mod 이름;` 앞에만 둘 수 있어요: {bare}"));
        } else if cut.is_some() && !trimmed.is_empty() {
            return Err(format!("시험 모듈 선언 뒤에 다른 코드가 있어요: {bare}"));
        }
        offset += line.len();
        i += 1;
    }
    Ok(cut.map_or(text, |at| &text[..at]))
}

/// 0열에서 시작하는 `mod 이름;`(앞에 `pub`이 없는)
fn is_mod_decl(line: &str) -> bool {
    let Some(name) = line.strip_prefix("mod ").and_then(|r| r.strip_suffix(';')) else { return false };
    !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || c == '_')
}

#[test]
fn only_allowed_files_call_write_apis() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut bad = Vec::new();
    for path in sources() {
        let rel = path.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
        let allowed: &[&str] = ALLOWED.iter().find(|(f, _)| *f == rel).map_or(&[], |(_, calls)| *calls);
        let text = fs::read_to_string(&path).unwrap();
        for call in WRITE_CALLS.iter().filter(|c| !allowed.contains(c)) {
            if production_part(&text).unwrap_or_else(|e| panic!("{rel}: {e}")).contains(call) {
                bad.push(format!("{rel}: {call}"));
            }
        }
    }
    assert!(bad.is_empty(), "쓰기 호출은 허용된 파일에서만: {bad:?}");
}

#[test]
fn the_scan_sees_k8s_files() {
    assert!(sources().iter().any(|p| p.ends_with("kubeconfig.rs")));
}

#[test]
fn production_part_accepts_trailing_test_mod_pairs() {
    assert_eq!(production_part("fn a() {}\n#[cfg(test)]\nmod tests;\n").unwrap(), "fn a() {}\n");
    assert_eq!(production_part("pub mod a;\n\n#[cfg(test)]\nmod hygiene;\n// 메모\n\n#[cfg(test)]\nmod live_tests;\n\n").unwrap(), "pub mod a;\n\n");
    assert_eq!(production_part("fn a() {}\n").unwrap(), "fn a() {}\n");
}

#[test]
fn production_part_rejects_everything_else() {
    // 앞쪽의 시험 전용 항목
    assert!(production_part("#[cfg(test)]\nuse std::fs;\nfn a() {}\n").is_err());
    assert!(production_part("#[cfg(test)] use std::fs;\nfn a() {}\n").is_err());
    assert!(production_part("#[cfg(test)]\nfn t() {}\n").is_err());
    // 여러 줄 인라인 모듈 뒤의 코드, 들여쓴 모듈, 한 줄 모듈
    assert!(production_part("fn a() {}\n#[cfg(test)]\nmod tests {\n    fn t() {}\n}\nfn late() {}\n").is_err());
    assert!(production_part("fn a() {}\n    #[cfg(test)] mod t {}\nfn late() {}\n").is_err());
    assert!(production_part("fn a() {}\n#[cfg(test)]\nmod tests;\nmod evil { fn x() {} }\n").is_err());
    assert!(production_part("fn a() {}\n#[cfg(test)]\nmod tests;\nfn late() {}\n").is_err());
}

#[test]
fn production_part_ignores_the_text_inside_comments() {
    let text = "// 시험은 #[cfg(test)] 아래에 둔다\nfn a() { x.delete(); }\n";
    assert_eq!(production_part(text).unwrap(), text);
}
