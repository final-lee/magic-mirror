// 클라이언트 지도의 재료: 호스트 → 연결 이름(BullMQ·Bull 연결은 큐 이름으로 푼다) → 노드. 순수 함수라 시험하기 쉽다.
import type { KvClient } from "../types";
import { hostOf, TOP_HOSTS } from "./clusterModel";

/** 연결 이름 묶음을 몇 개까지 따로 그리나. 나머지는 하나로 접는다 */
export const TOP_NAMES = 24;

export interface ClientMapNode {
  id: string;
  kind: "host" | "name" | "node";
  label: string;
  connections: number;
  /** 이름 묶음: 연결을 연 호스트 수 */
  hosts: number;
  /** 이 앱의 연결이 들어 있다 */
  own: boolean;
  /** 이름 묶음: Bull 연결(큐 이름으로 푼 것) */
  bull: boolean;
  /** 접어서 하나로 그린 수(호스트·이름). 접지 않았으면 1 */
  folded: number;
  /** 마우스를 올리면 보이는 원래 이름들(이름 묶음) */
  raw: string[];
}
export interface ClientMapEdge {
  id: string;
  from: string;
  to: string;
  count: number;
}
export interface ClientMap {
  nodes: ClientMapNode[];
  edges: ClientMapEdge[];
  /** 노드가 둘 이상이라 노드 열을 그린다 */
  showNodes: boolean;
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Bull 연결 이름(`<prefix>:<base64(큐)>`, 워커는 뒤에 `:w:<워커 이름>`)이면 큐 이름, 아니면 null.
 * base64로 읽히는 평범한 이름을 잘못 풀지 않게, 다시 인코딩해 같고 출력할 수 있는 UTF-8일 때만 받는다.
 */
export function bullQueueOf(name: string): string | null {
  const m = /^(.+?):([^:]+)(?::w:.*)?$/.exec(name);
  if (!m || !B64.test(m[2]) || m[2].length % 4 !== 0) return null;
  try {
    const bytes = Uint8Array.from(atob(m[2]), (ch) => ch.charCodeAt(0));
    const queue = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // 제어 문자가 있으면 큐 이름이 아니다
    // eslint-disable-next-line no-control-regex
    if (queue.length === 0 || /[\u0000-\u001f\u007f\ufffd]/.test(queue)) return null;
    return queue;
  } catch {
    return null;
  }
}

interface Bucket {
  connections: number;
  own: boolean;
  links: Map<string, number>;
}

const add = (map: Map<string, Bucket>, key: string, c: KvClient, to: string) => {
  const b = map.get(key) ?? { connections: 0, own: false, links: new Map<string, number>() };
  b.connections++;
  b.own = b.own || c.own;
  b.links.set(to, (b.links.get(to) ?? 0) + 1);
  map.set(key, b);
};

/** 연결이 많은 순(같으면 이름순)으로 위 limit개, 나머지는 하나로 */
function topWithRest(map: Map<string, Bucket>, limit: number): { kept: [string, Bucket][]; rest: [string, Bucket][] } {
  const sorted = [...map].sort(([ka, a], [kb, b]) => b.connections - a.connections || ka.localeCompare(kb, "en", { numeric: true }));
  return { kept: sorted.slice(0, limit), rest: sorted.slice(limit) };
}

/**
 * 호스트(포트를 뺀 주소) → 연결 이름 묶음 → 노드의 연결 수. Bull 연결은 같은 큐끼리 묶는다(생산자·워커 모두).
 * 노드가 하나뿐이면 노드 열은 그리지 않는다. 호스트는 TOP_HOSTS개, 이름은 TOP_NAMES개까지 따로 두고 나머지는 하나로 접는다.
 */
export function buildClientMap(clients: readonly KvClient[]): ClientMap {
  const nameKey = new Map<KvClient, { key: string; label: string; bull: boolean }>();
  for (const c of clients) {
    const queue = c.name ? bullQueueOf(c.name) : null;
    nameKey.set(c, queue !== null ? { key: `bull:${queue}`, label: queue, bull: true } : c.name ? { key: `name:${c.name}`, label: c.name, bull: false } : { key: "none", label: "이름 없음", bull: false });
  }

  const names = new Map<string, Bucket>();
  const nameHosts = new Map<string, Set<string>>();
  const rawNames = new Map<string, Set<string>>();
  for (const c of clients) {
    const n = nameKey.get(c)!;
    add(names, n.key, c, c.node);
    nameHosts.set(n.key, (nameHosts.get(n.key) ?? new Set()).add(hostOf(c.addr)));
    if (c.name) rawNames.set(n.key, (rawNames.get(n.key) ?? new Set()).add(c.name));
  }
  const keptNames = topWithRest(names, TOP_NAMES);
  const nameId = new Map<string, string>();
  for (const [key] of keptNames.kept) nameId.set(key, `name:${key}`);
  for (const [key] of keptNames.rest) nameId.set(key, "name:*");

  const hosts = new Map<string, Bucket>();
  for (const c of clients) add(hosts, hostOf(c.addr), c, nameId.get(nameKey.get(c)!.key)!);
  const keptHosts = topWithRest(hosts, TOP_HOSTS);
  const hostId = new Map<string, string>();
  for (const [host] of keptHosts.kept) hostId.set(host, `host:${host}`);
  for (const [host] of keptHosts.rest) hostId.set(host, "host:*");

  const nodes: ClientMapNode[] = [];
  const base = { hosts: 0, own: false, bull: false, folded: 1, raw: [] as string[] };
  for (const [host, b] of keptHosts.kept) nodes.push({ ...base, id: `host:${host}`, kind: "host", label: host, connections: b.connections, own: b.own });
  if (keptHosts.rest.length > 0) {
    nodes.push({ ...base, id: "host:*", kind: "host", label: `기타 ${keptHosts.rest.length}호스트`, connections: keptHosts.rest.reduce((s, [, b]) => s + b.connections, 0), own: keptHosts.rest.some(([, b]) => b.own), folded: keptHosts.rest.length });
  }
  const labelOf = new Map([...nameKey.values()].map((n) => [n.key, n]));
  for (const [key, b] of keptNames.kept) {
    const n = labelOf.get(key)!;
    nodes.push({ ...base, id: `name:${key}`, kind: "name", label: n.label, bull: n.bull, connections: b.connections, own: b.own, hosts: nameHosts.get(key)!.size, raw: [...(rawNames.get(key) ?? [])].sort() });
  }
  if (keptNames.rest.length > 0) {
    const restHosts = new Set(keptNames.rest.flatMap(([key]) => [...nameHosts.get(key)!]));
    nodes.push({ ...base, id: "name:*", kind: "name", label: `기타 이름 ${keptNames.rest.length}개`, connections: keptNames.rest.reduce((s, [, b]) => s + b.connections, 0), own: keptNames.rest.some(([, b]) => b.own), hosts: restHosts.size, folded: keptNames.rest.length });
  }

  // 간선: 접힌 것끼리 합친다
  const edges = new Map<string, ClientMapEdge>();
  const link = (from: string, to: string, count: number) => {
    const id = `${from}>${to}`;
    const e = edges.get(id) ?? { id, from, to, count: 0 };
    e.count += count;
    edges.set(id, e);
  };
  for (const [host, b] of hosts) for (const [to, count] of b.links) link(hostId.get(host)!, to, count);

  const serverNodes = new Map<string, number>();
  for (const c of clients) serverNodes.set(c.node, (serverNodes.get(c.node) ?? 0) + 1);
  const showNodes = serverNodes.size > 1;
  if (showNodes) {
    for (const [address, count] of [...serverNodes].sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))) {
      nodes.push({ ...base, id: `node:${address}`, kind: "node", label: address, connections: count, own: clients.some((c) => c.own && c.node === address) });
    }
    for (const [key, b] of names) for (const [node, count] of b.links) link(nameId.get(key)!, `node:${node}`, count);
  }
  return { nodes, edges: [...edges.values()], showNodes };
}
