//! 변경 기록(`sqs-changes.jsonl`). 한 줄이 기록 하나이고 메시지 본문은 남기지 않는다(ID·개수만). 되돌리기는 없다.

use std::io;
use std::path::Path;

use super::SqsChangeRecord;
use crate::jsonl;

/// 기록 하나를 파일 끝에 덧붙인다
pub fn append(path: &Path, record: &SqsChangeRecord) -> io::Result<()> {
    jsonl::append(path, record)
}

/// 이 프로필·리전의 기록(오래된 것부터)
pub fn read(path: &Path, profile: &str, region: &str) -> Vec<SqsChangeRecord> {
    jsonl::read_all::<SqsChangeRecord>(path).into_iter().filter(|r| r.profile == profile && r.region == region).collect()
}

#[cfg(test)]
mod tests;
