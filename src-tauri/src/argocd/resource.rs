//! 리소스 하나를 가리키는 값과 그 이벤트·링크·컨테이너 읽기.
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{list, text};

/// 서버 리소스 하나를 가리키는 값. 클러스터 범위 리소스는 namespace가 없다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResRef {
    pub group: String,
    pub version: String,
    pub kind: String,
    #[serde(default)]
    pub namespace: Option<String>,
    pub name: String,
    #[serde(default)]
    pub uid: Option<String>,
}

/// 리소스가 속한 Application. 서버 요청의 `appNamespace`와 `project`가 된다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppTarget {
    pub namespace: String,
    pub name: String,
    #[serde(default)]
    pub project: String,
}

impl AppTarget {
    /// 모든 Application 요청에 붙는 범위 질의. project가 비어 있으면 붙이지 않는다.
    pub fn scope(&self) -> Vec<(&'static str, &str)> {
        let mut query = vec![("appNamespace", self.namespace.as_str())];
        if !self.project.is_empty() {
            query.push(("project", self.project.as_str()));
        }
        query
    }
}

/// `resource`·`resource/links`·`logs`의 질의. 서버마다 리소스 이름 키가 다르다(`resourceName`/`name`).
pub fn resource_query<'a>(target: &'a AppTarget, res: &'a ResRef, name_key: &'static str) -> Vec<(&'a str, &'a str)> {
    let mut query = vec![
        ("namespace", res.namespace.as_deref().unwrap_or_default()),
        (name_key, res.name.as_str()),
        ("version", res.version.as_str()),
        ("group", res.group.as_str()),
        ("kind", res.kind.as_str()),
    ];
    query.extend(target.scope());
    query
}

/// 리소스 이벤트 한 줄.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceEvent {
    pub r#type: String,
    pub reason: String,
    pub message: String,
    pub count: i64,
    pub first_seen: Option<String>,
    pub last_seen: Option<String>,
    pub source: Option<String>,
}

fn string(v: &Value, path: &str) -> String {
    text(v, path).unwrap_or_default().to_owned()
}

fn opt(v: &Value, path: &str) -> Option<String> {
    text(v, path).filter(|s| !s.is_empty()).map(str::to_owned)
}

/// 이벤트 목록 응답에서 최근에 일어난 것부터 한 줄씩.
pub fn event_rows(body: &Value) -> Vec<ResourceEvent> {
    let mut rows: Vec<_> = list(body, "/items")
        .iter()
        .map(|e| ResourceEvent {
            r#type: string(e, "/type"),
            reason: string(e, "/reason"),
            message: string(e, "/message"),
            count: e.pointer("/count").and_then(Value::as_i64).unwrap_or(1).max(1),
            first_seen: opt(e, "/firstTimestamp").or_else(|| opt(e, "/eventTime")),
            last_seen: opt(e, "/series/lastObservedTime")
                .or_else(|| opt(e, "/lastTimestamp"))
                .or_else(|| opt(e, "/eventTime"))
                .or_else(|| opt(e, "/firstTimestamp")),
            source: opt(e, "/source/component").or_else(|| opt(e, "/reportingComponent")),
        })
        .collect();
    // RFC 3339(UTC) 문자열은 글자 순서가 시간 순서다
    rows.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
    rows
}

/// 서버가 설정한 링크(리소스 deep link 등) 한 개.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRow {
    pub title: String,
    pub url: String,
    pub description: Option<String>,
    pub icon_class: Option<String>,
}

/// 링크 응답에서 웹 주소(http·https)만 한 줄씩. 그 밖의 방식(`javascript:` 등)은 버린다.
pub fn link_rows(body: &Value) -> Vec<LinkRow> {
    list(body, "/items")
        .iter()
        .filter_map(|l| {
            let url = text(l, "/url")?;
            let valid = reqwest::Url::parse(url).is_ok_and(|u| matches!(u.scheme(), "http" | "https"));
            valid.then(|| LinkRow {
                title: opt(l, "/title").unwrap_or_else(|| url.to_owned()),
                url: url.to_owned(),
                description: opt(l, "/description"),
                icon_class: opt(l, "/iconClass"),
            })
        })
        .collect()
}

/// 로그를 고를 수 있는 컨테이너.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ContainerRef {
    pub name: String,
    pub init: bool,
}

/// live 매니페스트의 Pod 스펙(Pod, 워크로드의 템플릿, CronJob의 잡 템플릿)에서 컨테이너를 읽는다. 앱 컨테이너가 먼저다.
pub fn containers_of(live: &Value) -> Vec<ContainerRef> {
    let Some(spec) = ["/spec", "/spec/template/spec", "/spec/jobTemplate/spec/template/spec"]
        .into_iter()
        .filter_map(|p| live.pointer(p))
        .find(|s| s.get("containers").is_some_and(Value::is_array))
    else {
        return Vec::new();
    };
    [("/containers", false), ("/initContainers", true)]
        .into_iter()
        .flat_map(|(path, init)| {
            list(spec, path)
                .iter()
                .filter_map(move |c| text(c, "/name").map(|name| ContainerRef { name: name.to_owned(), init }))
        })
        .collect()
}

#[cfg(test)]
mod tests;
