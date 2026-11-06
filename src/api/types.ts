import type { K8sKindRef } from "../k8s/types";
import type { KvLoginSaved } from "../kv/types";
import type { ArgocdServer, ArgoViewState } from "../argocd/types";
import type { ArgoWfServer, ArgoWfViewState } from "../argowf/types";

export type ColumnKind = "text" | "mono" | "state" | "datetime" | "bytes";

export interface Column {
  key: string;
  label: string;
  kind: ColumnKind;
}

export interface ResourceType {
  id: string;
  name: string;
  columns: Column[];
}

export interface ServiceInfo {
  id: string;
  name: string;
  global: boolean;
  types: ResourceType[];
  /** 상세에 CloudWatch 지표를 붙이는 리소스 종류 */
  metricTypes?: string[];
}

/** 상세 지표의 기간 */
export type MetricRange = "1h" | "3h" | "12h" | "1d" | "3d" | "1w";
export type MetricUnit = "percent" | "bytes" | "count" | "seconds" | "milliseconds" | "microseconds" | "bytesPerSecond" | "countPerSecond";
export interface MetricSeries {
  /** 선 이름(복제 그룹의 노드 ID). 선이 하나면 빈 글 */
  label: string;
  /** Unix ms, 오래된 것부터 */
  times: number[];
  values: number[];
}
export interface MetricChart {
  metric: string;
  stat: string;
  unit: MetricUnit;
  series: MetricSeries[];
}
/** 리소스 상세의 CloudWatch 지표(resource_metrics) */
export interface ResourceMetrics {
  namespace: string;
  region: string;
  charts: MetricChart[];
  /** 점 사이 간격(초) */
  period: number;
  start: number;
  end: number;
  /** 하루 한 번 쌓이는 지표라 기간과 상관없이 최근 2주를 읽었다 */
  daily: boolean;
  /** 지표 대신 보이는 안내(클러스터 구성원 …) */
  note: string | null;
}

export interface Field {
  label: string;
  value: string;
}

export interface Resource {
  id: string;
  name: string;
  arn: string | null;
  values: Record<string, string>;
  tags: Record<string, string>;
  fields: Field[];
  raw: string;
  consoleUrl: string | null;
}

export interface ListResult {
  items: Resource[];
  truncated: boolean;
}

/** 디스크에 남기는 검색용 리소스: 원본(raw)과 상세 필드는 비밀값이 들어 있을 수 있어 남기지 않는다 */
export interface IndexedResource {
  id: string;
  name: string;
  arn: string | null;
  values: Record<string, string>;
  tags: Record<string, string>;
}

/** 한 번 읽은 리소스 목록(프로필·리전·종류 하나)의 검색용 사본. region은 전역 서비스면 "global" */
export interface IndexedList {
  region: string;
  service: string;
  typeId: string;
  /** 읽은 시각(unix ms) */
  fetchedAt: number;
  truncated: boolean;
  items: IndexedResource[];
}

export interface ProfileInfo {
  name: string;
  region: string | null;
  /** aws sso login에 넘길 프로필(자기 자신 또는 source_profile 체인의 SSO 프로필). SSO가 아니면 null */
  ssoLogin?: string | null;
  /** 같은 SSO 세션을 쓰는 프로필끼리 같은 값. SSO가 아니면 null */
  ssoKey?: string | null;
}

/** 즐겨찾기이자 사이드바 선택 상태 */
export interface Favorite {
  service: string;
  type: string;
}

/** 로컬 셸에서 실행할 EKS 플러그인. 확인 설정을 생략한 예전 항목은 확인한다. */
export interface K8sPlugin {
  name: string;
  description?: string | null;
  kinds: ("*" | K8sKindRef)[];
  command: string;
  confirm?: boolean;
  key?: string | null;
}

export interface Settings {
  enabledServices: string[];
  /** 앱이 이미 보여 준 서비스. 백엔드가 새 서비스를 한 번 켤 때 쓰고, 화면은 읽지 않고 그대로 돌려 저장한다. */
  knownServices?: string[];
  favorites: Favorite[];
  /** 첫 열에서 끌어 바꾼 서비스 순서. 비어 있으면 백엔드가 주는 순서이고, 여기 없는 서비스는 뒤에 붙는다. */
  sidebarServiceOrder?: string[];
  /** 서비스 ID → 그 서비스 아래 줄(리소스 종류 ID, `@`로 시작하는 바로가기)의 끌어 바꾼 순서 */
  sidebarTypeOrder?: Record<string, string[]>;
  lastProfile: string | null;
  lastRegion: string | null;
  explorerLocalPath?: string | null;
  diffTool?: "filemerge" | "vscode" | "custom" | null;
  diffToolCommand?: string | null;
  theme?: "system" | "light" | "dark";
  /** RDS 대상 ARN → 그 대상에 접속할 DB 사용자 이름. 대상마다 처음 열 때 묻고 여기에 기억한다. */
  pgLogins?: Record<string, string>;
  /** EKS 클러스터 ARN → 그 클러스터에 접속할 kubeconfig context 이름 */
  k8sContexts?: Record<string, string>;
  /** kubeconfig 파일 경로. 비우면 KUBECONFIG 또는 ~/.kube/config */
  kubeconfigPath?: string | null;
  /** EKS 탭 왼쪽 메뉴에 북마크한 리소스 종류. 북마크한 순서(드래그로 바꾼 순서)대로 둔다. */
  k8sBookmarks?: K8sKindRef[];
  /** EKS 탭 레인 너비(px). 비어 있으면 기본값 */
  k8sLaneWidths?: K8sLaneWidths;
  /** EKS 보안 점검: 끈 점검 항목과 시스템 네임스페이스 포함 여부. 비어 있으면 모두 켜고 시스템 네임스페이스는 뺀다 */
  k8sSecurityChecks?: K8sSecurityChecks;
  /** SNS 점검: 끈 점검 항목. 비어 있으면 모두 켠다 */
  snsChecks?: SnsChecks;
  k8sPlugins?: K8sPlugin[];
  /** ArgoCD API 서버 목록(이름과 주소). 토큰은 넣지 않는다(키체인에 있다). */
  argocdServers?: ArgocdServer[];
  /** ArgoCD 서버 주소 → 그 서버 목록에서 마지막으로 고른 필터·묶기 */
  argocdViews?: Record<string, ArgoViewState>;
  argoWorkflowsServers?: ArgoWfServer[];
  argoWorkflowsViews?: Record<string, ArgoWfViewState>;
  /** ElastiCache 대상 ARN → 그 대상에 마지막으로 연 로그인(방식·사용자·DB 번호). 비밀번호는 넣지 않는다(키체인에 있다). */
  kvLogins?: Record<string, KvLoginSaved>;
  /** ElastiCache 대상 ARN → 그 대상에서 Bull 큐를 찾는 prefix. 비어 있으면 "bull" */
  kvBullPrefixes?: Record<string, string>;
  /** Tailscale API를 쓸 테일넷 이름. 자격 증명은 키체인(계정 = 이 이름)에 있다. */
  tailscaleTailnet?: string | null;
  /** 리소스 목록 캐시가 오래됐다고 보는 시간(분). 비어 있으면 기본값(15분), 0이면 무제한 */
  resourceCacheTtlMinutes?: number | null;
}

/** 보안 점검 설정. disabled는 끈 점검 항목의 이름(`privileged`, `clusterAwsAuth` …) */
export interface K8sSecurityChecks {
  disabled: string[];
  includeSystem: boolean;
}

/** SNS 점검 설정. disabled는 끈 점검 항목의 id(`publicPolicy`, `httpEndpoint` …). 모든 주제에 같이 쓴다 */
export interface SnsChecks {
  disabled: string[];
}

/** 메뉴(1열)·종류(2열)는 px, 상세(4열)는 목록(3열) 너비에 대한 % */
export interface K8sLaneWidths {
  nav?: number | null;
  tree?: number | null;
  detailPct?: number | null;
}

export interface S3Entry {
  name: string;
  key: string;
  isFolder: boolean;
  size: number | null;
  lastModified: string | null;
  storageClass: string | null;
}

export interface S3Listing {
  entries: S3Entry[];
  nextToken: string | null;
}

export type AppError =
  | { kind: "ssoExpired" }
  | { kind: "accessDenied"; action: string }
  | { kind: "throttled" }
  | { kind: "network"; message: string }
  | { kind: "loginRequired"; message: string }
  | { kind: "other"; message: string };
