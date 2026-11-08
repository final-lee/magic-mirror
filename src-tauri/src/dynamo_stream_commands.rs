//! DynamoDB 탭의 스트림·연결 명령(D5). AWS를 읽기만 한다. 스트림 읽기 세션은 `DynamoState`가 들고 있다.

use tauri::State;

use crate::commands::AppState;
use crate::dynamo::{connections, stream};
use crate::dynamo_commands::DynamoState;
use crate::error::AppError;

/// 테이블의 스트림 소비자(Lambda ESM·Pipes)·Kinesis 대상·글로벌 테이블 복제본과 지연, 그리고 그에 대한 진단.
/// 권한이 없는 부분이 있어도 나머지는 돌려주고 그 부분을 `gaps`에 적는다
#[tauri::command]
pub async fn dynamo_connections(state: State<'_, AppState>, profile: String, region: String, table: String) -> Result<connections::Connections, AppError> {
    let cfg = state.ctx.config(&profile, &region).await?;
    connections::read(&cfg, &table).await
}

/// 스트림 읽기 세션을 연다. `from`은 `LATEST` 또는 `TRIM_HORIZON`
#[tauri::command]
pub async fn dynamo_stream_start(
    state: State<'_, AppState>,
    dynamo: State<'_, DynamoState>,
    profile: String,
    region: String,
    table: String,
    from: String,
) -> Result<stream::Start, AppError> {
    let cfg = state.ctx.config(&profile, &region).await?;
    stream::start(&cfg, &table, &from, &dynamo.stream_sessions).await
}

/// 세션이 읽은 새 레코드. 화면이 보이는 동안 2초마다 부른다
#[tauri::command]
pub async fn dynamo_stream_poll(dynamo: State<'_, DynamoState>, stream_id: String) -> Result<stream::Poll, AppError> {
    stream::poll(&stream_id, &dynamo.stream_sessions).await
}

/// 세션을 지운다. 없는 세션이어도 오류가 아니다
#[tauri::command]
pub async fn dynamo_stream_stop(dynamo: State<'_, DynamoState>, stream_id: String) -> Result<(), AppError> {
    stream::stop(&stream_id, &dynamo.stream_sessions).await;
    Ok(())
}
