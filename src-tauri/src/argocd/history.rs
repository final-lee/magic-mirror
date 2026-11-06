//! 배포 이력(`status.history`)과 리비전별 메타데이터(커밋·차트·OCI).
use std::future::Future;

use futures::stream::{self, StreamExt};
use serde::Serialize;
use serde_json::Value;

use super::app::{initiated, revisions};
use super::{list, text};
use crate::error::AppError;

/// 리비전 메타데이터를 한꺼번에 받는 최대 요청 수.
pub const FETCH_PARALLEL: usize = 8;

/// 커밋(Git) 리비전의 작성자·시각·메시지.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionMetadata {
    pub author: Option<String>,
    pub date: Option<String>,
    pub message: Option<String>,
    pub tags: Vec<String>,
    pub signature_info: Option<String>,
}

/// Helm 차트 리비전의 차트 정보.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartDetails {
    pub description: Option<String>,
    pub home: Option<String>,
    pub maintainers: Vec<String>,
}

/// OCI 아티팩트 리비전의 정보.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OciMetadata {
    pub version: Option<String>,
    pub authors: Option<String>,
    pub created_at: Option<String>,
    pub description: Option<String>,
    pub docs_url: Option<String>,
    pub image_url: Option<String>,
    pub source_url: Option<String>,
}

/// 이력 한 건의 소스 하나와 그 리비전.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionInfo {
    pub revision: String,
    pub source_index: usize,
    pub repo_url: Option<String>,
    pub chart: Option<String>,
    pub path: Option<String>,
    pub target_revision: Option<String>,
    /// 받지 못했거나 이 종류가 아니면 None
    pub metadata: Option<RevisionMetadata>,
    pub chart_details: Option<ChartDetails>,
    pub oci: Option<OciMetadata>,
}

/// 배포 이력 한 건.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: i64,
    pub deployed_at: Option<String>,
    pub deploy_started_at: Option<String>,
    pub initiated_by: Option<String>,
    pub revisions: Vec<RevisionInfo>,
}

/// 리비전 메타데이터 종류. 소스가 Helm 차트면 차트 정보, `oci://`면 OCI 정보, 아니면 커밋 정보를 읽는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Commit,
    Chart,
    Oci,
}

impl Kind {
    pub fn segment(self) -> &'static str {
        match self {
            Kind::Commit => "metadata",
            Kind::Chart => "chartdetails",
            Kind::Oci => "ocimetadata",
        }
    }
}

/// 받아야 할 메타데이터 하나(이력 번호 `version_id`는 그 시점의 소스를 서버가 찾는 데 쓴다).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Job {
    pub entry: usize,
    pub revision: usize,
    pub kind: Kind,
    pub revision_id: String,
    pub source_index: usize,
    pub version_id: i64,
}

fn opt(v: &Value, path: &str) -> Option<String> {
    text(v, path).filter(|s| !s.is_empty()).map(str::to_owned)
}

/// Application 응답의 `status.history`를 최근 것부터 모두 읽는다(메타데이터는 비어 있다).
pub fn entries_of(app: &Value) -> Vec<HistoryEntry> {
    let mut entries: Vec<_> = list(app, "/status/history")
        .iter()
        .map(|h| {
            let sources: Vec<&Value> = if list(h, "/sources").is_empty() {
                h.pointer("/source").into_iter().collect()
            } else {
                list(h, "/sources").iter().collect()
            };
            HistoryEntry {
                id: h.pointer("/id").and_then(Value::as_i64).unwrap_or_default(),
                deployed_at: opt(h, "/deployedAt"),
                deploy_started_at: opt(h, "/deployStartedAt"),
                initiated_by: initiated(h, "/initiatedBy"),
                revisions: revisions(h)
                    .into_iter()
                    .enumerate()
                    .map(|(i, revision)| {
                        let source = sources.get(i).copied();
                        RevisionInfo {
                            revision,
                            source_index: i,
                            repo_url: source.and_then(|s| opt(s, "/repoURL")),
                            chart: source.and_then(|s| opt(s, "/chart")),
                            path: source.and_then(|s| opt(s, "/path")),
                            target_revision: source.and_then(|s| opt(s, "/targetRevision")),
                            metadata: None,
                            chart_details: None,
                            oci: None,
                        }
                    })
                    .collect(),
            }
        })
        .collect();
    entries.sort_by_key(|e| std::cmp::Reverse(e.id));
    entries
}

fn kind_of(info: &RevisionInfo) -> Kind {
    if info.chart.is_some() {
        Kind::Chart
    } else if info.repo_url.as_deref().is_some_and(|u| u.starts_with("oci://")) {
        Kind::Oci
    } else {
        Kind::Commit
    }
}

/// 이력의 모든 리비전에 대해 받을 메타데이터 목록.
pub fn jobs_of(entries: &[HistoryEntry]) -> Vec<Job> {
    entries
        .iter()
        .enumerate()
        .flat_map(|(entry, e)| {
            e.revisions.iter().enumerate().map(move |(revision, info)| Job {
                entry,
                revision,
                kind: kind_of(info),
                revision_id: info.revision.clone(),
                source_index: info.source_index,
                version_id: e.id,
            })
        })
        .collect()
}

fn metadata_of(v: &Value) -> RevisionMetadata {
    RevisionMetadata {
        author: opt(v, "/author"),
        date: opt(v, "/date"),
        message: opt(v, "/message"),
        tags: list(v, "/tags").iter().filter_map(Value::as_str).map(str::to_owned).collect(),
        signature_info: opt(v, "/signatureInfo"),
    }
}

fn chart_of(v: &Value) -> ChartDetails {
    ChartDetails {
        description: opt(v, "/description"),
        home: opt(v, "/home"),
        maintainers: list(v, "/maintainers").iter().filter_map(Value::as_str).map(str::to_owned).collect(),
    }
}

fn oci_of(v: &Value) -> OciMetadata {
    OciMetadata {
        version: opt(v, "/version"),
        authors: opt(v, "/authors"),
        created_at: opt(v, "/createdAt"),
        description: opt(v, "/description"),
        docs_url: opt(v, "/docsUrl"),
        image_url: opt(v, "/imageUrl"),
        source_url: opt(v, "/sourceUrl"),
    }
}

/// 리비전 메타데이터를 동시에 받아 이력에 붙인다. 한 건이 실패해도 그 리비전만 비워 두고 나머지는 그대로 돌려준다.
pub async fn attach<F, Fut>(entries: &mut [HistoryEntry], fetch: F)
where
    F: Fn(Job) -> Fut,
    Fut: Future<Output = Result<Value, AppError>>,
{
    let results: Vec<(Job, Result<Value, AppError>)> = stream::iter(jobs_of(entries))
        .map(|job| {
            let call = fetch(job.clone());
            async move { (job, call.await) }
        })
        .buffer_unordered(FETCH_PARALLEL)
        .collect()
        .await;
    for (job, body) in results {
        let Ok(body) = body else { continue };
        let info = &mut entries[job.entry].revisions[job.revision];
        match job.kind {
            Kind::Commit => info.metadata = Some(metadata_of(&body)),
            Kind::Chart => info.chart_details = Some(chart_of(&body)),
            Kind::Oci => info.oci = Some(oci_of(&body)),
        }
    }
}

#[cfg(test)]
mod tests;
