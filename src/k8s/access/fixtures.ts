import type { AccessView, Grant, GrantSource, MappingRow, Subject } from "./types";

export const user = (name: string): Subject => ({ kind: "user", name, namespace: null });
export const group = (name: string): Subject => ({ kind: "group", name, namespace: null });
export const sa = (namespace: string, name: string): Subject => ({ kind: "serviceAccount", name, namespace });
export const iam = (name: string): Subject => ({ kind: "iam", name, namespace: null });

export const grant = (namespace: string | null, over: Partial<GrantSource> = {}): Grant => ({
  namespace,
  rule: { verbs: ["get"], apiGroups: [""], resources: ["pods"], resourceNames: [], nonResourceUrls: [] },
  source: {
    via: { kind: "direct" },
    binding: { kind: namespace === null ? "ClusterRoleBinding" : "RoleBinding", namespace, name: "b" },
    role: { kind: "ClusterRole", namespace: null, name: "view" },
    aggregatedFrom: null,
    sessionDependent: false,
    ...over,
  },
});

export const mapping = (arn: string, over: Partial<MappingRow> = {}): MappingRow => ({
  source: "accessEntry",
  principalArn: arn,
  kind: "role",
  username: "u",
  groups: [],
  accessType: "STANDARD",
  policies: [],
  permissionSet: null,
  label: arn.split("/").pop() ?? arn,
  effective: true,
  inactiveReason: null,
  subject: iam(arn),
  levels: [0, 0, 0, 0, 0, 0, 0],
  unevaluated: [],
  ...over,
});

export const accessView = (over: Partial<AccessView> = {}): AccessView => ({
  authMode: "API_AND_CONFIG_MAP",
  mode: "apiAndConfigMap",
  mappings: [],
  ssoGroups: [],
  awsAuth: { present: true, accounts: [], errors: [] },
  namespaces: ["default", "dev", "prod"],
  subjectCount: 0,
  dangling: [],
  rbacAvailable: true,
  gaps: [],
  fetchedAt: "2026-11-03T00:00:00Z",
  ...over,
});
