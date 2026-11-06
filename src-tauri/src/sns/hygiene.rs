use std::path::{Path, PathBuf};

fn collect(dir: &Path, files: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() { collect(&path, files); }
        else if path.extension().is_some_and(|e| e == "rs") { files.push(path); }
    }
}

#[test]
fn sns_write_apis_are_confined() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    collect(&root, &mut files);
    for file in files {
        if file == root.join("sns/write.rs") || file == root.join("sns/hygiene.rs") { continue; }
        let text = std::fs::read_to_string(&file).unwrap();
        for (line_no, line) in text.lines().enumerate() {
            if (file == root.join("k8s/forward.rs") && line.contains("shared.chosen.subscribe()")) || (file == root.join("pg/fake_server.rs") && line.contains("closing.subscribe()")) { continue; }
            for name in [".subscribe(", ".unsubscribe(", ".set_subscription_attributes(", ".set_topic_attributes(", ".publish(", ".set_queue_attributes(", ".receive_message(", ".change_message_visibility", ".add_permission(", ".remove_permission("] {
                assert!(!line.contains(name), "{}:{} contains {}", file.display(), line_no + 1, name);
            }
        }
    }
}
