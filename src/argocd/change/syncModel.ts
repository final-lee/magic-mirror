import type { ArgoResource, ResRef } from "../types";
import type { ArgoChange, Retry } from "./types";
import { SYNC_OPTIONS, SYNC_PROBLEM_DURATION, SYNC_PROBLEM_FACTOR, SYNC_PROBLEM_LIMIT } from "./text";

export type Sync = Extract<ArgoChange, { kind: "sync" }>;
export type SyncOptionKey = keyof typeof SYNC_OPTIONS;

/** 폼에서 고른 값. 재시도 칸은 글 그대로(비우면 안 쓴다) */
export interface SyncDraft {
  revision: string;
  /** 고른 리소스의 resourceKey. 비어 있으면 앱 전체 */
  selected: string[];
  options: Record<SyncOptionKey, boolean>;
  retry: { limit: string; duration: string; factor: string; maxDuration: string };
}

export const initialDraft: SyncDraft = {
  revision: "",
  selected: [],
  options: { prune: false, dryRun: false, applyOnly: false, force: false, serverSideApply: false, replace: false, pruneLast: false, createNamespace: false, applyOutOfSyncOnly: false, respectIgnoreDifferences: false },
  retry: { limit: "", duration: "", factor: "", maxDuration: "" },
};

type Keyed = { group: string; kind: string; namespace?: string | null; name: string };
/** 리소스를 가리키는 키(group/kind/namespace/name) */
export const resourceKey = (r: Keyed) => `${r.group}/${r.kind}/${r.namespace ?? ""}/${r.name}`;

/** 고를 수 있는 리소스: hook은 동기화 대상으로 고를 수 없다 */
export const selectable = (resources: ArgoResource[]) => resources.filter((r) => !r.hook);

/** OutOfSync인 리소스만 고른 목록 */
export const outOfSyncKeys = (resources: ArgoResource[]) => selectable(resources).filter((r) => r.status === "OutOfSync").map(resourceKey);

/** 서버가 받는 시간: 숫자(초) 또는 `5s`·`2m`·`1h30m`처럼 단위가 붙은 값 */
const DURATION = /^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$|^\d+$/;

/** 재시도 칸을 읽는다. limit을 비우면 재시도 없음. 잘못된 칸은 이유를 돌려준다 */
export function parseRetry(r: SyncDraft["retry"]): { retry: Retry | null; problem: string | null } {
  if (r.limit.trim() === "") return { retry: null, problem: null };
  if (!/^\d+$/.test(r.limit.trim())) return { retry: null, problem: SYNC_PROBLEM_LIMIT };
  if (r.factor.trim() !== "" && !/^[1-9]\d*$/.test(r.factor.trim())) return { retry: null, problem: SYNC_PROBLEM_FACTOR };
  for (const value of [r.duration, r.maxDuration]) {
    if (value.trim() !== "" && !DURATION.test(value.trim())) return { retry: null, problem: SYNC_PROBLEM_DURATION };
  }
  const backoff = {
    ...(r.duration.trim() ? { duration: r.duration.trim() } : {}),
    ...(r.factor.trim() ? { factor: Number(r.factor) } : {}),
    ...(r.maxDuration.trim() ? { maxDuration: r.maxDuration.trim() } : {}),
  };
  return { retry: { limit: Number(r.limit), ...(Object.keys(backoff).length > 0 ? { backoff } : {}) }, problem: null };
}

/** 폼 값을 sync 변경으로. 고른 리소스가 없으면 resources는 null(앱 전체) */
export function buildSync(draft: SyncDraft, resources: ArgoResource[]): { change: Sync | null; problem: string | null } {
  const { retry, problem } = parseRetry(draft.retry);
  if (problem) return { change: null, problem };
  const picked = new Set(draft.selected);
  const refs: ResRef[] = selectable(resources)
    .filter((r) => picked.has(resourceKey(r)))
    .map((r) => ({ group: r.group, version: r.version, kind: r.kind, namespace: r.namespace, name: r.name, uid: null }));
  return { change: { kind: "sync", revision: draft.revision.trim() || null, resources: refs.length > 0 ? refs : null, ...draft.options, retry }, problem: null };
}
