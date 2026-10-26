use serde::Serialize;
use std::collections::BTreeMap;

pub const MAX_ITEMS: usize = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ColumnKind {
    Text,
    Mono,
    State,
    Datetime,
    Bytes,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Column {
    pub key: &'static str,
    pub label: &'static str,
    pub kind: ColumnKind,
}

pub const fn col(key: &'static str, label: &'static str, kind: ColumnKind) -> Column {
    Column { key, label, kind }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ResourceType {
    pub id: &'static str,
    pub name: &'static str,
    pub columns: Vec<Column>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ServiceInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub global: bool,
    pub types: Vec<ResourceType>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct Field {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resource {
    pub id: String,
    pub name: String,
    pub arn: Option<String>,
    pub values: BTreeMap<String, String>,
    pub tags: BTreeMap<String, String>,
    pub fields: Vec<Field>,
    pub raw: String,
    pub console_url: Option<String>,
}

impl Resource {
    pub fn new(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self { id: id.into(), name: name.into(), ..Default::default() }
    }

    pub fn arn(mut self, arn: Option<impl Into<String>>) -> Self {
        self.arn = arn.map(Into::into);
        self
    }

    /// 표 칼럼 값 (`Column::key`와 같은 키를 쓴다)
    pub fn value(mut self, key: &str, v: impl ToString) -> Self {
        self.values.insert(key.to_string(), v.to_string());
        self
    }

    /// 상세 패널 전용 추가 정보. 빈 값은 넣지 않는다.
    pub fn field(mut self, label: &str, v: impl ToString) -> Self {
        let value = v.to_string();
        if !value.is_empty() {
            self.fields.push(Field { label: label.to_string(), value });
        }
        self
    }

    pub fn tags<'a>(mut self, pairs: impl IntoIterator<Item = (Option<&'a str>, Option<&'a str>)>) -> Self {
        for (k, v) in pairs {
            if let Some(k) = k {
                self.tags.insert(k.to_string(), v.unwrap_or_default().to_string());
            }
        }
        self
    }

    pub fn raw(mut self, d: &impl std::fmt::Debug) -> Self {
        self.raw = format!("{d:#?}");
        self
    }

    pub fn console(mut self, url: impl Into<String>) -> Self {
        self.console_url = Some(url.into());
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ListResult {
    pub items: Vec<Resource>,
    pub truncated: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builder_skips_empty_fields_and_collects_tags() {
        let r = Resource::new("i-1", "web")
            .value("state", "running")
            .field("Empty", "")
            .field("AMI", "ami-1")
            .tags([(Some("env"), Some("prod")), (None, Some("ignored")), (Some("k"), None)]);
        assert_eq!(r.values["state"], "running");
        assert_eq!(r.fields, vec![Field { label: "AMI".into(), value: "ami-1".into() }]);
        assert_eq!(r.tags["env"], "prod");
        assert_eq!(r.tags["k"], "");
        assert_eq!(r.tags.len(), 2);
    }

    #[test]
    fn serializes_camel_case() {
        let r = Resource::new("a", "b").console("https://x");
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["consoleUrl"], "https://x");
        let c = serde_json::to_value(col("id", "ID", ColumnKind::Mono)).unwrap();
        assert_eq!(c, serde_json::json!({ "key": "id", "label": "ID", "kind": "mono" }));
    }
}
