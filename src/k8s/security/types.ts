import type { AppError, K8sSecurityChecks } from "../../api/types";
import type { Subject } from "../access/types";
import type { K8sKindRef } from "../types";

// 백엔드 `src-tauri/src/k8s/checks.rs`와 같은 모양(camelCase)

export type Severity = "high" | "medium" | "low";
export type Category = "cluster" | "permissions" | "workloads";

export type CheckId =
  | "clusterPublicEndpoint" | "clusterLoggingOff" | "clusterSecretsPlain" | "clusterVersionSupport" | "clusterAwsAuth" | "clusterCreatorAdmin"
  | "adminSubject" | "anonymousAccess" | "escalateBind" | "impersonate" | "podCreateStrongSa" | "nodesProxy" | "secretsReadAll"
  | "unusedRole" | "bindingMissingRole" | "bindingMissingSubject"
  | "privileged" | "hostPath" | "hostNetwork" | "hostPid" | "runsAsRoot" | "privilegeEscalation" | "resourcesMissing" | "probesMissing"
  | "imageLatest" | "saTokenAutomount" | "noNetworkPolicy" | "imdsHopLimit";

/** 문제가 가리키는 곳 */
export type FindingTarget =
  | { type: "object"; kind: K8sKindRef; namespace: string | null; name: string }
  | { type: "subject"; subject: Subject }
  /** AWS 리소스. resource는 cluster, nodegroup, nodepool, instance */
  | { type: "aws"; resource: string; name: string };

/** 자동으로 고치는 방법. object는 바꾸는 필드만 담은 부분 객체(server-side apply) */
export interface Fix {
  summary: string;
  caution: string | null;
  kind: K8sKindRef;
  namespace: string | null;
  name: string;
  object: Record<string, unknown>;
}

export interface Finding {
  id: string;
  check: CheckId;
  severity: Severity;
  target: FindingTarget;
  /** 시스템 네임스페이스 제외에 쓰는 네임스페이스 */
  namespace: string | null;
  system: boolean;
  message: string;
  evidence: string[];
  fix: Fix | null;
}

export type SecuritySection =
  | "cluster" | "versions" | "accessEntries" | "awsAuth" | "rbac" | "namespaces" | "serviceAccounts" | "deployments" | "statefulSets"
  | "daemonSets" | "jobs" | "cronJobs" | "pods" | "networkPolicies" | "nodes" | "nodegroups" | "launchTemplates" | "instances";

export interface SecurityGap {
  section: SecuritySection;
  /** 노드그룹 하나 같은 일부에만 해당하는 실패면 그 이름 */
  subject: string | null;
  error: AppError;
  /** 오류가 아니라 목록이 잘려 일부만 점검했다 */
  partial: boolean;
}

export interface SecurityReport {
  findings: Finding[];
  /** 입력을 읽지 못해 점검하지 못한 항목 */
  skipped: CheckId[];
  gaps: SecurityGap[];
  fetchedAt: string;
}

/** 설정 `k8sSecurityChecks`: 끈 항목과 시스템 네임스페이스 포함 여부 */
export type SecurityChecksSetting = K8sSecurityChecks;
