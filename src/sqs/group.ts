import { fuzzyKeep } from "../lib/fuzzy";
import type { SqsQueue } from "./types";

/** 큐 하나의 건강. unknown은 속성을 읽지 못한 큐다 */
export type Health = "fail" | "warn" | "ok" | "unknown";

export function queueHealth(q: SqsQueue): Health {
  if (q.error) return "unknown";
  if (q.findings.some((f) => f.level === "fail")) return "fail";
  if (q.findings.some((f) => f.level === "warn")) return "warn";
  return "ok";
}

/** "문제 있는 큐만"에 드는 큐: 실패·주의 진단이 있거나 속성을 읽지 못한 큐(정보 수준은 문제가 아니다) */
export const hasProblem = (q: SqsQueue) => queueHealth(q) !== "ok";

/** 묶음 한 칸. parent는 이 큐가 들여 쓰여 붙는 원본 큐의 ARN이다 */
export interface QueueGroupRow {
  queue: SqsQueue;
  parent: string | null;
  /** 이 큐를 DLQ로 쓰는 원본 수(DLQ가 아니면 0) */
  sourceCount: number;
}

/** 화면에 그리는 줄. depth 1은 원본 큐 아래에 들여 쓴 DLQ다 */
export interface QueueRow {
  queue: SqsQueue;
  depth: 0 | 1;
  sourceCount: number;
}

const byName = (a: SqsQueue, b: SqsQueue) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * 원본 큐 아래에 그 DLQ를 붙인다. 이름순으로, 묶인 DLQ는 원본 바로 뒤에 온다.
 * - 원본이 하나뿐인 DLQ(목록에 그 원본이 있을 때)는 원본 아래로 들어간다.
 * - 원본이 여럿인 DLQ는 맨 위 단계에 두고 원본 수를 센다. 그 원본들은 따로 맨 위 단계에 남는다.
 * - 어디에도 묶이지 않은 큐는 맨 위 단계 그대로다. 들여 쓰기는 한 단계까지만 한다(DLQ의 DLQ, 순환도 맨 위 단계).
 */
export function groupQueues(queues: readonly SqsQueue[]): QueueGroupRow[] {
  const sorted = [...queues].sort(byName);
  const byArn = new Map(sorted.map((q) => [q.arn, q]));
  const sourcesOf = new Map<string, Set<string>>();
  for (const q of sorted) {
    if (!q.redrive) continue;
    const set = sourcesOf.get(q.redrive.dlqArn) ?? new Set<string>();
    set.add(q.arn);
    sourcesOf.set(q.redrive.dlqArn, set);
  }
  // 목록이 잘렸을 때를 위해 백엔드가 알려 준 sources도 센다
  const sources = (q: SqsQueue) => new Set([...q.sources, ...(sourcesOf.get(q.arn) ?? [])]);

  const parentOf = new Map<string, string>();
  const parents = new Set<string>();
  for (const q of sorted) {
    const src = sources(q);
    if (src.size !== 1) continue;
    const [source] = src;
    if (source === q.arn || !byArn.has(source) || parentOf.has(source) || parents.has(q.arn)) continue;
    parentOf.set(q.arn, source);
    parents.add(source);
  }

  const children = new Map<string, SqsQueue>();
  for (const q of sorted) {
    const parent = parentOf.get(q.arn);
    if (parent) children.set(parent, q);
  }
  const row = (queue: SqsQueue, parent: string | null): QueueGroupRow => ({ queue, parent, sourceCount: sources(queue).size });
  const out: QueueGroupRow[] = [];
  for (const q of sorted) {
    if (parentOf.has(q.arn)) continue;
    out.push(row(q, null));
    const child = children.get(q.arn);
    if (child) out.push(row(child, q.arn));
  }
  return out;
}

/**
 * 묶음에서 keep에 드는 큐만 남긴다. 원본이 걸러졌으면 그 아래 DLQ는 맨 위 단계로 나온다.
 * 순서는 묶음의 순서 그대로다.
 */
export function visibleRows(groups: readonly QueueGroupRow[], keep: (q: SqsQueue) => boolean): QueueRow[] {
  const kept = groups.filter((g) => keep(g.queue));
  const arns = new Set(kept.map((g) => g.queue.arn));
  return kept.map((g) => ({ queue: g.queue, depth: g.parent && arns.has(g.parent) ? 1 : 0, sourceCount: g.sourceCount }));
}

/** 목록에 보일 줄: 묶고, 문제 있는 큐만·퍼지 검색으로 거른다 */
export function listRows(queues: readonly SqsQueue[], opts: { problemOnly: boolean; query: string }): QueueRow[] {
  const groups = groupQueues(queues);
  const named = new Set(fuzzyKeep(groups, opts.query, (g) => [g.queue.name]).map((g) => g.queue.arn));
  return visibleRows(groups, (q) => named.has(q.arn) && (!opts.problemOnly || hasProblem(q)));
}
