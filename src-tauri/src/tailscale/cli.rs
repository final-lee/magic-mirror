use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

fn executable(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

pub async fn locate() -> Option<PathBuf> {
    let app = PathBuf::from("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
    if executable(&app) { return Some(app); }
    crate::k8s::path::login_path().await.split(':').filter(|s| !s.is_empty())
        .map(|s| Path::new(s).join("tailscale")).find(|p| executable(p))
}

/// Tailscale CLI 프로세스. 앱 번들의 `Tailscale`은 GUI와 CLI를 겸하는 바이너리라, 터미널 흔적(`TERM`·`SHLVL`)이 없는
/// 환경(Finder로 띄운 이 앱)에서 부르면 GUI로 뜨려다 stdout에 안내문을 찍고 0으로 끝난다. `TAILSCALE_BE_CLI`가 CLI로 고정한다.
fn cli(path: &Path) -> Command {
    let mut command = Command::new(path);
    command.env("TAILSCALE_BE_CLI", "1");
    command
}

async fn run(path: &Path, args: &[&str], seconds: u64, allow_failure: bool) -> Result<String, String> {
    let mut command = cli(path);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(seconds), command.output()).await
        .map_err(|_| "Tailscale 명령이 시간 안에 끝나지 않았어요".to_string())?
        .map_err(|e| format!("Tailscale을 실행하지 못했어요: {e}"))?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !allow_failure && !output.status.success() {
        return Err(format!("Tailscale 명령이 실패했어요: {}", stderr.lines().next().filter(|s| !s.is_empty()).unwrap_or("알 수 없는 오류")));
    }
    let mut stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if allow_failure && !stderr.is_empty() { stdout.push('\n'); stdout.push_str(&stderr); }
    Ok(stdout)
}

pub async fn status_json(path: &Path) -> Result<String, String> { run(path, &["status", "--json"], 5, false).await }
pub async fn prefs_json(path: &Path) -> Result<String, String> { run(path, &["get", "--json"], 5, false).await }
pub async fn lock_status_json(path: &Path) -> Result<String, String> { run(path, &["lock", "status", "--json"], 5, false).await }
pub async fn ping(path: &Path, addr: &str) -> Result<String, String> { run(path, &["ping", "--c", "3", "--timeout", "3s", addr], 12, true).await }
pub async fn netcheck_json(path: &Path) -> Result<String, String> { run(path, &["netcheck", "--format", "json"], 10, false).await }
pub async fn dns_status(path: &Path) -> Result<String, String> { run(path, &["dns", "status"], 10, false).await }
pub async fn dns_query(path: &Path, name: &str, record_type: Option<&str>) -> Result<String, String> {
    let mut args = vec!["dns", "query", name];
    if let Some(record_type) = record_type { args.push(record_type); }
    run(path, &args, 15, false).await
}
pub async fn whois(path: &Path, ip: &str) -> Result<String, String> { run(path, &["whois", "--json", ip], 10, false).await }
pub async fn whoami(path: &Path) -> Result<String, String> { run(path, &["whoami", "--json"], 10, false).await }
pub async fn local_read(path: &Path, kind: &str) -> Result<String, String> {
    let args: &[&str] = match kind {
        "prefs" => &["get", "--json"],
        "exits" => &["exit-node", "list"],
        "suggestion" => &["exit-node", "suggest"],
        "accounts" => &["switch", "--list", "--json"],
        "version-check" => &["update", "--dry-run"],
        "metrics" => &["metrics"],
        _ => return Err("알 수 없는 조회예요".into()),
    };
    run(path, args, 30, false).await
}

pub async fn local_write(path: &Path, kind: &str, value: &str) -> Result<String, String> {
    let args: Vec<&str> = match kind {
        "connect" => vec!["up"],
        "disconnect" => vec!["down"],
        "authenticate" => vec!["login"],
        "sign-out" => vec!["logout"],
        "upgrade" => vec!["update", "--yes"],
        "account-select" if !value.is_empty() && !value.starts_with('-') => vec!["switch", value],
        "account-remove" if !value.is_empty() && !value.starts_with('-') => vec!["switch", "remove", value],
        "preference" if value.starts_with("--") && value.contains('=') => vec!["set", value],
        _ => return Err("올바른 명령이 아니에요".into()),
    };
    run(path, &args, 180, false).await
}

pub async fn lock_history(path: &Path) -> Result<String, String> {
    run(path, &["lock", "log", "--json"], 15, false).await
}

pub async fn lock_init(path: &Path, keys: &[String], count: u32) -> Result<String, String> {
    let count_flag = format!("--gen-disablements={count}");
    let mut args = vec!["lock", "init", "--confirm", count_flag.as_str()];
    args.extend(keys.iter().map(String::as_str));
    run(path, &args, 30, false).await.map_err(|_| "Tailnet Lock을 초기화하지 못했어요".into())
}

pub async fn lock_change(path: &Path, kind: &str, value: &str) -> Result<String, String> {
    if value.starts_with('-') { return Err("올바른 키를 입력해 주세요".into()); }
    let args: Vec<&str> = match kind {
        "sign-node" if !value.is_empty() => vec!["lock", "sign", value],
        "trust-key" if !value.is_empty() => vec!["lock", "add", value],
        "untrust-key" if !value.is_empty() => vec!["lock", "remove", value],
        "local-off" => vec!["lock", "local-disable"],
        "tailnet-off" if !value.is_empty() => vec!["lock", "disable", value],
        "revoke-start" if !value.is_empty() && value.split_whitespace().all(|key| key.starts_with("tlpub:")) => {
            let mut args = vec!["lock", "revoke-keys"];
            args.extend(value.split_whitespace());
            args
        },
        "revoke-cosign" if !value.is_empty() => vec!["lock", "revoke-keys", "--cosign", value],
        "revoke-finish" if !value.is_empty() => vec!["lock", "revoke-keys", "--finish", value],
        _ => return Err("올바른 키를 입력해 주세요".into()),
    };
    let result = run(path, &args, 30, false).await;
    if kind == "tailnet-off" { result.map(|_| String::new()).map_err(|_| "Tailnet Lock을 끄지 못했어요".into()) } else { result }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareRequest {
    pub action: String,
    #[serde(default)] pub target: String,
    #[serde(default)] pub port: String,
    #[serde(default)] pub mode: String,
    #[serde(default)] pub path: String,
    #[serde(default)] pub service: String,
    #[serde(default)] pub files: Vec<String>,
    #[serde(default)] pub folder: String,
    #[serde(default)] pub domain: String,
}

pub fn share_args(req: &ShareRequest) -> Result<Vec<String>, String> {
    let bad = || "공유 설정을 확인해 주세요".to_string();
    let mut args = Vec::<String>::new();
    match req.action.as_str() {
        "mapping" | "mapping-off" => {
            if !matches!(req.mode.as_str(), "https" | "tcp") || req.port.parse::<u16>().ok().filter(|p| *p != 0).is_none()
                || !matches!(req.service.as_str(), "" | "funnel") && !req.service.starts_with("svc:")
                || (req.action == "mapping" && (req.target.is_empty() || req.target.starts_with('-')))
                || (!req.path.is_empty() && !req.path.starts_with('/')) { return Err(bad()); }
            args.push(if req.service == "funnel" { "funnel" } else { "serve" }.into());
            args.push("--bg".into());
            args.push(format!("--{}={}", req.mode, req.port));
            if !req.path.is_empty() { args.push(format!("--set-path={}", req.path)); }
            if req.service.starts_with("svc:") { args.push(format!("--service={}", req.service)); }
            args.push(if req.action == "mapping-off" { "off".into() } else { req.target.clone() });
        }
        "serve-reset" => args.extend(["serve".into(), "reset".into()]),
        "funnel-reset" => args.extend(["funnel".into(), "reset".into()]),
        "advertise" | "drain" | "clear" if req.service.starts_with("svc:") && !req.service.contains(char::is_whitespace) =>
            args.extend(["serve".into(), req.action.clone(), req.service.clone()]),
        "send" if !req.files.is_empty() && req.files.iter().all(|p| Path::new(p).is_absolute()) && !req.target.is_empty() && !req.target.starts_with('-') && !req.target.contains(':') => {
            args.extend(["file".into(), "cp".into()]);
            args.extend(req.files.iter().cloned());
            args.push(format!("{}:", req.target));
        }
        "receive" if Path::new(&req.folder).is_absolute() =>
            args.extend(["file".into(), "get".into(), "--verbose".into(), req.folder.clone()]),
        "certificate" if Path::new(&req.folder).is_absolute() && !req.domain.is_empty() && req.domain.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') => {
            args.extend(["cert".into(), format!("--cert-file={}", Path::new(&req.folder).join(format!("{}.crt", req.domain)).display()),
                format!("--key-file={}", Path::new(&req.folder).join(format!("{}.key", req.domain)).display()), req.domain.clone()]);
        }
        _ => return Err(bad()),
    }
    Ok(args)
}

pub async fn share_read(path: &Path, kind: &str) -> Result<String, String> {
    let args: &[&str] = match kind {
        "serve-status" => &["serve", "status", "--json"],
        "funnel-status" => &["funnel", "status", "--json"],
        "services" => &["service", "list", "--json"],
        "targets" => &["file", "cp", "--targets"],
        "cert-domains" => &["status", "--json"],
        _ => return Err("알 수 없는 조회예요".into()),
    };
    run(path, args, 15, false).await
}

pub async fn share_apply(path: &Path, req: &ShareRequest) -> Result<String, String> {
    let args = share_args(req)?;
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run(path, &refs, 180, false).await
}

/// Reconstruct only configurations whose complete semantics can be represented by
/// the CLI. Unknown fields are rejected before any reset is attempted.
pub fn restore_plan(status: &serde_json::Value) -> Result<Vec<Vec<String>>, String> {
    use serde_json::Value;
    let unsupported = || "이 공유 설정은 CLI 명령으로 안전하게 복원할 수 없어요".to_string();
    let object = status.as_object().ok_or_else(unsupported)?;
    if object.keys().any(|key| !matches!(key.as_str(), "TCP" | "Web" | "AllowFunnel")) {
        return Err(unsupported());
    }
    let empty = serde_json::Map::new();
    let tcp = match object.get("TCP") { None | Some(Value::Null) => &empty, Some(value) => value.as_object().ok_or_else(unsupported)? };
    let web = match object.get("Web") { None | Some(Value::Null) => &empty, Some(value) => value.as_object().ok_or_else(unsupported)? };
    let funnels = match object.get("AllowFunnel") { None | Some(Value::Null) => &empty, Some(value) => value.as_object().ok_or_else(unsupported)? };
    let mut commands = vec![vec!["serve".into(), "reset".into()]];
    let mut handled = std::collections::BTreeSet::new();
    let mut hostname: Option<&str> = None;
    for (hostport, web_config) in web {
        let (host, port) = hostport.rsplit_once(':').ok_or_else(unsupported)?;
        if host.is_empty() || hostname.is_some_and(|previous| previous != host) { return Err(unsupported()); }
        hostname = Some(host);
        port.parse::<u16>().ok().filter(|port| *port > 0).ok_or_else(unsupported)?;
        let transport = tcp.get(port).and_then(Value::as_object).ok_or_else(unsupported)?;
        if transport.len() != 1 || transport.get("HTTPS") != Some(&Value::Bool(true)) { return Err(unsupported()); }
        let config = web_config.as_object().ok_or_else(unsupported)?;
        if config.len() != 1 { return Err(unsupported()); }
        let handlers = config.get("Handlers").and_then(Value::as_object).ok_or_else(unsupported)?;
        if handlers.is_empty() { return Err(unsupported()); }
        let funnel = funnels.get(hostport).and_then(Value::as_bool).unwrap_or(false);
        for (route, handler) in handlers {
            let fields = handler.as_object().ok_or_else(unsupported)?;
            if fields.len() != 1 || !route.starts_with('/') { return Err(unsupported()); }
            let (kind, value) = fields.iter().next().ok_or_else(unsupported)?;
            let value = value.as_str().filter(|s| !s.is_empty() && !s.starts_with('-')).ok_or_else(unsupported)?;
            let target = match kind.as_str() {
                "Proxy" | "Path" => value.to_owned(),
                "Text" => format!("text:{value}"),
                _ => return Err(unsupported()),
            };
            commands.push(vec![if funnel { "funnel" } else { "serve" }.into(), "--bg".into(),
                format!("--https={port}"), format!("--set-path={route}"), target]);
        }
        handled.insert(port.to_owned());
    }
    for (port, transport) in tcp {
        if handled.contains(port) { continue; }
        port.parse::<u16>().ok().filter(|port| *port > 0).ok_or_else(unsupported)?;
        let transport = transport.as_object().ok_or_else(unsupported)?;
        if transport.len() != 1 { return Err(unsupported()); }
        let target = transport.get("TCPForward").and_then(Value::as_str).filter(|s| !s.is_empty() && !s.starts_with('-')).ok_or_else(unsupported)?;
        if funnels.iter().any(|(key, value)| key.rsplit_once(':').is_some_and(|(_, p)| p == port) && value == &Value::Bool(true)) { return Err(unsupported()); }
        commands.push(vec!["serve".into(), "--bg".into(), format!("--tcp={port}"), target.into()]);
    }
    if funnels.iter().any(|(host, value)| value != &Value::Bool(false) && (!web.contains_key(host) || value != &Value::Bool(true))) { return Err(unsupported()); }
    Ok(commands)
}

pub async fn restore_share(path: &Path, plan: &[Vec<String>]) -> Result<(), String> {
    for command in plan {
        let args: Vec<&str> = command.iter().map(String::as_str).collect();
        run(path, &args, 30, false).await?;
    }
    Ok(())
}

pub async fn service_config(path: &Path, service: &str) -> Result<String, String> {
    let service_flag = format!("--service={service}");
    run(path, &["serve", "get-config", &service_flag, "/dev/stdout"], 15, false).await
}

pub fn service_restore_args(service: &str) -> Vec<String> {
    vec!["serve".into(), "set-config".into(), format!("--service={service}"), "/dev/stdin".into()]
}

pub async fn restore_service(path: &Path, service: &str, config: &str) -> Result<(), String> {
    let args = service_restore_args(service);
    let mut command = cli(path);
    command.args(&args)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = command.spawn().map_err(|e| format!("Tailscale을 실행하지 못했어요: {e}"))?;
    let mut stdin = child.stdin.take().ok_or_else(|| "표준 입력을 열지 못했어요".to_string())?;
    stdin.write_all(config.as_bytes()).await.map_err(|e| format!("설정을 전달하지 못했어요: {e}"))?;
    drop(stdin);
    let output = tokio::time::timeout(Duration::from_secs(30), child.wait_with_output()).await
        .map_err(|_| "Tailscale 명령이 시간 안에 끝나지 않았어요".to_string())?
        .map_err(|e| format!("Tailscale을 실행하지 못했어요: {e}"))?;
    if !output.status.success() {
        return Err(format!("Tailscale 명령이 실패했어요: {}", String::from_utf8_lossy(&output.stderr)));
    }
    Ok(())
}
pub async fn set_accept_routes(path: &Path, enabled: bool) -> Result<(), String> {
    run(path, &["set", if enabled { "--accept-routes=true" } else { "--accept-routes=false" }], 5, false).await.map(|_| ())
}
