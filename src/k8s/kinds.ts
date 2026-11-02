import { NAMESPACES, kindKey } from "./targets";
import { CAT_CLUSTER, CAT_CONFIG, CAT_NETWORK, CAT_STORAGE, CAT_WORKLOADS } from "./text";
import type { K8sKind, K8sKindRef } from "./types";

const ref = (group: string, version: string, kind: string, plural: string, namespaced = true): K8sKindRef => ({ group, version, kind, plural, namespaced });

export const PODS = ref("", "v1", "Pod", "pods");
export const DEPLOYMENTS = ref("apps", "v1", "Deployment", "deployments");
export const STATEFULSETS = ref("apps", "v1", "StatefulSet", "statefulsets");
export const DAEMONSETS = ref("apps", "v1", "DaemonSet", "daemonsets");
export const REPLICASETS = ref("apps", "v1", "ReplicaSet", "replicasets");
export const JOBS = ref("batch", "v1", "Job", "jobs");
export const CRONJOBS = ref("batch", "v1", "CronJob", "cronjobs");
export const SERVICES = ref("", "v1", "Service", "services");
export const INGRESSES = ref("networking.k8s.io", "v1", "Ingress", "ingresses");
export const NETWORK_POLICIES = ref("networking.k8s.io", "v1", "NetworkPolicy", "networkpolicies");
export const ENDPOINTS = ref("", "v1", "Endpoints", "endpoints");
export const CONFIGMAPS = ref("", "v1", "ConfigMap", "configmaps");
export const SECRETS = ref("", "v1", "Secret", "secrets");
export const SERVICE_ACCOUNTS = ref("", "v1", "ServiceAccount", "serviceaccounts");
export const PVCS = ref("", "v1", "PersistentVolumeClaim", "persistentvolumeclaims");
export const PVS = ref("", "v1", "PersistentVolume", "persistentvolumes", false);
export const STORAGE_CLASSES = ref("storage.k8s.io", "v1", "StorageClass", "storageclasses", false);
export const NODES = ref("", "v1", "Node", "nodes", false);
export const EVENTS = ref("", "v1", "Event", "events");

export interface KindCategory {
  id: string;
  label: string;
  kinds: K8sKindRef[];
}

/** 설계의 워크로드 트리(내장 종류). 사용자 정의 리소스는 customCategories로 뒤에 붙인다. */
export const CATEGORIES: KindCategory[] = [
  { id: "workloads", label: CAT_WORKLOADS, kinds: [PODS, DEPLOYMENTS, STATEFULSETS, DAEMONSETS, REPLICASETS, JOBS, CRONJOBS] },
  { id: "network", label: CAT_NETWORK, kinds: [SERVICES, INGRESSES, NETWORK_POLICIES, ENDPOINTS] },
  { id: "config", label: CAT_CONFIG, kinds: [CONFIGMAPS, SECRETS, SERVICE_ACCOUNTS] },
  { id: "storage", label: CAT_STORAGE, kinds: [PVCS, PVS, STORAGE_CLASSES] },
  { id: "cluster", label: CAT_CLUSTER, kinds: [NAMESPACES, NODES] },
];

export const BUILTIN: K8sKindRef[] = CATEGORIES.flatMap((c) => c.kinds);

export const sameKind = (a: K8sKindRef, b: K8sKindRef) => kindKey(a) === kindKey(b);
export const isSecret = (k: K8sKindRef) => k.group === "" && k.kind === "Secret";
export const isPod = (k: K8sKindRef) => k.group === "" && k.kind === "Pod";
export const isService = (k: K8sKindRef) => k.group === "" && k.kind === "Service";
export const isServiceAccount = (k: K8sKindRef) => k.group === "" && k.kind === "ServiceAccount";

const strip = ({ group, version, kind, plural, namespaced }: K8sKindRef): K8sKindRef => ({ group, version, kind, plural, namespaced });

/** 북마크는 그룹과 복수형 이름으로 알아본다. 버전은 클러스터마다 권장 버전이 달라도 같은 북마크다. */
export const bookmarkKey = (k: K8sKindRef) => `${k.group}/${k.plural}`;
/** 설정에 저장하는 모양(동사·사용자 정의 표시는 빼고) */
export const bookmarkOf = strip;

/** 사용자 정의 리소스를 API 그룹마다 묶는다(그룹, 종류 이름 순서) */
export function customCategories(kinds: K8sKind[]): KindCategory[] {
  const groups = new Map<string, K8sKindRef[]>();
  for (const k of kinds.filter((k) => k.custom)) groups.set(k.group, [...(groups.get(k.group) ?? []), strip(k)]);
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, list]) => ({ id: `custom:${group}`, label: group, kinds: list.sort((a, b) => a.kind.localeCompare(b.kind)) }));
}

/** 소유 관계 링크(그룹·종류)를 열 수 있는 종류로. 내장 → 발견한 종류 순서, 없으면 null(글로만 보인다). */
export function resolveLink(link: { group: string; kind: string }, kinds: K8sKind[]): K8sKindRef | null {
  const builtin = BUILTIN.find((k) => k.group === link.group && k.kind === link.kind);
  if (builtin) return builtin;
  const found = kinds.find((k) => k.group === link.group && k.kind === link.kind);
  return found ? strip(found) : null;
}
