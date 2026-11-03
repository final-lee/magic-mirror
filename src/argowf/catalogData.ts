import type { CronRow, TemplateKind, TemplateRow, WfRow } from "./types";

/** Cron 목록의 막대가 보이는 최근 실행 수 */
export const RUNS_SHOWN = 10;
/** 템플릿의 "최근 실행 성공률"이 보는 끝난 실행 수 */
export const RATE_WINDOW = 20;

export const isFailed = (phase: string) => phase === "Failed" || phase === "Error";
const isDone = (phase: string) => phase === "Succeeded" || isFailed(phase);

export const cronKey = (namespace: string, name: string) => `${namespace}/${name}`;

/** 템플릿 하나의 열쇠. ClusterWorkflowTemplate은 네임스페이스가 없다(`*`는 네임스페이스 이름에 못 쓴다) */
export const templateKey = (kind: TemplateKind, namespace: string | null, name: string) =>
  kind === "ClusterWorkflowTemplate" ? `*/${name}` : `${namespace ?? ""}/${name}`;

/** 아직 시작하지 않은 Workflow는 가장 최근으로 본다 */
const startMs = (w: WfRow) => {
  const t = w.startedAt ? Date.parse(w.startedAt) : Infinity;
  return Number.isNaN(t) ? Infinity : t;
};
const newestFirst = (a: WfRow, b: WfRow) => {
  const x = startMs(a);
  const y = startMs(b);
  return x === y ? 0 : y > x ? 1 : -1;
};

/** Cron(`workflows.argoproj.io/cron-workflow` 레이블)이 만든 Workflow를 Cron별로, 각각 최근 것부터 */
export function runsByCron(workflows: readonly WfRow[]): Map<string, WfRow[]> {
  const map = new Map<string, WfRow[]>();
  for (const w of workflows) {
    if (!w.cron) continue;
    const key = cronKey(w.namespace, w.cron);
    const list = map.get(key);
    if (list) list.push(w);
    else map.set(key, [w]);
  }
  for (const list of map.values()) list.sort(newestFirst);
  return map;
}

/** 최근 것부터 놓은 실행에서 끝난 것이 몇 번 연달아 실패했나. 실행 중·대기는 아직 결과가 없어 건너뛰고, 성공에서 멈춘다. */
export function failStreak(runsNewestFirst: readonly WfRow[]): number {
  let n = 0;
  for (const w of runsNewestFirst) {
    if (!isDone(w.phase)) continue;
    if (!isFailed(w.phase)) break;
    n++;
  }
  return n;
}

/**
 * 템플릿별 최근 Workflow(최근 것부터). Workflow의 `workflow-template`·`cluster-workflow-template` 레이블로 모은다.
 * 키는 templateKey: 네임스페이스 템플릿은 Workflow가 같은 네임스페이스에 있다.
 */
export function runsByTemplate(workflows: readonly WfRow[]): Map<string, WfRow[]> {
  const map = new Map<string, WfRow[]>();
  for (const w of workflows) {
    if (!w.template) continue;
    const key = templateKey(w.clusterTemplate ? "ClusterWorkflowTemplate" : "WorkflowTemplate", w.namespace, w.template);
    const list = map.get(key);
    if (list) list.push(w);
    else map.set(key, [w]);
  }
  for (const list of map.values()) list.sort(newestFirst);
  return map;
}

/** 이 템플릿을 쓰는 Cron: workflowSpec.workflowTemplateRef가 이 템플릿(네임스페이스 템플릿은 같은 네임스페이스)인 것 */
export const cronsUsing = (crons: readonly CronRow[], t: Pick<TemplateRow, "kind" | "namespace" | "name">) =>
  crons.filter((c) => c.template === t.name && (t.kind === "ClusterWorkflowTemplate" ? c.clusterTemplate : !c.clusterTemplate && c.namespace === t.namespace));

/** 최근 끝난 실행 RATE_WINDOW개 중 성공. 끝난 실행이 없으면 null */
export function successRate(runsNewestFirst: readonly WfRow[]): { ok: number; total: number } | null {
  const done = runsNewestFirst.filter((w) => isDone(w.phase)).slice(0, RATE_WINDOW);
  return done.length === 0 ? null : { ok: done.filter((w) => w.phase === "Succeeded").length, total: done.length };
}

/** Workflow 목록에서 지금 보이는 네임스페이스들(ClusterWorkflowTemplate을 어디에 실행할지 고를 때의 후보) */
export const namespacesOf = (...lists: readonly { namespace: string }[][]) =>
  [...new Set(lists.flatMap((l) => l.map((x) => x.namespace)))].sort((a, b) => a.localeCompare(b));
