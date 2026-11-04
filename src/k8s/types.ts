import type { AppError } from "../api/types";
import type { HelmChangeVariant } from "./helm/types";
import type { RbacChangeVariant, RbacEffect } from "./rbac/types";

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
  | { type: "cordon"; unschedulable: boolean }
  | { type: "drain" }
  | { type: "recreate"; object: Record<string, unknown> }
  /** 셸·attach를 연 기록(미리보기·적용 대상이 아니다) */
  | { type: "shell"; container: string; mode: "exec" | "attach" }
  /** 노드 셸 디버그 Pod 만들기. 대상(kind·namespace·name)은 만들 Pod, node는 고정할 노드 */
  | { type: "nodeShell"; node: string; image: string }
  /** YAML 객체 하나를 server-side apply(field manager magic-mirror). force는 다른 manager의 필드까지 가져온다 */
  | { type: "apply"; object: Record<string, unknown>; force: boolean }
  /** Helm 릴리스 변경(대상은 릴리스). 같은 미리보기·적용·되돌리기 틀을 거친다 */
  | HelmChangeVariant
  /** RBAC 바인딩·EKS access entry 변경 */
  | RbacChangeVariant
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

/** drain 미리보기의 옮길 Pod 하나 */
export interface K8sDrainPod {
  namespace: string;
  name: string;
  uid: string;
  emptyDir: boolean;
  unmanaged: boolean;
  /** 허용량이 0인 PodDisruptionBudget의 이름 */
  blockedBy: string | null;
  /** terminationGracePeriodSeconds */
  graceSeconds: number;
}

export interface K8sSkippedPod {
  namespace: string;
  name: string;
  reason: "daemonSet" | "mirror" | "terminating";
}

export interface K8sDrainPlan {
  nodeCordoned: boolean;
  evict: K8sDrainPod[];
  skipped: K8sSkippedPod[];
  budgetsUnknown: boolean;
}

/** server-side apply에서 다른 manager가 가진 필드 */
export interface K8sFieldConflict {
  field: string;
  manager: string;
}

export interface K8sPreview {
  calls: K8sApiCall[];
  diff: K8sFieldDiff[];
  impact: string[];
  warnings: string[];
  confirmName: string | null;
  reversible: boolean;
  /** drain일 때만 온다 */
  drain?: K8sDrainPlan | null;
  /** 비어 있지 않으면 강제 적용(force)으로 다시 미리보기 하기 전에는 적용할 수 없다 */
  conflicts: K8sFieldConflict[];
  /** RBAC·access entry 변경에서만 온다: 실효 권한 계산이 보는 누가 무엇을 얻고 잃는지 */
  effect?: RbacEffect | null;
}

/** terminating: Eviction은 받아들여졌고 Pod가 사라지기를 기다림. lingering: 유예와 여유가 지나도 남아 있음 */
export type K8sDrainPodState = "pending" | "evicting" | "evicted" | "blocked" | "terminating" | "lingering" | "failed";

export interface K8sDrainCounts {
  total: number;
  pending: number;
  evicting: number;
  evicted: number;
  blocked: number;
  terminating: number;
  lingering: number;
  failed: number;
}

export type K8sDrainOutcome = "completed" | "stopped" | "timedOut" | "failed" | "lingering";

/** `k8s_drain` 채널 메시지. `finished`가 마지막이다. */
export type K8sDrainMessage =
  | { type: "started"; pods: K8sDrainPod[]; counts: K8sDrainCounts }
  | { type: "cordoned" }
  | { type: "pod"; namespace: string; name: string; state: K8sDrainPodState; error: string | null; counts: K8sDrainCounts }
  | { type: "finished"; outcome: K8sDrainOutcome; counts: K8sDrainCounts; error: AppError | null };

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
  /** 셸·attach·노드 셸 세션을 닫은 시각(세션 기록만) */
  closedAt?: string | null;
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

/** k8s_logs·k8s_workload_logs 옵션(백엔드 LogOptions) */
export interface K8sLogOptions {
  /** null이면 그 Pod의 모든(init이 아닌) 컨테이너 */
  container: string | null;
  follow: boolean;
  /** 처음에 받을 줄 수(컨테이너마다) */
  tailLines: number;
  previous: boolean;
  /** 최근 N초만. null이면 제한 없음(tailLines만) */
  sinceSeconds: number | null;
}

/** 로그 한 줄. ts는 서버가 붙인 시각(RFC 3339, 나노초까지). 백엔드는 늘 timestamps=true로 받아 앞의 시각을 떼어 낸다 */
export interface K8sLogLine {
  ts: string | null;
  text: string;
}

/**
 * k8s_logs·k8s_workload_logs 채널. 줄은 어느 Pod·컨테이너의 것인지와 함께 온다.
 * source: 워크로드 로그에서 Pod·컨테이너 흐름이 붙거나(attached) 끝날 때(ended).
 * error에 pod가 있으면 그 흐름만 실패한 것이고 나머지는 계속된다. pod가 없거나 end면 전체가 끝난다.
 * notice: 흐름을 다 붙이지 못했을 때 등(예: Pod가 너무 많음).
 */
export type K8sLogMessage =
  | { type: "lines"; pod: string; container: string; lines: K8sLogLine[] }
  | { type: "source"; pod: string; container: string; state: "attached" | "ended" }
  | { type: "notice"; message: string }
  | { type: "error"; error: AppError; pod: string | null; container: string | null }
  | { type: "end" };

/** k8s_shell_open·k8s_attach_open 채널. exit에서 세션이 끝난다(code가 없으면 연결이 끊겼거나 시작하지 못한 것, 시작하지 못했으면 reason). */
export type K8sShellMessage = { type: "output"; data: string } | { type: "exit"; code: number | null; reason: string | null };

/** 열린 셸·attach. input: 이 세션이 키 입력을 받는지(attach는 컨테이너에 stdin과 tty가 켜져 있어야 한다) */
export interface K8sShellOpened {
  id: number;
  input: boolean;
}

export type K8sShellMode = "exec" | "attach" | "node";

export type K8sForwardKind = "pod" | "service";

export interface K8sForwardRequest {
  namespace: string;
  kind: K8sForwardKind;
  name: string;
  /** Pod는 컨테이너 포트, Service는 Service 포트 */
  remotePort: number;
  /** 없으면 자동 */
  localPort: number | null;
}

/** 열린 port-forward. 로컬은 늘 127.0.0.1 */
export interface K8sForward {
  id: number;
  localPort: number;
  target: K8sTarget;
  namespace: string;
  kind: K8sForwardKind;
  name: string;
  remotePort: number;
  /** 지금 붙어 있는 Pod(Service는 바뀔 수 있고, 준비된 Pod가 없으면 null) */
  pod: string | null;
  /** 가장 최근 연결 실패의 사유 */
  error: string | null;
}

/** port-forward로 고를 수 있는 TCP 포트(Pod는 컨테이너 포트, Service는 Service 포트) */
export interface K8sPort {
  name: string | null;
  port: number;
  /** Pod: 이 포트를 가진 컨테이너 */
  container: string | null;
  /** Service: Pod로 가는 포트(번호 또는 이름) */
  target: string | null;
}

export type K8sProblem = "crashLoopBackOff" | "imagePullBackOff" | "pending" | "oomKilled" | "notReady" | "scalingBlocked" | "noDisruptions" | "quotaExceeded" | "notEstablished";

export interface K8sKind extends K8sKindRef {
  verbs: string[];
  /** 내장 API 그룹이 아닌 종류(사용자 정의 리소스) */
  custom: boolean;
  /** API 서버가 알려 주는 짧은 이름(`po`, `deploy`). 백엔드는 늘 보내고(못 읽었으면 빈 목록), 시험 자료는 생략해도 된다 */
  shortNames?: string[];
  /** API 서버가 알려 주는 단수 이름(`pod`). 못 읽었으면 빈 문자열 */
  singularName?: string;
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
  /** 요청·제한(없으면 null). 컨테이너의 사용량과 견준다 */
  cpuRequest?: number | null;
  cpuLimit?: number | null;
  memoryRequest?: number | null;
  memoryLimit?: number | null;
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
  /** 편집기에 넣는 YAML: 서버가 채우는 필드를 뺐고, Secret은 data·stringData도 뺐다 */
  editYaml: string;
  /** Secret일 때만 */
  secretKeys: K8sSecretKey[] | null;
  /** Pod와 Service만(TCP). 없는 응답은 빈 목록으로 본다 */
  ports?: K8sPort[];
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
  /** 노드 전체 용량(status.capacity) */
  capacity: K8sResources;
  allocatable: K8sResources;
  requested: K8sResources;
  /** 놓인 Pod의 제한 합. 제한 없는 컨테이너는 0으로 센다 */
  limits: K8sResources;
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

/** metrics-server에서 사용량을 읽지 못하는 까닭(없음·권한 없음·응답 없음) */
export type K8sMetricsUnavailable = "notInstalled" | "forbidden" | "notReady";

export interface K8sContainerUsage {
  name: string;
  cpuMilli: number;
  memoryBytes: number;
}

export interface K8sOwnerRef {
  kind: string;
  name: string;
}

export interface K8sPodUsage {
  namespace: string;
  name: string;
  cpuMilli: number;
  memoryBytes: number;
  containers: K8sContainerUsage[];
  /** 컨트롤러 사슬: 가까운 것부터 맨 위까지(ReplicaSet, Deployment) */
  owners: K8sOwnerRef[];
}

export interface K8sNodeUsage {
  name: string;
  cpuMilli: number;
  memoryBytes: number;
}

/** k8s_metrics. Pod와 노드는 따로 읽어, 한쪽만 막혀도 다른 쪽은 보인다 */
export interface K8sMetrics {
  podsUnavailable: K8sMetricsUnavailable | null;
  nodesUnavailable: K8sMetricsUnavailable | null;
  pods: K8sPodUsage[];
  nodes: K8sNodeUsage[];
}
