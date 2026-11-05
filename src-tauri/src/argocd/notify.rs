//! 알림 카탈로그: 서버에 설정된 서비스·트리거·템플릿 이름.
use serde::Serialize;
use serde_json::Value;

use super::{list, text};

/// 구독 annotation(`notifications.argoproj.io/subscribe.<트리거>.<서비스>`)에서 고를 수 있는 것들.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationCatalog {
    pub services: Vec<String>,
    pub triggers: Vec<String>,
    pub templates: Vec<String>,
}

/// 목록 응답(`{items:[{name}]}`)의 이름: 빈 이름은 버리고 중복은 한 번만, 이름 순으로.
pub fn names(body: &Value) -> Vec<String> {
    let mut names: Vec<String> = list(body, "/items")
        .iter()
        .filter_map(|i| text(i, "/name"))
        .filter(|n| !n.is_empty())
        .map(str::to_owned)
        .collect();
    names.sort();
    names.dedup();
    names
}

pub fn catalog(services: &Value, triggers: &Value, templates: &Value) -> NotificationCatalog {
    NotificationCatalog {
        services: names(services),
        triggers: names(triggers),
        templates: names(templates),
    }
}

#[cfg(test)]
mod tests;
