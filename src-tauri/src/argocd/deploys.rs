//! 서버가 보관한 배포 이력(`status.history`)을 모든 앱에서 모은다. 배포 지표가 로컬 이벤트 기록과 합쳐 쓴다.
//! 서버는 성공한 sync만 남기고 앱마다 기본 10개까지만 보관한다.
use serde::Serialize;
use serde_json::Value;

use super::history::entries_of;
use super::{list, text};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployRecord {
    pub namespace: String,
    pub app: String,
    /// 이력 번호
    pub id: i64,
    /// 이 배포의 첫 소스 리비전. 이력에 리비전이 없으면 None
    pub revision: Option<String>,
    pub started_at: Option<String>,
    pub deployed_at: Option<String>,
}

/// 앱 목록 응답의 모든 앱에서 이력 한 건씩. 배포 시각이 없는 항목은 지표에 쓸 수 없어 버린다.
pub fn records_of(apps: &Value) -> Vec<DeployRecord> {
    list(apps, "/items")
        .iter()
        .flat_map(|app| {
            let namespace = text(app, "/metadata/namespace").unwrap_or_default().to_owned();
            let name = text(app, "/metadata/name").unwrap_or_default().to_owned();
            entries_of(app).into_iter().filter(|e| e.deployed_at.is_some()).map(move |entry| DeployRecord {
                namespace: namespace.clone(),
                app: name.clone(),
                id: entry.id,
                revision: entry.revisions.first().map(|r| r.revision.clone()),
                started_at: entry.deploy_started_at,
                deployed_at: entry.deployed_at,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests;
