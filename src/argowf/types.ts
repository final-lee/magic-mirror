import type { AppError } from "../api/types";

/** 설정에 저장하는 Argo Server. context가 있으면 그 kubeconfig context의 자격 증명으로, 없으면 키체인의 API 토큰으로 붙는다. */
export interface ArgoWfServer {
  name: string;
  url: string;
  context: string | null;
  /** 이 네임스페이스만 본다(권한이 좁은 신원, managed namespace 서버). null이면 모든 네임스페이스. 서버 info의 managedNamespace가 있으면 그것이 이긴다 */
  namespace?: string | null;
  /** 목록에 더 보일 레이블 열(키). 서버 info의 columns 뒤에 붙는다 */
  labelColumns?: string[];
}

/** 서버 하나의 Workflows 화면 기억(설정에 서버 주소별로). 검색어·날짜는 남기지 않는다. */
export interface ArgoWfViewState {
  phases: string[];
  namespaces: string[];
  sources: string[];
  /** 레이블 필터(`key=value`·`key`), 같은 키는 OR 다른 키는 AND(ArgoCD 레이블 필터와 같다) */
  labels?: string[];
  /** 내가 만든 것만(creator 레이블이 세션 신원과 같은 것) */
  mine?: boolean;
}

/** 명령에 넘기는 서버. 백엔드는 이 값으로 인증 방식을 정한다. */
export interface ArgoWfServerRef {
  url: string;
  context: string | null;
}

/** 화면이 들고 다니는 연결: 서버 + exec 플러그인의 AWS 프로필(SSO 만료를 그 프로필로 알린다). */
export interface ArgoWfConn extends ArgoWfServerRef {
  ssoProfile: string | null;
}

export interface ArgoWfSession {
  url: string;
  version: string;
  /** userinfo의 email·subject, 없으면 context 이름, 그것도 없으면 "토큰" */
  identity: string;
  auth: "context" | "token";
  /** 같은 context로 쿠버네티스 API를 읽을 수 있나(이벤트, IAM 역할) */
  kube: boolean;
  /** context의 exec 플러그인이 쓰는 AWS 프로필. 없으면 null */
  ssoProfile: string | null;
}

export interface KubeContext {
  name: string;
  cluster: string;
  server: string | null;
  /** 이 context의 exec 플러그인이 쓰는 AWS 프로필(SSO 만료를 처음 연결부터 알리려고). 없으면 null */
  ssoProfile: string | null;
}

/** 서버가 알려 주는 UI 설정(`GET /api/v1/info`). 없는 칸은 빈 값 */
export interface ArgoWfInfo {
  managedNamespace: string | null;
  links: ArgoWfLink[];
  columns: ArgoWfColumn[];
}

/** 컨트롤러 설정의 links. scope: workflow, pod, pod-logs, event-source-logs, sensor-logs, workflow-list, chat … url의 `${metadata.name}` 같은 자리는 화면이 채운다 */
export interface ArgoWfLink {
  name: string;
  scope: string;
  url: string;
}

/** 컨트롤러 설정의 columns: 목록에 더 보일 레이블·어노테이션 열 */
export interface ArgoWfColumn {
  name: string;
  type: "label" | "annotation";
  key: string;
}

/** `GET /api/v1/userinfo`. 서버 인증 방식에 따라 대부분 비어 있을 수 있다 */
export interface ArgoWfUserInfo {
  issuer: string | null;
  subject: string | null;
  groups: string[];
  email: string | null;
  emailVerified: boolean | null;
  serviceAccountName: string | null;
  serviceAccountNamespace: string | null;
}

/** Workflow·보관함 목록 조건. 서버가 거르는 것(네임스페이스, 레이블, 이름, 날짜, phase)과 페이지 */
export interface WfListQuery {
  /** null이면 모든 네임스페이스 */
  namespace: string | null;
  /** 쿠버네티스 레이블 선택자(`a=b,c in (d)`) */
  labelSelector: string | null;
  /** 이름 조건. exact·prefix는 서버가, contains는 서버의 nameFilter가 지원하면 서버가 */
  name: { mode: "exact" | "prefix" | "contains"; value: string } | null;
  /** RFC3339 */
  createdAfter: string | null;
  finishedBefore: string | null;
  /** 서버에서 거를 phase(`workflows.argoproj.io/phase` 레이블). 비면 전부 */
  phases: string[];
  limit: number;
  continueToken: string | null;
}

export interface WfPage {
  rows: WfRow[];
  /** 다음 페이지 토큰. 없으면 마지막 */
  continueToken: string | null;
  /** 감시를 이어 붙일 resourceVersion(살아 있는 목록만) */
  resourceVersion: string | null;
}

/** argowf_watch 채널: 목록 감시(`/api/v1/workflow-events`). error·end에서 끝나고, 화면은 폴링으로 돌아갔다가 다시 붙는다 */
export type WfWatchEvent =
  { type: "upsert"; row: WfRow } | { type: "delete"; uid: string; namespace: string; name: string } | { type: "error"; error: AppError } | { type: "end" };

/** argowf_watch_workflow 채널: Workflow 하나의 상세 감시 */
export type WfDetailWatchEvent = { type: "detail"; detail: WfDetail } | { type: "deleted" } | { type: "error"; error: AppError } | { type: "end" };

export type WfPhase = "Pending" | "Running" | "Succeeded" | "Failed" | "Error" | "";

export interface WfRow {
  namespace: string;
  name: string;
  uid: string;
  resourceVersion: string;
  phase: WfPhase;
  message: string | null;
  /** "3/7" */
  progress: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** workflows.argoproj.io/cron-workflow 레이블 */
  cron: string | null;
  /** workflows.argoproj.io/workflow-template 또는 cluster-workflow-template 레이블 */
  template: string | null;
  clusterTemplate: boolean;
  /** creator-email, 없으면 creator 레이블 */
  creator: string | null;
  suspended: boolean;
  /** 워크플로 수준의 spec.activeDeadlineSeconds(템플릿마다의 제한은 상세에서) */
  activeDeadlineSeconds: number | null;
  /** 보관함에만 있는 Workflow(목록 API가 아카이브를 섞어 준다). 상세·동작은 보관함 경로로 간다 */
  archived: boolean;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  createdAt: string | null;
  /** status.estimatedDuration(초). 실행 중 진행 막대에 쓴다 */
  estimatedDuration: number | null;
}

export interface WfParam {
  name: string;
  value: string | null;
  /** 파라미터 정의의 기본값·선택지·설명(suspend 노드의 출력처럼 정의가 따라오는 경우). 없으면 빠진다 */
  default?: string | null;
  enum?: string[];
  description?: string | null;
}

export interface WfNode {
  id: string;
  name: string;
  displayName: string;
  /** Pod, Steps, StepGroup, DAG, TaskGroup, Retry, Skipped, Suspend, Container … */
  type: string;
  phase: string;
  message: string | null;
  templateName: string | null;
  templateScope: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  children: string[];
  boundaryId: string | null;
  /** Pod 노드만 */
  podName: string | null;
  exitCode: string | null;
  inputs: WfParam[];
  outputs: WfParam[];
  artifacts: WfArtifact[];
  /** Pod가 돈 노드(쿠버네티스 노드) */
  hostNodeName: string | null;
  /** memoize 캐시를 썼으면 그 결과 */
  memoization: { hit: boolean; key: string; cacheName: string } | null;
  /** 이 노드 템플릿의 컨테이너(init·main·sidecar). script 템플릿도 main으로 */
  containers: WfContainer[];
  /** 실행 중일 때 예상 걸린 시간(초) */
  estimatedDuration: number | null;
  resourcesDuration: Record<string, number>;
}

export interface WfArtifact {
  name: string;
  /** 입력 또는 출력 */
  direction: "input" | "output";
  /** 저장소 안의 키(s3 key 등). 모르면 null */
  key: string | null;
  /** 저장소 종류(s3, gcs, http, git, raw …). 모르면 null */
  repository: string | null;
}

export interface WfContainer {
  name: string;
  /** init | main | sidecar */
  role: string;
  image: string | null;
  command: string[];
  args: string[];
  workingDir: string | null;
  /** 이름만(값은 YAML 탭에서) */
  env: string[];
  requests: Record<string, string>;
  limits: Record<string, string>;
  volumeMounts: string[];
}

export interface WfSynchronization {
  kind: "mutex" | "semaphore";
  key: string;
  holding: string[];
  waiting: string[];
}

export interface WfDetail {
  row: WfRow;
  nodes: WfNode[];
  parameters: WfParam[];
  entrypoint: string | null;
  serviceAccount: string | null;
  activeDeadlineSeconds: number | null;
  podGC: string | null;
  ttl: string | null;
  conditions: { type: string; status: string; message: string | null }[];
  resourcesDuration: Record<string, number>;
  yaml: string;
  /** 워크플로 전역 출력(status.outputs.parameters) */
  outputs: WfParam[];
  /** 이 Workflow가 어디서 왔나: cron·템플릿·다시 제출·재시도·이벤트(레이블로 안다) */
  createdFrom: { kind: "cron" | "template" | "clusterTemplate" | "resubmit" | "event" | "workflow"; name: string }[];
  synchronization: WfSynchronization[];
}

export interface K8sEventRow {
  at: string | null;
  type: string;
  reason: string;
  message: string;
  object: string;
  count: number;
}

export interface WfLogLine {
  pod: string;
  text: string;
}

/** argowf_logs 채널. error와 end에서 흐름이 끝난다. */
export type WfLogMessage = { type: "lines"; lines: WfLogLine[] } | { type: "error"; error: AppError } | { type: "end" };

/** 로그 옵션(Argo 로그 API의 logOptions) */
export interface WfLogOptions {
  container: string;
  follow: boolean;
  tailLines: number | null;
  /** 직전(재시작 전) 컨테이너 */
  previous: boolean;
  sinceSeconds: number | null;
  timestamps: boolean;
}

export interface CronRow {
  namespace: string;
  name: string;
  schedules: string[];
  timezone: string | null;
  suspended: boolean;
  concurrencyPolicy: string | null;
  startingDeadlineSeconds: number | null;
  lastScheduledTime: string | null;
  /** 활성 Workflow 이름 */
  active: string[];
  succeeded: number | null;
  failed: number | null;
  /** RFC3339, 최대 5 */
  nextRuns: string[];
  missed: boolean;
  serviceAccount: string | null;
  hasDeadline: boolean;
  /** workflowSpec.workflowTemplateRef의 이름(없으면 null). 이 Cron이 어느 템플릿을 쓰는지 */
  template: string | null;
  clusterTemplate: boolean;
  labels: Record<string, string>;
}

export interface CronDetail {
  row: CronRow;
  entrypoint: string | null;
  template: string | null;
  parameters: WfParam[];
  yaml: string;
}

export type TemplateKind = "WorkflowTemplate" | "ClusterWorkflowTemplate";

export interface TemplateParam {
  name: string;
  value: string | null;
  enum: string[];
  description: string | null;
}

export interface TemplateRow {
  kind: TemplateKind;
  namespace: string | null;
  name: string;
  description: string | null;
  parameters: TemplateParam[];
  entrypoint: string | null;
  templates: string[];
  serviceAccount: string | null;
  hasDeadline: boolean;
}

export interface TemplateDetail {
  row: TemplateRow;
  yaml: string;
}

/** nodeFieldSelector: 노드 하나만(`id=<노드 id>`). null이면 워크플로 전체 */
export type WfAction =
  | { kind: "stop"; nodeFieldSelector: string | null; message: string | null }
  | { kind: "terminate" }
  | { kind: "suspend" }
  | { kind: "resume"; nodeFieldSelector: string | null }
  | { kind: "retry"; restartSuccessful: boolean; nodeFieldSelector: string | null; parameters: string[] }
  | { kind: "resubmit"; memoized: boolean; parameters: string[] }
  | { kind: "delete" }
  /** suspend 노드의 출력 파라미터를 넣는다(승인 단계에 값 넘기기). 보통 이어서 resume을 부른다 */
  | { kind: "setOutputs"; nodeFieldSelector: string; outputParameters: Record<string, string>; phase: "Succeeded" | "Failed" | null };

export type ArchivedAction =
  | { kind: "retry"; restartSuccessful: boolean; nodeFieldSelector: string | null; parameters: string[] }
  | { kind: "resubmit"; memoized: boolean; parameters: string[] }
  | { kind: "delete" };

export type CronAction = { kind: "suspend" } | { kind: "resume" } | { kind: "delete" } | { kind: "submit" };

/** 여러 Workflow를 한꺼번에 조작한 결과(하나씩 부르고, 실패해도 나머지는 계속한다) */
export interface WfBatchResult {
  namespace: string;
  name: string;
  ok: boolean;
  error: string | null;
  /** resubmit·retry가 새로 만든 Workflow */
  created: string | null;
}

/** 템플릿 실행 옵션(Argo submitOptions) */
export interface SubmitOptions {
  /** `이름=값` */
  parameters: string[];
  entryPoint: string | null;
  /** `a=b,c=d` */
  labels: string | null;
  generateName: string | null;
  serviceAccount: string | null;
  /** 서버에서 검사만 하고 만들지 않는다 */
  serverDryRun: boolean;
}

/** YAML 편집기로 만들고 고치는 대상 */
export type ManifestKind = "Workflow" | "WorkflowTemplate" | "ClusterWorkflowTemplate" | "CronWorkflow" | "EventSource" | "Sensor";

export interface LintResult {
  ok: boolean;
  /** 실패 이유(서버 메시지). 성공이면 null */
  message: string | null;
}

export interface ArtifactRef {
  target: WfTarget;
  nodeId: string;
  name: string;
  direction: "input" | "output";
}

/** 아티팩트 미리보기: 글(1MB까지)이나 이미지(5MB까지, base64). 더 크거나 바이너리면 둘 다 null이고 내려받기만 된다 */
export interface ArtifactPreview {
  contentType: string | null;
  size: number | null;
  text: string | null;
  imageBase64: string | null;
}

export interface EventBindingRow {
  namespace: string;
  name: string;
  /** spec.event.selector 식 */
  selector: string;
  template: { name: string; clusterScope: boolean } | null;
  /** `이름=값식` */
  parameters: string[];
}

export interface EventSourceRow {
  namespace: string;
  name: string;
  /** 이벤트 종류(webhook, sqs, sns, kafka, calendar …) */
  types: string[];
  /** 종류별 이벤트 이름 */
  eventNames: string[];
  /** 상태 조건 요약(Deployed 등). 모르면 null */
  status: string | null;
  message: string | null;
  yaml: string;
}

export interface SensorRow {
  namespace: string;
  name: string;
  dependencies: { name: string; eventSourceName: string; eventName: string }[];
  /** 트리거: 종류(argoWorkflow, k8s, http, log …)와 대상(만드는 리소스 종류·이름 또는 URL) */
  triggers: { name: string; type: string; target: string | null }[];
  status: string | null;
  message: string | null;
  yaml: string;
}

/** 실행기 플러그인(라벨 workflows.argoproj.io/configmap-type=ExecutorPlugin인 ConfigMap). context 연결에서만 읽는다 */
export interface PluginRow {
  namespace: string;
  name: string;
  description: string | null;
  image: string | null;
}

/** 상세로 열 대상 */
export type WfTarget = { kind: "live"; namespace: string; name: string } | { kind: "archived"; uid: string };
