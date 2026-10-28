// IAM 작업 공간 계약(docs/superpowers/specs/2026-10-26-iam-workspace-design.md "계약")과 1:1로 맞춘 타입.
// Tauri 명령/JSON 모양은 고정이다. 필드를 바꾸지 말고, 추가는 선택 필드로만 한다.

export type PrincipalKind = "user" | "group" | "role";
export type AccessLevel = "list" | "read" | "write" | "permissions" | "tagging";
export type Level = "danger" | "warn" | "info";
export type BadgeKind =
  | "admin"
  | "privesc"
  | "noMfa"
  | "oldKey"
  | "unusedKey"
  | "inactive"
  | "externalTrust"
  | "cfn"
  | "sso"
  | "serviceLinked"
  | "boundary"
  | "unattached"
  | "awsManaged";
export interface Badge {
  kind: BadgeKind;
  label: string;
  level: Level;
}

export interface IamOverview {
  accountId: string;
  caller: { arn: string; principalArn: string | null }; // principalArn: 호출자 IAM 사용자/역할 ARN(SSO 역할 포함), 알 수 없으면 null
  fetchedAt: string;
  users: PrincipalSummary[];
  groups: PrincipalSummary[];
  roles: PrincipalSummary[];
  policies: PolicySummary[]; // 고객 관리형 전체 + 붙어 있는 AWS 관리형
  findingCount: number;
  warnings: string[];
}
export interface PrincipalSummary {
  arn: string;
  name: string;
  kind: PrincipalKind;
  path: string;
  createdAt: string | null;
  lastUsed: string | null;
  policyCount: number;
  memberCount: number | null; // memberCount: 그룹만
  badges: Badge[];
  /** 직접 붙은 관리형 정책 ARN. 없으면 [] */
  attached?: string[];
  /** 사용자만: 속한 그룹 이름. 없으면 [] */
  groups?: string[];
  /** 권한 경계 정책 ARN */
  boundary?: string;
}
export interface PolicySummary {
  id: string;
  arn: string;
  name: string;
  scope: "aws" | "local";
  attachmentCount: number;
  defaultVersionId: string | null;
  updatedAt: string | null;
  badges: Badge[];
}
export interface PrincipalView {
  summary: PrincipalSummary;
  policies: AttachedPolicy[];
  groups: string[]; // 사용자: 소속 그룹 이름, 그룹: 구성원 사용자 이름, 역할: []
  trust: TrustEntry[]; // 역할만
  services: ServicePermissions[]; // 허용/조건부/거부가 하나라도 있는 서비스, 이름순
  adminLike: boolean;
  unknownActions: string[];
  tags: Record<string, string>;
  notes: string[];
}
export interface AttachedPolicy {
  id: string;
  name: string;
  kind: "managed" | "inline" | "boundary";
  scope: "aws" | "local" | null;
  via: string | null; // 그룹에서 상속되면 그룹 이름
  badges: Badge[];
  detachable: boolean;
}
export interface ServicePermissions {
  prefix: string;
  name: string;
  levels: Record<AccessLevel, LevelCell>;
  danger: boolean;
}
export interface LevelCell {
  total: number;
  allowed: number;
  conditional: number;
  denied: number; // denied = denied + boundary
}
export interface ActionGrant {
  action: string;
  status: "allowed" | "conditional" | "denied" | "boundary";
  resources: string[];
  sources: GrantSource[];
  danger: string | null;
}
export interface GrantSource {
  policyId: string;
  policyName: string;
  via: string | null;
  effect: "Allow" | "Deny";
  sid: string | null;
  statementIndex: number;
  conditional: boolean;
  boundary: boolean;
}
export interface TrustEntry {
  kind: "service" | "account" | "federated" | "anyone" | "principal";
  value: string;
  actions: string[];
  conditional: boolean;
  external: boolean;
  warning: string | null;
}
export interface PolicyView {
  id: string;
  name: string;
  scope: "aws" | "local" | "inline";
  arn: string | null;
  document: string;
  statements: StatementView[];
  versions: { id: string; isDefault: boolean; createdAt: string | null }[];
  attachedTo: { arn: string; name: string; kind: PrincipalKind }[];
  editable: boolean;
  badges: Badge[];
}
export interface StatementView {
  sid: string | null;
  effect: "Allow" | "Deny";
  notAction: boolean;
  actionPatterns: string[];
  services: { prefix: string; name: string; levels: AccessLevel[]; count: number }[];
  notResource: boolean;
  resources: string[];
  conditions: string[]; // "aws:SourceIp · IpAddress · 10.0.0.0/8"
}
export interface WhoCanResult {
  action: string;
  resource: string | null;
  hits: WhoCanHit[];
  notes: string[];
}
export interface WhoCanHit {
  principal: PrincipalSummary;
  status: "allowed" | "conditional" | "denied" | "boundary";
  sources: GrantSource[];
}
export interface SimulateResult {
  principalArn: string;
  decision: "allowed" | "explicitDeny" | "implicitDeny";
  matchedStatements: string[];
  missingContext: string[];
}
export type FindingKind =
  | "rootAccessKey"
  | "rootNoMfa"
  | "consoleNoMfa"
  | "oldAccessKey"
  | "unusedAccessKey"
  | "inactiveUser"
  | "inactiveRole"
  | "adminPrincipal"
  | "privescPrincipal"
  | "externalTrust"
  | "unattachedPolicy";
export interface Findings {
  generatedAt: string | null;
  groups: FindingGroup[]; // groups: 위 표 순서, 빈 그룹도 포함(items: [])
  warnings: string[];
}
export interface FindingGroup {
  kind: FindingKind;
  title: string;
  level: Level;
  items: FindingItem[];
}
export interface FindingItem {
  targetArn: string;
  targetName: string;
  detail: string;
  cli: string | null;
  fix: IamChange | null;
}
export interface AccessKeyInfo {
  id: string;
  status: "Active" | "Inactive";
  createdAt: string | null;
  ageDays: number | null;
  lastUsedAt: string | null;
  lastUsedService: string | null;
  lastUsedRegion: string | null;
  /** 마지막 사용을 읽지 못함(권한 없음 등). 이때 lastUsed* 값이 비어 있어도 "사용 기록 없음"이 아니다 */
  lastUsedUnknown?: boolean;
}
export interface LastAccessed {
  completedAt: string | null;
  trackingDays: number;
  services: {
    prefix: string;
    name: string;
    lastUsed: string | null;
    actions: { action: string; lastUsed: string | null }[] | null;
  }[];
  unusedPolicies: { policyId: string; name: string; via: string | null; reason: string }[];
  draft: string | null;
  draftNotes: string[];
}
export interface PolicyRef {
  arn: string;
  name: string;
  scope: "aws" | "local";
  description: string | null;
  badges: Badge[];
}
export interface ValidationResult {
  syntaxError: string | null;
  analyzerAvailable: boolean;
  findings: { level: "error" | "securityWarning" | "warning" | "suggestion"; code: string; message: string }[];
}
export type IamChange =
  | { op: "attachPolicy"; target: string; policyArn: string } // target = 사용자/그룹/역할 ARN
  | { op: "detachPolicy"; target: string; policyArn: string }
  | { op: "addToGroup"; userName: string; groupName: string }
  | { op: "removeFromGroup"; userName: string; groupName: string }
  | { op: "setAccessKeyStatus"; userName: string; accessKeyId: string; status: "Active" | "Inactive" }
  | { op: "deleteAccessKey"; userName: string; accessKeyId: string }
  | { op: "putInlinePolicy"; target: string; name: string; document: string }
  | { op: "deleteInlinePolicy"; target: string; name: string }
  | { op: "updateManagedPolicy"; policyArn: string; document: string };
export type PreviewWarning = { level: "block" | "confirm" | "warn"; message: string };
export interface ChangePreview {
  change: IamChange;
  summary: string;
  calls: { api: string; params: Record<string, string> }[];
  impacts: Impact[]; // 최대 30명
  /** impacts에 넣지 못한 주체 수. 없으면 0 */
  impactsOmitted?: number;
  warnings: PreviewWarning[];
  confirmText: string | null; // confirm 경고가 있으면 입력해야 할 문자열(대상 이름)
  reversible: boolean;
}
export interface Impact {
  principal: PrincipalSummary;
  gained: PermDelta[]; // 방향마다 작업이 많은 줄 최대 20개
  lost: PermDelta[];
  /** 조건 없이 허용되다가 조건부가 된 작업. 없으면 [] */
  restricted?: PermDelta[];
  /** 한도를 넘어 빠진 줄 수. 없으면 0 */
  gainedOmitted?: number;
  lostOmitted?: number;
  restrictedOmitted?: number;
}
export interface PermDelta {
  prefix: string;
  level: AccessLevel;
  count: number;
  sample: string[]; // sample 최대 5개
}
export interface ApplyResult {
  logId: string;
  summary: string;
  /** IAM은 바꿨지만 그 뒤에 하지 못한 일(변경 기록 저장 실패 등). 없으면 [] */
  notes?: string[];
} // 실패하면 AppError(기록은 남김)
export interface BatchItem {
  change: IamChange;
  summary: string;
  calls: { api: string; params: Record<string, string> }[];
  warnings: PreviewWarning[];
}
export interface BatchPreview {
  changes: BatchItem[];
  impacts: Impact[];
  impactsOmitted?: number;
  warnings: PreviewWarning[];
  confirmText: string | null;
  reversible: boolean;
}
export interface BatchResult {
  batchId: string;
  /** 적용한 변경의 기록 id. 적용 순서 */
  logIds: string[];
  /** 멈춘 변경. null이면 끝까지 적용했다. index는 0부터, 적용 순서 기준이다("k+1번째"는 index+1) */
  failed: { index: number; summary: string; message: string } | null;
  notes?: string[];
}
export interface UndoBatch {
  changes: IamChange[];
  /** undoOf[i]는 changes[i]가 되돌리는 기록 id */
  undoOf: string[];
}
export interface ChangeLogEntry {
  id: string;
  at: string;
  profile: string;
  accountId: string;
  callerArn: string;
  change: IamChange;
  summary: string;
  calls: string[];
  ok: boolean;
  error: string | null;
  inverse: IamChange | null;
  undoOf: string | null;
  undone: boolean;
  /** 묶음으로 적용한 변경. 같은 묶음은 같은 값 */
  batchId?: string;
}
