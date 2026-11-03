import type { Subject } from "../access/types";
import type { K8sChange, K8sChangeObject } from "../types";
import * as t from "./text";
import { ACCESS_ENTRY_KIND, CLUSTER_ROLE_BINDING_KIND, ROLE_BINDING_KIND, type RbacPolicySpec, type RbacSubjectSpec } from "./types";

export const RBAC_GROUP = "rbac.authorization.k8s.io";

/** 바인딩을 가리킨다. 네임스페이스가 없으면 ClusterRoleBinding */
export interface BindingTarget {
  namespace: string | null;
  name: string;
}

export const bindingObject = (target: BindingTarget): K8sChangeObject => ({
  kind: target.namespace === null ? CLUSTER_ROLE_BINDING_KIND : ROLE_BINDING_KIND,
  namespace: target.namespace,
  name: target.name,
});

export interface RoleRef {
  kind: "Role" | "ClusterRole";
  name: string;
}

/** 바인딩 만들기. ClusterRoleBinding은 ClusterRole만 가리킬 수 있다 */
export function createBinding(target: BindingTarget, role: RoleRef, subjects: RbacSubjectSpec[]): K8sChange {
  const metadata: Record<string, unknown> = { name: target.name };
  if (target.namespace !== null) metadata.namespace = target.namespace;
  return {
    ...bindingObject(target),
    type: "bindingCreate",
    object: {
      apiVersion: `${RBAC_GROUP}/v1`,
      kind: target.namespace === null ? "ClusterRoleBinding" : "RoleBinding",
      metadata,
      roleRef: { apiGroup: RBAC_GROUP, kind: role.kind, name: role.name },
      subjects: subjects.map(subjectValue),
    },
  };
}

/** 바인딩 삭제는 공통 삭제 변경이다(되돌리기는 지운 원본으로 다시 만든다) */
export const deleteBinding = (target: BindingTarget): K8sChange => ({ ...bindingObject(target), type: "delete" });

export const editSubjects = (target: BindingTarget, add: RbacSubjectSpec[], remove: RbacSubjectSpec[]): K8sChange => ({ ...bindingObject(target), type: "bindingSubjects", add, remove });

/** 바인딩의 `subjects[]` 항목 모양(백엔드 SubjectSpec::to_value와 같다) */
export function subjectValue(s: RbacSubjectSpec): Record<string, unknown> {
  return s.kind === "ServiceAccount" ? { kind: s.kind, name: s.name, namespace: s.namespace } : { apiGroup: RBAC_GROUP, kind: s.kind, name: s.name };
}

const entryObject = (arn: string): K8sChangeObject => ({ kind: ACCESS_ENTRY_KIND, namespace: null, name: arn });

export interface EntryDraft {
  username: string | null;
  groups: string[];
  policies: RbacPolicySpec[];
}

export const entryCreate = (arn: string, draft: EntryDraft): K8sChange => ({
  ...entryObject(arn),
  type: "accessEntryCreate",
  username: draft.username?.trim() || null,
  groups: draft.groups,
  policies: draft.policies,
});

export const entryDelete = (arn: string): K8sChange => ({ ...entryObject(arn), type: "accessEntryDelete" });
export const entryGroups = (arn: string, groups: string[]): K8sChange => ({ ...entryObject(arn), type: "accessEntryGroups", groups });
export const entryAssociate = (arn: string, policyArn: string, scope: RbacPolicySpec["scope"]): K8sChange => ({ ...entryObject(arn), type: "accessPolicyAssociate", policyArn, scope });
export const entryDisassociate = (arn: string, policyArn: string): K8sChange => ({ ...entryObject(arn), type: "accessPolicyDisassociate", policyArn });

/** 쉼표나 줄바꿈으로 나눈 목록(앞뒤 공백을 떼고 빈 것과 겹치는 것은 뺀다) */
export function splitList(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[,\n]/)) {
    const item = part.trim();
    if (item && !out.includes(item)) out.push(item);
  }
  return out;
}

/** 권한 표의 주체가 바인딩의 주체 모양이면 그것. IAM 주체는 바인딩에 나오지 않는다 */
export function subjectSpecOf(subject: Subject): RbacSubjectSpec | null {
  switch (subject.kind) {
    case "user":
      return { kind: "User", name: subject.name };
    case "group":
      return { kind: "Group", name: subject.name };
    case "serviceAccount":
      return { kind: "ServiceAccount", name: subject.name, namespace: subject.namespace };
    case "iam":
      return null;
  }
}

/** 바인딩 이름으로 쓸 수 있는 글: 소문자·숫자·`-`·`.`만 남기고 앞뒤를 다듬는다 */
const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");

/** 권한 주기용 바인딩 이름: `mm-<주체>-<역할>` */
export function bindingName(subject: RbacSubjectSpec, role: string): string {
  const who = slug(subject.kind === "ServiceAccount" ? `${subject.namespace}-${subject.name}` : subject.name) || "subject";
  const name = `mm-${who}-${slug(role) || "role"}`;
  return name.slice(0, 253).replace(/[^a-z0-9]+$/, "");
}

export const isBinding = (kind: K8sChangeObject["kind"]) => kind.group === RBAC_GROUP && (kind.kind === "RoleBinding" || kind.kind === "ClusterRoleBinding");

/** 권한 변경 모듈이 처리하는 변경인가(백엔드 rbac::handles와 같다) */
export function isRbacChange(change: K8sChange): boolean {
  switch (change.type) {
    case "bindingCreate":
    case "bindingSubjects":
    case "accessEntryCreate":
    case "accessEntryDelete":
    case "accessEntryGroups":
    case "accessPolicyAssociate":
    case "accessPolicyDisassociate":
      return true;
    case "delete":
      return isBinding(change.kind);
    default:
      return false;
  }
}

const bindingLabel = (c: K8sChangeObject) => `${c.kind.kind} ${c.namespace ? `${c.namespace}/` : ""}${c.name}`;
const entryName = (arn: string) => arn.split("/").pop() || arn;
const policyName = (arn: string) => arn.split("/").pop() || arn;

/** 장바구니와 되돌리기 목록에 보이는 변경 이름 */
export function changeTitle(change: K8sChange): string {
  switch (change.type) {
    case "bindingCreate":
      return t.TITLE_BINDING_CREATE(bindingLabel(change));
    case "delete":
      return t.TITLE_BINDING_DELETE(bindingLabel(change));
    case "bindingSubjects":
      return t.TITLE_SUBJECTS(bindingLabel(change), change.add.map((s) => s.name), change.remove.map((s) => s.name));
    case "accessEntryCreate":
      return t.TITLE_ENTRY_CREATE(entryName(change.name));
    case "accessEntryDelete":
      return t.TITLE_ENTRY_DELETE(entryName(change.name));
    case "accessEntryGroups":
      return t.TITLE_ENTRY_GROUPS(entryName(change.name), change.groups);
    case "accessPolicyAssociate":
      return t.TITLE_ENTRY_ASSOCIATE(entryName(change.name), policyName(change.policyArn));
    case "accessPolicyDisassociate":
      return t.TITLE_ENTRY_DISASSOCIATE(entryName(change.name), policyName(change.policyArn));
    default:
      return `${change.kind.kind} ${change.name}`;
  }
}
