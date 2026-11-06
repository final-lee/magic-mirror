import type { TextDiff } from "./change/types";

/** 서버 하나의 macOS 알림 설정. envs가 비면 모든 환경 */
export interface ArgocdNotify {
  enabled: boolean;
  envs: string[];
  /** OutOfSync가 이만큼(분) 이어지면 알린다 */
  outOfSyncMinutes: number;
}

/** 설정에 저장하는 ArgoCD 서버(이름과 주소). 토큰은 키체인에만 있고 여기에 없다. kubeContext는 서버가 자기 클러스터(in-cluster)를 가리킬 때 붙을 kubeconfig context. argocdNamespace는 ArgoCD가 설치된 네임스페이스(기본 argocd). */
export interface ArgocdServer {
  name: string;
  url: string;
  kubeContext?: string;
  argocdNamespace?: string;
  notify?: ArgocdNotify;
}

/** 서버 하나의 목록 화면 상태(설정에 서버 주소별로 남긴다). 묶기 기준은 GroupDim 글, 레이블은 `key=value`·`key`. 검색어는 남기지 않는다. */
export interface ArgoViewState {
  sync: string[];
  health: string[];
  envs: string[];
  clusters: string[];
  projects: string[];
  labels: string[];
  groupBy: string | null;
  thenBy: string | null;
  /** 마지막으로 연 화면(ARGO_VIEWS의 id). 없으면 첫 화면 */
  view?: string | null;
}

/** 토큰으로 확인한 로그인 상태 */
export interface ArgocdSession {
  url: string;
  username: string;
  version: string;
}

export interface ArgoEvent {
  at: string; server: string; namespace: string; app: string;
  kind: "sync" | "health" | "operation";
  from: string | null; to: string | null; revision: string | null;
  phase: string | null; startedAt: string | null; finishedAt: string | null;
  initiatedBy: string | null; message: string | null;
}

export type ArgoWatchEvent<T> =
  | { type: "upsert"; row: T }
  | { type: "delete"; namespace: string; name: string }
  | { type: "event"; event: ArgoEvent }
  | { type: "error"; error: unknown }
  | { type: "end" };
export type ArgoTreeWatchEvent = { type: "tree"; nodes: ArgoTreeNode[] } | { type: "error"; error: unknown } | { type: "end" };

/** 목록의 한 줄. values 키: sync, health, project, destination, destNamespace, revision, targetRevision, operation, lastSync, autoSync, selfHeal, autoPrune, appSet, errors, warnings (없으면 키가 없다) */
export interface ArgoAppRow {
  name: string;
  namespace: string;
  resourceVersion: string;
  values: Record<string, string>;
  /** Application의 metadata.labels(레이블 필터·묶기·환경 추정에 쓴다) */
  labels: Record<string, string>;
  /** status.resources 요약(전체 리소스 색인용). 리소스가 없는 앱은 키가 없다 */
  resources?: ArgoResourceRef[];
  /** 앱이 쓰는 컨테이너 이미지(status.summary.images). 이미지가 없는 앱은 키가 없다 */
  images?: string[];
}

/** 목록 행에 실린 리소스 한 개. hook·requiresPruning은 참일 때만, namespace·status·health는 있을 때만 있다 */
export interface ArgoResourceRef {
  group: string;
  version: string;
  kind: string;
  namespace?: string;
  name: string;
  /** Sync 상태 */
  status?: string;
  health?: string;
  hook?: boolean;
  requiresPruning?: boolean;
}

/** 상세에서 미리 골라 둘 리소스(group·kind·namespace·name으로 가린다) */
export interface ArgoResourceFocus {
  group: string;
  kind: string;
  namespace: string | null;
  name: string;
}

/** 다른 화면(리소스 검색·⌘K)에서 앱 목록 화면에 "이 앱을 열어 주세요"라고 보내는 요청. nonce는 같은 곳을 다시 열어도 새 요청으로 보이게 한다. */
export interface ArgoOpenRequest {
  namespace: string;
  name: string;
  resource: ArgoResourceFocus | null;
  tab?: "history";
  nonce: number;
}

/** ⌘K에서 ArgoCD 탭으로 보내는 요청: 이 서버의 이 앱(과 리소스)을 열어 달라는 뜻. 새 요청마다 새 객체로 만든다. */
export interface ArgoJump {
  url: string;
  namespace: string;
  name: string;
  resource: ArgoResourceFocus | null;
}

export interface ArgoAppSetRow {
  name: string;
  namespace: string;
  /** Error | UpToDate | null */
  status: string | null;
  /** status가 Error일 때의 메시지 */
  message: string | null;
  /** 오류 상태가 시작된 시각 */
  errorSince: string | null;
  generators: string[];
  /** generator가 다시 도는 간격 중 가장 짧은 것(초) */
  requeueSeconds: number | null;
  /** template의 프로젝트 */
  project: string | null;
}

export interface ArgoNetworkingInfo {
  targetLabels: Record<string, string>;
  targetRefs: { group: string; version: string; kind: string; namespace: string | null; name: string; uid: string | null }[];
  labels: Record<string, string>;
  ingress: { hostname: string | null; ip: string | null }[];
  externalURLs: string[];
}

export interface ArgoTreeNode {
  uid: string;
  group: string;
  version: string;
  kind: string;
  namespace: string | null;
  name: string;
  /** 부모 노드의 uid */
  parents: string[];
  health: string | null;
  healthMessage: string | null;
  /** "name: value" 목록 */
  info: string[];
  images: string[];
  networkingInfo?: ArgoNetworkingInfo | null;
  createdAt: string | null;
}

export interface ArgoDestination {
  server: string | null;
  name: string | null;
  namespace: string | null;
  /** server가 https://kubernetes.default.svc 이거나 name이 in-cluster */
  inCluster: boolean;
}

export interface ArgoSource {
  repoUrl: string;
  path: string | null;
  chart: string | null;
  targetRevision: string | null;
  ref: string | null;
  helmValueFiles: string[];
}

export interface ArgoSyncPolicy {
  automated: boolean;
  prune: boolean;
  selfHeal: boolean;
  options: string[];
}

export interface ArgoCondition {
  type: string;
  message: string;
  lastTransitionTime: string | null;
}

export interface ArgoResourceResult {
  group: string;
  version: string;
  kind: string;
  namespace: string | null;
  name: string;
  status: string | null;
  message: string | null;
  hookPhase: string | null;
  /** PreSync·Sync·PostSync·SyncFail·Skip 등 hook 종류. hook이 아니면 null */
  hookType: string | null;
  /** 이 리소스가 속한 단계(PreSync·Sync·PostSync·SyncFail) */
  syncPhase: string | null;
}

export interface ArgoOperation {
  phase: string | null;
  message: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** username, 자동이면 "automated" */
  initiatedBy: string | null;
  revisions: string[];
  /** 재시도한 횟수(처음 시도는 세지 않는다) */
  retryCount: number;
  /** 재시도 한도. 재시도 전략이 없으면 null */
  retryLimit: number | null;
  dryRun: boolean;
  prune: boolean;
  syncOptions: string[];
  /** syncResult.resources 중 status가 Synced가 아닌 것만, 최대 100 */
  failedResults: ArgoResourceResult[];
  /** syncResult.resources 전부(hook 포함), 최대 500 */
  results: ArgoResourceResult[];
}

/** Application.status.resources의 한 항목(Sync 상태만 있다. Health는 리소스 트리에서 온다) */
export interface ArgoResource {
  group: string;
  version: string;
  kind: string;
  namespace: string | null;
  name: string;
  status: string | null;
  hook: boolean;
  requiresPruning: boolean;
}

export interface ArgoHistory {
  id: number;
  revisions: string[];
  deployedAt: string | null;
  deployStartedAt: string | null;
  initiatedBy: string | null;
}

export interface ArgoApp {
  name: string;
  namespace: string;
  project: string | null;
  destination: ArgoDestination;
  sources: ArgoSource[];
  syncPolicy: ArgoSyncPolicy;
  syncStatus: string | null;
  syncRevisions: string[];
  health: string | null;
  healthMessage: string | null;
  images: string[];
  conditions: ArgoCondition[];
  operation: ArgoOperation | null;
  resources: ArgoResource[];
  /** 최신이 먼저, 최대 20 */
  history: ArgoHistory[];
  appSet: string | null;
  reconciledAt: string | null;
  /** metadata.annotations["argocd.argoproj.io/refresh"] (컨트롤러가 처리하면 사라진다) */
  refreshRequested: string | null;
  /** operationState.phase가 Running이면 true */
  operationInProgress: boolean;
  /** Application JSON 전체(YAML/JSON 탭) */
  raw: unknown;
}

/** 서버 리소스 하나를 가리키는 값(클러스터 범위 리소스는 namespace가 없다) */
export interface ResRef {
  group: string;
  version: string;
  kind: string;
  namespace?: string | null;
  name: string;
  uid?: string | null;
}

/** 리소스가 속한 Application(서버 요청의 appNamespace·project) */
export interface AppTarget {
  namespace: string;
  name: string;
  project: string;
}

/** 로그를 고를 수 있는 컨테이너 */
export interface ContainerRef {
  name: string;
  init: boolean;
}

/** 리소스 상세: live·desired YAML, 둘의 diff(desired가 있을 때만), 로그를 고를 컨테이너 */
export interface ResourceView {
  /** 클러스터에 없으면 null */
  live: string | null;
  /** Application의 목표 상태에 없으면 null */
  desired: string | null;
  diff: TextDiff | null;
  containers: ContainerRef[];
}

export interface ResourceEvent {
  type: string;
  reason: string;
  message: string;
  count: number;
  firstSeen: string | null;
  lastSeen: string | null;
  source: string | null;
}

/** 서버가 설정한 deep link(웹 주소만 온다) */
export interface LinkRow {
  title: string;
  url: string;
  description: string | null;
  iconClass: string | null;
}

/** 앱 Diff 탭의 한 줄: 정규화된 live와 적용 뒤 예상 상태(없으면 목표 상태)의 비교 */
export interface AppDiffRow {
  res: ResRef;
  syncStatus: string | null;
  health: string | null;
  hook: boolean;
  live: string;
  target: string;
  diff: TextDiff;
  changed: boolean;
}

export interface RevisionMetadata {
  author: string | null;
  date: string | null;
  message: string | null;
  tags: string[];
  signatureInfo: string | null;
}

export interface ChartDetails {
  description: string | null;
  home: string | null;
  maintainers: string[];
}

export interface OciMetadata {
  version: string | null;
  authors: string | null;
  createdAt: string | null;
  description: string | null;
  docsUrl: string | null;
  imageUrl: string | null;
  sourceUrl: string | null;
}

/** 이력 한 건의 소스 하나와 그 리비전. metadata·chartDetails·oci는 받지 못했거나 이 종류가 아니면 null */
export interface RevisionInfo {
  revision: string;
  sourceIndex: number;
  repoUrl: string | null;
  chart: string | null;
  path: string | null;
  targetRevision: string | null;
  metadata: RevisionMetadata | null;
  chartDetails: ChartDetails | null;
  oci: OciMetadata | null;
}

/** argocd_history의 한 건(최신이 먼저, 서버가 남긴 것 전부) */
export interface ArgoHistoryEntry {
  id: number;
  deployedAt: string | null;
  deployStartedAt: string | null;
  initiatedBy: string | null;
  revisions: RevisionInfo[];
}

export interface SyncWindow {
  /** allow | deny */
  kind: string;
  schedule: string;
  duration: string;
  manualSync: boolean;
}

export interface SyncWindows {
  canSync: boolean;
  active: SyncWindow[];
  assigned: SyncWindow[];
}

/** 렌더 결과의 리소스 하나와 sync wave(기본 0)·hook 종류 */
export interface ArgoWave {
  group: string;
  kind: string;
  namespace: string | null;
  name: string;
  wave: number;
  hook: string | null;
}

/** argocd_logs 요청. Pod 하나(podName)이거나 워크로드(kind·group·resourceName)다 */
export interface ArgoLogOptions {
  podName: string | null;
  container: string | null;
  kind: string | null;
  group: string | null;
  resourceName: string | null;
  /** 대상 리소스의 네임스페이스 */
  namespace: string;
  follow: boolean;
  previous: boolean;
  tailLines: number | null;
  sinceSeconds: number | null;
}
