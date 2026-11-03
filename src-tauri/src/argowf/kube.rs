//! context 연결에서만 쿠버네티스 이벤트와 IAM 역할을 읽는다.
use super::{
    auth,
    client::{Server, State},
};
use crate::{
    error::AppError,
    k8s::{
        connect,
        failure::{describe, failure_of, Endpoint},
    },
};
use k8s_openapi::api::core::v1::{ConfigMap, Event, ServiceAccount};
use kube::{
    api::{Api, ListParams},
    Client,
};
use serde::Serialize;
use std::collections::BTreeSet;
const ENDPOINT: Endpoint = Endpoint { public: true, private: true };
pub const CONTEXT_REQUIRED: &str = "kubeconfig context로 연결하면 이벤트도 보여요";
async fn client(state: &State, server: &Server) -> Result<Client, AppError> {
    let context = server.context.as_deref().ok_or_else(|| AppError::other(CONTEXT_REQUIRED))?;
    let loaded = auth::load(&state.settings_path)?;
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    serde_json::to_string(&loaded.config)
        .map_err(|_| AppError::other("kubeconfig를 읽지 못했어요"))?
        .hash(&mut hasher);
    let key = format!("{context}\0{:016x}", hasher.finish());
    let mut clients = state.kube_clients.lock().await;
    if let Some(client) = clients.get(&key) {
        return Ok(client.clone());
    }
    let (client, _) = connect::connect(&loaded, context, ENDPOINT).await?;
    clients.clear();
    clients.insert(key, client.clone());
    Ok(client)
}
async fn kube_error(state: &State, error: kube::Error, operation: &str, resource: &str) -> AppError {
    if matches!(&error, kube::Error::Api(response) if response.code == 401 || response.code == 403) {
        state.kube_clients.lock().await.clear();
    }
    describe(&failure_of(&error, operation, resource), ENDPOINT)
}
#[derive(Serialize)]
pub struct EventRow {
    at: Option<String>,
    r#type: String,
    reason: String,
    message: String,
    object: String,
    count: i32,
}
pub async fn events(state: &State, server: &Server, namespace: &str, names: Vec<String>) -> Result<Vec<EventRow>, AppError> {
    let client = client(state, server).await?;
    let api: Api<Event> = Api::namespaced(client, namespace);
    let mut rows = Vec::new();
    for name in names.into_iter().collect::<BTreeSet<_>>() {
        let events = match api.list(&ListParams::default().fields(&format!("involvedObject.name={name}"))).await {
            Ok(events) => events,
            Err(error) => return Err(kube_error(state, error, "list", "events").await),
        };
        for e in events.items {
            let at = e
                .last_timestamp
                .or(e.first_timestamp)
                .or(e.metadata.creation_timestamp)
                .map(|t| t.0.to_string())
                .or_else(|| e.event_time.map(|t| t.0.to_string()));
            rows.push(EventRow {
                at,
                r#type: e.type_.unwrap_or_default(),
                reason: e.reason.unwrap_or_default(),
                message: e.message.unwrap_or_default(),
                object: e.involved_object.name.unwrap_or_default(),
                count: e.count.unwrap_or(1),
            });
        }
    }
    rows.sort_by(|a, b| b.at.cmp(&a.at));
    Ok(rows)
}
pub async fn role_arn(state: &State, server: &Server, namespace: &str, name: &str) -> Result<Option<String>, AppError> {
    if server.context.is_none() {
        return Ok(None);
    }
    let api: Api<ServiceAccount> = Api::namespaced(client(state, server).await?, namespace);
    let sa = match api.get(name).await {
        Ok(sa) => sa,
        Err(error) => return Err(kube_error(state, error, "get", "serviceaccounts").await),
    };
    Ok(sa.metadata.annotations.and_then(|a| a.get("eks.amazonaws.com/role-arn").cloned()))
}

pub const PLUGINS_CONTEXT_REQUIRED: &str = "kubeconfig context로 연결하면 플러그인을 볼 수 있어요";

pub async fn plugins(state: &State, server: &Server, namespace: Option<&str>) -> Result<Vec<serde_json::Value>, AppError> {
    if server.context.is_none() {
        return Err(AppError::other(PLUGINS_CONTEXT_REQUIRED));
    }
    let client = client(state, server).await?;
    let api: Api<ConfigMap> = match namespace.filter(|ns| !ns.is_empty()) {
        Some(ns) => Api::namespaced(client, ns),
        None => Api::all(client),
    };
    let maps = match api
        .list(&ListParams::default().labels("workflows.argoproj.io/configmap-type=ExecutorPlugin"))
        .await
    {
        Ok(maps) => maps,
        Err(error) => return Err(kube_error(state, error, "list", "configmaps").await),
    };
    Ok(maps
        .items
        .into_iter()
        .map(|map| {
            let image = map.data.as_ref().and_then(|data| {
                data.values().find_map(|text| {
                    let value: serde_json::Value = serde_saphyr::from_str(text).ok()?;
                    value.pointer("/sidecar/container/image").and_then(serde_json::Value::as_str).map(str::to_owned)
                })
            });
            serde_json::json!({
                "namespace": map.metadata.namespace.unwrap_or_default(),
                "name": map.metadata.name.unwrap_or_default(),
                "description": map.metadata.annotations.and_then(|a| a.get("workflows.argoproj.io/description").cloned()),
                "image": image,
            })
        })
        .collect())
}
