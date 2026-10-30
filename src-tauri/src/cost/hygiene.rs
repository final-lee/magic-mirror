//! 비용 기능이 읽기 전용인지 소스로 확인한다. Cost Explorer는 `src/cost/`에서만 쓰고, 그 안에서도 조회 세 가지만 부른다.

use std::fs;
use std::path::{Path, PathBuf};

/// Cost Explorer의 변경 호출. 어디에도 있으면 안 된다.
const MUTATING: [&str; 16] = [
    "create_anomaly_monitor",
    "create_anomaly_subscription",
    "create_cost_category_definition",
    "delete_anomaly_monitor",
    "delete_anomaly_subscription",
    "delete_cost_category_definition",
    "update_anomaly_monitor",
    "update_anomaly_subscription",
    "update_cost_allocation_tags_status",
    "update_cost_category_definition",
    "provide_anomaly_feedback",
    "start_cost_allocation_tag_backfill",
    "start_savings_plans_purchase_recommendation_generation",
    "start_commitment_purchase_analysis",
    "tag_resource",
    "untag_resource",
];

/// `client.rs`가 부를 수 있는 Cost Explorer 호출
const ALLOWED: [&str; 3] = ["get_cost_and_usage", "get_cost_forecast", "list_cost_allocation_tags"];

fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            sources(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

fn src_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn all_sources() -> Vec<PathBuf> {
    let mut files = Vec::new();
    sources(&src_dir(), &mut files);
    files
}

fn is_this_file(path: &Path) -> bool {
    path.ends_with("cost/hygiene.rs")
}

/// Cost Explorer SDK를 써도 되는 곳: `src/cost/`와 클라이언트를 만들어 넘기기만 하는 `src/cost_commands.rs`
fn may_use_sdk(path: &Path) -> bool {
    path.starts_with(src_dir().join("cost")) || path == src_dir().join("cost_commands.rs")
}

#[test]
fn only_the_cost_files_use_the_cost_explorer_sdk() {
    let offenders: Vec<PathBuf> = all_sources()
        .into_iter()
        .filter(|p| !may_use_sdk(p))
        .filter(|p| fs::read_to_string(p).unwrap().contains("aws_sdk_costexplorer"))
        .collect();
    assert!(offenders.is_empty(), "Cost Explorer SDK outside the cost files: {offenders:?}");
}

#[test]
fn no_cost_explorer_mutation_is_called() {
    let mut found = Vec::new();
    for path in all_sources().into_iter().filter(|p| may_use_sdk(p) && !is_this_file(p)) {
        let text = fs::read_to_string(&path).unwrap();
        for name in MUTATING {
            if text.contains(&format!(".{name}(")) {
                found.push(format!("{}: {name}", path.display()));
            }
        }
    }
    assert!(found.is_empty(), "Cost Explorer mutating calls: {found:?}");
}

/// `client.rs`에서 `.get_…(`/`.list_…(`로 시작하는 호출 이름을 모두 모은다.
fn fluent_calls(text: &str) -> Vec<String> {
    let mut names = Vec::new();
    for prefix in [".get_", ".list_"] {
        let mut rest = text;
        while let Some(at) = rest.find(prefix) {
            let tail = &rest[at + 1..];
            let name: String = tail.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
            if tail[name.len()..].starts_with('(') {
                names.push(name);
            }
            rest = &rest[at + prefix.len()..];
        }
    }
    names
}

#[test]
fn the_client_calls_only_the_three_reads() {
    let text = fs::read_to_string(src_dir().join("cost/client.rs")).unwrap();
    // Cost Explorer 작업은 모두 `get_…`/`list_…`이거나 MUTATING의 변경 호출이다. SDK 출력 접근자(`results_by_time()` 등)는 여기에 걸리지 않는다.
    let calls = fluent_calls(&text);
    let unexpected: Vec<&String> = calls.iter().filter(|n| !ALLOWED.contains(&n.as_str())).collect();
    assert!(unexpected.is_empty(), "unexpected Cost Explorer calls in client.rs: {unexpected:?}");
    for name in ALLOWED {
        assert!(calls.iter().any(|n| n == name), "{name} is not called from client.rs");
    }
}

#[test]
fn fluent_call_scanner_finds_calls_and_skips_mentions() {
    let text = "client.get_cost_and_usage().send(); x.list_cost_allocation_tags()\n// .get_cost_forecast mentioned";
    assert_eq!(fluent_calls(text), vec!["get_cost_and_usage".to_string(), "list_cost_allocation_tags".to_string()]);
}
