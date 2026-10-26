use std::collections::HashMap;
use std::future::Future;

use aws_config::SdkConfig;
use aws_smithy_types::{date_time::Format, DateTime};
use futures::stream::{self, StreamExt};

use crate::error::AppError;
use crate::model::{ListResult, Resource, MAX_ITEMS};

/// Option<&str> → String (없으면 빈 문자열)
pub fn s(o: Option<&str>) -> String {
    o.unwrap_or_default().to_string()
}

/// AWS DateTime → ISO 8601 문자열
pub fn dt(o: Option<&DateTime>) -> String {
    o.and_then(|d| d.fmt(Format::DateTime).ok()).unwrap_or_default()
}

/// epoch 밀리초 → ISO 8601 문자열
pub fn dt_millis(ms: Option<i64>) -> String {
    ms.map(DateTime::from_millis).and_then(|d| d.fmt(Format::DateTime).ok()).unwrap_or_default()
}

pub fn opt<T: ToString>(o: Option<T>) -> String {
    o.map(|v| v.to_string()).unwrap_or_default()
}

pub fn region(cfg: &SdkConfig) -> String {
    cfg.region().map(|r| r.to_string()).unwrap_or_default()
}

pub fn last_segment(value: &str, sep: char) -> String {
    value.rsplit(sep).next().unwrap_or(value).to_string()
}

/// `Name` 태그 값 (비어 있으면 None)
pub fn name_tag<'a>(tags: impl IntoIterator<Item = (Option<&'a str>, Option<&'a str>)>) -> Option<String> {
    tags.into_iter()
        .find(|(k, _)| *k == Some("Name"))
        .and_then(|(_, v)| v)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

/// HashMap 형태 태그(EKS 등)를 Resource::tags 입력으로 바꾼다.
pub fn hash_tags(m: Option<&HashMap<String, String>>) -> Vec<(Option<&str>, Option<&str>)> {
    m.into_iter().flatten().map(|(k, v)| (Some(k.as_str()), Some(v.as_str()))).collect()
}

/// 콘솔 URL용 퍼센트 인코딩 (영숫자와 -_.~ 외 모두 인코딩)
pub fn url_encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

pub fn unknown_type(type_id: &str) -> AppError {
    AppError::other(format!("알 수 없는 리소스 타입: {type_id}"))
}

/// MAX_ITEMS까지만 모으는 컬렉션. push가 false를 돌려주면 순회를 멈춘다.
pub struct Capped<T> {
    pub items: Vec<T>,
    pub truncated: bool,
}

impl<T> Capped<T> {
    pub fn new() -> Self {
        Self { items: Vec::new(), truncated: false }
    }

    pub fn push(&mut self, item: T) -> bool {
        if self.items.len() >= MAX_ITEMS {
            self.truncated = true;
            return false;
        }
        self.items.push(item);
        true
    }
}

impl<T> Default for Capped<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl Capped<Resource> {
    pub fn finish(self) -> ListResult {
        ListResult { items: self.items, truncated: self.truncated }
    }
}

/// 최대 8개씩 동시에 실행하고 입력 순서대로 결과를 돌려준다.
pub async fn map_concurrent<T, R, F, Fut>(items: Vec<T>, f: F) -> Vec<R>
where
    F: FnMut(T) -> Fut,
    Fut: Future<Output = R>,
{
    stream::iter(items).map(f).buffered(8).collect().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_segment_splits() {
        assert_eq!(last_segment("arn:aws:ecs:r:1:cluster/prod", '/'), "prod");
        assert_eq!(last_segment("arn:aws:sns:r:1:alerts", ':'), "alerts");
        assert_eq!(last_segment("plain", '/'), "plain");
    }

    #[test]
    fn name_tag_finds_non_empty_name() {
        assert_eq!(name_tag([(Some("env"), Some("prod")), (Some("Name"), Some("web"))]), Some("web".into()));
        assert_eq!(name_tag([(Some("Name"), Some(""))]), None);
        assert_eq!(name_tag(Vec::<(Option<&str>, Option<&str>)>::new()), None);
    }

    #[test]
    fn url_encode_escapes_reserved() {
        assert_eq!(url_encode("arn:aws:iam::1:policy/a b"), "arn%3Aaws%3Aiam%3A%3A1%3Apolicy%2Fa%20b");
        assert_eq!(url_encode("abc-_.~"), "abc-_.~");
    }

    #[test]
    fn capped_stops_at_max() {
        let mut c = Capped::new();
        for i in 0..MAX_ITEMS {
            assert!(c.push(i));
        }
        assert!(!c.truncated);
        assert!(!c.push(MAX_ITEMS));
        assert!(c.truncated);
        assert_eq!(c.items.len(), MAX_ITEMS);
    }

    #[test]
    fn dt_millis_formats_iso() {
        assert_eq!(dt_millis(Some(0)), "1970-01-01T00:00:00Z");
        assert_eq!(dt_millis(None), "");
    }

    #[tokio::test]
    async fn map_concurrent_keeps_order() {
        let out = map_concurrent(vec![3, 1, 2], |n| async move { n * 10 }).await;
        assert_eq!(out, vec![30, 10, 20]);
    }
}
