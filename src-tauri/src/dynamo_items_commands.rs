use serde_json::{Value, Map};
use tauri::State;
use tauri_plugin_dialog::DialogExt;
use crate::{commands::AppState, dynamo::{attr, items::{self, ItemPage, ReadRequest}}, error::AppError};

#[tauri::command]
pub async fn dynamo_read(state: State<'_, AppState>, profile: String, region: String, table: String, req: ReadRequest) -> Result<ItemPage, AppError> {
 let cfg=state.ctx.config(&profile,&region).await?; items::read(&cfg,&table,req).await
}
#[tauri::command]
pub async fn dynamo_export_path(app: tauri::AppHandle, name: String) -> Result<Option<String>, AppError> {
 let path = tokio::task::spawn_blocking(move || app.dialog().file().set_file_name(name).blocking_save_file()).await.map_err(|_| AppError::other("저장 창을 열지 못했어요"))?;
 path.map(|p| p.into_path().map(|p| p.to_string_lossy().into_owned()).map_err(|_| AppError::other("저장 경로를 읽지 못했어요"))).transpose()
}
fn plain(v: &Value) -> Value {
 let Some((tag,x))=v.as_object().and_then(|m|m.iter().next()) else {return Value::Null};
 match tag.as_str() {
  "S"|"B"|"BOOL" => x.clone(), "NULL" => Value::Null,
  "N" => { let text=x.as_str().unwrap_or_default(); let digits=text.split(['e','E']).next().unwrap_or("").chars().filter(|c|c.is_ascii_digit()).skip_while(|c|*c=='0').count(); if digits<=15 { text.parse::<f64>().ok().filter(|n|n.is_finite() && n.abs()<=9_007_199_254_740_991.0).and_then(serde_json::Number::from_f64).map(Value::Number).unwrap_or_else(||x.clone()) } else { x.clone() } },
  "SS"|"NS"|"BS" => x.clone(), "L" => Value::Array(x.as_array().map(|a|a.iter().map(plain).collect()).unwrap_or_default()),
  "M" => Value::Object(x.as_object().map(|m|m.iter().map(|(k,v)|(k.clone(),plain(v))).collect()).unwrap_or_default()), _=>Value::Null
 }
}
fn csv_field(s: &str) -> String { format!("\"{}\"",s.replace('"',"\"\"")) }
#[tauri::command]
pub async fn dynamo_export(path: String, items: Vec<Value>, format: String) -> Result<(), AppError> {
 for i in &items { attr::item_from_json(i)?; }
 let plain_items: Vec<Value>=items.iter().map(|i|Value::Object(i.as_object().unwrap().iter().map(|(k,v)|(k.clone(),plain(v))).collect::<Map<_,_>>())).collect();
 let output=match format.as_str() {
  "ddbJsonl" | "jsonl" => { let rows=if format=="ddbJsonl" {&items}else{&plain_items}; rows.iter().map(|v|v.to_string()+"\n").collect::<String>() },
  "csv" => { let mut keys: Vec<String>=plain_items.iter().flat_map(|v|v.as_object().unwrap().keys().cloned()).collect(); keys.sort(); keys.dedup(); let mut out=keys.iter().map(|k|csv_field(k)).collect::<Vec<_>>().join(",")+"\n"; for item in &plain_items { out.push_str(&keys.iter().map(|k| {let v=item.get(k).unwrap_or(&Value::Null); csv_field(&match v {Value::Null=>String::new(),Value::String(s)=>s.clone(),_=>v.to_string()})}).collect::<Vec<_>>().join(",")); out.push('\n'); } out },
  _=>return Err(AppError::other("지원하지 않는 내보내기 형식이에요"))
 };
 tokio::fs::write(path,output).await.map_err(|e|AppError::other(format!("파일을 저장하지 못했어요: {e}")))
}
