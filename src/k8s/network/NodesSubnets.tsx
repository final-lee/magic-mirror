import type { RefObject } from "react";
import { ListFind, useListFind } from "../../components/ListFind";
import { fuzzyKeep } from "../../lib/fuzzy";
import { NODES } from "../kinds";
import type { ObjectRef } from "../types";
import { Section } from "./Detail";
import { subnetLabel, subnetUnused } from "./logic";
import {
  DASH, FARGATE, FARGATE_TITLE, H_CIDR, H_FREE_IPS, H_INSTANCE, H_INSTANCE_STATE, H_INSTANCE_TYPE, H_INTERNAL_IP, H_NODE, H_NODE_COUNT, H_POD_COUNT, H_READY,
  H_SUBNET, H_ZONE, NET_NO_MATCH, NODES_EMPTY, NODES_FILTER_PLACEHOLDER, NODES_TABLE_LABEL, NODES_TITLE, NOT_READY, READY, SUBNET_NOTE, SUBNETS_EMPTY, SUBNETS_TABLE_LABEL, SUBNETS_TITLE,
  UNUSED_SUBNET, freeIps, openLink,
} from "./text";
import type { Network, NodeNet, SubnetNet } from "./types";

interface Props {
  network: Network;
  onOpenObject: (ref: ObjectRef) => void;
  /** ⌘F를 받는 상자: 이 목록을 감싼 네트워크 화면 */
  host: RefObject<HTMLElement>;
}

/** 노드가 놓인 서브넷의 표시 이름. 서브넷 표에 있으면 이름과 ID, 없으면 ID만 */
function subnetOf(n: NodeNet, subnets: SubnetNet[] | null): string {
  if (!n.subnetId) return DASH;
  const s = subnets?.find((x) => x.id === n.subnetId);
  return s ? subnetLabel(s) : n.subnetId;
}

/** 노드 → EC2 인스턴스 → 서브넷·AZ, 그리고 서브넷별 노드 수와 남은 IP */
export function NodesSubnets({ network, onOpenObject, host }: Props) {
  const find = useListFind(host);
  const { subnets } = network;
  // ⌘F는 노드 표와 서브넷 표를 함께 거른다
  const nodes = network.nodes && fuzzyKeep(network.nodes, find.query, (n) => [n.name, n.instanceId, n.instanceType, n.instanceState, n.zone, subnetOf(n, subnets), n.internalIp]);
  const shownSubnets = subnets && fuzzyKeep(subnets, find.query, (s) => [subnetLabel(s), s.zone, ...s.cidrs]);
  const total = (nodes?.length ?? 0) + (shownSubnets?.length ?? 0);
  return (
    <div className="net-scroll">
      <ListFind find={find} placeholder={NODES_FILTER_PLACEHOLDER} count={total} />
      {nodes && (
        <Section title={NODES_TITLE}>
          {nodes.length === 0 ? (
            <p className="dim">{network.nodes?.length ? NET_NO_MATCH : NODES_EMPTY}</p>
          ) : (
            <table className="k8s-table" aria-label={NODES_TABLE_LABEL}>
              <thead>
                <tr>
                  <th>{H_NODE}</th><th>{H_READY}</th><th>{H_INSTANCE}</th><th>{H_INSTANCE_TYPE}</th><th>{H_INSTANCE_STATE}</th><th>{H_ZONE}</th><th>{H_SUBNET}</th><th>{H_INTERNAL_IP}</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((n) => (
                  <tr key={n.name}>
                    <td>
                      <button className="link mono tone-nav" aria-label={openLink("Node", n.name)} title={openLink("Node", n.name)} onClick={() => onOpenObject({ kind: NODES, namespace: null, name: n.name })}>
                        {n.name}
                      </button>
                    </td>
                    <td><span className={`net-chip ${n.ready ? "ok" : "bad"}`}>{n.ready ? READY : NOT_READY}</span></td>
                    <td className="mono">
                      {n.instanceId ?? (n.fargate ? <span className="dim" title={FARGATE_TITLE}>{FARGATE}</span> : DASH)}
                    </td>
                    <td>{n.instanceType ?? DASH}</td>
                    <td>{n.instanceState ?? DASH}</td>
                    <td>{n.zone ?? DASH}</td>
                    <td className="mono">{subnetOf(n, subnets)}</td>
                    <td className="mono">{n.internalIp ?? DASH}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      )}
      {subnets && (
        <Section title={SUBNETS_TITLE}>
          {shownSubnets?.length === 0 ? (
            <p className="dim">{subnets.length ? NET_NO_MATCH : SUBNETS_EMPTY}</p>
          ) : (
            <>
              <table className="k8s-table" aria-label={SUBNETS_TABLE_LABEL}>
                <thead>
                  <tr>
                    <th>{H_SUBNET}</th><th>{H_ZONE}</th><th>{H_CIDR}</th><th>{H_FREE_IPS}</th><th>{H_NODE_COUNT}</th><th>{H_POD_COUNT}</th>
                  </tr>
                </thead>
                <tbody>
                  {shownSubnets?.map((s) => (
                    <tr key={s.id} className={subnetUnused(s) ? "net-unused" : undefined} title={subnetUnused(s) ? UNUSED_SUBNET : undefined}>
                      <td className="mono">{subnetLabel(s)}</td>
                      <td>{s.zone ?? DASH}</td>
                      <td className="mono">{s.cidrs.join(", ")}</td>
                      <td>{freeIps(s.availableIps, s.capacity)}</td>
                      <td>{s.nodeCount}</td>
                      <td>{s.podCount ?? DASH}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="dim">{SUBNET_NOTE}</p>
            </>
          )}
        </Section>
      )}
    </div>
  );
}
