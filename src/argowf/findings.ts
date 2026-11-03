import { cronKey, failStreak, isFailed, runsByCron } from "./catalogData";
import { relTime, spanText } from "./catalogFormat";
import {
  FIND_DEFAULT_SA,
  FIND_DEFAULT_SA_TITLE,
  FIND_DEFAULT_SA_UNSET,
  FIND_FAILING,
  FIND_LONG_PENDING,
  FIND_LONG_RUNNING,
  FIND_MISSED,
  FIND_NO_DEADLINE,
  FIND_NO_DEADLINE_DETAIL,
  FIND_SCOPE_CLUSTER,
  FIND_SUBJECT_CLUSTER_TEMPLATE,
  FIND_SUBJECT_CRON,
  FIND_SUBJECT_TEMPLATE,
  FIND_SUBJECT_WORKFLOW,
  findFailingDetail,
  findMissedDetail,
  findPendingDetail,
  findRunningDetail,
} from "./catalogText";
import type { CronRow, TemplateKind, TemplateRow, WfRow, WfTarget } from "./types";

export type FindingKind = "failingCron" | "missedCron" | "longRunning" | "longPending" | "noDeadline" | "defaultSA";
export type FindingLevel = "danger" | "warn" | "info";

/** 항목을 누르면 열 상세 */
export type FindingTarget =
  | { type: "workflow"; target: WfTarget }
  | { type: "cron"; namespace: string; name: string }
  | { type: "template"; kind: TemplateKind; namespace: string | null; name: string };

export interface FindingItem {
  /** 목록 안에서 유일한 열쇠 */
  id: string;
  /** Cron · Workflow · 템플릿 · 클러스터 템플릿 */
  subject: string;
  name: string;
  /** 네임스페이스, ClusterWorkflowTemplate은 "클러스터" */
  scope: string;
  detail: string;
  target: FindingTarget;
}

export interface FindingGroup {
  kind: FindingKind;
  level: FindingLevel;
  title: string;
  items: FindingItem[];
}

/** 이 시간을 넘게(같으면 아니다) Running이면 "오래 실행 중" */
export const LONG_RUNNING_MS = 60 * 60_000;
/** 이 시간을 넘게 Pending이면 "오래 대기" */
export const LONG_PENDING_MS = 10 * 60_000;
/** 끝난 실행이 이 횟수 이상 연달아 실패하면 "연속 실패" */
export const FAIL_STREAK = 3;

/** 최근 끝난 실행이 FAIL_STREAK회 이상 연달아 실패한 Cron(점검과 Workflows 요약 띠가 같이 쓴다) */
export function failingCrons(crons: readonly CronRow[], workflows: readonly WfRow[]): CronRow[] {
  const runs = runsByCron(workflows);
  return crons.filter((c) => failStreak(runs.get(cronKey(c.namespace, c.name)) ?? []) >= FAIL_STREAK);
}

const byScopeName = (a: FindingItem, b: FindingItem) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name);

/** 시작한 지 얼마나 됐나(밀리초). 시작 시각이 없거나 읽을 수 없으면 null */
function elapsed(w: WfRow, now: number): number | null {
  const t = w.startedAt ? Date.parse(w.startedAt) : NaN;
  return Number.isNaN(t) ? null : now - t;
}

const templateScope = (t: TemplateRow) => (t.kind === "ClusterWorkflowTemplate" ? FIND_SCOPE_CLUSTER : (t.namespace ?? ""));
const templateSubject = (t: TemplateRow) => (t.kind === "ClusterWorkflowTemplate" ? FIND_SUBJECT_CLUSTER_TEMPLATE : FIND_SUBJECT_TEMPLATE);

interface Input {
  workflows: readonly WfRow[];
  crons: readonly CronRow[];
  templates: readonly TemplateRow[];
  /** 기준 시각(밀리초). 시간 경계 판정에 쓴다 */
  now: number;
}

/**
 * 점검 카드 여섯 개(항목이 없어도 카드는 있다). 순서는 위험 → 주의 → 참고.
 * - "오래 실행 중"은 워크플로 수준 activeDeadlineSeconds가 있으면 뺀다(그 제한이 끝내 준다). 템플릿마다의 제한은 목록에 없어 보지 않는다.
 * - "오래 대기"는 시작 시각이 없는 Pending(아직 컨트롤러가 잡지 않은 것)을 건너뛴다.
 * - 제한 시간·ServiceAccount는 Cron과 템플릿 목록이 주는 hasDeadline·serviceAccount를 그대로 따른다.
 *   ServiceAccount를 지정하지 않은 것(null)도 Argo가 default로 돌리므로 같이 센다. workflowTemplateRef를 쓰는 Cron은 SA를 템플릿이 정하는데
 *   백엔드가 알 수 없어 null로 오므로 센 대상에서 뺀다(그 템플릿이 자기 항목으로 걸린다).
 */
export function findings({ workflows, crons, templates, now }: Input): FindingGroup[] {
  const runs = runsByCron(workflows);

  const failing = failingCrons(crons, workflows)
    .map((c) => {
      const list = runs.get(cronKey(c.namespace, c.name)) ?? [];
      const streak = failStreak(list);
      const last = list.find((w) => isFailed(w.phase));
      return { c, streak, item: cronItem(c, findFailingDetail(streak, relTime(last?.startedAt ?? null, now))) };
    })
    .sort((a, b) => b.streak - a.streak || byScopeName(a.item, b.item))
    .map((x) => x.item);

  const missed = crons
    .filter((c) => c.missed)
    .map((c) => cronItem(c, findMissedDetail(relTime(c.lastScheduledTime, now))))
    .sort(byScopeName);

  const longOf = (phase: string, limit: number, detail: (span: string, w: WfRow) => string, skip: (w: WfRow) => boolean = () => false) =>
    workflows
      .flatMap((w) => {
        const ms = w.phase === phase && !skip(w) ? elapsed(w, now) : null;
        return ms !== null && ms > limit ? [{ w, ms }] : [];
      })
      .sort((a, b) => b.ms - a.ms)
      .map(({ w, ms }): FindingItem => ({
        id: `wf|${w.uid || cronKey(w.namespace, w.name)}`,
        subject: FIND_SUBJECT_WORKFLOW,
        name: w.name,
        scope: w.namespace,
        detail: detail(spanText(ms), w),
        target: { type: "workflow", target: { kind: "live", namespace: w.namespace, name: w.name } },
      }));
  const running = longOf(
    "Running",
    LONG_RUNNING_MS,
    (span, w) => findRunningDetail(span, w.suspended),
    (w) => w.activeDeadlineSeconds !== null,
  );
  const pending = longOf("Pending", LONG_PENDING_MS, (span) => findPendingDetail(span));

  const noDeadline = [
    ...crons.filter((c) => !c.hasDeadline).map((c) => cronItem(c, FIND_NO_DEADLINE_DETAIL)),
    ...templates.filter((t) => !t.hasDeadline).map((t) => templateItem(t, FIND_NO_DEADLINE_DETAIL)),
  ].sort(byScopeName);

  const isDefault = (sa: string | null) => sa === null || sa === "default";
  const defaultSa = [
    ...crons
      .filter((c) => c.template === null && isDefault(c.serviceAccount))
      .map((c) => cronItem(c, c.serviceAccount === null ? FIND_DEFAULT_SA_UNSET : FIND_DEFAULT_SA)),
    ...templates.filter((t) => isDefault(t.serviceAccount)).map((t) => templateItem(t, t.serviceAccount === null ? FIND_DEFAULT_SA_UNSET : FIND_DEFAULT_SA)),
  ].sort(byScopeName);

  return [
    { kind: "failingCron", level: "danger", title: FIND_FAILING, items: failing },
    { kind: "missedCron", level: "warn", title: FIND_MISSED, items: missed },
    { kind: "longRunning", level: "warn", title: FIND_LONG_RUNNING, items: running },
    { kind: "longPending", level: "warn", title: FIND_LONG_PENDING, items: pending },
    { kind: "noDeadline", level: "info", title: FIND_NO_DEADLINE, items: noDeadline },
    { kind: "defaultSA", level: "info", title: FIND_DEFAULT_SA_TITLE, items: defaultSa },
  ];
}

function cronItem(c: CronRow, detail: string): FindingItem {
  return {
    id: `cron|${cronKey(c.namespace, c.name)}`,
    subject: FIND_SUBJECT_CRON,
    name: c.name,
    scope: c.namespace,
    detail,
    target: { type: "cron", namespace: c.namespace, name: c.name },
  };
}

function templateItem(t: TemplateRow, detail: string): FindingItem {
  return {
    id: `template|${t.kind}|${t.namespace ?? ""}|${t.name}`,
    subject: templateSubject(t),
    name: t.name,
    scope: templateScope(t),
    detail,
    target: { type: "template", kind: t.kind, namespace: t.namespace, name: t.name },
  };
}
