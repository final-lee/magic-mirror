import { IN_CLUSTER } from "../argoGroup";
import type { ArgoAppRow, ArgoDestination, ArgoTreeNode } from "../types";
import type { PodReading, PodRef } from "./types";

/** 리소스 트리의 Pod(코어 그룹의 Pod, 네임스페이스가 있는 것)를 사용량을 물을 대상으로 */
export function podsOfTree(nodes: Pick<ArgoTreeNode, "group" | "kind" | "namespace" | "name">[]): PodRef[] {
  return nodes.filter((n) => n.group === "" && n.kind === "Pod" && n.namespace !== null).map((n) => ({ namespace: n.namespace as string, name: n.name }));
}

/** 목록 행의 대상: `values.destination`은 클러스터 이름이거나 서버 주소다 */
export function destinationOf(row: ArgoAppRow): Pick<ArgoDestination, "server" | "name" | "inCluster"> {
  const destination = row.values.destination ?? "";
  const isServer = /^https?:\/\//i.test(destination);
  return { server: isServer ? destination : null, name: !isServer && destination !== "" ? destination : null, inCluster: IN_CLUSTER.includes(destination) };
}

export interface UsageSum {
  /** 앱의 Pod 수와, 그중 metrics-server가 사용량을 준 수 */
  pods: number;
  reporting: number;
  cpuMilli: number;
  memoryBytes: number;
  /** 사용량을 준 Pod 모두가 값을 가졌을 때만 합한다(일부만의 합은 사용량과 견줄 수 없다) */
  cpuRequest: number | null;
  cpuLimit: number | null;
  memoryRequest: number | null;
  memoryLimit: number | null;
}

const total = (pods: PodReading[], pick: (p: PodReading) => number | null): number | null => {
  if (pods.length === 0) return null;
  let sum = 0;
  for (const pod of pods) {
    const value = pick(pod);
    if (value === null) return null;
    sum += value;
  }
  return sum;
};

/** 앱의 Pod 사용량 합과 요청·제한 합 */
export function sumUsage(pods: PodReading[]): UsageSum {
  const reporting = pods.filter((p) => p.cpuMilli !== null && p.memoryBytes !== null);
  return {
    pods: pods.length,
    reporting: reporting.length,
    cpuMilli: reporting.reduce((a, p) => a + (p.cpuMilli as number), 0),
    memoryBytes: reporting.reduce((a, p) => a + (p.memoryBytes as number), 0),
    cpuRequest: total(reporting, (p) => p.bounds.cpuRequest),
    cpuLimit: total(reporting, (p) => p.bounds.cpuLimit),
    memoryRequest: total(reporting, (p) => p.bounds.memoryRequest),
    memoryLimit: total(reporting, (p) => p.bounds.memoryLimit),
  };
}

export interface UsageRow {
  key: string;
  namespace: string;
  name: string;
  sum: UsageSum;
}

/** 위에서 `limit`개: 큰 것부터, 같으면 이름 순 */
export function topUsage(rows: UsageRow[], by: "cpuMilli" | "memoryBytes", limit: number): UsageRow[] {
  return [...rows].sort((a, b) => b.sum[by] - a.sum[by] || a.key.localeCompare(b.key)).slice(0, limit);
}
