//! 변경 적용의 마지막 관문. 백엔드가 미리보기를 다시 계산해 막힘과 확인 문구를 확인한 뒤에만 쓰기 호출을 하고, 결과를 변경 기록에 남긴다.
//! IAM 쓰기 호출은 `write`에 있고 여기서는 함수로 받는다(테스트는 가짜 쓰기를 넣는다).

use std::collections::hash_map::RandomState;
use std::future::Future;
use std::hash::{BuildHasher, Hasher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::Serialize;

use super::change::{inverse, preview, ChangePreview, IamChange, WarnLevel};
use super::clock::{iso, parse_iso};
use super::log::{self, ChangeLogEntry};
use super::model::Snapshot;
use crate::error::AppError;

/// 스냅숏이 이보다 오래됐으면 적용 전에 새로 읽는다(초).
pub const FRESH_SECS: i64 = 60;

/// 계약의 `ApplyResult`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub log_id: String,
    pub summary: String,
}

/// 적용 요청. 스냅숏은 적용 직전에 읽은(또는 60초 안에 읽은) 것이어야 한다.
pub struct Request {
    pub profile: String,
    pub snapshot: Arc<Snapshot>,
    /// 액세스 키 변경이면 그 키의 지금 상태(`"Active"`/`"Inactive"`)
    pub key_status: Option<String>,
    pub change: IamChange,
    pub confirm_text: Option<String>,
    /// 되돌리기면 되돌리는 기록의 id
    pub undo_of: Option<String>,
    pub log_path: PathBuf,
    /// 유닉스 초
    pub now: i64,
    pub log_id: String,
}

/// 적용 결과. `wrote`가 true면 쓰기 호출을 했으므로 읽어 둔 스냅숏을 버려야 한다(실패해도 일부가 적용됐을 수 있다).
pub struct Committed {
    pub result: Result<ApplyResult, AppError>,
    pub wrote: bool,
}

/// 읽어 둔 스냅숏이 적용하기에 낡았는가. 시각을 읽지 못해도 낡은 것으로 본다.
pub fn is_stale(fetched_at: &str, now: i64) -> bool {
    parse_iso(fetched_at).is_none_or(|read| now - read > FRESH_SECS)
}

/// 변경 기록의 새 id. 시각(밀리초)·이 프로세스 안의 순번·무작위 값으로 만든다.
pub fn new_log_id(now_millis: u128) -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let random = RandomState::new().build_hasher().finish();
    format!("{now_millis:x}-{:x}-{:08x}", NEXT.fetch_add(1, Ordering::Relaxed), random as u32)
}

/// 미리보기대로 적용해도 되는지. 막힘이 있으면 거부하고, 확인 문구가 필요하면 한 글자도 다르지 않게 입력해야 한다.
pub fn gate(preview: &ChangePreview, typed: Option<&str>) -> Result<(), AppError> {
    let blocks: Vec<&str> = preview.warnings.iter().filter(|w| w.level == WarnLevel::Block).map(|w| w.message.as_str()).collect();
    if !blocks.is_empty() {
        return Err(AppError::other(format!("막혀 있어서 적용할 수 없어요: {}", blocks.join(" / "))));
    }
    match preview.confirm_text.as_deref() {
        Some(expected) if typed != Some(expected) => Err(AppError::other(format!("확인 문구가 달라요. 입력해야 할 이름: {expected}"))),
        Some(_) => Ok(()),
        // 확인이 필요한데 입력할 이름을 알 수 없으면 확인할 방법이 없다
        None if preview.warnings.iter().any(|w| w.level == WarnLevel::Confirm) => Err(AppError::other("확인할 이름을 알 수 없어서 적용할 수 없어요")),
        None => Ok(()),
    }
}

/// 변경 기록에서 `id`의 역변경. 기록이 없거나 되돌릴 수 없거나 이미 되돌렸으면 이유(한국어)를 오류로 돌려준다.
pub fn undo_change_of(entries: &[ChangeLogEntry], id: &str) -> Result<IamChange, AppError> {
    let entry = entries.iter().find(|e| e.id == id).ok_or_else(|| AppError::other("변경 기록을 찾을 수 없어요"))?;
    let inverse = entry.inverse.clone().ok_or_else(|| AppError::other("되돌릴 수 없는 변경이에요"))?;
    if entry.undone {
        return Err(AppError::other("이미 되돌린 변경이에요"));
    }
    Ok(inverse)
}

/// 되돌리기로 들어온 요청이 기록과 맞는지: 기록이 있고, 되돌릴 수 있고, 아직 안 되돌렸고, 같은 계정이고, 적용하려는 변경이 기록된 역변경과 같다.
pub fn check_undo(entries: &[ChangeLogEntry], id: &str, change: &IamChange, account_id: &str) -> Result<(), AppError> {
    let recorded = undo_change_of(entries, id)?;
    if let Some(entry) = entries.iter().find(|e| e.id == id).filter(|e| e.account_id != account_id) {
        return Err(AppError::other(format!("다른 계정({})에서 한 변경이라 이 계정에서는 되돌릴 수 없어요", entry.account_id)));
    }
    if &recorded != change {
        return Err(AppError::other("되돌리려는 변경이 기록과 달라요"));
    }
    Ok(())
}

/// 되돌리기 점검, 미리보기 재계산, 관문까지 통과해야 쓰기로 넘어간다. (미리보기, 되돌리는 변경)을 돌려준다.
async fn prepare(req: &Request) -> Result<(ChangePreview, Option<IamChange>), AppError> {
    if let Some(id) = req.undo_of.as_deref() {
        check_undo(&log::read_all(&req.log_path), id, &req.change, &req.snapshot.account_id)?;
    }
    // 권한 계산은 CPU를 쓰는 일이라 비동기 실행기를 막지 않게 따로 돌린다
    let (snapshot, change, key_status) = (req.snapshot.clone(), req.change.clone(), req.key_status.clone());
    let (checked, undo) = tokio::task::spawn_blocking(move || (preview(&snapshot, &change, key_status.as_deref()), inverse(&snapshot, &change, key_status.as_deref())))
        .await
        .map_err(|e| AppError::other(format!("미리보기를 계산하지 못했어요: {e}")))?;
    gate(&checked, req.confirm_text.as_deref())?;
    Ok((checked, undo))
}

/// 쓰기 결과를 기록에 남기고 호출자에게 돌려줄 값을 만든다.
fn finish(req: Request, checked: ChangePreview, undo: Option<IamChange>, outcome: Result<Vec<String>, AppError>) -> Committed {
    let ok = outcome.is_ok();
    let entry = ChangeLogEntry {
        id: req.log_id.clone(),
        at: iso(req.now),
        profile: req.profile.clone(),
        account_id: req.snapshot.account_id.clone(),
        caller_arn: req.snapshot.caller_arn.clone(),
        change: req.change.clone(),
        summary: checked.summary.clone(),
        calls: checked.calls.iter().map(|call| call.api.clone()).collect(),
        ok,
        error: outcome.as_ref().err().map(ToString::to_string),
        // 적용되지 않은 변경은 되돌릴 것이 없다
        inverse: if ok { undo } else { None },
        undo_of: req.undo_of.clone(),
        undone: false,
    };
    let mut notes = Vec::new();
    match log::append(&req.log_path, &entry) {
        Err(e) => notes.push(format!("변경 기록을 저장하지 못했어요: {e}")),
        Ok(()) if ok => {
            if let Some(original) = &req.undo_of {
                if let Err(e) = log::mark_undone(&req.log_path, original) {
                    notes.push(format!("이전 기록에 '되돌림' 표시를 하지 못했어요: {e}"));
                }
            }
        }
        Ok(()) => {}
    }
    let result = outcome.map(|_| {
        let summary = if notes.is_empty() { checked.summary } else { format!("{} ({})", checked.summary, notes.join(", ")) };
        ApplyResult { log_id: req.log_id, summary }
    });
    Committed { result, wrote: true }
}

/// 미리보기를 다시 계산해 거를 것을 거르고, `write`로 적용하고, 결과를 기록에 남긴다.
/// 거부되면 `write`를 부르지 않고 기록도 남기지 않는다. 적용에 실패하면 실패한 기록(`ok=false`)을 남기고 그 오류를 돌려준다.
/// 기록을 저장하지 못한 것은 이미 적용된 변경을 가리지 않도록 오류가 아니라 요약에 덧붙인다.
pub async fn commit<W, Fut>(req: Request, write: W) -> Committed
where
    W: FnOnce() -> Fut,
    Fut: Future<Output = Result<Vec<String>, AppError>>,
{
    match prepare(&req).await {
        Err(refused) => Committed { result: Err(refused), wrote: false },
        Ok((checked, undo)) => {
            let outcome = write().await;
            finish(req, checked, undo, outcome)
        }
    }
}

#[cfg(test)]
mod tests;
