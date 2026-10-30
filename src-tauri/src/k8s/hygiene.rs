//! 클러스터에 쓰는 호출이 허용된 파일 밖에 없는지 글자로 확인한다(PG의 `pg::hygiene`과 같은 방식).
//! K1에서 허용되는 것은 `review.rs`의 `create`(SelfSubjectReview, SelfSubjectRulesReview) 하나다. 이후 단계가 `exec.rs`, `shell.rs`, `forward.rs`를 더한다.

use std::fs;
use std::path::{Path, PathBuf};

const WRITE_CALLS: &[&str] = &[
    ".create(", ".patch(", ".replace(", ".delete(", ".delete_collection(", ".create_subresource(", ".patch_subresource(",
    ".replace_subresource(", ".evict(", ".exec(", ".attach(", ".portforward(", "Method::POST", "Method::PUT", "Method::PATCH",
    "Method::DELETE", "Request::post", "Request::put", "Request::patch", "Request::delete",
];
/// (파일, 허용하는 호출)
const ALLOWED: &[(&str, &[&str])] = &[("k8s/review.rs", &[".create("])];

fn sources() -> Vec<PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut out = vec![root.join("k8s_commands.rs")];
    let mut stack = vec![root.join("k8s")];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|e| e == "rs") && !path.ends_with("hygiene.rs") {
                out.push(path);
            }
        }
    }
    out.into_iter().filter(|p| p.exists()).collect()
}

/// 제품 코드 부분. `#[cfg(test)]`는 줄 맨 앞에서만 속성으로 읽고(주석 속 글자는 무시), 파일 끝의 시험 모듈로만 쓸 수 있다:
/// `#[cfg(test)] mod x {` 본문이 끝까지 가거나, 끝에 `#[cfg(test)] mod x;` 줄들만 이어진다. 그 밖의 자리(앞쪽의 시험 전용 `use`나 함수 등)는
/// 그 뒤의 제품 코드를 가려 버리므로 에러로 거절한다.
fn production_part(text: &str) -> Result<&str, String> {
    let mut offset = 0;
    let mut cut = None;
    let mut lines = text.split_inclusive('\n').peekable();
    while let Some(line) = lines.next() {
        let start = offset;
        offset += line.len();
        let trimmed = line.trim();
        if let Some(at) = cut {
            // `;` 꼴 뒤에는 시험 모듈 선언, 주석, 빈 줄만 올 수 있다. `{` 꼴은 본문이 끝까지다.
            if cut_is_inline(text, at) {
                return Ok(&text[..at]);
            }
            let ok = trimmed.is_empty() || trimmed.starts_with("//") || trimmed == "#[cfg(test)]" || is_mod_decl(trimmed.trim_start_matches("#[cfg(test)]").trim());
            if !ok {
                return Err(format!("`#[cfg(test)] mod x;` 뒤에 다른 코드가 있어요: {trimmed}"));
            }
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("#[cfg(test)]") {
            let rest = rest.trim();
            let decl = if rest.is_empty() { lines.peek().map_or("", |l| l.trim()) } else { rest };
            if !is_mod_decl(decl) {
                return Err(format!("`#[cfg(test)]`는 파일 끝의 `mod x;`/`mod x {{` 앞에만 둘 수 있어요: {decl}"));
            }
            cut = Some(start);
        }
    }
    Ok(cut.map_or(text, |at| &text[..at]))
}

fn is_mod_decl(line: &str) -> bool {
    let line = line.trim();
    let Some(rest) = line.strip_prefix("mod ").or_else(|| line.strip_prefix("pub mod ")) else { return false };
    let name_end = rest.find(|c: char| !(c.is_alphanumeric() || c == '_')).unwrap_or(rest.len());
    name_end > 0 && matches!(rest[name_end..].trim_start().chars().next(), Some(';' | '{'))
}

/// 잘린 자리의 선언이 본문이 있는 `mod x {` 꼴인가
fn cut_is_inline(text: &str, at: usize) -> bool {
    let tail = text[at..].trim_start().trim_start_matches("#[cfg(test)]").trim_start();
    tail.lines().next().is_some_and(|l| l.trim_end().ends_with('{'))
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
fn production_part_cuts_at_the_trailing_test_module() {
    assert_eq!(production_part("fn a() {}\n#[cfg(test)]\nmod tests {\n    fn t() {}\n}\n").unwrap(), "fn a() {}\n");
    assert_eq!(production_part("pub mod a;\n#[cfg(test)]\nmod hygiene;\n#[cfg(test)]\nmod live_tests;\n").unwrap(), "pub mod a;\n");
    assert_eq!(production_part("fn a() {}\n").unwrap(), "fn a() {}\n");
}

#[test]
fn production_part_rejects_early_test_only_items() {
    assert!(production_part("#[cfg(test)]\nuse std::fs;\nfn a() { x.delete(); }\n").is_err());
    assert!(production_part("#[cfg(test)] use std::fs;\nfn a() {}\n").is_err());
    assert!(production_part("pub mod a;\n#[cfg(test)]\nmod hygiene;\nfn late() {}\n").is_err());
}

#[test]
fn production_part_ignores_the_text_inside_comments() {
    let text = "// 시험은 #[cfg(test)] 아래에 둔다\nfn a() { x.delete(); }\n";
    assert_eq!(production_part(text).unwrap(), text);
}
