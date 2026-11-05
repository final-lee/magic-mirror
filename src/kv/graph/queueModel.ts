import { BACKLOG_WARN, type Attention } from "../bull";
import type { KvBullCounts, KvBullTopology } from "../types";

export interface MapQueueNode {
  kind: "queue";
  id: string;
  name: string;
  paused: boolean;
  flavor: "bullmq" | "bull";
  counts: KvBullCounts;
  /** 이 큐의 워커 수. 워커를 읽지 못했으면 null */
  workers: number | null;
  attention: Attention;
}
export interface MapHostNode {
  kind: "host";
  id: string;
  host: string;
  workers: number;
  queues: string[];
}
export type MapNode = MapQueueNode | MapHostNode;
export interface MapEdge {
  id: string;
  from: string;
  to: string;
  /** 부모→자식 큐 연결이면 이어진 작업 수, 워커 호스트→큐면 그 호스트에서 그 큐를 맡은 워커 수 */
  value: number;
  kind: "link" | "worker";
}
export interface QueueMap {
  nodes: MapNode[];
  edges: MapEdge[];
  /** 워커를 읽을 수 있었나(false면 호스트 노드가 없다) */
  workersKnown: boolean;
}

export const queueNodeId = (name: string) => `q:${name}`;
export const hostNodeId = (host: string) => `h:${host}`;

/** 카드와 같은 기준의 건강 상태를 이 지도의 정보(수·워커)만으로 정한다: 대기가 있는데 워커가 0이면 위험, 일시정지에 일이 있거나 대기가 쌓였으면 주의 */
export function mapAttention(counts: KvBullCounts, paused: boolean, workers: number | null): Attention {
  const backlog = counts.wait + counts.prioritized;
  if (!paused && backlog > 0 && workers === 0) return "danger";
  if (backlog >= BACKLOG_WARN || (paused && backlog + counts.paused > 0)) return "warn";
  return null;
}

/**
 * 큐 지도의 노드와 간선. 큐 노드, 부모→자식 큐 연결(작업 수), 워커 호스트(호스트마다 한 노드, 워커 수)와
 * 호스트→맡은 큐 연결. attention을 주면(카드가 계산한 건강 상태, 최근 처리량까지 본 것) 그것을 쓴다.
 */
export function buildQueueMap(topology: KvBullTopology, attention?: ReadonlyMap<string, Attention>): QueueMap {
  const workersKnown = topology.workers !== null;
  const byQueue = new Map<string, number>();
  const byHost = new Map<string, { workers: number; queues: Map<string, number> }>();
  for (const w of topology.workers ?? []) {
    byQueue.set(w.queue, (byQueue.get(w.queue) ?? 0) + 1);
    const host = byHost.get(w.host) ?? { workers: 0, queues: new Map<string, number>() };
    host.workers++;
    host.queues.set(w.queue, (host.queues.get(w.queue) ?? 0) + 1);
    byHost.set(w.host, host);
  }
  const names = new Set(topology.queues.map((q) => q.name));
  const nodes: MapNode[] = topology.queues.map((q) => {
    const workers = workersKnown ? (byQueue.get(q.name) ?? 0) : null;
    return { kind: "queue", id: queueNodeId(q.name), name: q.name, paused: q.paused, flavor: q.flavor, counts: q.counts, workers, attention: attention?.get(q.name) ?? mapAttention(q.counts, q.paused, workers) };
  });
  const edges: MapEdge[] = [];
  for (const l of topology.links) {
    if (names.has(l.from) && names.has(l.to) && l.from !== l.to) edges.push({ id: `link:${l.from}>${l.to}`, from: queueNodeId(l.from), to: queueNodeId(l.to), value: l.jobs, kind: "link" });
  }
  // 호스트는 이름순으로(지도가 새로 읽을 때마다 흔들리지 않게)
  for (const [host, info] of [...byHost].sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))) {
    const queues = [...info.queues.keys()].filter((q) => names.has(q)).sort();
    nodes.push({ kind: "host", id: hostNodeId(host), host, workers: info.workers, queues });
    for (const q of queues) edges.push({ id: `worker:${host}>${q}`, from: hostNodeId(host), to: queueNodeId(q), value: info.queues.get(q)!, kind: "worker" });
  }
  return { nodes, edges, workersKnown };
}
