import type { K8sKindRef, K8sObjectView } from "../types";

/** 관계를 계산하는 내장 종류(그룹/종류). 백엔드 `k8s/xray`가 읽는 종류와 짝이다 */
const RELATED: Record<string, true> = {
  "/Pod": true,
  "apps/Deployment": true,
  "apps/ReplicaSet": true,
  "apps/StatefulSet": true,
  "apps/DaemonSet": true,
  "batch/Job": true,
  "batch/CronJob": true,
  "/Service": true,
  "discovery.k8s.io/EndpointSlice": true,
  "networking.k8s.io/Ingress": true,
  "networking.k8s.io/NetworkPolicy": true,
  "autoscaling/HorizontalPodAutoscaler": true,
  "policy/PodDisruptionBudget": true,
  "/ConfigMap": true,
  "/Secret": true,
  "/ServiceAccount": true,
  "/PersistentVolumeClaim": true,
  "/PersistentVolume": true,
  "storage.k8s.io/StorageClass": true,
  "/Node": true,
  "scheduling.k8s.io/PriorityClass": true,
};

/**
 * 관계 탭을 둘 객체인가: 관계를 계산하는 종류이거나, 상세가 이미 소유자·자식을 가진 객체(사용자 정의 리소스 등).
 * 상세를 아직 읽지 못했으면 종류만 본다.
 */
export function hasRelations(kind: K8sKindRef, view: K8sObjectView | undefined): boolean {
  if (RELATED[`${kind.group}/${kind.kind}`]) return true;
  return view !== undefined && (view.owners.length > 0 || view.children.length > 0);
}
