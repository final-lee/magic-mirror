use serde_json::{Map, Value};
use tauri::State;
use tauri_plugin_dialog::DialogExt;

use crate::{
    commands::AppState,
    dynamo::{attr, items::{self, ItemPage, ReadRequest}},
    error::AppError,
};

#[tauri::command]
pub async fn dynamo_read(state: State<'_, AppState>, profile: String, region: String, table: String, req: ReadRequest) -> Result<ItemPage, AppError> {
    let cfg = state.ctx.config(&profile, &region).await?;
    items::read(&cfg, &table, req).await
}

#[tauri::command]
pub async fn dynamo_export_path(app: tauri::AppHandle, name: String) -> Result<Option<String>, AppError> {
    let path = tokio::task::spawn_blocking(move || app.dialog().file().set_file_name(name).blocking_save_file())
        .await.map_err(|_| AppError::other("저장 창을 열지 못했어요"))?;
    path.map(|path| path.into_path().map(|path| path.to_string_lossy().into_owned())
        .map_err(|_| AppError::other("저장 경로를 읽지 못했어요"))).transpose()
}

fn plain(value: &Value) -> Value {
    let Some((tag, content)) = value.as_object().and_then(|object| object.iter().next()) else { return Value::Null };
    match tag.as_str() {
        "S" | "B" | "BOOL" => content.clone(),
        "NULL" => Value::Null,
        "N" => {
            let text = content.as_str().unwrap_or_default();
            let digits = text.split(['e', 'E']).next().unwrap_or("").chars()
                .filter(|character| character.is_ascii_digit()).skip_while(|character| *character == '0').count();
            if digits <= 15 {
                text.parse::<f64>().ok().filter(|number| number.is_finite() && number.abs() <= 9_007_199_254_740_991.0)
                    .and_then(serde_json::Number::from_f64).map(Value::Number).unwrap_or_else(|| content.clone())
            } else { content.clone() }
        }
        "SS" | "NS" | "BS" => content.clone(),
        "L" => Value::Array(content.as_array().map(|items| items.iter().map(plain).collect()).unwrap_or_default()),
        "M" => Value::Object(content.as_object().map(|item| item.iter().map(|(key, value)| (key.clone(), plain(value))).collect()).unwrap_or_default()),
        _ => Value::Null,
    }
}

fn csv_field(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

#[tauri::command]
pub async fn dynamo_export(path: String, items: Vec<Value>, format: String) -> Result<(), AppError> {
    for item in &items { attr::item_from_json(item)?; }
    let plain_items: Vec<Value> = items.iter().map(|item| Value::Object(item.as_object().unwrap().iter()
        .map(|(key, value)| (key.clone(), plain(value))).collect::<Map<_, _>>())).collect();
    let output = match format.as_str() {
        "ddbJsonl" | "jsonl" => {
            let rows = if format == "ddbJsonl" { &items } else { &plain_items };
            rows.iter().map(|row| row.to_string() + "\n").collect::<String>()
        }
        "csv" => {
            let mut keys: Vec<String> = plain_items.iter().flat_map(|item| item.as_object().unwrap().keys().cloned()).collect();
            keys.sort();
            keys.dedup();
            let mut output = keys.iter().map(|key| csv_field(key)).collect::<Vec<_>>().join(",") + "\n";
            for item in &plain_items {
                let row = keys.iter().map(|key| {
                    let value = item.get(key).unwrap_or(&Value::Null);
                    csv_field(&match value { Value::Null => String::new(), Value::String(text) => text.clone(), _ => value.to_string() })
                }).collect::<Vec<_>>().join(",");
                output.push_str(&row);
                output.push('\n');
            }
            output
        }
        _ => return Err(AppError::other("지원하지 않는 내보내기 형식이에요")),
    };
    tokio::fs::write(path, output).await.map_err(|error| AppError::other(format!("파일을 저장하지 못했어요: {error}")))
}
