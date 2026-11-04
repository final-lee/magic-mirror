//! 읽어 온 객체 더미. 관계 계산은 이 더미만 보고 하므로 클러스터 없이 시험할 수 있다.
use std::collections::{BTreeMap, HashMap, HashSet};

use kube::api::DynamicObject;
use kube::core::ObjectMeta;
use serde_json::Value;

use super::model::{Gap, Presence};
use crate::error::AppError;
use crate::k8s::read::detail::split_api_version;
use crate::k8s::read::values::{values_of, Problem};
use crate::k8s::rows::KindRef;

/// 객체를 가리키는 이름: (그룹, 종류, 네임스페이스, 이름). 버전은 쓰지 않는다(ownerReference와 scaleTargetRef가 버전을 달리 적을 수 있다).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Key {
    pub group: String,
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
}

impl Key {
    pub fn new(group: &str, kind: &str, namespace: Option<&str>, name: &str) -> Self {
        Key { group: group.into(), kind: kind.into(), namespace: namespace.map(str::to_string), name: name.into() }
    }
}

/// ownerReferences의 한 줄
#[derive(Debug, Clone, PartialEq)]
pub struct OwnerRef {
    pub group: String,
    pub version: String,
    pub kind: String,
    pub name: String,
    pub uid: String,
    pub controller: bool,
}

/// 관계 계산에 쓰는 객체 하나. Secret·ConfigMap·ServiceAccount는 존재와 소유 관계만 필요해서 본문(`data`)이 비어 있다.
#[derive(Debug, Clone)]
pub struct Item {
    pub kind: KindRef,
    pub namespace: Option<String>,
    pub name: String,
    pub uid: String,
    pub labels: BTreeMap<String, String>,
    pub owners: Vec<OwnerRef>,
    pub data: Value,
    pub status: Option<String>,
    pub problems: Vec<Problem>,
}

fn owners_of(meta: &ObjectMeta) -> Vec<OwnerRef> {
    meta.owner_references
        .iter()
        .flatten()
        .map(|o| {
            let (group, version) = split_api_version(&o.api_version);
            OwnerRef { group, version, kind: o.kind.clone(), name: o.name.clone(), uid: o.uid.clone(), controller: o.controller == Some(true) }
        })
        .collect()
}

impl Item {
    pub fn of(kind: &KindRef, obj: &DynamicObject) -> Item {
        let values = values_of(kind, obj);
        let status = values.values.get("status").or_else(|| values.values.get("ready")).cloned();
        let mut item = Item::meta(kind, &obj.metadata);
        item.data = obj.data.clone();
        item.status = status;
        item.problems = values.problems;
        item
    }

    /// 메타데이터만(본문이 없는 객체)
    pub fn meta(kind: &KindRef, meta: &ObjectMeta) -> Item {
        Item {
            kind: kind.clone(),
            namespace: meta.namespace.clone(),
            name: meta.name.clone().unwrap_or_default(),
            uid: meta.uid.clone().unwrap_or_default(),
            labels: meta.labels.clone().unwrap_or_default().into_iter().collect(),
            owners: owners_of(meta),
            data: Value::Null,
            status: None,
            problems: vec![],
        }
    }

    pub fn key(&self) -> Key {
        Key::new(&self.kind.group, &self.kind.kind, self.namespace.as_deref(), &self.name)
    }
}

/// 읽을 종류 하나
pub struct Spec {
    pub group: &'static str,
    pub version: &'static str,
    pub kind: &'static str,
    pub plural: &'static str,
    pub namespaced: bool,
    /// 본문 없이 메타데이터만 읽는다(Secret 값을 받지 않는다)
    pub meta_only: bool,
}

impl Spec {
    pub fn kind_ref(&self) -> KindRef {
        KindRef { group: self.group.into(), version: self.version.into(), kind: self.kind.into(), plural: self.plural.into(), namespaced: self.namespaced }
    }
}

const fn spec(group: &'static str, version: &'static str, kind: &'static str, plural: &'static str, namespaced: bool, meta_only: bool) -> Spec {
    Spec { group, version, kind, plural, namespaced, meta_only }
}

pub const POD: Spec = spec("", "v1", "Pod", "pods", true, false);
pub const SERVICE: Spec = spec("", "v1", "Service", "services", true, false);
pub const PVC: Spec = spec("", "v1", "PersistentVolumeClaim", "persistentvolumeclaims", true, false);
pub const PV: Spec = spec("", "v1", "PersistentVolume", "persistentvolumes", false, false);
pub const CONFIG_MAP: Spec = spec("", "v1", "ConfigMap", "configmaps", true, true);
pub const SECRET: Spec = spec("", "v1", "Secret", "secrets", true, true);
pub const SERVICE_ACCOUNT: Spec = spec("", "v1", "ServiceAccount", "serviceaccounts", true, true);
pub const NODE: Spec = spec("", "v1", "Node", "nodes", false, false);
pub const STORAGE_CLASS: Spec = spec("storage.k8s.io", "v1", "StorageClass", "storageclasses", false, false);
pub const PRIORITY_CLASS: Spec = spec("scheduling.k8s.io", "v1", "PriorityClass", "priorityclasses", false, false);
pub const REPLICA_SET: Spec = spec("apps", "v1", "ReplicaSet", "replicasets", true, false);
pub const DEPLOYMENT: Spec = spec("apps", "v1", "Deployment", "deployments", true, false);
pub const STATEFUL_SET: Spec = spec("apps", "v1", "StatefulSet", "statefulsets", true, false);
pub const DAEMON_SET: Spec = spec("apps", "v1", "DaemonSet", "daemonsets", true, false);
pub const JOB: Spec = spec("batch", "v1", "Job", "jobs", true, false);
pub const CRON_JOB: Spec = spec("batch", "v1", "CronJob", "cronjobs", true, false);
pub const ENDPOINT_SLICE: Spec = spec("discovery.k8s.io", "v1", "EndpointSlice", "endpointslices", true, false);
pub const INGRESS: Spec = spec("networking.k8s.io", "v1", "Ingress", "ingresses", true, false);
pub const NETWORK_POLICY: Spec = spec("networking.k8s.io", "v1", "NetworkPolicy", "networkpolicies", true, false);
pub const HPA: Spec = spec("autoscaling", "v2", "HorizontalPodAutoscaler", "horizontalpodautoscalers", true, false);
pub const PDB: Spec = spec("policy", "v1", "PodDisruptionBudget", "poddisruptionbudgets", true, false);

/// 네임스페이스 안의 객체를 보는 상세에서 읽는 종류 전부
pub const NAMESPACED: &[&Spec] = &[
    &POD, &REPLICA_SET, &DEPLOYMENT, &STATEFUL_SET, &DAEMON_SET, &JOB, &CRON_JOB, &SERVICE, &ENDPOINT_SLICE, &INGRESS, &NETWORK_POLICY, &HPA, &PDB, &PVC,
    &CONFIG_MAP, &SECRET, &SERVICE_ACCOUNT,
];

/// 클러스터 범위 객체(노드, PV, StorageClass, PriorityClass)를 보는 상세에서 읽는 종류: 그것을 쓰는 Pod·워크로드·PVC·PV를 모든 네임스페이스에서 찾는다
pub const CLUSTER_WIDE: &[&Spec] = &[&POD, &REPLICA_SET, &DEPLOYMENT, &STATEFUL_SET, &DAEMON_SET, &JOB, &CRON_JOB, &PVC, &PV];

/// 읽어 온 객체 전체와, 종류마다 읽은 결과
#[derive(Default)]
pub struct Pool {
    items: Vec<Item>,
    by_key: HashMap<Key, usize>,
    by_uid: HashMap<String, usize>,
    kids: HashMap<String, Vec<usize>>,
    /// 끝까지 읽은 종류(그룹, 종류)
    complete: HashSet<(String, String)>,
    /// 이름으로 읽었더니 없던 객체
    absent: HashSet<Key>,
    pub gaps: Vec<Gap>,
    /// 쪽 수 한도에서 멈춘 종류
    pub partial: Vec<String>,
}

impl Pool {
    pub fn add(&mut self, item: Item) {
        let key = item.key();
        if self.by_key.contains_key(&key) {
            return;
        }
        let idx = self.items.len();
        if !item.uid.is_empty() {
            self.by_uid.insert(item.uid.clone(), idx);
        }
        for owner in &item.owners {
            self.kids.entry(owner.uid.clone()).or_default().push(idx);
        }
        self.by_key.insert(key, idx);
        self.items.push(item);
    }

    /// 한 종류를 읽은 결과를 담는다. 오류면 빈 칸(`gaps`)으로 적는다.
    pub fn add_list(&mut self, kind: &KindRef, result: Result<(Vec<Item>, bool), AppError>) {
        match result {
            Ok((items, stopped)) => {
                if stopped {
                    self.partial.push(kind.kind.clone());
                } else {
                    self.complete.insert((kind.group.clone(), kind.kind.clone()));
                }
                for item in items {
                    self.add(item);
                }
            }
            Err(error) => self.gaps.push(Gap { kind: kind.kind.clone(), error }),
        }
    }

    /// 이름으로 읽은 결과를 담는다. 없으면(404) 없는 것으로 적고, 그 밖의 오류는 빈 칸으로 적는다.
    pub fn add_fetched(&mut self, key: Key, kind: &KindRef, result: Result<Option<Item>, AppError>) {
        match result {
            Ok(Some(item)) => self.add(item),
            Ok(None) => {
                self.absent.insert(key);
            }
            Err(error) => {
                if !self.gaps.iter().any(|g| g.kind == kind.kind) {
                    self.gaps.push(Gap { kind: kind.kind.clone(), error });
                }
            }
        }
    }

    pub fn get(&self, key: &Key) -> Option<&Item> {
        self.by_key.get(key).map(|i| &self.items[*i])
    }

    pub fn by_uid(&self, uid: &str) -> Option<&Item> {
        self.by_uid.get(uid).map(|i| &self.items[*i])
    }

    /// 이 uid를 소유자로 적은 객체들
    pub fn children_of(&self, uid: &str) -> Vec<&Item> {
        self.kids.get(uid).map(|v| v.iter().map(|i| &self.items[*i]).collect()).unwrap_or_default()
    }

    pub fn items(&self) -> &[Item] {
        &self.items
    }

    pub fn of_kind<'a>(&'a self, spec: &'a Spec) -> impl Iterator<Item = &'a Item> {
        self.items.iter().filter(move |i| i.kind.group == spec.group && i.kind.kind == spec.kind)
    }

    /// 그 종류를 끝까지 읽었는가
    pub fn is_complete(&self, group: &str, kind: &str) -> bool {
        self.complete.contains(&(group.to_string(), kind.to_string()))
    }

    pub fn presence(&self, key: &Key) -> Presence {
        if self.by_key.contains_key(key) {
            Presence::Found
        } else if self.absent.contains(key) || self.is_complete(&key.group, &key.kind) {
            Presence::Missing
        } else {
            Presence::Unknown
        }
    }

    /// 이름으로 읽었다가 이미 시도한 키인가(없음·오류를 다시 읽지 않는다)
    pub fn tried(&self, key: &Key) -> bool {
        self.by_key.contains_key(key) || self.absent.contains(key) || self.gaps.iter().any(|g| g.kind == key.kind)
    }
}
