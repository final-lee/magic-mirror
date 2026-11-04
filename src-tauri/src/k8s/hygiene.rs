//! 클러스터에 쓰는 호출이 허용된 파일 밖에 없는지 글자로 확인한다(PG의 `pg::hygiene`과 같은 방식).
//! K1에서 허용되는 것은 `review.rs`의 `create`(SelfSubjectReview, SelfSubjectRulesReview) 하나다. `shell.rs`는 exec·attach, `forward.rs`는 port-forward만 연다. 이후 단계가 `exec.rs`를 더한다.
//! 프로세스를 띄우는 곳은 로그인 PATH의 `path.rs`, helm의 `helm/run.rs`, 읽기 전용 describe의 `describe.rs`뿐이다.
//! helm은 클러스터를 바꾸는 CLI라 kube 쓰기 호출과 같은 취급이다: 그 하위 명령(upgrade·install·uninstall·rollback)의 이름은 인자를 만드는 `helm/cli.rs`에만 있어야 한다.

use std::fs;
use std::path::{Path, PathBuf};

const WRITE_CALLS: &[&str] = &[
    ".create(", "::create(", ".method(", ".patch(", ".replace(", ".delete(", ".delete_collection(", ".create_subresource(", ".create_subresource::<", ".patch_subresource(",
    ".replace_subresource(", ".evict(", ".exec(", ".attach(", ".portforward(", "Method::POST", "Method::PUT", "Method::PATCH",
    ".patch_metadata(", ".patch_scale(", ".replace_scale(", ".patch_status(", ".replace_status(", ".patch_approval(",
    ".patch_resize(", ".replace_resize(", ".patch_ephemeral_containers(", ".replace_ephemeral_containers(", ".create_token_request(",
    "Method::DELETE", "Request::post", "Request::put", "Request::patch", "Request::delete",
    "Command::new(",
    ".create_access_entry(", ".delete_access_entry(", ".update_access_entry(", ".associate_access_policy(", ".disassociate_access_policy(",
];
/// 클러스터를 바꾸는 helm 하위 명령 이름. 인자를 만드는 `k8s/helm/cli.rs`에서만 쓴다.
const HELM_WRITE_VERBS: &[&str] = &["\"upgrade\"", "\"install\"", "\"uninstall\"", "\"rollback\""];
const HELM_BUILDER: &str = "k8s/helm/cli.rs";
/// (파일, 허용하는 호출)
const ALLOWED: &[(&str, &[&str])] = &[
    ("k8s/review.rs", &[".create(", "::create("]),
    ("k8s/access/review.rs", &[".create("]),
    ("k8s/exec.rs", &[".create(", ".patch(", ".delete(", ".create_subresource::<"]),
    ("k8s/exec/eks.rs", &[".create_access_entry(", ".delete_access_entry(", ".update_access_entry(", ".associate_access_policy(", ".disassociate_access_policy("]),
    ("k8s/shell.rs", &[".exec(", ".attach("]),
    ("k8s/forward.rs", &[".portforward("]),
    ("k8s/path.rs", &["Command::new("]),
    ("k8s/helm/run.rs", &["Command::new("]),
    ("k8s/describe.rs", &["Command::new("]),
];

/// 시험일 때만 컴파일되는 파일은 스캔하지 않는다: `hygiene.rs`, `live_tests.rs`와 `live_tests/` 아래 파일, 이름이 `tests.rs`인 파일
fn is_test_only(path: &Path) -> bool {
    path.file_name().is_some_and(|n| n == "hygiene.rs" || n == "live_tests.rs" || n == "tests.rs") || path.components().any(|c| c.as_os_str() == "live_tests")
}

fn sources() -> Vec<PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut out = vec![root.join("k8s_commands.rs"), root.join("k8s_helm_commands.rs")];
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
fn the_terminal_and_forward_calls_live_in_their_own_files_and_the_scan_reads_them() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for (file, call) in [("k8s/shell.rs", ".exec("), ("k8s/shell.rs", ".attach("), ("k8s/forward.rs", ".portforward(")] {
        let path = root.join(file);
        assert!(sources().contains(&path), "{file}를 스캔하지 않아요");
        let text = fs::read_to_string(&path).unwrap();
        assert!(production_part(&text).unwrap().contains(call), "{file}에 {call}가 없으면 허용 목록이 헛돌아요");
    }
    // 다른 쪽 호출은 이 파일들에서도 허용하지 않는다
    let allowed = |file: &str| ALLOWED.iter().find(|(f, _)| *f == file).map_or(&[][..], |(_, calls)| *calls);
    assert!(!allowed("k8s/shell.rs").contains(&".portforward("));
    assert!(!allowed("k8s/forward.rs").contains(&".exec(") && !allowed("k8s/forward.rs").contains(&".attach("));
}

#[test]
fn helm_write_commands_are_named_only_in_the_command_builder() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut bad = Vec::new();
    for path in sources() {
        let rel = path.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
        let text = fs::read_to_string(&path).unwrap();
        let code = production_part(&text).unwrap_or_else(|e| panic!("{rel}: {e}"));
        for verb in HELM_WRITE_VERBS {
            if rel != HELM_BUILDER && code.contains(verb) {
                bad.push(format!("{rel}: {verb}"));
            }
        }
    }
    assert!(bad.is_empty(), "helm 쓰기 하위 명령은 {HELM_BUILDER}에서만: {bad:?}");
    // 허용 목록이 헛돌지 않게: 빌더에는 모든 이름이 있고, 실행 파일에는 Command::new가 있다
    let builder = fs::read_to_string(root.join(HELM_BUILDER)).unwrap();
    for verb in HELM_WRITE_VERBS {
        assert!(production_part(&builder).unwrap().contains(verb), "{HELM_BUILDER}에 {verb}가 없어요");
    }
    assert!(sources().contains(&root.join("k8s/helm/run.rs")), "helm/run.rs를 스캔하지 않아요");
    assert!(production_part(&fs::read_to_string(root.join("k8s/helm/run.rs")).unwrap()).unwrap().contains("Command::new("));
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
