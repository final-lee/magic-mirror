import type { AppError } from "../../api/types";
import { NODES, PODS } from "../kinds";
import type { ObjectRef } from "../types";
import {
  ANYWHERE, ANY_PORT, SECTION_LABELS, peerIp, peerNamespace, peerPod, subjectGap,
} from "./text";
import type { LbRow, LoadBalancerView, NetworkGap, NetworkSection, ObjectLink, Peer, PodNet, PolicyRule, PortRule, SubnetNet } from "./types";

/** 목록에서 행 하나를 가리키는 키 */
export const rowKey = (r: { kind: string; namespace: string; name: string }) => `${r.kind}/${r.namespace}/${r.name}`;

export interface HealthCounts {
  healthy: number;
  unhealthy: number;
  /** initial, draining, unused, unavailable */
  other: number;
}

/** 로드 밸런서의 모든 대상 그룹을 합친 대상 상태 개수. 같은 대상이 여러 그룹에 있으면 그룹마다 센다. */
export function healthCounts(lb: LoadBalancerView | null): HealthCounts {
  const counts: HealthCounts = { healthy: 0, unhealthy: 0, other: 0 };
  for (const g of lb?.targetGroups ?? []) {
    for (const t of g.targets) {
      if (t.state === "healthy") counts.healthy += 1;
      else if (t.state === "unhealthy") counts.unhealthy += 1;
      else counts.other += 1;
    }
  }
  return counts;
}

/** `HTTPS:443, HTTP:80` */
export const listenersText = (lb: LoadBalancerView | null) => (lb?.listeners ?? []).map((l) => `${l.protocol}:${l.port}`).join(", ");

/** 포트 한 줄: `TCP/8080`, `UDP/9000-9100`, 포트가 없으면 `TCP/모든 포트` */
export function portText(p: PortRule): string {
  const port = p.port === null ? ANY_PORT : p.endPort !== null ? `${p.port}-${p.endPort}` : p.port;
  return `${p.protocol}/${port}`;
}

export const portsText = (ports: PortRule[]) => (ports.length === 0 ? ANY_PORT : ports.map(portText).join(", "));

/**
 * 상대 한 줄. 한 항목 안의 pod·네임스페이스 셀렉터는 함께 적용된다(AND)고 `+`로 잇는다.
 * 네임스페이스 셀렉터 없이 Pod 셀렉터만 있으면 정책이 있는 네임스페이스의 Pod다.
 */
export function peerText(peer: Peer): string {
  if (peer.ipBlock) return peerIp(peer.ipBlock.cidr, peer.ipBlock.except);
  const parts: string[] = [];
  if (peer.namespaceSelector !== null) parts.push(peerNamespace(peer.namespaceSelector));
  if (peer.podSelector !== null) parts.push(peerPod(peer.podSelector));
  return parts.join(" + ") || ANYWHERE;
}

export type DirectionView =
  /** 정책이 이 방향을 다루지 않는다 */
  | { mode: "open" }
  /** 다루는데 허용 규칙이 없다 */
  | { mode: "deny" }
  | { mode: "rules"; rules: { allowAll: boolean; peers: string[]; ports: string }[] };

/** 방향 하나의 규칙 요약. `types`에 방향이 없으면 정책이 다루지 않는 방향이다. */
export function directionView(direction: "Ingress" | "Egress", types: string[], rules: PolicyRule[]): DirectionView {
  if (!types.includes(direction)) return { mode: "open" };
  if (rules.length === 0) return { mode: "deny" };
  return {
    mode: "rules",
    rules: rules.map((r) => ({ allowAll: r.peers.length === 0 && r.ports.length === 0, peers: r.peers.map(peerText), ports: portsText(r.ports) })),
  };
}

export interface GapGroup {
  /** 같은 이유로 읽지 못한 부분들 */
  labels: string[];
  sections: NetworkSection[];
  error: AppError;
}

/** 같은 이유로 읽지 못한 부분을 한 줄로 묶는다(AWS 설정을 못 읽으면 AWS 부분이 모두 같은 이유로 실패한다). */
export function groupGaps(gaps: NetworkGap[]): GapGroup[] {
  const groups = new Map<string, GapGroup>();
  for (const g of gaps) {
    const key = JSON.stringify(g.error);
    const label = g.subject ? subjectGap(g.subject, SECTION_LABELS[g.section]) : SECTION_LABELS[g.section];
    const group = groups.get(key) ?? { labels: [], sections: [], error: g.error };
    if (!group.sections.includes(g.section)) group.sections.push(g.section);
    if (!group.labels.includes(label)) group.labels.push(label);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Pod 찾기: 이름·네임스페이스·IP·노드·서브넷 ID 어디든 대소문자 무시 부분 일치 */
export function filterPods(items: PodNet[], query: string): PodNet[] {
  const q = query.trim().toLowerCase();
  if (q === "") return items;
  return items.filter((p) => [p.namespace, p.name, p.ip, p.node ?? "", p.subnetId ?? ""].some((v) => v.toLowerCase().includes(q)));
}

/** 서브넷 한 줄의 이름: Name 태그가 있으면 `이름 (ID)` */
export const subnetLabel = (s: { id: string; name: string | null }) => (s.name ? `${s.name} (${s.id})` : s.id);

/** 노드·Pod가 하나도 없는 서브넷 */
export const subnetUnused = (s: SubnetNet) => s.nodeCount === 0 && (s.podCount ?? 0) === 0;

/** 선택한 행의 로드 밸런서를 다이어그램에서 강조할 ID */
export const rowHighlight = (r: LbRow): string[] => (r.loadBalancer ? [r.loadBalancer.arn] : []);

/** 로드 밸런서 이름에서 마지막 호스트 조각을 줄여 보인다(긴 DNS 이름용) */
export function shortHost(host: string, max = 38): string {
  return host.length > max ? `${host.slice(0, max - 1)}…` : host;
}

/** 대상 그룹의 대상에서 이어진 쿠버네티스 객체(노드나 Pod). 다른 종류면 null */
export function refOfLink(link: ObjectLink): ObjectRef | null {
  if (link.kind === "Node") return { kind: NODES, namespace: null, name: link.name };
  if (link.kind === "Pod") return { kind: PODS, namespace: link.namespace, name: link.name };
  return null;
}
