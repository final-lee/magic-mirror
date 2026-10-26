pub mod diff;
pub mod keys;
pub mod local;
pub mod s3ops;
pub mod textfile;
pub mod transfer;

use serde::{Deserialize, Serialize};

use crate::error::AppError;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "source", rename_all = "camelCase")]
pub enum FileRef {
    Local { path: String },
    S3 { bucket: String, region: String, key: String },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub modified: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Upload,
    Download,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferRequest {
    pub id: String,
    pub direction: Direction,
    pub local_path: String,
    pub bucket: String,
    pub region: String,
    pub key: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferStatus {
    Queued,
    Running,
    Done,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferEvent {
    pub id: String,
    pub status: TransferStatus,
    pub transferred: u64,
    pub total: Option<u64>,
    pub error: Option<AppError>,
}

impl TransferEvent {
    pub fn new(id: &str, status: TransferStatus, transferred: u64, total: Option<u64>) -> Self {
        Self { id: id.to_string(), status, transferred, total, error: None }
    }

    pub fn failed(id: &str, error: AppError) -> Self {
        Self { id: id.to_string(), status: TransferStatus::Failed, transferred: 0, total: None, error: Some(error) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_ref_json_shape() {
        let s3: FileRef = serde_json::from_value(serde_json::json!({
            "source": "s3", "bucket": "b", "region": "ap-northeast-2", "key": "a/x.txt"
        }))
        .unwrap();
        assert_eq!(s3, FileRef::S3 { bucket: "b".into(), region: "ap-northeast-2".into(), key: "a/x.txt".into() });
        let local = serde_json::to_value(FileRef::Local { path: "/tmp/a".into() }).unwrap();
        assert_eq!(local, serde_json::json!({ "source": "local", "path": "/tmp/a" }));
    }

    #[test]
    fn transfer_types_json_shape() {
        let req: TransferRequest = serde_json::from_value(serde_json::json!({
            "id": "1", "direction": "upload", "localPath": "/a", "bucket": "b", "region": "r", "key": "k"
        }))
        .unwrap();
        assert_eq!(req.direction, Direction::Upload);
        let ev = serde_json::to_value(TransferEvent::failed("1", AppError::Throttled)).unwrap();
        assert_eq!(ev["status"], "failed");
        assert_eq!(ev["error"]["kind"], "throttled");
        let entry = serde_json::to_value(LocalEntry {
            name: "a".into(), path: "/a".into(), is_dir: true, size: None, modified: None,
        })
        .unwrap();
        assert_eq!(entry["isDir"], true);
    }
}
