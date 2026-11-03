import type { ArgoWfConn, CronRow, TemplateRow, WfRow } from "./types";

// Cron·템플릿·보관함·점검 시험이 같이 쓰는 익명 자료
export const CONN: ArgoWfConn = { url: "https://argo.example", context: "ctx-a", ssoProfile: null };
/** 시험의 기준 시각 */
export const NOW = Date.parse("2026-11-03T12:00:00Z");
/** NOW에서 ms 전의 RFC3339 */
export const ago = (ms: number) => new Date(NOW - ms).toISOString();
export const MIN = 60_000;
export const HOUR = 60 * MIN;

export const wf = (over: Partial<WfRow> = {}): WfRow => ({
  namespace: "batch",
  name: "wf-1",
  uid: "uid-1",
  resourceVersion: "1",
  phase: "Succeeded",
  message: null,
  progress: "1/1",
  startedAt: ago(HOUR),
  finishedAt: ago(HOUR - MIN),
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
  ...over,
});

export const cron = (over: Partial<CronRow> = {}): CronRow => ({
  namespace: "batch",
  name: "nightly",
  schedules: ["30 19 * * *"],
  timezone: "Asia/Seoul",
  suspended: false,
  concurrencyPolicy: "Forbid",
  startingDeadlineSeconds: null,
  lastScheduledTime: ago(5 * HOUR),
  active: [],
  succeeded: 4,
  failed: 1,
  nextRuns: [new Date(NOW + 3 * HOUR).toISOString(), new Date(NOW + 27 * HOUR).toISOString()],
  missed: false,
  serviceAccount: "runner",
  hasDeadline: true,
  template: null,
  clusterTemplate: false,
  labels: {},
  ...over,
});

export const tpl = (over: Partial<TemplateRow> = {}): TemplateRow => ({
  kind: "WorkflowTemplate",
  namespace: "batch",
  name: "report",
  description: null,
  parameters: [],
  entrypoint: "main",
  templates: ["main"],
  serviceAccount: "runner",
  hasDeadline: true,
  ...over,
});

/** 같은 Cron의 실행들: 최근 것이 앞(i=0이 가장 최근) */
export const runs = (cronName: string, phases: WfRow["phase"][], namespace = "batch"): WfRow[] =>
  phases.map((phase, i) =>
    wf({
      namespace,
      name: `${cronName}-${i}`,
      uid: `${cronName}-uid-${i}`,
      cron: cronName,
      phase,
      startedAt: ago((i + 1) * HOUR),
      finishedAt: phase === "Running" ? null : ago((i + 1) * HOUR - MIN),
    }),
  );
