use std::path::{Path, PathBuf};

fn collect(dir: &Path, files: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() { collect(&path, files); }
        else if path.extension().is_some_and(|e| e == "rs") { files.push(path); }
    }
}
#[test]
fn process_and_write_are_confined_to_cli() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = vec![root.join("tailscale_commands.rs")];
    collect(&root.join("tailscale"), &mut files);
    for file in files {
        if file.ends_with("cli.rs") || file.ends_with("hygiene.rs") { continue; }
        let text = std::fs::read_to_string(&file).unwrap();
        for forbidden in [concat!("Command", "::new("), concat!("\"", "set", "\"")] {
            assert!(!text.contains(forbidden), "{} contains {}", file.display(), forbidden);
        }
        // CLI argument vectors must be constructed in cli.rs. Avoid forbidding
        // ordinary data values such as the device finding named "update".
        for verb in ["up", "down", "switch", "login", "logout", "serve", "funnel", "file", "cert", "update", "lock"] {
            for prefix in ["&[\"", "vec![\""] {
                let forbidden = format!("{prefix}{verb}\"");
                assert!(!text.contains(&forbidden), "{} contains {}", file.display(), forbidden);
            }
        }
    }
}
