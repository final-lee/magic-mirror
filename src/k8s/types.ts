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

/** 변경 대상. 네임스페이스가 없는 종류는 namespace가 null이다. */
export interface K8sChangeObject {
  kind: K8sKindRef;
  namespace: string | null;
  name: string;
}

/** 되돌리기용 recreate는 변경 기록에서만 만들어진다. */
export type K8sChange = K8sChangeObject & (
  | { type: "scale"; replicas: number }
  | { type: "restart" }
  | { type: "rolloutUndo"; revision: string }
  | { type: "delete" }
  | { type: "rerun"; jobName: string }
  | { type: "suspend"; suspend: boolean }
  | { type: "recreate"; object: Record<string, unknown> }
);

export interface K8sRevision {
  revision: string;
  name: string;
}

export interface K8sApiCall {
  verb: string;
  path: string;
  body: unknown;
}

export interface K8sFieldDiff {
  path: string;
  before: unknown;
  after: unknown;
}

export interface K8sPreview {
  calls: K8sApiCall[];
  diff: K8sFieldDiff[];
  impact: string[];
  warnings: string[];
  confirmName: string | null;
  reversible: boolean;
}

export interface K8sApplyResult {
  logId: string;
}

export interface K8sChangeLogEntry {
  id: string;
  at: string;
  target: K8sTarget;
  change: K8sChange;
  summary: string;
  ok: boolean;
  error: string | null;
  inverse: K8sChange | null;
  undoOf: string | null;
  undone: boolean;
}

export interface K8sUndo {
  target: K8sTarget;
  change: K8sChange;
}

export interface K8sRow {
  uid: string;
  name: string;
  namespace: string | null;
  resourceVersion: string;
  createdAt: string | null;
  labels: Record<string, string>;
  values: Record<string, string>;
  /** 이상 표시. 정렬돼 있고 겹치지 않는다(K2) */
  problems: K8sProblem[];
}

export type K8sWatchMessage =
  | { type: "reset"; rows: K8sRow[] }
  | { type: "changes"; upserts: K8sRow[]; deletes: string[] } // deletes는 uid
  | { type: "error"; error: AppError; fatal: boolean };

/** k8s_logs 옵션(백엔드 LogOptions) */
export interface K8sLogOptions {
  container: string | null;
  follow: boolean;
  tailLines: number;
  previous: boolean;
}

/** k8s_logs 채널. error와 end에서 흐름이 끝난다. */
export type K8sLogMessage = { type: "lines"; lines: string[] } | { type: "error"; error: AppError } | { type: "end" };

export type K8sProblem = "crashLoopBackOff" | "imagePullBackOff" | "pending" | "oomKilled" | "notReady";

export interface K8sKind extends K8sKindRef {
  verbs: string[];
  /** 내장 API 그룹이 아닌 종류(사용자 정의 리소스) */
  custom: boolean;
}

/** 소유자 또는 자식. plural은 kinds로 프론트가 찾는다 */
export interface K8sLink {
  group: string;
  version: string;
  kind: string;
  name: string;
  namespace: string | null;
  uid: string;
  controller: boolean;
  problems: K8sProblem[];
}

export interface K8sTermination {
  reason: string | null;
  exitCode: number;
  finishedAt: string | null;
}

export interface K8sContainer {
  name: string;
  image: string;
  init: boolean;
  /** template: 워크로드의 Pod 템플릿에서 읽은 것(상태 없음) */
  state: "running" | "waiting" | "terminated" | "unknown" | "template";
  ready: boolean;
  restarts: number;
  reason: string | null;
  message: string | null;
  lastTermination: K8sTermination | null;
}

export interface K8sCondition {
  type: string;
  status: string;
  reason: string | null;
  message: string | null;
  lastTransition: string | null;
}

export interface K8sEvent {
  type: string;
  reason: string;
  message: string;
  count: number;
  lastSeen: string | null;
  source: string | null;
  /** "Kind/name" */
  object: string;
}

export interface K8sSecretKey {
  key: string;
  /** 값의 바이트 수 */
  size: number;
}

export interface K8sObjectView {
  kind: K8sKindRef;
  row: K8sRow;
  /** Secret이면 last-applied 어노테이션은 가려져 있다 */
  annotations: Record<string, string>;
  owners: K8sLink[];
  children: K8sLink[];
  childrenTruncated: boolean;
  childrenError: AppError | null;
  containers: K8sContainer[];
  conditions: K8sCondition[];
  /** 최근 것부터, 최대 100개 */
  events: K8sEvent[];
  eventsError: AppError | null;
  /** managedFields 없음, Secret 값은 •••• */
  yaml: string;
  /** Secret일 때만 */
  secretKeys: K8sSecretKey[] | null;
}

/** Secret 키 하나의 값. 컴포넌트 상태에만 둔다(React Query에 넣지 않는다) */
export interface K8sSecretValue {
  text: string;
  encoding: "utf8" | "base64";
}

export type K8sOverviewSection = "cluster" | "nodes" | "metrics" | "nodegroups" | "fargate" | "nodePools" | "addons" | "insights" | "removedApis";

export interface K8sGap {
  section: K8sOverviewSection;
  error: AppError;
}

export interface K8sClusterView {
  version: string;
  platformVersion: string | null;
  status: string | null;
  endpointPublic: boolean;
  endpointPrivate: boolean;
  publicCidrs: string[];
  /** 켜진 컨트롤 플레인 로그 종류 */
  logging: string[];
  secretsEncrypted: boolean;
  oidcIssuer: string | null;
  authenticationMode: string | null;
}

export interface K8sResources {
  cpuMilli: number;
  memoryBytes: number;
  pods: number;
}

export type K8sGroupKind = "managed" | "fargate" | "karpenter" | "self";

export interface K8sNodeView {
  name: string;
  ready: boolean;
  unschedulable: boolean;
  pressures: string[];
  instanceType: string | null;
  zone: string | null;
  groupKind: K8sGroupKind;
  group: string | null;
  kubeletVersion: string;
  allocatable: K8sResources;
  requested: K8sResources;
  usage: { cpuMilli: number; memoryBytes: number } | null;
}

export interface K8sNodegroupView {
  name: string;
  status: string | null;
  version: string | null;
  instanceTypes: string[];
  capacityType: string | null;
  min: number | null;
  max: number | null;
  desired: number | null;
}

export interface K8sAddonView {
  name: string;
  version: string | null;
  latest: string | null;
  status: string | null;
  issues: string[];
}

export interface K8sInsightView {
  name: string;
  category: string | null;
  status: string | null;
  reason: string | null;
  description: string | null;
  kubernetesVersion: string | null;
}

export interface K8sRemovedUse {
  kind: string;
  apiVersion: string;
  replacement: string;
  removedIn: string;
  namespace: string | null;
  name: string;
}

export interface K8sSkew {
  node: string;
  kubeletVersion: string;
  minorsBehind: number;
}

export interface K8sOverview {
  cluster: K8sClusterView | null;
  nodes: K8sNodeView[] | null;
  requestsPartial: boolean;
  /** 사용량을 metrics-server에서 받았는지 */
  metrics: boolean;
  nodegroups: K8sNodegroupView[] | null;
  fargateProfiles: string[] | null;
  /** null: Karpenter NodePool 종류가 없다(또는 읽지 못함) */
  nodePools: string[] | null;
  addons: K8sAddonView[] | null;
  insights: K8sInsightView[] | null;
  removedApis: K8sRemovedUse[] | null;
  nextVersion: string | null;
  skew: K8sSkew[];
  gaps: K8sGap[];
}

/** 화면 안에서 객체 하나를 가리킨다(프론트 전용) */
export interface ObjectRef {
  kind: K8sKindRef;
  namespace: string | null;
  name: string;
}
