import type { K8sKindRef } from "../k8s/types";
import type { ArgocdServer, ArgoViewState } from "../argocd/types";

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

export interface Settings {
  enabledServices: string[];
  favorites: Favorite[];
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
  /** ArgoCD API 서버 목록(이름과 주소). 토큰은 넣지 않는다(키체인에 있다). */
  argocdServers?: ArgocdServer[];
  /** ArgoCD 서버 주소 → 그 서버 목록에서 마지막으로 고른 필터·묶기 */
  argocdViews?: Record<string, ArgoViewState>;
  /** 리소스 목록 캐시가 오래됐다고 보는 시간(분). 비어 있으면 기본값(15분), 0이면 무제한 */
  resourceCacheTtlMinutes?: number | null;
}

/** 보안 점검 설정. disabled는 끈 점검 항목의 이름(`privileged`, `clusterAwsAuth` …) */
export interface K8sSecurityChecks {
  disabled: string[];
  includeSystem: boolean;
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
  | { kind: "other"; message: string };
