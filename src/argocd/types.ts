/** 설정에 저장하는 ArgoCD 서버(이름과 주소). 토큰은 키체인에만 있고 여기에 없다. */
export interface ArgocdServer {
  name: string;
  url: string;
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
}

/** 토큰으로 확인한 로그인 상태 */
export interface ArgocdSession {
  url: string;
  username: string;
  version: string;
}

/** 목록의 한 줄. values 키: sync, health, project, destination, destNamespace, revision, targetRevision, operation, lastSync, autoSync, appSet, errors, warnings (없으면 키가 없다) */
export interface ArgoAppRow {
  name: string;
  namespace: string;
  resourceVersion: string;
  values: Record<string, string>;
  /** Application의 metadata.labels(레이블 필터·묶기·환경 추정에 쓴다) */
  labels: Record<string, string>;
}

export interface ArgoAppSetRow {
  name: string;
  namespace: string;
  /** Error | UpToDate | null */
  status: string | null;
  /** status가 Error일 때의 메시지 */
  message: string | null;
  generators: string[];
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
  kind: string;
  namespace: string | null;
  name: string;
  status: string | null;
  message: string | null;
  hookPhase: string | null;
}

export interface ArgoOperation {
  phase: string | null;
  message: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** username, 자동이면 "automated" */
  initiatedBy: string | null;
  revisions: string[];
  /** syncResult.resources 중 status가 Synced가 아닌 것만, 최대 100 */
  failedResults: ArgoResourceResult[];
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

/** argocd_sync 옵션 */
export interface ArgoSyncOptions {
  prune: boolean;
  dryRun: boolean;
}
