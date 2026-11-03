//! 릴리스 manifest(여러 YAML 문서)를 객체로 나누고 두 manifest를 객체별로 견준다. 순수 코드다.
//! Secret의 값은 보이는 곳 어디에서도 가린다(`read::secret::mask`와 같은 규칙).
use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

use crate::error::AppError;
use crate::k8s::change::apply::{mask_pair, walk};
use crate::k8s::change::FieldDiff;
use crate::k8s::read::secret::mask;

pub const MANIFEST_UNREADABLE: &str = "릴리스 manifest를 해석하지 못했어요";

/// manifest의 객체 하나
#[derive(Clone, Debug, PartialEq)]
pub struct Doc {
    pub api_version: String,
    pub kind: String,
    pub name: String,
    pub namespace: Option<String>,
    pub object: Value,
}

impl Doc {
    pub fn group(&self) -> &str {
        self.api_version.split_once('/').map_or("", |(group, _)| group)
    }

    fn is_secret(&self) -> bool {
        self.api_version == "v1" && self.kind == "Secret"
    }

    /// 화면에 쓰는 이름표: `Deployment demo-web`
    pub fn label(&self) -> String {
        format!("{} {}", self.kind, self.name)
    }

    fn key(&self) -> (String, String, String, String) {
        (self.group().to_string(), self.kind.clone(), self.namespace.clone().unwrap_or_default(), self.name.clone())
    }
}

/// `---` 줄로 나눈 문서 덩어리(주석만 있거나 빈 덩어리는 건너뛴다)
fn chunks(manifest: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut offset = 0;
    for line in manifest.split_inclusive('\n') {
        if line.trim_end() == "---" {
            out.push(&manifest[start..offset]);
            start = offset + line.len();
        }
        offset += line.len();
    }
    out.push(&manifest[start..]);
    out.into_iter().filter(|c| c.lines().any(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#'))).collect()
}

fn doc_of(object: Value) -> Option<Doc> {
    let text = |pointer: &str| object.pointer(pointer).and_then(Value::as_str).map(str::to_string);
    Some(Doc {
        api_version: text("/apiVersion")?,
        kind: text("/kind")?,
        name: text("/metadata/name").unwrap_or_default(),
        namespace: text("/metadata/namespace"),
        object,
    })
}

/// 덩어리 하나를 객체로 푼다. `kind: List`는 안의 `items`로 펼친다.
fn parse_chunk(chunk: &str) -> Result<Vec<Doc>, AppError> {
    let object: Value = serde_saphyr::from_str(chunk).map_err(|_| AppError::other(MANIFEST_UNREADABLE))?;
    if object.get("kind").and_then(Value::as_str) == Some("List") {
        let items = object.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
        return Ok(items.into_iter().filter_map(doc_of).collect());
    }
    Ok(doc_of(object).into_iter().collect())
}

pub fn parse(manifest: &str) -> Result<Vec<Doc>, AppError> {
    let mut docs = Vec::new();
    for chunk in chunks(manifest) {
        docs.extend(parse_chunk(chunk)?);
    }
    Ok(docs)
}

/// 화면에 보이는 manifest: Secret 문서는 값을 `••••`로 가리고(`# Source:` 같은 주석은 남긴다), 나머지는 원문 그대로다.
pub fn masked_text(manifest: &str) -> Result<String, AppError> {
    let mut out = String::new();
    for (index, chunk) in chunks(manifest).into_iter().enumerate() {
        if index > 0 {
            out.push_str("---\n");
        }
        let docs = parse_chunk(chunk)?;
        if docs.iter().any(Doc::is_secret) {
            for line in chunk.lines().filter(|l| l.trim_start().starts_with('#')) {
                out.push_str(line);
                out.push('\n');
            }
            for (i, mut doc) in docs.into_iter().enumerate() {
                if i > 0 {
                    out.push_str("---\n");
                }
                if doc.is_secret() {
                    mask(&mut doc.object);
                }
                out.push_str(&serde_saphyr::to_string(&doc.object).map_err(|_| AppError::other(MANIFEST_UNREADABLE))?);
            }
        } else {
            out.push_str(chunk);
            if !chunk.ends_with('\n') {
                out.push('\n');
            }
        }
    }
    Ok(out)
}

/// 릴리스가 만든 리소스 한 줄. 화면이 종류를 알면 이 객체를 워크로드 화면에서 연다.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resource {
    pub api_version: String,
    pub kind: String,
    pub name: String,
    /// manifest에 적힌 네임스페이스. 없으면 릴리스의 네임스페이스(네임스페이스 종류일 때)다
    pub namespace: Option<String>,
}

pub fn resources(docs: &[Doc]) -> Vec<Resource> {
    docs.iter()
        .map(|d| Resource { api_version: d.api_version.clone(), kind: d.kind.clone(), name: d.name.clone(), namespace: d.namespace.clone() })
        .collect()
}

/// 바뀌는 객체 수
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Counts {
    pub added: usize,
    pub changed: usize,
    pub removed: usize,
}

impl Counts {
    pub fn total(self) -> usize {
        self.added + self.changed + self.removed
    }
}

/// 값은 가린 객체. 새로 생기거나 지워지는 Secret을 그대로 보이지 않게 한다.
fn shown(doc: &Doc) -> Value {
    let mut object = doc.object.clone();
    if doc.is_secret() {
        mask(&mut object);
    }
    object
}

/// 객체별 차이. 새 객체와 지워지는 객체는 객체 전체가 한 항목이고, 바뀐 객체는 `Deployment demo-web · spec.replicas` 꼴로 필드마다 한 항목이다.
/// Secret은 값 없이 바뀐 키만 보인다.
pub fn diff(before: &[Doc], after: &[Doc]) -> (Vec<FieldDiff>, Counts) {
    let old: BTreeMap<_, _> = before.iter().map(|d| (d.key(), d)).collect();
    let new: BTreeMap<_, _> = after.iter().map(|d| (d.key(), d)).collect();
    let mut out = Vec::new();
    let mut counts = Counts::default();
    for (key, doc) in &new {
        match old.get(key) {
            None => {
                counts.added += 1;
                out.push(FieldDiff { path: doc.label(), before: Value::Null, after: shown(doc) });
            }
            Some(previous) if previous.object != doc.object => {
                counts.changed += 1;
                let (mut b, mut a) = (previous.object.clone(), doc.object.clone());
                if doc.is_secret() {
                    mask_pair(&mut b, &mut a);
                }
                let mut fields = Vec::new();
                walk(&mut String::new(), &b, &a, &mut fields);
                out.extend(fields.into_iter().map(|f| FieldDiff { path: format!("{} · {}", doc.label(), f.path), ..f }));
            }
            Some(_) => {}
        }
    }
    for (key, doc) in &old {
        if !new.contains_key(key) {
            counts.removed += 1;
            out.push(FieldDiff { path: doc.label(), before: shown(doc), after: Value::Null });
        }
    }
    (out, counts)
}

/// 두 values(사용자가 준 값)의 차이. 필드마다 `values · replicaCount` 꼴 한 항목
pub fn values_diff(before: &Value, after: &Value) -> Vec<FieldDiff> {
    let mut fields = Vec::new();
    walk(&mut String::new(), before, after, &mut fields);
    fields.into_iter().map(|f| FieldDiff { path: format!("values · {}", f.path), ..f }).collect()
}

#[cfg(test)]
mod tests;
