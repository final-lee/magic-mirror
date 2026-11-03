//! 아티팩트 미리보기와 파일 저장.
use super::client::{Server, State};
use crate::error::AppError;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri_plugin_dialog::DialogExt;
use tokio::io::AsyncWriteExt;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Target {
    Live { namespace: String, name: String },
    Archived { uid: String },
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    target: Target,
    node_id: String,
    name: String,
    direction: String,
}

async fn path(state: &State, server: &Server, artifact: &Artifact) -> Result<Vec<String>, AppError> {
    let (namespace, kind, id) = match &artifact.target {
        Target::Live { namespace, name } => (namespace.clone(), "workflows", name.clone()),
        Target::Archived { uid } => {
            let wf = state
                .api(server, reqwest::Method::GET, &["api", "v1", "archived-workflows", uid], &[], None)
                .await?;
            let ns = wf
                .pointer("/metadata/namespace")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::other("보관된 Workflow의 네임스페이스를 읽지 못했어요"))?;
            (ns.to_owned(), "archived-workflows", uid.clone())
        }
    };
    artifact_path(namespace, kind, id, artifact)
}

fn artifact_path(namespace: String, kind: &str, id: String, artifact: &Artifact) -> Result<Vec<String>, AppError> {
    let direction = match artifact.direction.as_str() {
        "input" => "inputs",
        "output" => "outputs",
        _ => return Err(AppError::other("아티팩트 방향을 읽지 못했어요")),
    };
    Ok(vec![
        "artifact-files".into(),
        namespace,
        kind.into(),
        id,
        artifact.node_id.clone(),
        direction.into(),
        artifact.name.clone(),
    ])
}
async fn request(state: &State, server: &Server, artifact: &Artifact) -> Result<reqwest::Response, AppError> {
    let path = path(state, server, artifact).await?;
    let parts: Vec<&str> = path.iter().map(String::as_str).collect();
    state.request(server, reqwest::Method::GET, &parts, &[], None, None, true).await
}

pub async fn preview(state: &State, server: &Server, artifact: &Artifact) -> Result<Value, AppError> {
    let mut response = request(state, server, artifact).await?;
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let mut size = response.content_length();
    let mime = content_type.as_deref().unwrap_or("").split(';').next().unwrap_or("");
    let image = mime.starts_with("image/");
    let text = mime.starts_with("text/") || mime == "application/json" || mime.ends_with("+json") || mime == "application/xml" || mime.ends_with("+xml");
    let limit = if image { 5 * 1024 * 1024 } else { 1024 * 1024 };
    let mut bytes = Vec::new();
    if (image || text) && size.is_none_or(|n| n <= limit as u64) {
        while let Some(chunk) = response.chunk().await.map_err(|_| AppError::other("아티팩트를 읽지 못했어요"))? {
            if bytes.len() + chunk.len() > limit {
                bytes.clear();
                break;
            }
            bytes.extend_from_slice(&chunk);
        }
        if size.is_none() && !bytes.is_empty() {
            size = Some(bytes.len() as u64);
        }
    }
    let text_value = if text && !bytes.is_empty() {
        String::from_utf8(bytes.clone()).ok()
    } else {
        None
    };
    let image_value = if image && !bytes.is_empty() { Some(STANDARD.encode(&bytes)) } else { None };
    Ok(json!({"contentType":content_type, "size":size, "text":text_value, "imageBase64":image_value}))
}

async fn pick(app: tauri::AppHandle, name: String) -> Result<Option<std::path::PathBuf>, AppError> {
    let selected = tokio::task::spawn_blocking(move || app.dialog().file().set_file_name(name).blocking_save_file())
        .await
        .map_err(|_| AppError::other("저장 창을 열지 못했어요"))?;
    selected
        .map(|p| p.into_path().map_err(|_| AppError::other("저장 경로를 읽지 못했어요")))
        .transpose()
}
pub async fn save_text(app: tauri::AppHandle, name: String, text: String) -> Result<Option<String>, AppError> {
    let Some(path) = pick(app, name).await? else {
        return Ok(None);
    };
    tokio::fs::write(&path, text)
        .await
        .map_err(|e| AppError::other(format!("파일을 저장하지 못했어요: {e}")))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}
pub async fn save_artifact(app: tauri::AppHandle, state: &State, server: &Server, artifact: &Artifact) -> Result<Option<String>, AppError> {
    let Some(path) = pick(app, artifact.name.clone()).await? else {
        return Ok(None);
    };
    let mut response = request(state, server, artifact).await?;
    let mut file = tokio::fs::File::create(&path)
        .await
        .map_err(|e| AppError::other(format!("파일을 저장하지 못했어요: {e}")))?;
    while let Some(chunk) = response.chunk().await.map_err(|_| AppError::other("아티팩트를 읽지 못했어요"))? {
        file.write_all(&chunk)
            .await
            .map_err(|e| AppError::other(format!("파일을 저장하지 못했어요: {e}")))?;
    }
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn argowf_artifact_path() {
        let artifact = Artifact {
            target: Target::Live {
                namespace: "ns".into(),
                name: "wf".into(),
            },
            node_id: "node".into(),
            name: "data".into(),
            direction: "output".into(),
        };
        assert_eq!(
            artifact_path("ns".into(), "workflows", "wf".into(), &artifact).unwrap(),
            ["artifact-files", "ns", "workflows", "wf", "node", "outputs", "data"]
        );
        assert_eq!(
            artifact_path("ns".into(), "archived-workflows", "uid".into(), &artifact).unwrap()[2],
            "archived-workflows"
        );
    }
}
