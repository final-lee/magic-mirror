import type { AppError } from "../../api/types";

// 백엔드 계약(camelCase)과 같은 모양이다(src-tauri/src/k8s/access).

export type SubjectKind = "user" | "group" | "serviceAccount" | "iam";

export interface Subject {
  kind: SubjectKind;
  name: string;
  /** ServiceAccount만 가진다 */
  namespace: string | null;
}

export interface Rule {
  verbs: string[];
  apiGroups: string[];
  resources: string[];
  resourceNames: string[];
  nonResourceUrls: string[];
}

export type Via =
  | { kind: "direct" }
  | { kind: "group"; group: string }
  | { kind: "defaultGroup"; group: string }
  | { kind: "accessPolicy"; policy: string }
  | { kind: "builtin"; group: string };

export interface BindingRef {
  /** RoleBinding 또는 ClusterRoleBinding */
  kind: string;
  namespace: string | null;
  name: string;
}

export interface RoleView {
  kind: "Role" | "ClusterRole";
  namespace: string | null;
  name: string;
}

export interface GrantSource {
  via: Via;
  binding: BindingRef | null;
  role: RoleView | null;
  aggregatedFrom: string | null;
  sessionDependent: boolean;
}

export interface Grant {
  /** null이면 클러스터 전체 */
  namespace: string | null;
  rule: Rule;
  source: GrantSource;
}

/** 요청 하나. namespace가 null이면 클러스터 범위 요청이다. */
export interface AccessQuery {
  verb: string;
  group: string;
  resource: string;
  subresource: string | null;
  namespace: string | null;
  name: string | null;
}

// ── 신원 연결 ──

export type AuthMode = "api" | "apiAndConfigMap" | "configMap";

export type PolicyScope = { kind: "cluster" } | { kind: "namespaces"; namespaces: string[] };

export interface PolicyGrant {
  policyArn: string;
  policyName: string;
  /** 대응하는 ClusterRole. null이면 평가하지 못함 */
  role: string | null;
  scope: PolicyScope;
}

export interface IdentityMapping {
  source: "accessEntry" | "awsAuth";
  principalArn: string;
  kind: "role" | "user" | "other";
  username: string;
  groups: string[];
  accessType: string | null;
  policies: PolicyGrant[];
  permissionSet: string | null;
  label: string;
  effective: boolean;
  inactiveReason: string | null;
}

export interface MappingRow extends IdentityMapping {
  subject: Subject | null;
  /** 클러스터 전체 열의 일곱 칸(CELLS 순서) */
  levels: number[] | null;
  unevaluated: string[];
}

export interface SsoGroup {
  permissionSet: string;
  principals: string[];
}

export type AccessSection = "cluster" | "accessEntries" | "awsAuth" | "rbac" | "namespaces" | "serviceAccounts" | "pods" | "podIdentity" | "iamRoles";

export interface AccessGap {
  section: AccessSection;
  error: AppError;
}

export interface AccessView {
  authMode: string | null;
  mode: AuthMode | null;
  mappings: MappingRow[];
  ssoGroups: SsoGroup[];
  awsAuth: { present: boolean; accounts: string[]; errors: string[] };
  namespaces: string[];
  subjectCount: number;
  dangling: { binding: BindingRef; role: RoleView }[];
  rbacAvailable: boolean;
  gaps: AccessGap[];
  fetchedAt: string;
}

// ── 권한 표 ──

export type Cell = "read" | "write" | "delete" | "exec" | "secretRead" | "rbacWrite" | "escalate";

export interface MatrixQuery {
  /** 비면 모든 종류 */
  kinds: SubjectKind[];
  text: string;
  /** 열: null은 클러스터 전체 */
  namespaces: (string | null)[];
  offset: number;
  limit: number;
}

export interface MatrixRow {
  subject: Subject;
  label: string | null;
  /** 열마다 일곱 칸(0 없음, 1 일부, 2 전부) */
  levels: number[][];
}

export interface MatrixPage {
  total: number;
  rows: MatrixRow[];
}

export interface ProbeResult {
  query: AccessQuery;
  allowed: boolean;
  namesOnly: boolean;
  direct: boolean;
  grants: Grant[];
}

export interface CellDetail {
  subject: Subject;
  namespace: string | null;
  cell: Cell;
  level: number;
  probes: ProbeResult[];
}

// ── 누가 할 수 있나 ──

export interface WhoCan {
  subject: Subject;
  label: string | null;
  grants: Grant[];
}

export interface WhoCanView {
  entries: WhoCan[];
  total: number;
}

export interface ReviewResult {
  allowed: boolean;
  denied: boolean;
  reason: string | null;
}

// ── 워크로드 신원 ──

export type Check = { kind: "works" } | { kind: "broken"; reasons: string[] } | { kind: "unknown"; message: string };

export interface IrsaView {
  roleArn: string;
  audience: string;
  check: Check;
}

export interface PodIdentityView {
  associationId: string;
  roleArn: string;
  targetRoleArn: string | null;
  check: Check;
}

export interface WorkloadIdentity {
  namespace: string;
  serviceAccount: string;
  exists: boolean;
  irsa: IrsaView | null;
  podIdentity: PodIdentityView | null;
  pods: string[];
  podCount: number;
  notes: string[];
}

export interface WorkloadView {
  items: WorkloadIdentity[];
  oidcIssuer: string | null;
  truncated: boolean;
  gaps: AccessGap[];
}
