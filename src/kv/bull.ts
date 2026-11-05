import { formatDuration } from "./format";
import type { KvBullCounts, KvBullQueue, KvBullState } from "./types";

/** 상태 표시 순서(막대·상태 칸). 처리 안 끝난 상태 다음에 끝난 상태 */
export const BULL_STATES: KvBullState[] = ["wait", "active", "delayed", "prioritized", "waitingChildren", "paused", "completed", "failed"];
/** 상태 막대에 그리는 상태: 아직 끝나지 않은 작업 */
export const BULL_OPEN_STATES: KvBullState[] = ["wait", "active", "delayed", "prioritized", "waitingChildren", "paused"];

/** 큐 화면이 기본으로 여는 작업 표의 상태: 실패가 있으면 실패, 아니면 대기, 처리 중, 완료 순으로 비어 있지 않은 첫 상태 */
export function defaultJobState(counts: KvBullCounts): KvBullState {
  if (counts.failed > 0) return "failed";
  return (["wait", "active", "delayed", "prioritized", "waitingChildren", "paused", "completed"] as const).find((s) => counts[s] > 0) ?? "wait";
}

/** 최근 몇 분을 "최근"으로 보는지(실패가 늘었는지 판단) */
export const RECENT_MINUTES = 15;
/** 이 이상 대기가 쌓이면 주의 */
export const BACKLOG_WARN = 1000;
/** 최근 끝난 작업(완료+실패) 가운데 실패가 이 비율 이상이면 주의, DANGER 이상(그리고 DANGER_MIN건 이상)이면 위험. 아주 바쁜 큐의 드문 실패는 문제로 보지 않는다 */
export const FAIL_WARN_RATIO = 0.02;
export const FAIL_DANGER_RATIO = 0.25;
export const FAIL_DANGER_MIN = 5;

export type Attention = "danger" | "warn" | null;

export interface QueueHealth {
  attention: Attention;
  /** 최근 RECENT_MINUTES분 동안 끝난 수 */
  completedRecent: number;
  failedRecent: number;
  /** 아직 처리를 기다리는 작업(대기 + 우선순위) */
  backlog: number;
  /** 대기가 있는데 워커가 0(워커 수를 알 때만) */
  stalled: boolean;
  /** 최근 실패 비율이 FAIL_WARN_RATIO 이상이다 */
  failing: boolean;
}

const tail = (values: readonly number[], n: number) => values.slice(Math.max(0, values.length - n)).reduce((a, b) => a + b, 0);

/**
 * 큐의 건강 상태. 위험(빨강): 대기가 쌓였는데 워커가 0이거나, 최근 실패가 완료 이상으로 많다.
 * 주의(노랑): 최근 실패가 있거나, 대기가 BACKLOG_WARN 이상이거나, 일시정지인데 대기가 있다.
 * 워커 수를 모르면(null) 워커가 없다고 단정하지 않는다.
 */
export function queueHealth(q: KvBullQueue): QueueHealth {
  const completedRecent = tail(q.recent.completed, RECENT_MINUTES);
  const failedRecent = tail(q.recent.failed, RECENT_MINUTES);
  const backlog = q.counts.wait + q.counts.prioritized;
  const stalled = !q.paused && backlog > 0 && q.workers === 0;
  const failRatio = failedRecent / Math.max(1, failedRecent + completedRecent);
  const failing = failedRecent > 0 && failRatio >= FAIL_WARN_RATIO;
  const attention: Attention =
    stalled || (failedRecent >= FAIL_DANGER_MIN && failRatio >= FAIL_DANGER_RATIO)
      ? "danger"
      : failing || backlog >= BACKLOG_WARN || (q.paused && backlog + q.counts.paused > 0)
        ? "warn"
        : null;
  return { attention, completedRecent, failedRecent, backlog, stalled, failing };
}

const RANK: Record<NonNullable<Attention> | "none", number> = { danger: 2, warn: 1, none: 0 };

/** 문제가 있는 큐를 위로: 위험, 주의, 그 밖의 순서이고 같은 단계에서는 최근 실패, 대기가 많은 순, 마지막으로 이름순 */
export function orderQueues(queues: readonly KvBullQueue[]): { queue: KvBullQueue; health: QueueHealth }[] {
  return queues
    .map((queue) => ({ queue, health: queueHealth(queue) }))
    .sort(
      (a, b) =>
        RANK[b.health.attention ?? "none"] - RANK[a.health.attention ?? "none"] ||
        b.health.failedRecent - a.health.failedRecent ||
        b.health.backlog - a.health.backlog ||
        a.queue.name.localeCompare(b.queue.name, "ko", { numeric: true }),
    );
}

/** 작업 키(`<prefix>:<큐>:<id>`)를 큐 이름과 작업 id로 나눈다. 이 prefix가 아니면 null. 큐 이름에 ':'가 있어도 마지막 ':' 뒤가 id다. */
export function parseJobKey(prefix: string, key: string): { queue: string; id: string } | null {
  if (!key.startsWith(`${prefix}:`)) return null;
  const rest = key.slice(prefix.length + 1);
  const at = rest.lastIndexOf(":");
  return at > 0 && at < rest.length - 1 ? { queue: rest.slice(0, at), id: rest.slice(at + 1) } : null;
}

/** 부모 작업이 사는 큐(`queueKey` = `<prefix>:<큐>`)의 이름. 이 prefix가 아니면 null */
export function parseQueueKey(prefix: string, queueKey: string): string | null {
  return queueKey.startsWith(`${prefix}:`) && queueKey.length > prefix.length + 1 ? queueKey.slice(prefix.length + 1) : null;
}

/** 분 칸 여러 개를 factor개씩 합쳐 칸 수를 줄인다(24시간 1440칸 → 144칸). 남는 칸은 마지막 칸에 합친다. */
export function rebin(values: readonly number[], factor: number): number[] {
  if (factor <= 1) return [...values];
  const out: number[] = [];
  for (let i = 0; i < values.length; i += factor) out.push(values.slice(i, i + factor).reduce((a, b) => a + b, 0));
  return out;
}

/** 밀리초 길이를 "230ms", "4.2초", "3분 10초", "2시간 5분"으로 */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}초`;
  return formatDuration(Math.round(ms / 1000));
}

/** 분포 그림 칸의 이름: "≤ 100ms". 끝이 없는(아주 큰) 한계는 "그 이상" */
export function bucketLabel(upToMs: number): string {
  return upToMs >= 1e15 || !Number.isFinite(upToMs) ? "그 이상" : `≤ ${formatMs(upToMs)}`;
}

/** 진행률 글("42", "42.5", "{\"step\":3}")이 0~100 숫자면 그 값, 아니면 null */
export function progressPercent(progress: string | null): number | null {
  if (progress === null || progress.trim() === "") return null;
  const n = Number(progress);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

/** 상태 이름(화면용) */
export const STATE_LABEL: Record<KvBullState, string> = {
  wait: "대기",
  active: "처리 중",
  delayed: "지연",
  prioritized: "우선순위",
  waitingChildren: "자식 기다림",
  paused: "일시정지",
  completed: "완료",
  failed: "실패",
};
