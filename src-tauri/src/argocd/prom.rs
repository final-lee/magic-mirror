//! Prometheus 텍스트 형식 해석과 ArgoCD 컨트롤러 지표 요약.
//! 컨트롤러·repo-server·server·ApplicationSet 컨트롤러의 `/metrics`는 시리즈가 수천 개(앱마다, 저장소마다)라서,
//! 화면이 쓰는 지표만 골라 라벨을 줄여 합친다. 카운터는 시리즈마다 앞 읽기와 견줘 늘어난 양(리셋 반영)을 구해 합친다.
use std::collections::{BTreeMap, HashMap};

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Counter,
    Gauge,
    Histogram,
    Summary,
    Untyped,
}

/// 읽은 시리즈 한 줄. `family`는 `# TYPE`에 적힌 이름(히스토그램의 `_bucket`·`_sum`·`_count`는 뗀 이름).
#[derive(Debug, Clone, PartialEq)]
pub struct Sample {
    pub name: String,
    pub family: String,
    pub kind: Kind,
    pub labels: BTreeMap<String, String>,
    pub value: f64,
}

fn kind_of(word: &str) -> Kind {
    match word {
        "counter" => Kind::Counter,
        "gauge" => Kind::Gauge,
        "histogram" | "gaugehistogram" => Kind::Histogram,
        "summary" => Kind::Summary,
        _ => Kind::Untyped,
    }
}

/// 값 칸: `NaN`·`+Inf`·`-Inf`와 보통의 부동소수. 읽지 못하면 None.
fn value_of(word: &str) -> Option<f64> {
    match word {
        "NaN" | "nan" => Some(f64::NAN),
        "+Inf" | "Inf" | "inf" | "+inf" => Some(f64::INFINITY),
        "-Inf" | "-inf" => Some(f64::NEG_INFINITY),
        _ => word.parse().ok(),
    }
}

/// `{a="1",b="x\"y"}` 안쪽을 읽는다. 이스케이프는 `\\`·`\"`·`\n`. 끝 쉼표를 허용하고, 닫는 `}` 뒤의 나머지를 함께 돌려준다.
fn labels_of(rest: &str) -> Option<(BTreeMap<String, String>, &str)> {
    let mut labels = BTreeMap::new();
    let mut chars = rest.char_indices().peekable();
    loop {
        while matches!(chars.peek(), Some((_, c)) if c.is_whitespace() || *c == ',') {
            chars.next();
        }
        let (start, c) = *chars.peek()?;
        if c == '}' {
            return Some((labels, &rest[start + 1..]));
        }
        let mut key = String::new();
        while let Some(&(_, c)) = chars.peek() {
            if c == '=' || c.is_whitespace() {
                break;
            }
            key.push(c);
            chars.next();
        }
        while matches!(chars.peek(), Some((_, c)) if c.is_whitespace()) {
            chars.next();
        }
        if chars.next()?.1 != '=' {
            return None;
        }
        while matches!(chars.peek(), Some((_, c)) if c.is_whitespace()) {
            chars.next();
        }
        if chars.next()?.1 != '"' {
            return None;
        }
        let mut value = String::new();
        loop {
            match chars.next()?.1 {
                '"' => break,
                '\\' => match chars.next()?.1 {
                    'n' => value.push('\n'),
                    other => value.push(other),
                },
                other => value.push(other),
            }
        }
        labels.insert(key, value);
    }
}

/// 시리즈 줄 하나: 이름, 라벨, 값. 타임스탬프와 OpenMetrics 예시(` # {…}`)는 버린다. 해석할 수 없으면 None.
fn line_of(line: &str) -> Option<(String, BTreeMap<String, String>, f64)> {
    let end = line.find(|c: char| c == '{' || c.is_whitespace()).unwrap_or(line.len());
    let name = &line[..end];
    if name.is_empty() {
        return None;
    }
    let rest = &line[end..];
    let (labels, rest) = match rest.strip_prefix('{') {
        Some(inner) => labels_of(inner)?,
        None => (BTreeMap::new(), rest),
    };
    let value = value_of(rest.split_whitespace().next()?)?;
    Some((name.to_owned(), labels, value))
}

/// `# TYPE` 이름에 이 시리즈 이름을 대 본다: 그대로, 히스토그램·요약 부품, OpenMetrics 카운터의 `_total`.
fn family_of(name: &str, types: &HashMap<String, Kind>) -> (String, Kind) {
    if let Some(kind) = types.get(name) {
        return (name.to_owned(), *kind);
    }
    for suffix in ["_bucket", "_sum", "_count"] {
        if let Some(base) = name.strip_suffix(suffix) {
            if let Some(kind @ (Kind::Histogram | Kind::Summary)) = types.get(base) {
                return (base.to_owned(), *kind);
            }
        }
    }
    if let Some(base) = name.strip_suffix("_total") {
        if types.get(base) == Some(&Kind::Counter) {
            return (base.to_owned(), Kind::Counter);
        }
    }
    (name.to_owned(), Kind::Untyped)
}

/// 텍스트 전체를 읽는다. 주석·빈 줄·해석할 수 없는 줄·NaN 값은 건너뛴다.
pub fn parse(text: &str) -> Vec<Sample> {
    let mut types = HashMap::new();
    for line in text.lines() {
        let mut words = line.split_whitespace();
        if (words.next(), words.next()) == (Some("#"), Some("TYPE")) {
            if let (Some(name), Some(kind)) = (words.next(), words.next()) {
                types.insert(name.to_owned(), kind_of(kind));
            }
        }
    }
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(line_of)
        .filter(|(_, _, value)| !value.is_nan())
        .map(|(name, labels, value)| {
            let (family, kind) = family_of(&name, &types);
            Sample {
                name,
                family,
                kind,
                labels,
                value,
            }
        })
        .collect()
}

/// 화면이 쓰는 지표 가족과, 합칠 때 남길 라벨(나머지 라벨은 지우고 같은 값끼리 더한다)
const WANTED: &[(&str, &[&str])] = &[
    ("argocd_app_reconcile", &[]),
    ("argocd_app_sync_total", &["phase"]),
    ("argocd_git_request_duration_seconds", &["request_type"]),
    ("argocd_git_request_total", &["request_type"]),
    ("argocd_repo_pending_request_total", &[]),
    ("argocd_cluster_info", &["name", "server", "k8s_version"]),
    ("argocd_cluster_connection_status", &["server"]),
    ("argocd_cluster_api_resource_objects", &["server"]),
    ("argocd_cluster_api_resources", &["server"]),
    ("argocd_cluster_cache_age_seconds", &["server"]),
    ("argocd_cluster_events_total", &["server"]),
    ("argocd_kubectl_exec_pending", &["command"]),
    ("workqueue_depth", &["name"]),
    ("controller_runtime_reconcile_errors_total", &["controller"]),
    ("controller_runtime_reconcile_total", &["controller", "result"]),
];

/// 합친 시리즈. `delta`는 앞 읽기 이후 늘어난 양(카운터와 히스토그램 부품만, 첫 읽기이거나 게이지면 None).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Series {
    pub component: String,
    pub name: String,
    pub labels: BTreeMap<String, String>,
    pub value: f64,
    pub delta: Option<f64>,
}

/// 이 값이 이 시리즈의 앞 값에서 늘어난 양. 줄었으면 리셋(재시작)이라 새 값이 처음부터 센 양이다.
pub fn increase(previous: f64, current: f64) -> f64 {
    if current >= previous {
        current - previous
    } else {
        current
    }
}

fn series_key(sample: &Sample) -> String {
    let labels: Vec<String> = sample.labels.iter().map(|(k, v)| format!("{k}={v}")).collect();
    format!("{}{{{}}}", sample.name, labels.join(","))
}

/// 시리즈 이름과 남긴 레이블.
type SeriesKey = (String, BTreeMap<String, String>);

/// 컴포넌트마다 앞 읽기의 시리즈별 값과 읽은 시각. 읽기에 실패한 컴포넌트는 건드리지 않아 다음 성공 때 이어서 센다.
#[derive(Default)]
pub struct Tracker {
    previous: HashMap<String, (i64, HashMap<String, f64>)>,
}

impl Tracker {
    /// 컴포넌트 하나의 읽기를 요약한다. 돌려주는 값은 시리즈와 앞 읽기와의 간격(ms, 첫 읽기면 None).
    pub fn reduce(&mut self, component: &str, at_ms: i64, samples: &[Sample]) -> (Vec<Series>, Option<i64>) {
        let before = self.previous.get(component);
        let interval = before.map(|(at, _)| at_ms - at).filter(|ms| *ms > 0);
        let mut grouped: BTreeMap<SeriesKey, (f64, Option<f64>)> = BTreeMap::new();
        let mut now = HashMap::new();
        for sample in samples {
            let Some((_, keep)) = WANTED.iter().find(|(family, _)| *family == sample.family) else {
                continue;
            };
            // 히스토그램은 `_bucket`·`_sum`·`_count` 모두, 카운터는 값 하나. 요약은 쓰지 않는다.
            if sample.kind == Kind::Summary || sample.kind == Kind::Untyped {
                continue;
            }
            let counting = sample.kind != Kind::Gauge;
            let labels: BTreeMap<String, String> = sample
                .labels
                .iter()
                .filter(|(k, _)| *k == "le" || keep.contains(&k.as_str()))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            let key = series_key(sample);
            let delta = match (counting, before, interval) {
                (true, Some((_, prev)), Some(_)) => Some(prev.get(&key).map_or(sample.value, |p| increase(*p, sample.value))),
                _ => None,
            };
            let entry = grouped.entry((sample.name.clone(), labels)).or_insert((0.0, None));
            entry.0 += sample.value;
            if let Some(d) = delta {
                entry.1 = Some(entry.1.unwrap_or(0.0) + d);
            }
            if counting {
                now.insert(key, sample.value);
            }
        }
        self.previous.insert(component.to_owned(), (at_ms, now));
        let series = grouped
            .into_iter()
            .map(|((name, labels), (value, delta))| Series {
                component: component.to_owned(),
                name,
                labels,
                value,
                delta,
            })
            .collect();
        (series, interval)
    }
}

#[cfg(test)]
mod tests;
