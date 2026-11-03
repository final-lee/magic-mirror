import { targetKey } from "./targets";
import { METRICS_INTERVAL_MS, podKey } from "./usage";
import type { K8sMetrics, K8sMetricsUnavailable, K8sOwnerRef, K8sTarget, ObjectRef } from "./types";

/**
 * 사용량 그래프의 기록. Prometheus 없이 metrics-server의 현재 값을 앱이 직접 모아 둔다.
 * 연결된 동안 모은 값만 있고 앱을 끄면 사라진다. 메모리를 아끼려고 최근 HISTORY_MS만 남긴다.
 */

/** 그래프에 남기는 기간 */
export const HISTORY_MS = 60 * 60_000;
/** 같은 클러스터를 여러 화면이 함께 읽어도 이 간격 안의 값은 한 번만 남긴다 */
const MIN_GAP_MS = 10_000;
/** 이보다 오래 값이 비면(연결이 끊겼던 동안) 그래프 선을 잇지 않는다 */
const GAP_MS = METRICS_INTERVAL_MS * 3;

/** 그래프 선 하나: [시각(ms), 값]. CPU는 코어, 메모리는 바이트 */
export interface UsageSeries {
  name: string;
  points: [number, number][];
}

export interface UsageView {
  cpu: UsageSeries[];
  memory: UsageSeries[];
  /** 마지막으로 모은 시각. 아직 모은 적이 없으면 null */
  lastAt: number | null;
  /** 마지막으로 읽었을 때 이 객체의 사용량(Pod 또는 노드)을 읽지 못한 까닭 */
  unavailable: K8sMetricsUnavailable | null;
}

interface Track {
  at: number[];
  cpu: number[];
  memory: number[];
}

interface PodTrack {
  namespace: string;
  name: string;
  owners: K8sOwnerRef[];
  total: Track;
  containers: Map<string, Track>;
}

interface History {
  lastAt: number | null;
  podsUnavailable: K8sMetricsUnavailable | null;
  nodesUnavailable: K8sMetricsUnavailable | null;
  /** 키: podKey */
  pods: Map<string, PodTrack>;
  /** 키: 노드 이름 */
  nodes: Map<string, Track>;
  /** 값이 바뀔 때마다 늘어난다. 화면이 다시 그릴 때를 안다 */
  version: number;
}

const histories = new Map<string, History>();
const listeners = new Map<string, Set<() => void>>();

/** 클러스터와 context마다 따로 모은다 */
export const historyKey = (target: K8sTarget, context: string) => `${targetKey(target)}|${context}`;

const emptyTrack = (): Track => ({ at: [], cpu: [], memory: [] });

function push(track: Track, at: number, cpuMilli: number, memoryBytes: number) {
  track.at.push(at);
  track.cpu.push(cpuMilli / 1000);
  track.memory.push(memoryBytes);
}

/** from보다 오래된 값을 버린다. 남은 값이 없으면 true */
function trim(track: Track, from: number): boolean {
  let drop = 0;
  while (drop < track.at.length && track.at[drop] < from) drop += 1;
  if (drop > 0) {
    track.at.splice(0, drop);
    track.cpu.splice(0, drop);
    track.memory.splice(0, drop);
  }
  return track.at.length === 0;
}

function notify(key: string) {
  listeners.get(key)?.forEach((listener) => listener());
}

/** 읽은 사용량 한 번을 기록에 더한다. 직전 기록과 너무 가깝거나 더 오래된 값은 버린다. */
export function recordUsage(key: string, at: number, metrics: K8sMetrics) {
  let history = histories.get(key);
  if (!history) {
    history = { lastAt: null, podsUnavailable: null, nodesUnavailable: null, pods: new Map(), nodes: new Map(), version: 0 };
    histories.set(key, history);
  }
  if (history.lastAt !== null && at - history.lastAt < MIN_GAP_MS) return;
  history.lastAt = at;
  history.podsUnavailable = metrics.podsUnavailable;
  history.nodesUnavailable = metrics.nodesUnavailable;
  for (const pod of metrics.pods) {
    const id = podKey(pod.namespace, pod.name);
    let track = history.pods.get(id);
    if (!track) {
      track = { namespace: pod.namespace, name: pod.name, owners: pod.owners, total: emptyTrack(), containers: new Map() };
      history.pods.set(id, track);
    }
    track.owners = pod.owners;
    push(track.total, at, pod.cpuMilli, pod.memoryBytes);
    for (const container of pod.containers) {
      let containerTrack = track.containers.get(container.name);
      if (!containerTrack) {
        containerTrack = emptyTrack();
        track.containers.set(container.name, containerTrack);
      }
      push(containerTrack, at, container.cpuMilli, container.memoryBytes);
    }
  }
  for (const node of metrics.nodes) {
    let track = history.nodes.get(node.name);
    if (!track) {
      track = emptyTrack();
      history.nodes.set(node.name, track);
    }
    push(track, at, node.cpuMilli, node.memoryBytes);
  }
  const from = at - HISTORY_MS;
  for (const [id, track] of history.pods) {
    for (const [name, containerTrack] of track.containers) {
      if (trim(containerTrack, from)) track.containers.delete(name);
    }
    if (trim(track.total, from)) history.pods.delete(id);
  }
  for (const [name, track] of history.nodes) {
    if (trim(track, from)) history.nodes.delete(name);
  }
  history.version += 1;
  notify(key);
}

/** 대상 탭을 닫으면 그 대상의 기록을 모두 버린다 */
export function forgetUsage(target: K8sTarget) {
  const prefix = `${targetKey(target)}|`;
  for (const key of [...histories.keys()]) {
    if (!key.startsWith(prefix)) continue;
    histories.delete(key);
    notify(key);
  }
}

export function subscribeUsage(key: string, listener: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

export const usageVersion = (key: string) => histories.get(key)?.version ?? 0;

/** 목록의 작은 그래프에 쓰는 Pod 합계 또는 노드 기록. 시각은 오래된 것부터, CPU는 코어, 메모리는 바이트. end는 마지막으로 모은 시각 */
export interface UsageTrend {
  at: readonly number[];
  cpu: readonly number[];
  memory: readonly number[];
  end: number;
}

function trendOf(history: History | undefined, track: Track | undefined): UsageTrend | null {
  if (!history || history.lastAt === null || !track) return null;
  return { at: track.at, cpu: track.cpu, memory: track.memory, end: history.lastAt };
}

export function podTrend(key: string, namespace: string, name: string): UsageTrend | null {
  const history = histories.get(key);
  return trendOf(history, history?.pods.get(podKey(namespace, name))?.total);
}

export function nodeTrend(key: string, name: string): UsageTrend | null {
  const history = histories.get(key);
  return trendOf(history, history?.nodes.get(name));
}

/** 값이 GAP_MS보다 오래 빈 곳에서 선을 끊는다 */
export function splitAtGaps(points: [number, number][]): [number, number][][] {
  const out: [number, number][][] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && point[0] - last[last.length - 1][0] <= GAP_MS) last.push(point);
    else out.push([point]);
  }
  return out;
}

function series(name: string, track: Track): [UsageSeries, UsageSeries] {
  return [
    { name, points: track.at.map((at, i) => [at, track.cpu[i]]) },
    { name, points: track.at.map((at, i) => [at, track.memory[i]]) },
  ];
}

/** Pod는 컨테이너별, 워크로드는 그 컨트롤러 사슬에 든 Pod별, 노드는 노드 하나의 선 */
export function usageOf(key: string, ref: ObjectRef): UsageView {
  const history = histories.get(key);
  const node = ref.kind.group === "" && ref.kind.kind === "Node";
  const unavailable = (node ? history?.nodesUnavailable : history?.podsUnavailable) ?? null;
  const view: UsageView = { cpu: [], memory: [], lastAt: history?.lastAt ?? null, unavailable };
  if (!history) return view;
  const lines: [UsageSeries, UsageSeries][] = [];
  if (node) {
    const track = history.nodes.get(ref.name);
    if (track) lines.push(series(ref.name, track));
  } else if (ref.namespace === null) {
    return view;
  } else if (ref.kind.group === "" && ref.kind.kind === "Pod") {
    const pod = history.pods.get(podKey(ref.namespace, ref.name));
    for (const [name, track] of pod?.containers ?? []) lines.push(series(name, track));
  } else {
    const pods = [...history.pods.values()]
      .filter((pod) => pod.namespace === ref.namespace && pod.owners.some((o) => o.kind === ref.kind.kind && o.name === ref.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const pod of pods) lines.push(series(pod.name, pod.total));
  }
  view.cpu = lines.map(([cpu]) => cpu);
  view.memory = lines.map(([, memory]) => memory);
  return view;
}

/** 시험에서 모듈 상태를 비운다 */
export function resetUsageHistory() {
  histories.clear();
  listeners.clear();
}
