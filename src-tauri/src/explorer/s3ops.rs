use std::path::Path;

use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::{Delete, ObjectIdentifier};
use aws_sdk_s3::Client;
use tokio::io::AsyncWriteExt;

use super::keys::moved_key;
use super::textfile::{classify_bytes, Content, SideMeta, MAX_TEXT_BYTES};
use crate::adapters::util::{dt, url_encode};
use crate::error::{from_sdk, AppError};

pub const DELETE_BATCH: usize = 1000;
pub const MAX_SINGLE_PUT: u64 = 5 * 1024 * 1024 * 1024;

/// 단일 파트 업로드의 ETag만 MD5다("-"가 들어가면 멀티파트).
pub fn etag_md5(etag: Option<&str>) -> Option<String> {
    let e = etag?.trim_matches('"');
    (!e.contains('-') && e.len() == 32).then(|| e.to_ascii_lowercase())
}

/// CopyObject의 CopySource: "버킷/URL 인코딩된 키".
pub fn copy_source(bucket: &str, key: &str) -> String {
    format!("{bucket}/{}", url_encode(key))
}

pub async fn exists(client: &Client, bucket: &str, key: &str) -> Result<bool, AppError> {
    match client.head_object().bucket(bucket).key(key).send().await {
        Ok(_) => Ok(true),
        Err(e) if e.as_service_error().is_some_and(|s| s.is_not_found()) => Ok(false),
        Err(e) => Err(from_sdk(e, "s3:GetObject")),
    }
}

pub async fn prefix_has_objects(client: &Client, bucket: &str, prefix: &str) -> Result<bool, AppError> {
    let out = client
        .list_objects_v2()
        .bucket(bucket)
        .prefix(prefix)
        .max_keys(1)
        .send()
        .await
        .map_err(|e| from_sdk(e, "s3:ListBucket"))?;
    Ok(!out.contents().is_empty())
}

/// prefix 아래 모든 키와 크기(폴더 표시 객체 포함).
pub async fn list_keys(client: &Client, bucket: &str, prefix: &str) -> Result<Vec<(String, i64)>, AppError> {
    let mut out = Vec::new();
    let mut pages = client.list_objects_v2().bucket(bucket).prefix(prefix).into_paginator().send();
    while let Some(page) = pages.next().await {
        let page = page.map_err(|e| from_sdk(e, "s3:ListBucket"))?;
        for o in page.contents() {
            if let Some(k) = o.key() {
                out.push((k.to_string(), o.size().unwrap_or(0)));
            }
        }
    }
    Ok(out)
}

/// 폴더(`/`로 끝남)는 하위 키 전체로, 파일은 HeadObject 크기와 함께 그대로. 중복 제거.
pub async fn expand_keys(client: &Client, bucket: &str, keys: &[String]) -> Result<Vec<(String, i64)>, AppError> {
    let mut out: Vec<(String, i64)> = Vec::new();
    for key in keys {
        if key.ends_with('/') {
            out.extend(list_keys(client, bucket, key).await?);
        } else {
            let head = client
                .head_object()
                .bucket(bucket)
                .key(key)
                .send()
                .await
                .map_err(|e| from_sdk(e, "s3:GetObject"))?;
            out.push((key.clone(), head.content_length().unwrap_or(0)));
        }
    }
    out.sort();
    out.dedup_by(|a, b| a.0 == b.0);
    Ok(out)
}

pub async fn create_folder(client: &Client, bucket: &str, key: &str) -> Result<(), AppError> {
    client
        .put_object()
        .bucket(bucket)
        .key(key)
        .body(ByteStream::from_static(b""))
        .send()
        .await
        .map_err(|e| from_sdk(e, "s3:PutObject"))?;
    Ok(())
}

pub async fn delete_keys(client: &Client, bucket: &str, keys: Vec<String>) -> Result<usize, AppError> {
    let mut deleted = 0;
    let mut failures: Vec<String> = Vec::new();
    for chunk in keys.chunks(DELETE_BATCH) {
        let ids = chunk
            .iter()
            .map(|k| ObjectIdentifier::builder().key(k).build().map_err(|e| AppError::other(e.to_string())))
            .collect::<Result<Vec<_>, _>>()?;
        let delete = Delete::builder()
            .set_objects(Some(ids))
            .quiet(true)
            .build()
            .map_err(|e| AppError::other(e.to_string()))?;
        let out = client
            .delete_objects()
            .bucket(bucket)
            .delete(delete)
            .send()
            .await
            .map_err(|e| from_sdk(e, "s3:DeleteObject"))?;
        let errs = out.errors();
        deleted += chunk.len() - errs.len();
        failures.extend(errs.iter().map(|e| format!("{}: {}", e.key().unwrap_or(""), e.message().unwrap_or(""))));
    }
    if failures.is_empty() {
        Ok(deleted)
    } else {
        Err(AppError::other(format!("{}개를 지우지 못했어요 ({})", failures.len(), failures[0])))
    }
}

/// 이동 전 검사: 같은 키이거나 폴더를 자기 자신 안으로 옮기는 경우를 막는다.
pub fn rename_guard(from: &str, to: &str) -> Result<(), String> {
    if from == to {
        return Err("원본과 대상이 같아요".to_string());
    }
    if from.ends_with('/') && to.starts_with(from) {
        return Err("폴더를 자기 자신 안으로 옮길 수 없어요".to_string());
    }
    Ok(())
}

/// 삭제할 원본 키: 복사 대상 키와 겹치는 것은 지우지 않는다.
pub fn keys_to_delete(sources: &[String], targets: &[String]) -> Vec<String> {
    sources.iter().filter(|k| !targets.contains(k)).cloned().collect()
}

/// 복사 후 삭제. 하나라도 복사에 실패하면 원본은 지우지 않는다.
pub async fn rename(client: &Client, bucket: &str, from: &str, to: &str) -> Result<(), AppError> {
    rename_guard(from, to).map_err(AppError::other)?;
    let items = expand_keys(client, bucket, &[from.to_string()]).await?;
    if let Some((k, _)) = items.iter().find(|(_, size)| *size as u64 > MAX_SINGLE_PUT) {
        return Err(AppError::other(format!("5GB가 넘는 파일은 아직 옮길 수 없어요 ({k})")));
    }
    let mut failed = 0;
    let mut first_err: Option<String> = None;
    let mut targets = Vec::with_capacity(items.len());
    for (key, _) in &items {
        let target = moved_key(from, to, key);
        targets.push(target.clone());
        let res = client
            .copy_object()
            .bucket(bucket)
            .copy_source(copy_source(bucket, key))
            .key(&target)
            .send()
            .await;
        if let Err(e) = res {
            failed += 1;
            if first_err.is_none() {
                first_err = Some(from_sdk(e, "s3:PutObject").to_string());
            }
        }
    }
    if failed > 0 {
        return Err(AppError::other(format!(
            "일부 객체를 옮기지 못했어요 ({failed}개): {}",
            first_err.unwrap_or_default()
        )));
    }
    let sources: Vec<String> = items.into_iter().map(|(k, _)| k).collect();
    delete_keys(client, bucket, keys_to_delete(&sources, &targets)).await?;
    Ok(())
}

pub async fn read_side(client: &Client, bucket: &str, key: &str) -> Result<(SideMeta, Content), AppError> {
    let head = client
        .head_object()
        .bucket(bucket)
        .key(key)
        .send()
        .await
        .map_err(|e| from_sdk(e, "s3:GetObject"))?;
    let size = head.content_length().unwrap_or(0).max(0) as u64;
    let meta = SideMeta {
        label: format!("s3://{bucket}/{key}"),
        size,
        modified: Some(dt(head.last_modified())).filter(|s| !s.is_empty()),
        md5: etag_md5(head.e_tag()),
    };
    if size > MAX_TEXT_BYTES {
        return Ok((meta, Content::TooLarge));
    }
    let out = client
        .get_object()
        .bucket(bucket)
        .key(key)
        .send()
        .await
        .map_err(|e| from_sdk(e, "s3:GetObject"))?;
    let bytes = out
        .body
        .collect()
        .await
        .map_err(|e| AppError::Network { message: e.to_string() })?
        .into_bytes()
        .to_vec();
    Ok((meta, classify_bytes(bytes)))
}

/// 외부 비교 도구용 임시 다운로드(진행 이벤트 없음).
pub async fn download_to(client: &Client, bucket: &str, key: &str, dest: &Path) -> Result<(), AppError> {
    let out = client
        .get_object()
        .bucket(bucket)
        .key(key)
        .send()
        .await
        .map_err(|e| from_sdk(e, "s3:GetObject"))?;
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| AppError::other(e.to_string()))?;
    }
    let mut file = tokio::fs::File::create(dest).await.map_err(|e| AppError::other(e.to_string()))?;
    let mut body = out.body;
    while let Some(chunk) = body.try_next().await.map_err(|e| AppError::Network { message: e.to_string() })? {
        file.write_all(&chunk).await.map_err(|e| AppError::other(e.to_string()))?;
    }
    file.flush().await.map_err(|e| AppError::other(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn etag_md5_only_for_single_part() {
        assert_eq!(etag_md5(Some("\"5D41402ABC4B2A76B9719D911017C592\"")), Some("5d41402abc4b2a76b9719d911017c592".into()));
        assert_eq!(etag_md5(Some("\"abc123-4\"")), None);
        assert_eq!(etag_md5(None), None);
    }

    #[test]
    fn rename_guard_rejects_folder_into_itself() {
        assert!(rename_guard("a/", "a/b/").is_err());
        assert!(rename_guard("a/", "a/").is_err());
    }

    #[test]
    fn rename_guard_allows_valid_moves() {
        assert!(rename_guard("a/", "ab/").is_ok());
        assert!(rename_guard("a/x.txt", "a/y.txt").is_ok());
        assert!(rename_guard("a", "a/b").is_ok());
        assert!(rename_guard("x.txt", "x.txt").is_err());
    }

    #[test]
    fn keys_to_delete_excludes_targets() {
        let src = vec!["a/x".to_string(), "a/b/x".to_string()];
        let tgt = vec!["a/b/x".to_string(), "a/b/b/x".to_string()];
        assert_eq!(keys_to_delete(&src, &tgt), vec!["a/x".to_string()]);
    }

    #[test]
    fn copy_source_encodes_key() {
        assert_eq!(copy_source("b", "a dir/x+y.txt"), "b/a%20dir%2Fx%2By.txt");
    }
}
