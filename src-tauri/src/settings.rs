use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use crate::error::AppError;
use crate::k8s::rows::KindRef;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Favorite {
    pub service: String,
    #[serde(rename = "type")]
    pub type_id: String,
}

/// EKS 탭 레인 너비. 메뉴(1열)·종류(2열)는 px, 상세(4열)는 목록(3열) 너비에 대한 %. 비어 있으면 화면의 기본값을 쓴다.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct K8sLaneWidths {
    pub nav: Option<u32>,
    pub tree: Option<u32>,
    pub detail_pct: Option<u32>,
}
/// EKS 보안 점검 설정: 끈 점검 항목과 시스템 네임스페이스 포함 여부. 비어 있으면 모든 항목을 켜고 시스템 네임스페이스(`kube-system` 등)는 뺀다.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct K8sSecurityChecks {
    /// 끈 점검 항목의 이름(`privileged`, `clusterAwsAuth` …). 모든 클러스터에 같이 쓴다.
    pub disabled: Vec<String>,
    pub include_system: bool,
}

/// ArgoCD API 서버의 표시 이름과 주소.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArgocdServer {
    pub name: String,
    pub url: String,
}

/// ArgoCD 서버 하나의 목록 화면 상태: 마지막으로 고른 필터와 묶기 기준. 검색어는 남기지 않는다.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ArgocdView {
    pub sync: Vec<String>,
    pub health: Vec<String>,
    pub envs: Vec<String>,
    pub clusters: Vec<String>,
    pub projects: Vec<String>,
    /// `key=value` 또는 `key`
    pub labels: Vec<String>,
    pub group_by: Option<String>,
    pub then_by: Option<String>,
}

/// Argo Workflows 서버의 인증은 context 또는 키체인 토큰을 쓴다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgoWorkflowsServer {
    pub name: String,
    pub url: String,
    pub context: Option<String>,
    #[serde(default)]
    pub namespace: Option<String>,
    #[serde(default)]
    pub label_columns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ArgoWorkflowsView {
    pub phases: Vec<String>,
    pub namespaces: Vec<String>,
    pub sources: Vec<String>,
    pub labels: Vec<String>,
    pub mine: bool,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub enabled_services: Vec<String>,
    pub favorites: Vec<Favorite>,
    pub last_profile: Option<String>,
    pub last_region: Option<String>,
    pub explorer_local_path: Option<String>,
    pub diff_tool: Option<String>,
    pub diff_tool_command: Option<String>,
    /// 화면 테마. 비어 있으면 시스템 설정을 따른다.
    pub theme: Option<String>,
    /// PostgreSQL 탭의 로그인 사용자: 대상(클러스터·인스턴스) ARN → DB 사용자 이름
    pub pg_logins: BTreeMap<String, String>,
    /// EKS 탭이 접속할 kubeconfig context: 클러스터 ARN → context 이름
    pub k8s_contexts: BTreeMap<String, String>,
    /// kubeconfig 경로. 비우면 KUBECONFIG 또는 ~/.kube/config
    pub kubeconfig_path: Option<String>,
    /// EKS 탭 왼쪽 메뉴에 북마크한 리소스 종류. 북마크한 순서(드래그로 바꾼 순서)대로 둔다.
    pub k8s_bookmarks: Vec<KindRef>,
    pub k8s_lane_widths: K8sLaneWidths,
    pub k8s_security_checks: K8sSecurityChecks,
    /// ArgoCD 서버 목록. 토큰은 설정이 아니라 키체인에 저장한다.
    pub argocd_servers: Vec<ArgocdServer>,
    /// ArgoCD 서버 주소 → 그 서버 목록의 필터·묶기 상태
    pub argocd_views: BTreeMap<String, ArgocdView>,
    pub argo_workflows_servers: Vec<ArgoWorkflowsServer>,
    pub argo_workflows_views: BTreeMap<String, ArgoWorkflowsView>,
    /// 리소스 목록 캐시 유효 시간(분). 없으면 앱 기본값(15분), 0이면 무제한. Rust는 저장만 하고 프론트엔드가 해석한다.
    pub resource_cache_ttl_minutes: Option<u32>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct RawSettings {
    enabled_services: Option<Vec<String>>,
    favorites: Vec<Favorite>,
    last_profile: Option<String>,
    last_region: Option<String>,
    explorer_local_path: Option<String>,
    diff_tool: Option<String>,
    diff_tool_command: Option<String>,
    theme: Option<String>,
    pg_logins: BTreeMap<String, String>,
    k8s_contexts: BTreeMap<String, String>,
    kubeconfig_path: Option<String>,
    k8s_bookmarks: Vec<KindRef>,
    k8s_lane_widths: K8sLaneWidths,
    k8s_security_checks: K8sSecurityChecks,
    argocd_servers: Vec<ArgocdServer>,
    argocd_views: BTreeMap<String, ArgocdView>,
    argo_workflows_servers: Vec<ArgoWorkflowsServer>,
    argo_workflows_views: BTreeMap<String, ArgoWorkflowsView>,
    resource_cache_ttl_minutes: Option<u32>,
}

fn defaults(all_services: &[&str]) -> Settings {
    Settings {
        enabled_services: all_services.iter().map(|s| s.to_string()).collect(),
        ..Default::default()
    }
}

/// 파일이 없거나 깨져 있으면 기본값(모든 서비스 활성화)을 돌려준다.
pub fn load(path: &Path, all_services: &[&str]) -> Settings {
    match fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<RawSettings>(&text) {
            // enabledServices 키가 없으면 모든 서비스를 켠다. 빈 배열은 사용자가 모두 끈 상태다.
            Ok(raw) => Settings {
                enabled_services: raw
                    .enabled_services
                    .unwrap_or_else(|| all_services.iter().map(|s| s.to_string()).collect()),
                favorites: raw.favorites,
                last_profile: raw.last_profile,
                last_region: raw.last_region,
                explorer_local_path: raw.explorer_local_path,
                diff_tool: raw.diff_tool,
                diff_tool_command: raw.diff_tool_command,
                theme: raw.theme,
                pg_logins: raw.pg_logins,
                k8s_contexts: raw.k8s_contexts,
                kubeconfig_path: raw.kubeconfig_path,
                k8s_bookmarks: raw.k8s_bookmarks,
                k8s_lane_widths: raw.k8s_lane_widths,
                k8s_security_checks: raw.k8s_security_checks,
                argocd_servers: raw.argocd_servers,
                argocd_views: raw.argocd_views,
                argo_workflows_servers: raw.argo_workflows_servers,
                argo_workflows_views: raw.argo_workflows_views,
                resource_cache_ttl_minutes: raw.resource_cache_ttl_minutes,
            },
            Err(_) => defaults(all_services),
        },
        Err(_) => defaults(all_services),
    }
}

pub fn save(path: &Path, settings: &Settings) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AppError::other(format!("설정 폴더를 만들 수 없어요: {e}")))?;
    }
    let text =
        serde_json::to_string_pretty(settings).map_err(|e| AppError::other(e.to_string()))?;
    fs::write(path, text).map_err(|e| AppError::other(format!("설정을 저장할 수 없어요: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_returns_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let s = load(&dir.path().join("settings.json"), &["ec2", "s3"]);
        assert_eq!(s.enabled_services, vec!["ec2", "s3"]);
        assert!(s.favorites.is_empty());
        assert_eq!(s.last_profile, None);
    }

    fn load_text(text: &str) -> Settings {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, text).unwrap();
        load(&path, &["ec2", "s3"])
    }
    #[test]
    fn argocd_servers_roundtrip_and_default() {
        assert!(load_text("{}").argocd_servers.is_empty());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let settings = Settings {
            argocd_servers: vec![ArgocdServer {
                name: "stg".into(),
                url: "https://example.test".into(),
            }],
            ..Default::default()
        };
        save(&path, &settings).unwrap();
        assert_eq!(load(&path, &[]).argocd_servers, settings.argocd_servers);
        let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(json["argocdServers"][0]["name"], "stg");
    }

    #[test]
    fn argocd_views_roundtrip_and_partial_entries() {
        assert!(load_text("{}").argocd_views.is_empty());
        // 빠진 칸은 비운 채로 읽는다(앞으로 칸이 늘어도 옛 설정이 깨지지 않는다)
        let partial = load_text(r#"{"argocdViews":{"https://a.test":{"envs":["prd"],"groupBy":"env"}}}"#);
        let view = &partial.argocd_views["https://a.test"];
        assert_eq!(view.envs, ["prd"]);
        assert_eq!(view.group_by.as_deref(), Some("env"));
        assert!(view.labels.is_empty());
        assert_eq!(view.then_by, None);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let settings = Settings {
            argocd_views: BTreeMap::from([(
                "https://a.test".to_string(),
                ArgocdView {
                    labels: vec!["type=api".into()],
                    then_by: Some("label:type".into()),
                    ..Default::default()
                },
            )]),
            ..Default::default()
        };
        save(&path, &settings).unwrap();
        assert_eq!(load(&path, &[]).argocd_views, settings.argocd_views);
        let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(json["argocdViews"]["https://a.test"]["thenBy"], "label:type");
    }

    #[test]
    fn resource_cache_ttl_distinguishes_absent_zero_and_value() {
        assert_eq!(load_text("{}").resource_cache_ttl_minutes, None);
        assert_eq!(load_text(r#"{"resourceCacheTtlMinutes":null}"#).resource_cache_ttl_minutes, None);
        assert_eq!(load_text(r#"{"resourceCacheTtlMinutes":0}"#).resource_cache_ttl_minutes, Some(0));
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        save(&path, &Settings { resource_cache_ttl_minutes: Some(30), ..Default::default() }).unwrap();
        assert_eq!(load(&path, &[]).resource_cache_ttl_minutes, Some(30));
        let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(json["resourceCacheTtlMinutes"], 30);
    }


    #[test]
    fn theme_roundtrip_and_default() {
        assert_eq!(load_text("{}").theme, None);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        for theme in ["system", "light", "dark"] {
            let settings = Settings {
                theme: Some(theme.into()),
                ..Default::default()
            };
            save(&path, &settings).unwrap();
            assert_eq!(load(&path, &[]).theme.as_deref(), Some(theme));
        }
    }

    #[test]
    fn k8s_fields_roundtrip_and_default() {
        let s = load_text(r#"{"k8sContexts":{"arn:aws:eks:r:1:cluster/a":"ctx-a"},"kubeconfigPath":"~/kc"}"#);
        assert_eq!(s.k8s_contexts.get("arn:aws:eks:r:1:cluster/a").map(String::as_str), Some("ctx-a"));
        assert_eq!(s.kubeconfig_path.as_deref(), Some("~/kc"));
        let d = load_text("{}");
        assert!(d.k8s_contexts.is_empty());
        assert_eq!(d.kubeconfig_path, None);
        assert!(d.k8s_bookmarks.is_empty());
        assert_eq!(d.k8s_lane_widths, K8sLaneWidths::default());
    }

    #[test]
    fn k8s_bookmarks_keep_their_order_and_lane_widths_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let kind = |group: &str, kind: &str, plural: &str| KindRef { group: group.into(), version: "v1".into(), kind: kind.into(), plural: plural.into(), namespaced: true };
        let s = Settings {
            k8s_bookmarks: vec![kind("apps", "Deployment", "deployments"), kind("", "Pod", "pods")],
            k8s_lane_widths: K8sLaneWidths { nav: Some(220), tree: None, detail_pct: Some(64) },
            ..Default::default()
        };
        save(&path, &s).unwrap();
        let back = load(&path, &[]);
        assert_eq!(back.k8s_bookmarks, s.k8s_bookmarks);
        assert_eq!(back.k8s_lane_widths, s.k8s_lane_widths);
        let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["k8sBookmarks"][0]["plural"], "deployments");
        assert_eq!(json["k8sLaneWidths"]["detailPct"], 64);
        // 예전 px 값(detail)은 읽지 않는다
        let old = load_text(r#"{"k8sLaneWidths":{"nav":200,"detail":640}}"#);
        assert_eq!(old.k8s_lane_widths, K8sLaneWidths { nav: Some(200), tree: None, detail_pct: None });
    }

    #[test]
    fn k8s_security_checks_default_all_on_and_roundtrip() {
        // 예전 설정 파일에는 이 키가 없다: 모든 항목이 켜지고 시스템 네임스페이스는 뺀다
        let old = load_text(r#"{"k8sBookmarks":[]}"#);
        assert_eq!(old.k8s_security_checks, K8sSecurityChecks::default());
        assert!(old.k8s_security_checks.disabled.is_empty() && !old.k8s_security_checks.include_system);
        // 일부 필드만 있어도 읽힌다
        let partial = load_text(r#"{"k8sSecurityChecks":{"disabled":["probesMissing"]}}"#);
        assert_eq!(partial.k8s_security_checks, K8sSecurityChecks { disabled: vec!["probesMissing".into()], include_system: false });
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let s = Settings { k8s_security_checks: K8sSecurityChecks { disabled: vec!["privileged".into(), "imageLatest".into()], include_system: true }, ..Default::default() };
        save(&path, &s).unwrap();
        assert_eq!(load(&path, &[]).k8s_security_checks, s.k8s_security_checks);
        let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["k8sSecurityChecks"]["includeSystem"], true);
        assert_eq!(json["k8sSecurityChecks"]["disabled"][1], "imageLatest");
    }

    #[test]
    fn argo_workflows_settings_roundtrip_and_old_defaults() {
        let old = load_text(r#"{"lastProfile":"p"}"#);
        assert!(old.argo_workflows_servers.is_empty());
        assert!(old.argo_workflows_views.is_empty());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let s = Settings {
            argo_workflows_servers: vec![ArgoWorkflowsServer {
                name: "test".into(), url: "https://example.test".into(), context: Some("test".into()),
                namespace: Some("demo".into()), label_columns: vec!["team".into()],
            }],
            argo_workflows_views: BTreeMap::from([("https://example.test".into(), ArgoWorkflowsView {
                phases: vec!["Failed".into()], namespaces: vec!["demo".into()], sources: vec!["job".into()],
                labels: vec!["team=a".into()], mine: true,
            })]),
            ..old
        };
        save(&path, &s).unwrap();
        assert_eq!(load(&path, &["ec2", "s3"]), s);
        let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(json["argoWorkflowsServers"][0]["context"], "test");
        assert_eq!(json["argoWorkflowsViews"]["https://example.test"]["phases"][0], "Failed");
    }

    #[test]
    fn missing_enabled_services_key_enables_all() {
        assert_eq!(load_text("{}").enabled_services, vec!["ec2", "s3"]);
        let s = load_text(r#"{"lastProfile":"x"}"#);
        assert_eq!(s.enabled_services, vec!["ec2", "s3"]);
        assert_eq!(s.last_profile.as_deref(), Some("x"));
    }

    #[test]
    fn explicit_empty_enabled_services_stays_empty() {
        assert!(load_text(r#"{"enabledServices": []}"#)
            .enabled_services
            .is_empty());
    }

    #[test]
    fn corrupt_file_returns_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "{not json").unwrap();
        assert_eq!(load(&path, &["ec2"]).enabled_services, vec!["ec2"]);
    }

    #[test]
    fn save_then_load_roundtrip_creates_parent_dir() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("settings.json");
        let s = Settings {
            enabled_services: vec!["iam".into()],
            favorites: vec![Favorite {
                service: "ec2".into(),
                type_id: "instances".into(),
            }],
            last_profile: Some("prod".into()),
            last_region: Some("ap-northeast-2".into()),
            ..Default::default()
        };
        save(&path, &s).unwrap();
        assert_eq!(load(&path, &["ec2", "iam"]), s);
        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["favorites"][0]["type"], "instances");
        assert_eq!(json["lastProfile"], "prod");
    }

    const ARN: &str = "arn:aws:rds:ap-northeast-2:123456789012:cluster:orders-aurora";

    #[test]
    fn pg_logins_roundtrip_and_an_old_file_without_them_still_loads() {
        // PostgreSQL 탭이 생기기 전에 저장한 파일에는 `pgLogins`가 없다
        let old = load_text(r#"{"enabledServices":["ec2"],"lastProfile":"p"}"#);
        assert!(old.pg_logins.is_empty());
        assert_eq!(old.last_profile.as_deref(), Some("p"));

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let s = Settings { pg_logins: BTreeMap::from([(ARN.to_string(), "iam_admin".to_string())]), ..old };
        save(&path, &s).unwrap();
        assert_eq!(load(&path, &["ec2", "s3"]), s);
        let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["pgLogins"][ARN], "iam_admin");
    }

    #[test]
    fn a_file_with_pg_logins_keeps_them_through_a_load_and_a_save() {
        // 프런트엔드가 `save_settings`로 보낸 모양 그대로다: 대상 ARN → DB 사용자
        let text = format!(r#"{{"enabledServices":["ec2"],"pgLogins":{{"{ARN}":"iam_admin","arn:aws:rds:us-east-1:123456789012:db:legacy":"reader"}}}}"#);
        let loaded = load_text(&text);
        assert_eq!(loaded.pg_logins.len(), 2);
        assert_eq!(loaded.pg_logins.get(ARN).map(String::as_str), Some("iam_admin"));

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        save(&path, &loaded).unwrap();
        let again = load(&path, &["ec2", "s3"]);
        assert_eq!(again.pg_logins, loaded.pg_logins);
        // 설정 화면의 다른 값을 바꿔 저장해도 로그인 사용자는 남는다
        let changed = Settings { last_profile: Some("prod".into()), ..again };
        save(&path, &changed).unwrap();
        assert_eq!(load(&path, &["ec2", "s3"]).pg_logins, loaded.pg_logins);
    }

    #[test]
    fn pg_logins_of_the_wrong_shape_make_the_file_corrupt_like_any_other_wrong_field() {
        assert!(load_text(r#"{"pgLogins":["iam_admin"]}"#).pg_logins.is_empty());
    }

    #[test]
    fn explorer_fields_roundtrip_and_default_to_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, r#"{"lastProfile":"p"}"#).unwrap();
        let s = load(&path, &["ec2"]);
        assert_eq!(s.explorer_local_path, None);
        assert_eq!(s.diff_tool, None);
        let s = Settings {
            explorer_local_path: Some("/Users/me".into()),
            diff_tool: Some("vscode".into()),
            diff_tool_command: None,
            ..s
        };
        save(&path, &s).unwrap();
        assert_eq!(load(&path, &["ec2"]), s);
        let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["explorerLocalPath"], "/Users/me");
        assert_eq!(json["diffTool"], "vscode");
    }
}
