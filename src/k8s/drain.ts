import type { AppError } from "../api/types";
import type { K8sDrainCounts, K8sDrainMessage, K8sDrainOutcome, K8sDrainPod, K8sDrainPodState } from "./types";

export interface DrainRow {
  pod: K8sDrainPod;
  state: K8sDrainPodState;
  error: string | null;
}

export interface DrainRun {
  node: string;
  /** 중단에 쓰는 번호. `k8s_drain`이 돌아오기 전에는 없다 */
  id: number | null;
  cordoned: boolean;
  rows: DrainRow[];
  counts: K8sDrainCounts;
  /** 중단을 눌렀다. 끝 메시지가 올 때까지 기다린다 */
  stopping: boolean;
  finished: { outcome: K8sDrainOutcome; error: AppError | null } | null;
}

const NONE: K8sDrainCounts = { total: 0, pending: 0, evicting: 0, evicted: 0, blocked: 0, failed: 0 };

export function startRun(node: string): DrainRun {
  return { node, id: null, cordoned: false, rows: [], counts: NONE, stopping: false, finished: null };
}

const same = (a: { namespace: string; name: string }, b: { namespace: string; name: string }) =>
  a.namespace === b.namespace && a.name === b.name;

/** 채널 메시지 하나를 진행 화면 상태에 반영한다. 순서가 어긋나도(`started` 전의 `pod`) 알려진 Pod만 바꾼다. */
export function reduceDrain(run: DrainRun, message: K8sDrainMessage): DrainRun {
  switch (message.type) {
    case "started":
      return {
        ...run,
        rows: message.pods.map((pod) => ({ pod, state: "pending", error: null })),
        counts: message.counts,
      };
    case "cordoned":
      return { ...run, cordoned: true };
    case "pod":
      return {
        ...run,
        counts: message.counts,
        rows: run.rows.map((row) => (same(row.pod, message) ? { ...row, state: message.state, error: message.error } : row)),
      };
    case "finished":
      return {
        ...run,
        counts: message.counts,
        stopping: false,
        finished: { outcome: message.outcome, error: message.error },
      };
  }
}
