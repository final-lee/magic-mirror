use std::path::{Path, PathBuf};
use std::sync::Arc;

use aws_config::SdkConfig;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client;
use tokio::io::AsyncWriteExt;

use super::s3ops::MAX_SINGLE_PUT;
use super::{Direction, TransferEvent, TransferRequest, TransferStatus};
use crate::error::{from_sdk, AppError};

pub const PROGRESS_STEP: u64 = 512 * 1024;

pub trait ProgressSink: Send + Sync {
    fn emit(&self, ev: TransferEvent);
}

pub fn part_path(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".part");
    dest.with_file_name(name)
}

pub fn check_upload_size(len: u64) -> Result<(), AppError> {
    if len > MAX_SINGLE_PUT {
        Err(AppError::other("5GB가 넘는 파일은 아직 업로드할 수 없어요"))
    } else {
        Ok(())
    }
}

fn io_err(e: std::io::Error) -> AppError {
    AppError::other(format!("파일 오류: {e}"))
}

pub async fn run(cfg: SdkConfig, req: TransferRequest, sink: Arc<dyn ProgressSink>) {
    let client = Client::new(&cfg);
    let result = match req.direction {
        Direction::Upload => upload(&client, &req, sink.as_ref()).await,
        Direction::Download => download(&client, &req, sink.as_ref()).await,
    };
    match result {
        Ok(total) => sink.emit(TransferEvent::new(&req.id, TransferStatus::Done, total, Some(total))),
        Err(e) => sink.emit(TransferEvent::failed(&req.id, e)),
    }
}

async fn upload(client: &Client, req: &TransferRequest, sink: &dyn ProgressSink) -> Result<u64, AppError> {
    let len = tokio::fs::metadata(&req.local_path).await.map_err(io_err)?.len();
    check_upload_size(len)?;
    sink.emit(TransferEvent::new(&req.id, TransferStatus::Running, 0, Some(len)));
    let body = ByteStream::from_path(&req.local_path)
        .await
        .map_err(|e| AppError::other(format!("파일을 읽을 수 없어요: {e}")))?;
    client
        .put_object()
        .bucket(&req.bucket)
        .key(&req.key)
        .body(body)
        .send()
        .await
        .map_err(|e| from_sdk(e, "s3:PutObject"))?;
    Ok(len)
}

async fn download(client: &Client, req: &TransferRequest, sink: &dyn ProgressSink) -> Result<u64, AppError> {
    let out = client
        .get_object()
        .bucket(&req.bucket)
        .key(&req.key)
        .send()
        .await
        .map_err(|e| from_sdk(e, "s3:GetObject"))?;
    let total = out.content_length().map(|l| l.max(0) as u64);
    let dest = PathBuf::from(&req.local_path);
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(io_err)?;
    }
    let part = part_path(&dest);
    sink.emit(TransferEvent::new(&req.id, TransferStatus::Running, 0, total));
    let result: Result<u64, AppError> = async {
        let mut file = tokio::fs::File::create(&part).await.map_err(io_err)?;
        let mut body = out.body;
        let (mut done, mut last) = (0u64, 0u64);
        while let Some(chunk) = body.try_next().await.map_err(|e| AppError::Network { message: e.to_string() })? {
            file.write_all(&chunk).await.map_err(io_err)?;
            done += chunk.len() as u64;
            if done - last >= PROGRESS_STEP {
                sink.emit(TransferEvent::new(&req.id, TransferStatus::Running, done, total));
                last = done;
            }
        }
        file.flush().await.map_err(io_err)?;
        Ok(done)
    }
    .await;
    match result {
        Ok(done) => {
            tokio::fs::rename(&part, &dest).await.map_err(io_err)?;
            Ok(done)
        }
        Err(e) => {
            let _ = tokio::fs::remove_file(&part).await;
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn part_path_appends_suffix() {
        assert_eq!(part_path(Path::new("/tmp/a/report.csv")), PathBuf::from("/tmp/a/report.csv.part"));
    }

    #[test]
    fn upload_size_limit() {
        assert!(check_upload_size(MAX_SINGLE_PUT).is_ok());
        assert_eq!(
            check_upload_size(MAX_SINGLE_PUT + 1),
            Err(AppError::other("5GB가 넘는 파일은 아직 업로드할 수 없어요"))
        );
    }
}
