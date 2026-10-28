//! 읽기 전용 보장을 지키는 검사 테스트(시험 전용). 1단계의 약속은 "데이터베이스에 아무것도 쓰지 않는다"이고, 서버의 읽기 전용 트랜잭션은
//! 세션 `SET`이나 부작용 있는 함수를 막지 못한다(`catalog::read`의 설명). 그래서 이 약속은 두 가지에 기댄다: `catalog.rs`의 고정된 SELECT들,
//! 그리고 질의를 보내거나 트랜잭션을 여는 호출이 `catalog.rs` 말고 어디에도 없다는 것. 뒤의 것을 여기서 지킨다.
//!
//! 검사는 `src/pg.rs`, `src/pg/` 아래 모든 파일, `src/pg_commands.rs`(와 그 아래)를 읽는다. 시험만을 위한 파일은 건너뛰는데,
//! 그 목록을 손으로 적지 않고 `#[cfg(test)] mod 이름;` 선언에서 읽는다: 시험 모듈이 새로 생겨도 이 검사가 걸리지 않고,
//! 제품 파일이 건너뛰어지는 일도 없다. 시험 파일이 다시 선언하는 모듈(`live_tests.rs`의 `comparison`)도 시험 전용이다.
//! 제품 파일 안에 `#[cfg(test)] mod 이름 { … }`처럼 시험을 인라인으로 두면 제품 코드로 읽혀 버리므로 그것은 거절한다(파일로 옮긴다).

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

/// `catalog.rs` 말고는 쓰면 안 되는 호출. 앞의 여덟은 설계가 정한 것이고, 나머지는 같은 일을 하는 드라이버의 다른 이름이다
const FORBIDDEN: [&str; 14] = [
    ".query(",
    ".query_one(",
    ".query_opt(",
    ".execute(",
    "batch_execute(",
    "simple_query(",
    "build_transaction(",
    ".transaction(",
    ".query_raw(",
    ".query_typed(",
    ".query_typed_raw(",
    ".execute_raw(",
    ".copy_in(",
    ".copy_out(",
];

fn src_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

// ───────────────────────── 선언 읽기 ─────────────────────────

/// 파일 맨 위 단계의 `mod` 선언 하나
#[derive(Debug, PartialEq, Eq)]
struct Declaration {
    name: String,
    /// `mod 이름 { … }`처럼 본문이 있다(파일이 아니다)
    inline: bool,
    /// 바로 앞에 `#[cfg(test)]`가 있다
    cfg_test: bool,
}

/// `mod 이름;`이나 `mod 이름 {`로 시작하는 줄이면 (이름, 인라인 여부). 앞의 `pub`, `pub(crate)`, `pub(super)`는 건너뛴다.
fn parse_mod(line: &str) -> Option<(String, bool)> {
    let mut rest = line.trim_start();
    if let Some(after_pub) = rest.strip_prefix("pub") {
        rest = match after_pub.strip_prefix('(') {
            Some(restricted) => restricted.split_once(')')?.1,
            None => after_pub,
        };
    }
    let rest = rest.trim_start().strip_prefix("mod ")?;
    let name_end = rest.find(|c: char| !(c.is_alphanumeric() || c == '_'))?;
    let (name, after) = rest.split_at(name_end);
    let after = after.trim_start();
    match after.chars().next()? {
        ';' => Some((name.to_string(), false)),
        '{' => Some((name.to_string(), true)),
        _ => None,
    }
}

/// 파일 안의 `mod` 선언들. `#[cfg(test)]`와 다른 속성, 빈 줄, 주석은 선언 앞에 몇 줄이든 올 수 있다.
fn declarations(text: &str) -> Vec<Declaration> {
    let mut found = Vec::new();
    let mut cfg_test = false;
    for line in text.lines() {
        let mut trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("//") {
            continue;
        }
        // `#[cfg(test)] mod x;`처럼 한 줄에 있어도 읽는다
        while let Some(attribute) = trimmed.strip_prefix("#[") {
            let Some((inside, after)) = attribute.split_once(']') else { break };
            cfg_test |= inside.trim() == "cfg(test)";
            trimmed = after.trim_start();
        }
        if trimmed.is_empty() {
            continue;
        }
        if let Some((name, inline)) = parse_mod(trimmed) {
            found.push(Declaration { name, inline, cfg_test });
        }
        cfg_test = false;
    }
    found
}

/// `file`의 하위 모듈 파일들이 놓이는 폴더. `foo.rs`는 `foo/`, `mod.rs`는 자기 폴더다
fn children_dir(file: &Path) -> Option<PathBuf> {
    Some(if file.file_name()? == "mod.rs" { file.parent()?.to_path_buf() } else { file.with_extension("") })
}

/// `file`이 선언한 모듈 `name`의 파일. `foo.rs`가 선언한 `bar`는 `foo/bar.rs`나 `foo/bar/mod.rs`에, `mod.rs`가 선언한 것은 같은 폴더에 있다
fn module_file(file: &Path, name: &str) -> Option<PathBuf> {
    let dir = children_dir(file)?;
    [dir.join(format!("{name}.rs")), dir.join(name).join("mod.rs")].into_iter().find(|candidate| candidate.is_file())
}

/// 모듈 트리: 루트 파일들에서 시작해 선언을 따라 모은 모든 파일과, 각 파일이 시험 전용인지.
/// 제품 파일만 읽어서 선언을 따른다. `#[cfg(test)]`로 선언된 모듈은 시험 전용이고, 그 모듈의 하위 모듈은 모두 그 폴더 아래에 있으므로
/// 시험 전용 파일은 읽지 않고 폴더째 시험 전용으로 친다(시험 파일 안의 글에 `mod`로 시작하는 줄이 있어도 선언으로 읽히지 않는다).
/// 선언이 가리키는 파일이 없거나 제품 파일에 인라인 시험 모듈이 있으면 그 이유를 오류로 돌려준다.
fn module_tree(roots: &[PathBuf]) -> Result<BTreeMap<PathBuf, bool>, String> {
    let mut tree: BTreeMap<PathBuf, bool> = BTreeMap::new();
    let mut pending: Vec<PathBuf> = roots.to_vec();
    while let Some(file) = pending.pop() {
        if tree.contains_key(&file) {
            continue;
        }
        tree.insert(file.clone(), false);
        let text = fs::read_to_string(&file).map_err(|e| format!("{}을(를) 읽지 못했어요: {e}", file.display()))?;
        for declaration in declarations(&text) {
            if declaration.inline {
                if declaration.cfg_test {
                    return Err(format!(
                        "{}: 인라인 시험 모듈 `{name}`이 제품 파일에 있어요. 시험을 파일로 옮기세요(`#[cfg(test)] mod {name};`)",
                        file.display(),
                        name = declaration.name
                    ));
                }
                continue;
            }
            let child = module_file(&file, &declaration.name).ok_or_else(|| format!("{}: 모듈 `{}`의 파일이 없어요", file.display(), declaration.name))?;
            if declaration.cfg_test {
                let mut below = BTreeSet::new();
                if let Some(dir) = children_dir(&child) {
                    rust_files_under(&dir, &mut below);
                }
                tree.extend(below.into_iter().map(|nested| (nested, true)));
                tree.insert(child, true);
            } else {
                pending.push(child);
            }
        }
    }
    Ok(tree)
}

fn rust_files_under(dir: &Path, found: &mut BTreeSet<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files_under(&path, found);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            found.insert(path);
        }
    }
}

// ───────────────────────── 호출 찾기 ─────────────────────────

/// 주석만 있는 줄을 뺀 코드. 줄 끝에 주석이 붙은 줄은 그대로 읽는다
fn code_of(text: &str) -> String {
    text.lines().filter(|line| !line.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n")
}

/// 코드에서 `FORBIDDEN` 호출들(나온 것만, 정렬)
fn forbidden_calls(text: &str) -> Vec<&'static str> {
    let code = code_of(text);
    let mut found: Vec<&'static str> = FORBIDDEN.iter().copied().filter(|call| code.contains(call)).collect();
    found.sort_unstable();
    found
}

/// `build_transaction(` 뒤가 바로 `).read_only(true)`인 자리의 수와 전체 수
fn read_only_transactions(text: &str) -> (usize, usize) {
    let code = code_of(text);
    let mut total = 0;
    let mut read_only = 0;
    for (at, _) in code.match_indices("build_transaction(") {
        total += 1;
        let after: String = code[at..].chars().filter(|c| !c.is_whitespace()).take("build_transaction().read_only(true)".len()).collect();
        read_only += usize::from(after == "build_transaction().read_only(true)");
    }
    (total, read_only)
}

// ───────────────────────── 시험 ─────────────────────────

#[test]
fn declarations_are_read_with_their_cfg_test_attribute() {
    let text = "\
//! 문서
pub mod catalog;
pub(crate) mod fake_server;
#[cfg(test)]
mod tests;

#[cfg(test)]
// 설명
#[doc(hidden)]
pub(super) mod generated;
#[cfg(test)] mod one_line;
#[cfg(test)]
mod inline_tests {
    use super::*;
}
mod modular {
}
fn mod_like() {}
#[cfg(test)]
use super::x;
mod last;
";
    let declared = declarations(text);
    let found: Vec<(&str, bool, bool)> = declared.iter().map(|d| (d.name.as_str(), d.inline, d.cfg_test)).collect();
    assert_eq!(
        found,
        [
            ("catalog", false, false),
            ("fake_server", false, false),
            ("tests", false, true),
            ("generated", false, true),
            ("one_line", false, true),
            ("inline_tests", true, true),
            ("modular", true, false),
            // `#[cfg(test)]`는 바로 다음 항목에만 걸린다: `use`에 걸었으니 그다음 `mod last`는 시험 전용이 아니다
            ("last", false, false),
        ]
    );
}

#[test]
fn forbidden_calls_are_found_in_code_and_not_in_comment_lines() {
    assert_eq!(forbidden_calls("let rows = client.query(sql, &[]).await?;"), [".query("]);
    assert_eq!(forbidden_calls("tx.batch_execute(\"SET x\").await?;\nlet t = c.build_transaction().start();"), ["batch_execute(", "build_transaction("]);
    assert_eq!(forbidden_calls("conn.client.transaction().await?"), [".transaction("]);
    assert_eq!(forbidden_calls("let s = c.simple_query(\"x\");"), ["simple_query("]);
    // 주석만 있는 줄은 코드가 아니다. 줄 끝 주석에 가려진 코드는 놓치지 않는다
    assert!(forbidden_calls("/// 예: client.query(sql)\n//! batch_execute(\n    // .execute(").is_empty());
    assert_eq!(forbidden_calls("run(); client.execute(sql, &[]); // 비밀"), [".execute("]);
    assert!(forbidden_calls("let query = 1; queryable(); execute_plan();").is_empty());
}

#[test]
fn only_a_transaction_that_is_read_only_counts_as_one() {
    let good = "let tx = client.build_transaction().read_only(true).isolation_level(x).start().await?;";
    assert_eq!(read_only_transactions(good), (1, 1));
    // 줄이 바뀌어도 읽는다
    assert_eq!(read_only_transactions("client\n    .build_transaction()\n    .read_only(true)\n    .start()"), (1, 1));
    assert_eq!(read_only_transactions("client.build_transaction().isolation_level(x).read_only(true).start()"), (1, 0));
    assert_eq!(read_only_transactions("client.build_transaction().read_only(false).start()"), (1, 0));
    assert_eq!(read_only_transactions("// build_transaction().start()\nlet x = 1;"), (0, 0));
    assert_eq!(read_only_transactions(&format!("{good}\n{good}")), (2, 2));
}

fn roots() -> Vec<PathBuf> {
    let src = src_dir();
    vec![src.join("pg.rs"), src.join("pg_commands.rs")]
}

fn tree() -> BTreeMap<PathBuf, bool> {
    module_tree(&roots()).unwrap_or_else(|reason| panic!("{reason}"))
}

fn relative(path: &Path) -> String {
    path.strip_prefix(src_dir()).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

#[test]
fn the_skip_list_comes_from_the_cfg_test_declarations_nested_ones_included() {
    let tree = tree();
    let test_only: BTreeSet<String> = tree.iter().filter(|(_, test_only)| **test_only).map(|(file, _)| relative(file)).collect();
    let production: BTreeSet<String> = tree.iter().filter(|(_, test_only)| !**test_only).map(|(file, _)| relative(file)).collect();

    // 시험 전용: 가짜 서버, 픽스처, live 시험과 그 안에서 선언한 `comparison`, 평가기의 생성 시험, 모든 `tests.rs`
    for file in [
        "pg/fake_server.rs",
        "pg/fixtures.rs",
        "pg/hygiene.rs",
        "pg/live_tests.rs",
        "pg/live_tests/comparison.rs",
        "pg/eval/generated.rs",
        "pg/eval/tests.rs",
        "pg/catalog/tests.rs",
        "pg/connect/tests.rs",
        "pg/pool/tests.rs",
        "pg/target/tests.rs",
        "pg/view/tests.rs",
        "pg/summary/tests.rs",
        "pg/checks/tests.rs",
        "pg_commands/tests.rs",
    ] {
        assert!(test_only.contains(file), "{file}은 시험 전용으로 읽혀야 해요: {test_only:?}");
    }
    // 제품 파일은 건너뛰어지지 않는다
    for file in [
        "pg.rs",
        "pg_commands.rs",
        "pg/catalog.rs",
        "pg/checks.rs",
        "pg/connect.rs",
        "pg/eval.rs",
        "pg/model.rs",
        "pg/pool.rs",
        "pg/summary.rs",
        "pg/target.rs",
        "pg/view.rs",
    ] {
        assert!(production.contains(file), "{file}은 제품 파일로 읽혀야 해요: {production:?}");
    }
    assert!(test_only.is_disjoint(&production));
}

#[test]
fn every_rust_file_under_pg_belongs_to_the_module_tree() {
    // 선언되지 않은 파일은 컴파일도 이 검사도 거치지 않는다: 숨은 파일이 없는지 본다
    let mut on_disk = BTreeSet::new();
    rust_files_under(&src_dir().join("pg"), &mut on_disk);
    rust_files_under(&src_dir().join("pg_commands"), &mut on_disk);
    on_disk.extend(roots());
    let in_tree: BTreeSet<PathBuf> = tree().into_keys().collect();
    let orphans: Vec<String> = on_disk.difference(&in_tree).map(|file| relative(file)).collect();
    assert!(orphans.is_empty(), "어디에서도 선언하지 않은 파일이 있어요: {orphans:?}");
}

/// 앱이 PostgreSQL에 질의를 보내거나 트랜잭션을 여는 곳은 `pg/catalog.rs` 하나뿐이다. 그 트랜잭션은 하나고 읽기 전용이다.
#[test]
fn pg_only_the_catalog_runs_queries() {
    let tree = tree();
    let catalog = src_dir().join("pg").join("catalog.rs");
    assert_eq!(tree.get(&catalog), Some(&false), "catalog.rs가 제품 파일로 읽히지 않았어요");

    let mut violations = Vec::new();
    for (file, _) in tree.iter().filter(|(file, test_only)| !**test_only && **file != catalog) {
        let text = fs::read_to_string(file).unwrap_or_else(|e| panic!("{}: {e}", file.display()));
        for call in forbidden_calls(&text) {
            violations.push(format!("{}: {call}", relative(file)));
        }
    }
    assert!(violations.is_empty(), "catalog.rs 말고는 질의를 보내거나 트랜잭션을 열 수 없어요:\n{}", violations.join("\n"));

    // catalog.rs의 트랜잭션은 하나고, 읽기 전용으로 연다. 읽기 전용이 아닌 `transaction()`은 쓰지 않는다
    let text = fs::read_to_string(&catalog).expect("catalog.rs");
    assert_eq!(read_only_transactions(&text), (1, 1), "build_transaction()은 한 번, 바로 뒤에 .read_only(true)와 함께 나와야 해요");
    assert!(!forbidden_calls(&text).contains(&".transaction("), "catalog.rs도 읽기 전용이 아닌 transaction()은 열 수 없어요");
}
