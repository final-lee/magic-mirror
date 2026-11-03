import type { ArgoWfConn, ArgoWfInfo, WfDetail, WfNode, WfRow } from "./types";

// Workflow 목록·상세·그래프 시험이 같이 쓰는 익명 자료
export const conn: ArgoWfConn = { url: "https://example.test", context: null, ssoProfile: null };
export const info: ArgoWfInfo = { managedNamespace: null, links: [], columns: [] };

export const row = (name: string, phase: WfRow["phase"], extra: Partial<WfRow> = {}): WfRow => ({
  namespace: "test",
  name,
  uid: name,
  resourceVersion: "1",
  phase,
  message: null,
  progress: null,
  startedAt: new Date(Date.now() - 60000).toISOString(),
  finishedAt: null,
  cron: null,
  template: null,
  clusterTemplate: false,
  creator: null,
  suspended: false,
  activeDeadlineSeconds: null,
  archived: false,
  labels: {},
  annotations: {},
  createdAt: null,
  estimatedDuration: null,
  ...extra,
});

export const node = (id: string, extra: Partial<WfNode> = {}): WfNode => ({
  id,
  name: id,
  displayName: id,
  type: "Pod",
  phase: "Failed",
  message: null,
  templateName: null,
  templateScope: null,
  startedAt: null,
  finishedAt: null,
  children: [],
  boundaryId: null,
  podName: id,
  exitCode: null,
  inputs: [],
  outputs: [],
  artifacts: [],
  hostNodeName: null,
  memoization: null,
  containers: [],
  estimatedDuration: null,
  resourcesDuration: {},
  ...extra,
});

export const detailOf = (over: Partial<WfDetail> = {}): WfDetail => ({
  row: row("prod-job", "Failed", { namespace: "prod", finishedAt: new Date().toISOString() }),
  nodes: [
    node("root", { type: "Steps", children: ["later", "first"], podName: null }),
    node("later", { finishedAt: "2026-01-01T00:02:00Z" }),
    node("first", { finishedAt: "2026-01-01T00:01:00Z" }),
  ],
  parameters: [{ name: "who", value: "alice" }],
  entrypoint: null,
  serviceAccount: null,
  activeDeadlineSeconds: null,
  podGC: null,
  ttl: null,
  conditions: [],
  resourcesDuration: {},
  yaml: "kind: Workflow",
  outputs: [],
  createdFrom: [],
  synchronization: [],
  ...over,
});

export const page = (rows: WfRow[], continueToken: string | null = null, resourceVersion: string | null = "100") => ({ rows, continueToken, resourceVersion });
