import type { KvKeyspace, KvNodeInfo, KvOverview } from "./types";

/** 개요 카드에 쓰는 합계. 메모리·히트·초당 명령·키 같은 양은 기본 노드(primary)만 더한다: 복제 노드는 같은 데이터의 사본이다 */
export interface OverviewStats {
  usedMemory: number;
  usedMemoryPeak: number;
  /** 모든 기본 노드의 maxmemory를 알 때만 합(하나라도 없으면 null) */
  maxMemory: number | null;
  /** 기본 노드 가운데 가장 높은 단편화. 없으면 null */
  fragmentation: number | null;
  hits: number;
  misses: number;
  /** 히트율(0~1). 히트·미스가 모두 0이면 null */
  hitRatio: number | null;
  opsPerSec: number;
  connectedClients: number;
  evictedKeys: number;
  expiredKeys: number;
  /** 가장 최근에 시작한 노드의 가동 시간(초). 없으면 null */
  uptimeSeconds: number | null;
  /** 복제 노드 가운데 가장 큰 복제 지연(초). 복제 노드나 값이 없으면 null */
  replicationLagSeconds: number | null;
  /** 고른 DB 번호의 키 수(overview.dbsize)와 만료 설정 키 수 */
  expires: number;
}

/** 노드 표의 역할이 우선이고, 없으면 INFO의 role(replica·slave는 복제 노드)을 본다 */
const isPrimary = (info: KvNodeInfo, roles: ReadonlyMap<string, string>) => !(roles.get(info.node) === "replica" || info.role === "replica" || info.role === "slave");

export function summarize(overview: KvOverview): OverviewStats {
  const roles = new Map(overview.nodes.map((n) => [n.address, n.role]));
  const primaries = overview.info.filter((i) => isPrimary(i, roles));
  const replicas = overview.info.filter((i) => !isPrimary(i, roles));
  const sum = (pick: (i: KvNodeInfo) => number) => primaries.reduce((n, i) => n + pick(i), 0);
  const hits = sum((i) => i.hits);
  const misses = sum((i) => i.misses);
  const frags = primaries.flatMap((i) => (i.fragmentation === null ? [] : [i.fragmentation]));
  const lags = replicas.flatMap((i) => (i.replicationLagSeconds === null ? [] : [i.replicationLagSeconds]));
  const maxes = primaries.map((i) => i.maxMemory);
  return {
    usedMemory: sum((i) => i.usedMemory),
    usedMemoryPeak: sum((i) => i.usedMemoryPeak),
    maxMemory: maxes.length > 0 && maxes.every((m) => m !== null && m > 0) ? maxes.reduce<number>((n, m) => n + (m ?? 0), 0) : null,
    fragmentation: frags.length > 0 ? Math.max(...frags) : null,
    hits,
    misses,
    hitRatio: hits + misses > 0 ? hits / (hits + misses) : null,
    opsPerSec: sum((i) => i.opsPerSec),
    connectedClients: sum((i) => i.connectedClients),
    evictedKeys: sum((i) => i.evictedKeys),
    expiredKeys: sum((i) => i.expiredKeys),
    uptimeSeconds: overview.info.length > 0 ? Math.min(...overview.info.map((i) => i.uptimeSeconds)) : null,
    replicationLagSeconds: lags.length > 0 ? Math.max(...lags) : null,
    expires: sum((i) => i.keyspace.find((k) => k.db === overview.database)?.expires ?? 0),
  };
}

/** 기본 노드들의 키스페이스를 DB 번호별로 더한다(DB 번호 순) */
export function keyspaceTotals(overview: KvOverview): KvKeyspace[] {
  const roles = new Map(overview.nodes.map((n) => [n.address, n.role]));
  const totals = new Map<number, KvKeyspace>();
  for (const info of overview.info) {
    if (!isPrimary(info, roles)) continue;
    for (const k of info.keyspace) {
      const cur = totals.get(k.db) ?? { db: k.db, keys: 0, expires: 0 };
      totals.set(k.db, { db: k.db, keys: cur.keys + k.keys, expires: cur.expires + k.expires });
    }
  }
  return [...totals.values()].sort((a, b) => a.db - b.db);
}
