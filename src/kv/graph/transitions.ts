import type { KvBullTransitions } from "../types";

/** 상태 전이 그림의 노드: BullMQ 이벤트 이름과 같은 id(waiting, waiting-children …) */
export type TransitionNodeId = "new" | "delayed" | "prioritized" | "waiting-children" | "waiting" | "active" | "completed" | "failed";

/** 노드, 그 층(왼쪽에서부터), 큐의 현재 수를 가져올 상태 이름 */
export const TRANSITION_NODES: { id: TransitionNodeId; label: string; layer: number; count: "wait" | "active" | "delayed" | "prioritized" | "waitingChildren" | "completed" | "failed" | null }[] = [
  { id: "new", label: "새 작업", layer: 0, count: null },
  { id: "delayed", label: "지연", layer: 1, count: "delayed" },
  { id: "prioritized", label: "우선순위", layer: 1, count: "prioritized" },
  { id: "waiting-children", label: "자식 기다림", layer: 1, count: "waitingChildren" },
  { id: "waiting", label: "대기", layer: 2, count: "wait" },
  { id: "active", label: "처리 중", layer: 3, count: "active" },
  { id: "completed", label: "완료", layer: 4, count: "completed" },
  { id: "failed", label: "실패", layer: 4, count: "failed" },
];

const IDS = new Set<string>(TRANSITION_NODES.map((n) => n.id));
/** 작업이 그 상태가 됐다는 이벤트(전이의 도착점이 되는 것) */
const STATE_EVENTS = new Set<string>(["waiting", "active", "completed", "failed", "delayed", "prioritized", "waiting-children"]);

/** `prev`·이벤트 글을 노드 id로. 옛 이름 wait는 waiting이고, 모르는 글은 null */
export function normalizeState(value: string | null): TransitionNodeId | null {
  if (value === null) return null;
  const v = value === "wait" ? "waiting" : value === "waitingChildren" ? "waiting-children" : value;
  return IDS.has(v) ? (v as TransitionNodeId) : null;
}

export type EdgeTone = "dim" | "good" | "bad" | "warn";
export interface TransitionEdge {
  id: string;
  from: TransitionNodeId;
  to: TransitionNodeId;
  count: number;
  tone: EdgeTone;
  /** 정체(stalled)로 되돌아간 작업을 따로 그린 간선 */
  stalled: boolean;
}
export interface TransitionBadge {
  label: string;
  count: number;
  tone: "bad" | "warn";
}
export interface TransitionModel {
  edges: TransitionEdge[];
  badges: Partial<Record<TransitionNodeId, TransitionBadge[]>>;
  /** 상태 전이가 아닌 이벤트(progress, removed, drained …)를 많은 순으로 */
  other: { event: string; count: number }[];
  /** 전이 간선에 센 이벤트 수 */
  moves: number;
}

/**
 * (prev, event) 쌍을 상태 전이 그림으로 옮긴다.
 * - 상태가 된 이벤트(waiting·active·completed …)는 prev 상태 → 그 상태 간선이다. prev가 없으면 "새 작업"에서 온 것이다.
 * - added는 "새 작업" 노드의 배지, stalled는 처리 중 → 대기로 되돌아간 빨간 간선과 처리 중 노드의 배지, retries-exhausted는 실패 노드의 배지다.
 * - 나머지 이벤트는 `other`에 센다.
 */
export function buildTransitions(t: Pick<KvBullTransitions, "pairs">): TransitionModel {
  const merged = new Map<string, TransitionEdge>();
  const badges: TransitionModel["badges"] = {};
  const other = new Map<string, number>();
  let moves = 0;
  let stalled = 0;
  const badge = (id: TransitionNodeId, b: TransitionBadge) => (badges[id] = [...(badges[id] ?? []), b]);

  for (const { prev, event, count } of t.pairs) {
    if (event === "added") {
      badge("new", { label: "추가", count, tone: "warn" });
      // 배지는 한 번만 만든다: 같은 이벤트의 다른 prev는 합친다
    } else if (event === "stalled") stalled += count;
    else if (event === "retries-exhausted") badge("failed", { label: "재시도 소진", count, tone: "bad" });
    else if (STATE_EVENTS.has(event)) {
      const to = event as TransitionNodeId;
      const from = normalizeState(prev) ?? "new";
      if (from === to) continue;
      const id = `${from}>${to}`;
      const old = merged.get(id);
      merged.set(id, old ? { ...old, count: old.count + count } : { id, from, to, count, tone: to === "failed" ? "bad" : to === "completed" ? "good" : "dim", stalled: false });
      moves += count;
    } else other.set(event, (other.get(event) ?? 0) + count);
  }
  if (stalled > 0) {
    badge("active", { label: "정체", count: stalled, tone: "bad" });
    merged.set("stalled", { id: "stalled", from: "active", to: "waiting", count: stalled, tone: "bad", stalled: true });
  }
  // added·retries-exhausted 배지는 prev가 다른 항목이 여럿일 수 있어 같은 이름끼리 합친다
  for (const id of Object.keys(badges) as TransitionNodeId[]) {
    const byLabel = new Map<string, TransitionBadge>();
    for (const b of badges[id]!) byLabel.set(b.label, { ...b, count: (byLabel.get(b.label)?.count ?? 0) + b.count });
    badges[id] = [...byLabel.values()];
  }
  return {
    edges: [...merged.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
    badges,
    other: [...other].map(([event, count]) => ({ event, count })).sort((a, b) => b.count - a.count || a.event.localeCompare(b.event)),
    moves,
  };
}

/** 간선 굵기: 가장 많은 간선이 6, 가장 적은 간선이 1.5 근처가 되게 로그 눈금으로 */
export function edgeWidth(count: number, max: number): number {
  if (max <= 0) return 1.5;
  return 1.5 + (4.5 * Math.log(count + 1)) / Math.log(max + 1);
}

export type WindowNote = { kind: "trimmed"; minutes: number } | { kind: "truncated"; events: number } | { kind: "empty" } | null;

/** 이 구간 끝(to) 기준으로 이벤트를 모두 읽지 못한 이유를 알린다 */
export function windowNotes(t: Pick<KvBullTransitions, "from" | "to" | "firstAt" | "events" | "truncated">): WindowNote[] {
  const notes: WindowNote[] = [];
  if (t.events === 0) notes.push({ kind: "empty" });
  // 첫 이벤트가 구간 시작보다 1분 넘게 뒤면 스트림이 잘렸거나(maxLen) 그 전에는 이벤트가 없었다
  if (t.firstAt !== null && t.firstAt - t.from > 60_000) notes.push({ kind: "trimmed", minutes: Math.max(1, Math.round((t.to - t.firstAt) / 60_000)) });
  if (t.truncated) notes.push({ kind: "truncated", events: t.events });
  return notes;
}
