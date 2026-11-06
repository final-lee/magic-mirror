use crate::error::AppError;
use serde_json::{json, Value};
use super::{changes::{self, Entry, Target}, cli, TailscaleState};
pub use super::cli::ShareRequest;
use tauri_plugin_dialog::DialogExt;

const PREFS: &[&str] = &[
    "accept-dns", "accept-routes", "advertise-connector", "advertise-exit-node",
    "advertise-routes", "auto-update", "exit-node", "exit-node-allow-lan-access",
    "hostname", "nickname", "operator", "relay-server-port", "relay-server-static-endpoints",
    "report-posture", "shields-up", "ssh", "update-check", "webclient",
];

pub async fn read(kind: &str) -> Result<String, AppError> {
    let path = cli::locate().await.ok_or_else(|| AppError::other("Tailscale CLI를 찾지 못했어요"))?;
    cli::local_read(&path, kind).await.map_err(AppError::other)
}

pub async fn apply(state: &TailscaleState, kind: &str, value: &str, tailnet: &str) -> Result<String, AppError> {
    let path = cli::locate().await.ok_or_else(|| AppError::other("Tailscale CLI를 찾지 못했어요"))?;
    if kind != "preference" { return cli::local_write(&path, kind, value).await.map_err(AppError::other); }
    let (key, after) = value.split_once('=').ok_or_else(|| AppError::other("설정을 확인해 주세요"))?;
    let key = key.strip_prefix("--").ok_or_else(|| AppError::other("설정을 확인해 주세요"))?;
    if !PREFS.contains(&key) { return Err(AppError::other("알 수 없는 설정이에요")); }
    let prefs: Value = serde_json::from_str(&cli::prefs_json(&path).await.map_err(AppError::other)?)
        .map_err(|e| AppError::other(format!("설정을 읽지 못했어요: {e}")))?;
    let before = prefs.get(key).ok_or_else(|| AppError::other("이 설정의 이전 값을 읽지 못했어요"))?.clone();
    let after_value = if before.is_boolean() {
        Value::Bool(after.parse::<bool>().map_err(|_| AppError::other("참 또는 거짓 설정이 필요해요"))?)
    } else {
        Value::String(after.to_owned())
    };
    let output = cli::local_write(&path, kind, value).await.map_err(AppError::other)?;
    let now = chrono::Utc::now();
    let entry = Entry {
        id: format!("{}-local", now.timestamp_nanos_opt().unwrap_or_default()),
        at: now.to_rfc3339(), tailnet: tailnet.trim().into(), action: "localPreference".into(),
        target: Target::default(), summary: format!("이 Mac의 {key} 설정을 바꿨어요"),
        before: json!({"key": key, "value": before}), after: json!({"key": key, "value": after_value}),
        undo_of: None, undone: false,
    };
    changes::record(state.changes_path(), &entry).map_err(|e| AppError::other(format!("설정은 바뀌었지만 변경 기록을 저장하지 못했어요: {e}")))?;
    Ok(output)
}

pub async fn lock_history() -> Result<String, AppError> {
    let path = cli::locate().await.ok_or_else(|| AppError::other("Tailscale CLI를 찾지 못했어요"))?;
    match cli::lock_history(&path).await {
        Ok(output) => Ok(output),
        Err(error) if error.contains("Tailnet Lock is not enabled") => Ok("Tailnet Lock이 꺼져 있어 변경 이력이 없어요".into()),
        Err(error) => Err(AppError::other(error)),
    }
}

pub async fn lock_init(keys: Vec<String>, count: u32) -> Result<String, AppError> {
    if count == 0 || keys.is_empty() || keys.iter().any(|key| {
        !key.starts_with("tlpub:") || key.len() != 70 || !key[6..].bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        return Err(AppError::other("신뢰 키와 비활성화 비밀값 개수를 확인해 주세요"));
    }
    let path = cli::locate().await.ok_or_else(|| AppError::other("Tailscale CLI를 찾지 못했어요"))?;
    let status = cli::lock_status_json(&path).await.map_err(AppError::other)?;
    let lock = super::keys::shape_lock(&status)?;
    if lock.enabled { return Err(AppError::other("Tailnet Lock이 이미 켜져 있어요")); }
    if !lock.public_key.as_ref().is_some_and(|own| keys.contains(own)) {
        return Err(AppError::other("이 Mac의 신뢰 키를 포함해야 해요"));
    }
    cli::lock_init(&path, &keys, count).await.map_err(AppError::other)
}

pub async fn lock_change(state: &TailscaleState, kind: &str, value: &str) -> Result<String, AppError> {
    let path = cli::locate().await.ok_or_else(|| AppError::other("Tailscale CLI를 찾지 못했어요"))?;
    let status_json = cli::lock_status_json(&path).await.map_err(AppError::other)?;
    if !matches!(kind, "local-off" | "tailnet-off") {
        let lock = super::keys::shape_lock(&status_json)?;
        if !lock.enabled || lock.this_key_trusted != Some(true) { return Err(AppError::other("이 Mac은 신뢰된 서명 노드가 아니에요")); }
    }
    let previous = if matches!(kind, "trust-key" | "untrust-key") {
        let status: Value = serde_json::from_str(&status_json).map_err(|_| AppError::other("잠금 상태를 읽지 못했어요"))?;
        Some(status["TrustedKeys"].as_array().is_some_and(|keys| keys.iter().any(|key| key["Key"].as_str() == Some(value))))
    } else { None };
    if previous == Some(kind == "trust-key") {
        return Err(AppError::other("이미 같은 신뢰 상태예요"));
    }
    let tailnet = if previous.is_some() {
        let node: Value = serde_json::from_str(&cli::status_json(&path).await.map_err(AppError::other)?)
            .map_err(|_| AppError::other("테일넷 상태를 읽지 못했어요"))?;
        node["CurrentTailnet"]["Name"].as_str().unwrap_or_default().to_owned()
    } else { String::new() };
    let output = cli::lock_change(&path, kind, value).await.map_err(AppError::other)?;
    if let Some(before) = previous {
        let now = chrono::Utc::now();
        let entry = Entry {
            id: format!("{}-lock", now.timestamp_nanos_opt().unwrap_or_default()), at: now.to_rfc3339(), tailnet,
            action: "lockTrustedKey".into(), target: Target::default(), summary: "Tailnet Lock 신뢰 키를 바꿨어요".into(),
            before: json!({"key": value, "trusted": before}), after: json!({"key": value, "trusted": kind == "trust-key"}),
            undo_of: None, undone: false,
        };
        changes::record(state.changes_path(), &entry).map_err(|e| AppError::other(format!("키는 바뀌었지만 변경 기록을 저장하지 못했어요: {e}")))?;
    }
    Ok(output)
}

pub fn share_preview(request: &ShareRequest) -> Result<Vec<String>, AppError> {
    cli::share_args(request).map_err(AppError::other)
}

pub async fn share_read(kind: &str) -> Result<String, AppError> {
    if kind == "downloads" {
        return std::env::var("HOME").map(|home| format!("{home}/Downloads")).map_err(|e| AppError::other(e.to_string()));
    }
    let path = cli::locate().await.ok_or_else(|| AppError::other("Tailscale CLI를 찾지 못했어요"))?;
    let output = cli::share_read(&path, kind).await.map_err(AppError::other)?;
    if kind == "cert-domains" {
        let value: Value = serde_json::from_str(&output).map_err(|e| AppError::other(format!("인증서 도메인을 읽지 못했어요: {e}")))?;
        return Ok(value.get("CertDomains").cloned().unwrap_or_else(|| json!([])).to_string());
    }
    Ok(output)
}

async fn share_snapshot(path: &std::path::Path) -> Result<Value, AppError> {
    let serve = cli::share_read(path, "serve-status").await.map_err(AppError::other)?;
    let funnel = cli::share_read(path, "funnel-status").await.map_err(AppError::other)?;
    let serve: Value = serde_json::from_str(&serve).map_err(|_| AppError::other("Serve 상태를 읽지 못했어요"))?;
    let funnel: Value = serde_json::from_str(&funnel).map_err(|_| AppError::other("Funnel 상태를 읽지 못했어요"))?;
    Ok(json!({"serve": serve, "funnel": funnel}))
}

fn share_hosts_match(status: &Value, node: &Value) -> bool {
    let Some(web) = status["Web"].as_object() else { return status["Web"].is_null(); };
    if web.is_empty() { return true; }
    let Some(dns_name) = node["Self"]["DNSName"].as_str() else { return false; };
    let dns_name = dns_name.trim_end_matches('.');
    web.keys().all(|hostport| hostport.rsplit_once(':').is_some_and(|(host, _)| host.eq_ignore_ascii_case(dns_name)))
}

pub async fn share_apply(state: &TailscaleState, request: &ShareRequest) -> Result<String, AppError> {
    let path = cli::locate().await.ok_or_else(|| AppError::other("Tailscale CLI를 찾지 못했어요"))?;
    cli::share_args(request).map_err(AppError::other)?;
    let service_change = request.service.starts_with("svc:")
        && matches!(request.action.as_str(), "mapping" | "mapping-off" | "clear" | "advertise" | "drain");
    if service_change {
        let before_text = cli::service_config(&path, &request.service).await.map_err(AppError::other)?;
        let before: Value = serde_json::from_str(&before_text).map_err(|_| AppError::other("Service 설정을 읽지 못했어요"))?;
        let node: Value = serde_json::from_str(&cli::status_json(&path).await.map_err(AppError::other)?)
            .map_err(|_| AppError::other("테일넷 상태를 읽지 못했어요"))?;
        let tailnet = node["CurrentTailnet"]["Name"].as_str().unwrap_or_default().to_owned();
        let output = cli::share_apply(&path, request).await.map_err(AppError::other)?;
        let after_text = cli::service_config(&path, &request.service).await.map_err(AppError::other)?;
        let after: Value = serde_json::from_str(&after_text).map_err(|_| AppError::other("Service 설정은 바뀌었지만 현재 상태를 읽지 못했어요"))?;
        let advertisement = matches!(request.action.as_str(), "advertise" | "drain");
        let commands = (!advertisement).then(|| vec![cli::service_restore_args(&request.service)]);
        let reason = advertisement.then_some("이전 서비스 광고 상태를 CLI 설정 파일에서 확인할 수 없어 되돌릴 수 없어요");
        let now = chrono::Utc::now();
        let entry = Entry {
            id: format!("{}-service", now.timestamp_nanos_opt().unwrap_or_default()), at: now.to_rfc3339(), tailnet,
            action: "serviceConfig".into(), target: Target::default(), summary: format!("{} 공유 설정을 바꿨어요", request.service),
            before: json!({"service": request.service, "config": before, "commands": commands, "reason": reason}),
            after, undo_of: None, undone: false,
        };
        changes::record(state.changes_path(), &entry).map_err(|e| AppError::other(format!("Service는 바뀌었지만 변경 기록을 저장하지 못했어요: {e}")))?;
        return Ok(output);
    }
    let node_change = matches!(request.action.as_str(), "mapping" | "mapping-off" | "serve-reset" | "funnel-reset")
        && matches!(request.service.as_str(), "" | "funnel");
    if !node_change { return cli::share_apply(&path, request).await.map_err(AppError::other); }
    let before = share_snapshot(&path).await?;
    let plan = if before["serve"] == before["funnel"] {
        cli::restore_plan(&before["serve"])
    } else {
        Err("Serve와 Funnel 상태가 달라 안전하게 복원할 수 없어요".to_string())
    };
    let node: Value = serde_json::from_str(&cli::status_json(&path).await.map_err(AppError::other)?)
        .map_err(|_| AppError::other("테일넷 상태를 읽지 못했어요"))?;
    let plan = plan.and_then(|commands| {
        if share_hosts_match(&before["serve"], &node) { Ok(commands) }
        else { Err("이 기기의 DNS 이름과 공유 주소가 달라 안전하게 복원할 수 없어요".to_string()) }
    });
    let tailnet = node["CurrentTailnet"]["Name"].as_str().unwrap_or_default().to_owned();
    let output = cli::share_apply(&path, request).await.map_err(AppError::other)?;
    let after = share_snapshot(&path).await?;
    let (commands, reason) = match plan { Ok(commands) => (Some(commands), None), Err(reason) => (None, Some(reason)) };
    let now = chrono::Utc::now();
    let entry = Entry {
        id: format!("{}-share", now.timestamp_nanos_opt().unwrap_or_default()), at: now.to_rfc3339(), tailnet,
        action: "shareConfig".into(), target: Target::default(), summary: "공유 설정을 바꿨어요".into(),
        before: json!({"snapshot": before, "commands": commands, "reason": reason}), after,
        undo_of: None, undone: false,
    };
    changes::record(state.changes_path(), &entry).map_err(|e| AppError::other(format!("공유는 바뀌었지만 변경 기록을 저장하지 못했어요: {e}")))?;
    Ok(output)
}

pub async fn undo(entry: &Entry) -> Result<(), AppError> {
    let path = cli::locate().await.ok_or_else(|| AppError::other("Tailscale CLI를 찾지 못했어요"))?;
    let node: Value = serde_json::from_str(&cli::status_json(&path).await.map_err(AppError::other)?)
        .map_err(|_| AppError::other("테일넷 상태를 읽지 못했어요"))?;
    if node["CurrentTailnet"]["Name"].as_str() != Some(entry.tailnet.as_str()) {
        return Err(AppError::other("이 Mac의 테일넷이 변경 기록과 달라요"));
    }
    match entry.action.as_str() {
        "localPreference" => {
            let key = entry.before["key"].as_str().ok_or_else(|| AppError::other("변경 기록을 읽지 못했어요"))?;
            if !PREFS.contains(&key) { return Err(AppError::other("알 수 없는 설정이에요")); }
            let prefs: Value = serde_json::from_str(&cli::prefs_json(&path).await.map_err(AppError::other)?)
                .map_err(|_| AppError::other("설정을 읽지 못했어요"))?;
            if prefs.get(key) != entry.after.get("value") {
                return Err(AppError::other("설정이 바뀌어서 되돌릴 수 없어요"));
            }
            let before = &entry.before["value"];
            let value = before.as_str().map(str::to_owned).unwrap_or_else(|| before.to_string());
            cli::local_write(&path, "preference", &format!("--{key}={value}")).await.map_err(AppError::other)?;
        }
        "lockTrustedKey" => {
            let key = entry.before["key"].as_str().ok_or_else(|| AppError::other("변경 기록을 읽지 못했어요"))?;
            let status_json = cli::lock_status_json(&path).await.map_err(AppError::other)?;
            let lock = super::keys::shape_lock(&status_json)?;
            if !lock.enabled || lock.this_key_trusted != Some(true) { return Err(AppError::other("이 Mac은 신뢰된 서명 노드가 아니에요")); }
            let status: Value = serde_json::from_str(&status_json).map_err(|_| AppError::other("잠금 상태를 읽지 못했어요"))?;
            let current = status["TrustedKeys"].as_array().is_some_and(|keys| keys.iter().any(|item| item["Key"].as_str() == Some(key)));
            if Some(current) != entry.after["trusted"].as_bool() { return Err(AppError::other("키의 신뢰 상태가 바뀌었어요")); }
            let kind = if entry.before["trusted"].as_bool() == Some(true) { "trust-key" } else { "untrust-key" };
            cli::lock_change(&path, kind, key).await.map_err(AppError::other)?;
        }
        "shareConfig" => {
            if share_snapshot(&path).await? != entry.after { return Err(AppError::other("공유 설정이 바뀌어서 되돌릴 수 없어요")); }
            if !share_hosts_match(&entry.before["snapshot"]["serve"], &node) {
                return Err(AppError::other("이 기기의 DNS 이름이 바뀌어서 되돌릴 수 없어요"));
            }
            let plan = cli::restore_plan(&entry.before["snapshot"]["serve"]).map_err(AppError::other)?;
            let saved: Vec<Vec<String>> = serde_json::from_value(entry.before["commands"].clone())
                .map_err(|_| AppError::other("되돌릴 수 없는 공유 설정이에요"))?;
            if plan != saved || entry.before["snapshot"]["serve"] != entry.before["snapshot"]["funnel"] {
                return Err(AppError::other("공유 복원 명령을 확인하지 못했어요"));
            }
            cli::restore_share(&path, &plan).await.map_err(AppError::other)?;
        }
        "serviceConfig" => {
            let service = entry.before["service"].as_str().filter(|name| name.starts_with("svc:"))
                .ok_or_else(|| AppError::other("Service 기록을 읽지 못했어요"))?;
            let current: Value = serde_json::from_str(&cli::service_config(&path, service).await.map_err(AppError::other)?)
                .map_err(|_| AppError::other("Service 설정을 읽지 못했어요"))?;
            if current != entry.after { return Err(AppError::other("Service 설정이 바뀌어서 되돌릴 수 없어요")); }
            let commands: Vec<Vec<String>> = serde_json::from_value(entry.before["commands"].clone())
                .map_err(|_| AppError::other("Service 복원 명령을 읽지 못했어요"))?;
            if commands != vec![cli::service_restore_args(service)] { return Err(AppError::other("Service 복원 명령을 확인하지 못했어요")); }
            let config = serde_json::to_string(&entry.before["config"]).map_err(|_| AppError::other("Service 기록을 읽지 못했어요"))?;
            cli::restore_service(&path, service, &config).await.map_err(AppError::other)?;
        }
        _ => return Err(AppError::other("되돌릴 수 없는 변경이에요")),
    }
    Ok(())
}

pub async fn pick_files(app: tauri::AppHandle) -> Result<Option<Vec<String>>, AppError> {
    let picked = tokio::task::spawn_blocking(move || app.dialog().file().blocking_pick_files())
        .await.map_err(|_| AppError::other("파일 선택 창을 열지 못했어요"))?;
    picked.map(|files| files.into_iter().map(|file| file.into_path()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|_| AppError::other("파일 경로를 읽지 못했어요"))).collect()).transpose()
}

pub async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, AppError> {
    let picked = tokio::task::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
        .await.map_err(|_| AppError::other("폴더 선택 창을 열지 못했어요"))?;
    picked.map(|folder| folder.into_path().map(|path| path.to_string_lossy().into_owned())
        .map_err(|_| AppError::other("폴더 경로를 읽지 못했어요"))).transpose()
}
