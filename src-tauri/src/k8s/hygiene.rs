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

/// 테스트 모듈(`#[cfg(test)]` 아래)은 빼고 본다: 그 줄부터 파일 끝까지 버린다. 테스트는 이 파일 맨 끝의 `mod tests;`나 `mod tests { … }`에만 둔다.
fn production_part(text: &str) -> &str {
    text.find("#[cfg(test)]").map_or(text, |at| &text[..at])
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
            if production_part(&text).contains(call) {
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
