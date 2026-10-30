import type { AppError } from "../api/types";

// 백엔드 계약(camelCase)과 같은 모양이다. 필드는 이후 단계에서 추가만 된다.
export type K8sTarget = { profile: string; region: string; cluster: string };

export interface K8sContextCandidate {
  /** context 이름 */
  name: string;
  /** kubeconfig의 cluster 항목 이름 */
  cluster: string;
  /** kubeconfig의 user 항목 이름 */
  user: string;
  /** context의 기본 네임스페이스 */
  namespace: string | null;
  /** exec 플러그인의 `--profile` 인자 또는 AWS_PROFILE */
  execProfile: string | null;
}

export interface K8sContextInfo {
  arn: string;
  endpoint: string;
  version: string;
  endpointPublic: boolean;
  endpointPrivate: boolean;
  publicCidrs: string[];
  /** 어느 경로에도 kubeconfig 파일이 없을 때만 true. 이때 kubeconfigPaths는 찾아본 경로들이고 candidates는 비어 있다 */
  kubeconfigMissing: boolean;
  /** 읽은 파일들, 합친 순서대로 */
  kubeconfigPaths: string[];
  /** 이 클러스터를 가리키는 context들, kubeconfig 순서 */
  candidates: K8sContextCandidate[];
  /** 저장해 둔 context가 아직 후보면 그것, 아니면 후보가 하나일 때 그것, 아니면 null */
  chosen: string | null;
  /** 저장해 둔 context가 더는 후보가 아닐 때 그 이름 */
  savedMissing: string | null;
  updateCommand: string;
}

export interface K8sIdentity {
  username: string;
  groups: string[];
  arn: string | null;
  source: "selfSubjectReview" | "kubeconfig";
}

export interface K8sSession {
  context: string;
  execProfile: string | null;
  identity: K8sIdentity;
  serverVersion: string;
}

export interface K8sResourceRule {
  verbs: string[];
  apiGroups: string[];
  resources: string[];
  resourceNames: string[];
}

export interface K8sNonResourceRule {
  verbs: string[];
  nonResourceUrls: string[];
}

export interface K8sRules {
  namespace: string;
  resourceRules: K8sResourceRule[];
  nonResourceRules: K8sNonResourceRule[];
  incomplete: boolean;
}

export interface K8sKindRef {
  group: string;
  version: string;
  kind: string;
  plural: string;
  namespaced: boolean;
}

export interface K8sRow {
  uid: string;
  name: string;
  namespace: string | null;
  resourceVersion: string;
  createdAt: string | null;
  labels: Record<string, string>;
  values: Record<string, string>;
}

export type K8sWatchMessage =
  | { type: "reset"; rows: K8sRow[] }
  | { type: "changes"; upserts: K8sRow[]; deletes: string[] } // deletes는 uid
  | { type: "error"; error: AppError; fatal: boolean };
