import type { KvClient, KvNode, KvNodeInfo, KvOverview } from "../types";

export interface TopoNode {
  address: string;
  role: "primary" | "replica";
  slots: string | null;
  usedMemory: number | null;
  maxMemory: number | null;
  opsPerSec: number | null;
  /** 이 노드에 붙은 클라이언트 연결 수(CLIENT LIST). 읽지 못했으면 null */
  connections: number | null;
  /** 복제 지연(초). 기본 노드는 null */
  lagSeconds: number | null;
}
export interface TopoGroup {
  id: string;
  /** "샤드 0001", "복제 그룹", "서버리스" */
  label: string;
  /** 기본 노드가 맨 앞 */
  nodes: TopoNode[];
}
export interface TopoHost {
  id: string;
  /** 클라이언트 주소에서 포트를 뺀 것. 접힌 호스트는 "기타 N호스트" */
  label: string;
  connections: number;
  /** CLIENT SETNAME으로 붙은 이 앱의 연결이 있다 */
  own: boolean;
  /** 접어 둔 호스트 수(접힌 노드면 1보다 크다) */
  folded: number;
  /** 노드 주소 → 그 호스트가 그 노드에 연 연결 수 */
  links: { node: string; count: number }[];
}
export interface ClusterTopology {
  groups: TopoGroup[];
  hosts: TopoHost[];
  /** CLIENT LIST를 읽었나(서버리스·권한 없음이면 false: 호스트 없음) */
  clientsKnown: boolean;
}

/** 클라이언트 호스트를 몇 개까지 따로 그리나. 나머지는 하나로 접는다 */
export const TOP_HOSTS = 20;

/** "10.0.4.7:51000" → "10.0.4.7"; "[::1]:5000" → "::1". 포트가 없으면 그대로 */
export function hostOf(addr: string): string {
  if (addr.startsWith("[")) return addr.slice(1, addr.indexOf("]"));
  const at = addr.lastIndexOf(":");
  return at > 0 && addr.indexOf(":") === at ? addr.slice(0, at) : addr;
}

const groupLabel = (mode: KvOverview["mode"], shard: string | null) => (shard !== null ? `샤드 ${shard}` : mode === "serverless" ? "서버리스" : "복제 그룹");

/**
 * 토폴로지 그림의 재료: 샤드(클러스터 모드가 아니면 복제 그룹 하나)마다 기본 노드와 복제 노드, 그리고 클라이언트 호스트.
 * 호스트는 연결이 많은 순 상위 TOP_HOSTS개만 따로 두고 나머지는 하나로 접는다. clients가 null이면 호스트가 없다.
 */
export function buildClusterTopology(overview: Pick<KvOverview, "mode" | "nodes" | "info">, clients: readonly KvClient[] | null): ClusterTopology {
  const infoOf = new Map<string, KvNodeInfo>(overview.info.map((i) => [i.node, i]));
  const conns = new Map<string, number>();
  for (const c of clients ?? []) conns.set(c.node, (conns.get(c.node) ?? 0) + 1);

  const toNode = (n: KvNode): TopoNode => {
    const i = infoOf.get(n.address);
    return {
      address: n.address,
      role: n.role,
      slots: n.slots,
      usedMemory: i?.usedMemory ?? null,
      maxMemory: i?.maxMemory ?? null,
      opsPerSec: i?.opsPerSec ?? null,
      connections: clients === null ? null : (conns.get(n.address) ?? 0),
      lagSeconds: n.role === "replica" ? (i?.replicationLagSeconds ?? null) : null,
    };
  };
  const groups = new Map<string, TopoGroup>();
  for (const n of overview.nodes) {
    const id = n.shard ?? "_";
    const g = groups.get(id) ?? { id, label: groupLabel(overview.mode, n.shard), nodes: [] };
    g.nodes.push(toNode(n));
    groups.set(id, g);
  }
  for (const g of groups.values()) g.nodes.sort((a, b) => (a.role === b.role ? a.address.localeCompare(b.address) : a.role === "primary" ? -1 : 1));
  const ordered = [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));

  if (clients === null) return { groups: ordered, hosts: [], clientsKnown: false };

  const byHost = new Map<string, { connections: number; own: boolean; links: Map<string, number> }>();
  for (const c of clients) {
    const host = hostOf(c.addr);
    const h = byHost.get(host) ?? { connections: 0, own: false, links: new Map<string, number>() };
    h.connections++;
    h.own = h.own || c.own;
    h.links.set(c.node, (h.links.get(c.node) ?? 0) + 1);
    byHost.set(host, h);
  }
  const sorted = [...byHost].sort(([ha, a], [hb, b]) => b.connections - a.connections || ha.localeCompare(hb, "en", { numeric: true }));
  const toHost = ([host, h]: [string, (typeof sorted)[number][1]]): TopoHost => ({
    id: `host:${host}`, label: host, connections: h.connections, own: h.own, folded: 1, links: [...h.links].map(([node, count]) => ({ node, count })),
  });
  const hosts = sorted.slice(0, TOP_HOSTS).map(toHost);
  const rest = sorted.slice(TOP_HOSTS);
  if (rest.length > 0) {
    const links = new Map<string, number>();
    for (const [, h] of rest) for (const [node, count] of h.links) links.set(node, (links.get(node) ?? 0) + count);
    hosts.push({ id: "host:*", label: `기타 ${rest.length}호스트`, connections: rest.reduce((s, [, h]) => s + h.connections, 0), own: rest.some(([, h]) => h.own), folded: rest.length, links: [...links].map(([node, count]) => ({ node, count })) });
  }
  return { groups: ordered, hosts, clientsKnown: true };
}
