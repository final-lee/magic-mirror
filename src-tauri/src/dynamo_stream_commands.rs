use tauri::State;
use crate::{commands::AppState, dynamo::{connections, stream}, dynamo_commands::DynamoState, error::AppError};

#[tauri::command]
pub async fn dynamo_connections(state: State<'_, AppState>, profile: String, region: String, table: String) -> Result<connections::Connections, AppError> {
    let cfg = state.ctx.config(&profile, &region).await?;
    connections::read(&cfg, &table).await
}
#[tauri::command]
pub async fn dynamo_stream_start(state: State<'_, AppState>, dynamo: State<'_, DynamoState>, profile: String, region: String, table: String, from: String) -> Result<stream::Start, AppError> {
    let cfg = state.ctx.config(&profile, &region).await?;
    stream::start(&cfg, &table, &from, &dynamo.stream_sessions).await
}
#[tauri::command]
pub async fn dynamo_stream_poll(dynamo: State<'_, DynamoState>, stream_id: String) -> Result<stream::Poll, AppError> {
    stream::poll(&stream_id, &dynamo.stream_sessions).await
}
#[tauri::command]
pub async fn dynamo_stream_stop(dynamo: State<'_, DynamoState>, stream_id: String) -> Result<(), AppError> {
    stream::stop(&stream_id, &dynamo.stream_sessions).await;
    Ok(())
}
