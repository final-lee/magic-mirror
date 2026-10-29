//! 데이터베이스 변경 기록: 앱 데이터 폴더의 `db-changes.jsonl`(IAM의 `iam-changes.jsonl` 옆). 한 줄이 변경 하나이고 새 기록은 맨 아래에 붙는다.
//! 읽기·덧붙이기·고쳐 쓰기는 `jsonl`이 한다. 기록의 `sql`은 가린 글(`Statement::shown`)이라 비밀번호도 검증값도 파일에 없다.

use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::change::model::PgChange;
use crate::jsonl;

/// 계약의 `PgChangeLogEntry`
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PgLogEntry {
    pub id: String,
    /// ISO 8601
    pub at: String,
    pub profile: String,
    pub target_arn: String,
    pub database: String,
    pub login_user: String,
    pub change: PgChange,
    pub summary: String,
    /// 보낸 문장들. 비밀번호는 가려져 있다
    pub sql: Vec<String>,
    pub ok: bool,
    pub error: Option<String>,
    /// 되돌리는 변경들. `None`은 되돌릴 수 없다
    pub inverse: Option<Vec<PgChange>>,
    /// 이 기록이 되돌린 기록의 id
    pub undo_of: Option<String>,
    #[serde(default)]
    pub undone: bool,
    /// 묶음으로 적용한 변경. 같은 묶음의 기록은 같은 값을 쓴다
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<String>,
}

pub fn append(path: &Path, e: &PgLogEntry) -> io::Result<()> {
    jsonl::append(path, e)
}

/// 덧붙인 순서(오래된 것부터). 읽을 수 없는 줄은 건너뛴다
pub fn read_all(path: &Path) -> Vec<PgLogEntry> {
    jsonl::read_all(path)
}

pub fn mark_undone(path: &Path, id: &str) -> io::Result<()> {
    jsonl::update(path, |entry: &PgLogEntry| entry.id == id, |entry| entry.undone = true)
}

#[cfg(test)]
mod tests;
