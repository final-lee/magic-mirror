//! 릴리스 상세 화면의 값을 만든다: 풀린 릴리스 하나와 이력에서 요약, values, manifest, 리소스, 훅을 뽑는다. 순수 코드다.
use serde::Serialize;
use serde_json::Value;

use super::manifest::{self, Resource};
use super::read::Revision;
use super::release::{is_problem, Driver, Release};
use crate::error::AppError;

pub const VALUES_UNREADABLE: &str = "values를 YAML로 바꾸지 못했어요";

/// Chart.yaml이 선언한 의존 차트
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dependency {
    pub name: String,
    pub version: String,
    pub repository: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartInfo {
    pub name: String,
    pub version: String,
    pub app_version: String,
    pub description: String,
    pub home: String,
    pub kube_version: String,
    pub deprecated: bool,
    pub dependencies: Vec<Dependency>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookInfo {
    pub name: String,
    pub kind: String,
    pub events: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseDetail {
    pub name: String,
    pub namespace: String,
    /// 지금 보는 리비전
    pub revision: u32,
    /// 저장된 가장 높은 리비전. 변경은 이 리비전에 한다
    pub latest: u32,
    pub status: String,
    pub problem: bool,
    pub description: String,
    pub first_deployed: Option<String>,
    pub last_deployed: Option<String>,
    pub notes: String,
    pub chart: ChartInfo,
    /// 사용자가 준 값(편집기 시작 글). 없으면 빈 글
    pub user_values: String,
    /// 차트 기본값 위에 사용자 값을 얹은 값
    pub computed_values: String,
    /// Secret의 값은 가린 manifest
    pub manifest: String,
    pub resources: Vec<Resource>,
    pub hooks: Vec<HookInfo>,
    pub history: Vec<Revision>,
    pub driver: Driver,
}

/// 편집기에 넣는 YAML. 빈 맵은 빈 글이다(되돌려 읽으면 빈 맵).
pub fn values_yaml(values: &Value) -> Result<String, AppError> {
    if values.as_object().is_some_and(|m| m.is_empty()) || values.is_null() {
        return Ok(String::new());
    }
    serde_saphyr::to_string(values).map_err(|_| AppError::other(VALUES_UNREADABLE))
}

fn chart_info(release: &Release) -> ChartInfo {
    let metadata = &release.chart.metadata;
    let text = |key: &str| metadata.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    let dependencies = metadata
        .get("dependencies")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(|d| {
                    let field = |key: &str| d.get(key).and_then(Value::as_str).unwrap_or("").to_string();
                    Dependency { name: field("name"), version: field("version"), repository: field("repository") }
                })
                .collect()
        })
        .unwrap_or_default();
    ChartInfo {
        name: release.chart.name(),
        version: release.chart.version(),
        app_version: release.chart.app_version(),
        description: text("description"),
        home: text("home"),
        kube_version: text("kubeVersion"),
        deprecated: metadata.get("deprecated").and_then(Value::as_bool).unwrap_or(false),
        dependencies,
    }
}

pub fn build(release: &Release, driver: Driver, latest: u32, history: Vec<Revision>) -> Result<ReleaseDetail, AppError> {
    let docs = manifest::parse(&release.manifest)?;
    Ok(ReleaseDetail {
        name: release.name.clone(),
        namespace: release.namespace.clone(),
        revision: release.version,
        latest,
        status: release.info.status.clone(),
        problem: is_problem(&release.info.status),
        description: release.info.description.clone(),
        first_deployed: release.info.first_deployed.clone(),
        last_deployed: release.info.last_deployed.clone(),
        notes: release.info.notes.clone(),
        chart: chart_info(release),
        user_values: values_yaml(&release.user_values())?,
        computed_values: values_yaml(&release.computed_values())?,
        manifest: manifest::masked_text(&release.manifest)?,
        resources: manifest::resources(&docs),
        hooks: release.hooks.iter().map(|h| HookInfo { name: h.name.clone(), kind: h.kind.clone(), events: h.events.clone() }).collect(),
        history,
        driver,
    })
}

#[cfg(test)]
mod tests;
