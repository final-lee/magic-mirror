import type { PolicyScope, Subject } from "../access/types";
import type { K8sKindRef, K8sPreview } from "../types";

// 백엔드 계약(camelCase)과 같은 모양이다(src-tauri/src/k8s/rbac, k8s_commands/rbac.rs).

/** 바인딩 `subjects[]`의 주체. ServiceAccount만 namespace를 가진다 */
export interface RbacSubjectSpec {
  kind: "User" | "Group" | "ServiceAccount";
  name: string;
  namespace?: string | null;
}

export interface RbacPolicySpec {
  policyArn: string;
  scope: PolicyScope;
}

/** 변경 틀(K8sChange)에 더하는 권한 변경. 바인딩 삭제는 공통 `delete`다. access entry 변경의 대상 이름은 IAM 주체 ARN이다. */
export type RbacChangeVariant =
  /** 바인딩 만들기(되돌리기에서는 지운 원본). object는 바인딩 전체 */
  | { type: "bindingCreate"; object: Record<string, unknown> }
  | { type: "bindingSubjects"; add: RbacSubjectSpec[]; remove: RbacSubjectSpec[] }
  | { type: "accessEntryCreate"; username?: string | null; groups: string[]; policies: RbacPolicySpec[]; entryType?: string | null }
  | { type: "accessEntryDelete" }
  | { type: "accessEntryGroups"; groups: string[] }
  | { type: "accessPolicyAssociate"; policyArn: string; scope: PolicyScope }
  | { type: "accessPolicyDisassociate"; policyArn: string };

/** 한 범위·리소스에서 바뀐 동사들. namespace가 null이면 클러스터 전체 */
export interface RbacCapability {
  namespace: string | null;
  group: string;
  resource: string;
  verbs: string[];
}

export interface RbacUrlCapability {
  url: string;
  verbs: string[];
}

export interface RbacSubjectEffect {
  subject: Subject;
  gained: RbacCapability[];
  lost: RbacCapability[];
  gainedUrls: RbacUrlCapability[];
  lostUrls: RbacUrlCapability[];
}

/** 실효 권한 엔진이 본 "누가 무엇을 얻고 잃는지" */
export interface RbacEffect {
  /** 권한 상승 주체와 이 앱의 신원이 앞. 한도에서 잘렸으면 total이 더 크다 */
  subjects: RbacSubjectEffect[];
  total: number;
  /** 클러스터 관리자 권한이나 직접 권한 상승 경로를 새로 얻는 주체 */
  escalated: Subject[];
  losesOwnAccess: boolean;
  /** 이 앱의 신원 주체(권한이 달라지는 주체 가운데 있을 때만) */
  own: Subject | null;
  /** 계산하지 못한 부분의 이유 */
  unavailable: string | null;
}

export interface RbacBatchItem {
  preview: K8sPreview | null;
  /** 계획하지 못한 이유 */
  error: string | null;
}

export interface RbacBatchPreview {
  items: RbacBatchItem[];
  /** 모든 변경을 적용한 뒤의 영향 */
  total: RbacEffect | null;
}

export type RbacItemStatus = "applied" | "failed" | "skipped";

export interface RbacBatchApplied {
  status: RbacItemStatus;
  logId: string | null;
  error: string | null;
}

export interface RbacBatchResult {
  items: RbacBatchApplied[];
}

/** 변경 틀에서 바인딩을 가리키는 종류(백엔드 rbac::binding_kind) */
export const ROLE_BINDING_KIND: K8sKindRef = { group: "rbac.authorization.k8s.io", version: "v1", kind: "RoleBinding", plural: "rolebindings", namespaced: true };
export const CLUSTER_ROLE_BINDING_KIND: K8sKindRef = { group: "rbac.authorization.k8s.io", version: "v1", kind: "ClusterRoleBinding", plural: "clusterrolebindings", namespaced: false };
/** 변경 틀에서 access entry를 가리키는 종류(백엔드 rbac::access_entry_kind). 클러스터의 API 종류가 아니다 */
export const ACCESS_ENTRY_KIND: K8sKindRef = { group: "eks.amazonaws.com", version: "v1", kind: "AccessEntry", plural: "accessentries", namespaced: false };
/** 장바구니와 일괄 미리보기의 최대 수(백엔드 rbac::BATCH_MAX) */
export const CART_MAX = 50;
