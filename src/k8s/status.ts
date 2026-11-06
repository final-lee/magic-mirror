import { STATE_NONE_WANTED, STATE_NOT_READY, STATE_PARTIAL, STATE_READY } from "./text";
import type { K8sRow } from "./types";

/** 상태 글의 색: 정상·끝남(정상 종료)·기다림·오류, 그 밖은 기본 */
export type StatusTone = "ok" | "done" | "warn" | "bad" | "plain";

/** 알려진 상태 낱말의 색. 그 밖에 `…BackOff`·`ErrImage…`·`…Error`는 오류로 본다 */
const TONE_BY_WORD: Record<string, StatusTone> = {
  Running: "ok", Ready: "ok", Bound: "ok", Active: "ok", Available: "ok", True: "ok",
  Succeeded: "done", Completed: "done", Complete: "done",
  Pending: "warn", ContainerCreating: "warn", PodInitializing: "warn", Terminating: "warn", Unknown: "warn", Released: "warn",
  SchedulingDisabled: "warn", NotReady: "warn", Unschedulable: "warn",
  Failed: "bad", Error: "bad", OOMKilled: "bad", Evicted: "bad", Lost: "bad", False: "bad", ContainerStatusUnknown: "bad",
  InvalidImageName: "bad", DeadlineExceeded: "bad", BackoffLimitExceeded: "bad",
};

function toneOfWord(word: string): StatusTone {
  if (Object.prototype.hasOwnProperty.call(TONE_BY_WORD, word)) return TONE_BY_WORD[word];
  return word.endsWith("BackOff") || word.startsWith("ErrImage") || word.endsWith("Error") ? "bad" : "plain";
}

const RANK: Record<StatusTone, number> = { bad: 0, warn: 1, plain: 2, ok: 3, done: 4 };

/**
 * 상태 글(kubectl STATUS와 같은 값)의 색. `Init:` 접두는 떼고 보며, 아직 init 중이면 기다림이다.
 * 쉼표로 붙은 값(노드 `Ready,SchedulingDisabled`)은 가장 나쁜 쪽을 따른다.
 */
export function statusTone(text: string): StatusTone {
  if (text.startsWith("Init:")) {
    const t = toneOfWord(text.slice(5));
    return t === "bad" ? "bad" : "warn";
  }
  return text
    .split(",")
    .map((w) => toneOfWord(w.trim()))
    .reduce<StatusTone>((worst, t) => (RANK[t] < RANK[worst] ? t : worst), "done");
}

/** 준비 수 `ready/total` 또는 Ready 조건(True/False)의 색. 해석하지 못하면 null */
export function readyTone(text: string): StatusTone | null {
  const m = /^(\d+)\/(\d+)$/.exec(text);
  if (!m) return text === "True" ? "ok" : text === "False" ? "bad" : null;
  const [ready, total] = [Number(m[1]), Number(m[2])];
  if (total === 0) return "plain";
  if (ready >= total) return "ok";
  return ready === 0 ? "bad" : "warn";
}

/** 행의 준비 색. DaemonSet·ReplicaSet은 준비 수만 따로 있어 원하는 수와 견준다 */
export function rowReadyTone(row: K8sRow): StatusTone | null {
  const ready = row.values.ready;
  if (ready === undefined) return null;
  const desired = row.values.desired;
  return readyTone(desired !== undefined && /^\d+$/.test(ready) ? `${ready}/${desired}` : ready);
}

const READY_STATES: Record<StatusTone, string> = { ok: STATE_READY, warn: STATE_PARTIAL, bad: STATE_NOT_READY, plain: STATE_NONE_WANTED, done: STATE_READY };
const READY_STATE_TONE: Record<string, StatusTone> = { [STATE_READY]: "ok", [STATE_PARTIAL]: "warn", [STATE_NOT_READY]: "bad", [STATE_NONE_WANTED]: "plain" };

/** 상태 필터에 쓰는 행의 상태: 상태 값이 있으면 그것, 없으면 준비 정도(준비됨·일부·안 됨·0개) */
export function rowState(row: K8sRow): string | null {
  if (row.values.status) return row.values.status;
  const tone = rowReadyTone(row);
  return tone ? READY_STATES[tone] : null;
}

export function stateTone(state: string): StatusTone {
  return Object.prototype.hasOwnProperty.call(READY_STATE_TONE, state) ? READY_STATE_TONE[state] : statusTone(state);
}

/** 상태 칩 순서: 나쁜 것부터, 같은 색이면 많은 것부터 */
export function orderStates(counts: Map<string, number>): [string, number][] {
  return [...counts].sort(([a, na], [b, nb]) => RANK[stateTone(a)] - RANK[stateTone(b)] || nb - na || a.localeCompare(b));
}
