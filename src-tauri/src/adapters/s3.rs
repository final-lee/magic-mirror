use async_trait::async_trait;
use aws_config::SdkConfig;
use aws_sdk_s3::operation::list_objects_v2::ListObjectsV2Output;
use aws_sdk_s3::types::Bucket;
use serde::Serialize;

use super::util::{dt, map_concurrent, s, unknown_type, Capped};
use super::ResourceAdapter;
use crate::error::{from_sdk, AppError};
use crate::model::{col, ColumnKind::*, ListResult, Resource, ResourceType, MAX_ITEMS};

pub struct S3;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct S3Entry {
    pub name: String,
    pub key: String,
    pub is_folder: bool,
    pub size: Option<i64>,
    pub last_modified: Option<String>,
    pub storage_class: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct S3Listing {
    pub entries: Vec<S3Entry>,
    pub next_token: Option<String>,
}

#[async_trait]
impl ResourceAdapter for S3 {
    fn service_id(&self) -> &'static str {
        "s3"
    }
    fn display_name(&self) -> &'static str {
        "S3"
    }
    fn is_global(&self) -> bool {
        true
    }
    fn resource_types(&self) -> Vec<ResourceType> {
        vec![ResourceType {
            id: "buckets",
            name: "Buckets",
            columns: vec![
                col("name", "Bucket name", Text),
                col("region", "Region", Text),
                col("created", "Created", Datetime),
            ],
        }]
    }

    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError> {
        if type_id != "buckets" {
            return Err(unknown_type(type_id));
        }
        let client = aws_sdk_s3::Client::new(cfg);
        let out = client
            .list_buckets()
            .max_buckets(MAX_ITEMS as i32)
            .send()
            .await
            .map_err(|e| from_sdk(e, "s3:ListAllMyBuckets"))?;
        let buckets: Vec<Bucket> = out.buckets().to_vec();
        let list_truncated = is_truncated(out.continuation_token());
        // ListBuckets 응답에 리전이 없으면 GetBucketLocation으로 보완한다(실패하면 빈 값).
        let regions = map_concurrent(buckets.clone(), |b| {
            let client = client.clone();
            async move {
                if let Some(r) = b.bucket_region() {
                    return r.to_string();
                }
                match client
                    .get_bucket_location()
                    .bucket(s(b.name()))
                    .send()
                    .await
                {
                    Ok(loc) => location_to_region(loc.location_constraint().map(|c| c.as_str())),
                    Err(_) => String::new(),
                }
            }
        })
        .await;
        let mut capped = Capped::new();
        capped.truncated = list_truncated;
        for (b, region) in buckets.iter().zip(regions) {
            if !capped.push(bucket(b, &region)) {
                break;
            }
        }
        Ok(capped.finish())
    }
}

/// ListBuckets 응답에 이어받을 토큰이 있으면 1,000개를 넘는 버킷이 더 있다는 뜻이다.
pub fn is_truncated(continuation_token: Option<&str>) -> bool {
    continuation_token.is_some()
}

/// GetBucketLocation의 빈 값은 us-east-1, "EU"는 eu-west-1을 뜻한다.
pub fn location_to_region(constraint: Option<&str>) -> String {
    match constraint {
        None | Some("") => "us-east-1".to_string(),
        Some("EU") => "eu-west-1".to_string(),
        Some(r) => r.to_string(),
    }
}

fn bucket(b: &Bucket, region: &str) -> Resource {
    let name = s(b.name());
    Resource::new(&name, &name)
        .arn(Some(format!("arn:aws:s3:::{name}")))
        .value("name", &name)
        .value("region", region)
        .value("created", dt(b.creation_date()))
        .raw(b)
        .console(format!(
            "https://s3.console.aws.amazon.com/s3/buckets/{name}?region={region}"
        ))
}

pub async fn list_objects(
    cfg: &SdkConfig,
    bucket: &str,
    prefix: &str,
    token: Option<String>,
) -> Result<S3Listing, AppError> {
    let out = aws_sdk_s3::Client::new(cfg)
        .list_objects_v2()
        .bucket(bucket)
        .prefix(prefix)
        .delimiter("/")
        .max_keys(1000)
        .set_continuation_token(token)
        .send()
        .await
        .map_err(|e| from_sdk(e, "s3:ListBucket"))?;
    Ok(to_listing(&out, prefix))
}

pub fn to_listing(out: &ListObjectsV2Output, prefix: &str) -> S3Listing {
    let strip = |key: &str| key.strip_prefix(prefix).unwrap_or(key).to_string();
    let mut entries: Vec<S3Entry> = out
        .common_prefixes()
        .iter()
        .filter_map(|p| p.prefix())
        .map(|p| S3Entry {
            name: strip(p).trim_end_matches('/').to_string(),
            key: p.to_string(),
            is_folder: true,
            size: None,
            last_modified: None,
            storage_class: None,
        })
        .collect();
    entries.extend(
        out.contents()
            .iter()
            .filter(|o| o.key().is_some_and(|k| k != prefix))
            .map(|o| {
                let key = s(o.key());
                S3Entry {
                    name: strip(&key),
                    key,
                    is_folder: false,
                    size: o.size(),
                    last_modified: Some(dt(o.last_modified())).filter(|v| !v.is_empty()),
                    storage_class: o.storage_class().map(|c| c.as_str().to_string()),
                }
            }),
    );
    let next_token = if out.is_truncated() == Some(true) {
        out.next_continuation_token().map(str::to_owned)
    } else {
        None
    };
    S3Listing {
        entries,
        next_token,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_s3::types::{CommonPrefix, Object, ObjectStorageClass};

    #[test]
    fn listing_has_folders_then_objects_and_skips_placeholder() {
        let out = ListObjectsV2Output::builder()
            .common_prefixes(CommonPrefix::builder().prefix("images/products/").build())
            .contents(Object::builder().key("images/").size(0).build())
            .contents(
                Object::builder()
                    .key("images/logo.svg")
                    .size(12)
                    .storage_class(ObjectStorageClass::Standard)
                    .build(),
            )
            .is_truncated(true)
            .next_continuation_token("tok")
            .build();
        let l = to_listing(&out, "images/");
        assert_eq!(l.entries.len(), 2);
        assert_eq!(l.entries[0].name, "products");
        assert!(l.entries[0].is_folder);
        assert_eq!(l.entries[0].key, "images/products/");
        assert_eq!(l.entries[1].name, "logo.svg");
        assert_eq!(l.entries[1].size, Some(12));
        assert_eq!(l.entries[1].storage_class.as_deref(), Some("STANDARD"));
        assert_eq!(l.next_token.as_deref(), Some("tok"));
    }

    #[test]
    fn listing_without_truncation_has_no_token() {
        let out = ListObjectsV2Output::builder()
            .next_continuation_token("stale")
            .is_truncated(false)
            .build();
        assert_eq!(to_listing(&out, "").next_token, None);
    }

    #[test]
    fn bucket_location_mapping() {
        assert_eq!(location_to_region(None), "us-east-1");
        assert_eq!(location_to_region(Some("")), "us-east-1");
        assert_eq!(location_to_region(Some("EU")), "eu-west-1");
        assert_eq!(location_to_region(Some("ap-northeast-2")), "ap-northeast-2");
    }

    #[test]
    fn truncation_follows_continuation_token() {
        assert!(is_truncated(Some("tok")));
        assert!(!is_truncated(None));
    }

    #[test]
    fn bucket_resource_has_arn_and_region() {
        let b = Bucket::builder().name("assets").build();
        let r = bucket(&b, "ap-northeast-2");
        assert_eq!(r.arn.as_deref(), Some("arn:aws:s3:::assets"));
        assert_eq!(r.values["region"], "ap-northeast-2");
        assert!(r.console_url.unwrap().contains("buckets/assets"));
    }
}
