//! DynamoDB 탭의 명령. 이 단계(D1)의 명령은 AWS를 읽기만 한다. 변경 기록 경로(`dynamo-changes.jsonl`)는 `DynamoState`가 들고 있다.
//! 아이템 본문은 메모리에만 둔다: 디스크 캐시·⌘K 색인·변경 기록 파일에 남기지 않는다.

use std::path::PathBuf;

use tauri::State;

use crate::commands::AppState;
use crate::dynamo::{read, DynamoOverview, DynamoTable, TopKeys};
use crate::error::AppError;
use crate::iam::clock::now_secs;

/// 앱이 시작할 때 한 번 `manage`한다. 뒤 단계가 여기에 필드를 더한다: 스트림 읽기 세션(`streamId` → 샤드 반복자),
/// 아이템 쓰기의 되돌리기용 이전 이미지(메모리만). 변경 기록은 `log_path`의 JSON Lines다.
pub struct DynamoState {
    /// 변경 기록 파일(`dynamo-changes.jsonl`). 키와 바뀐 속성 이름만 쓰고 아이템 값은 쓰지 않는다
    #[allow(dead_code)]
    log_path: PathBuf,
}

impl DynamoState {
    pub fn new(log_path: PathBuf) -> DynamoState {
        DynamoState { log_path }
    }
}

/// 리전의 테이블 목록과 진단. 권한이 없는 부분이 있어도 나머지는 돌려주고 그 부분을 `gaps`에 적는다
#[tauri::command]
pub async fn dynamo_overview(state: State<'_, AppState>, profile: String, region: String) -> Result<DynamoOverview, AppError> {
    let cfg = state.ctx.config(&profile, &region).await?;
    read::read_overview(&cfg).await
}

/// 테이블 하나를 다시 읽는다(진단 포함). 만드는 중·백필 중인 테이블을 10초마다 볼 때 쓴다
#[tauri::command]
pub async fn dynamo_table(state: State<'_, AppState>, profile: String, region: String, table: String) -> Result<DynamoTable, AppError> {
    let cfg = state.ctx.config(&profile, &region).await?;
    read::read_table(&cfg, &table).await
}

/// Contributor Insights가 켜진 테이블의 최근 1시간 상위 키
#[tauri::command]
pub async fn dynamo_top_keys(state: State<'_, AppState>, profile: String, region: String, table: String) -> Result<TopKeys, AppError> {
    let cfg = state.ctx.config(&profile, &region).await?;
    read::top_keys(&cfg, &table, now_secs()).await
}
