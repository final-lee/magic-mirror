import { type RefObject } from "react";
import { ListFind, useListFind } from "../../components/ListFind";
import { PODS } from "../kinds";
import type { ObjectRef } from "../types";
import { Section } from "./Detail";
import { filterPods, subnetLabel } from "./logic";
import {
  DASH, H_CIDR, H_FREE_IPS, H_HOST_NETWORK, H_IP, H_NAMESPACE, H_POD, H_POD_COUNT, H_SUBNET, H_ZONE, HOST_NETWORK_MARK, NOT_VPC_CNI,
  POD_FILTER_PLACEHOLDER, POD_IP_TITLE, PODS_EMPTY, PODS_PARTIAL, PODS_TABLE_LABEL, SUBNET_NOTE, SUBNETS_UNKNOWN, VPC_CNI_NOTE, freeIps, openLink, outsideNote,
  podsShown, H_NODE,
} from "./text";
import type { Network } from "./types";

/** 한 번에 그리는 Pod 행 수. 넘으면 찾기로 좁히게 한다 */
export const PODS_SHOWN_MAX = 300;

interface Props {
  network: Network;
  /** null이면 모든 네임스페이스 */
  namespace: string | null;
  onOpenObject: (ref: ObjectRef) => void;
  /** ⌘F를 받는 상자: 이 목록을 감싼 네트워크 화면 */
  host: RefObject<HTMLElement>;
}

/** VPC CNI의 Pod IP → 서브넷, 서브넷별 Pod 수와 남은 IP, Pod 목록 */
export function PodIps({ network, namespace, onOpenObject, host }: Props) {
  const find = useListFind(host);
  const pods = network.pods;
  if (!pods) return null;
  const subnets = network.subnets;
  const scoped = namespace === null ? pods.items : pods.items.filter((p) => p.namespace === namespace);
  const found = filterPods(scoped, find.query);
  const shown = found.slice(0, PODS_SHOWN_MAX);
  const names = new Map((subnets ?? []).map((s) => [s.id, subnetLabel(s)]));
  return (
    <div className="net-scroll">
      <p className="dim">{pods.vpcCni ? (subnets ? VPC_CNI_NOTE : SUBNETS_UNKNOWN) : NOT_VPC_CNI}</p>
      {pods.partial && <p className="dim">{PODS_PARTIAL}</p>}
      {pods.vpcCni && subnets && (
        <Section title={POD_IP_TITLE}>
          <table className="k8s-table" aria-label={POD_IP_TITLE}>
            <thead>
              <tr>
                <th>{H_SUBNET}</th><th>{H_ZONE}</th><th>{H_CIDR}</th><th>{H_POD_COUNT}</th><th>{H_FREE_IPS}</th>
              </tr>
            </thead>
            <tbody>
              {subnets
                .filter((s) => (s.podCount ?? 0) > 0 || s.nodeCount > 0)
                .map((s) => (
                  <tr key={s.id}>
                    <td className="mono">{subnetLabel(s)}</td>
                    <td>{s.zone ?? DASH}</td>
                    <td className="mono">{s.cidrs.join(", ")}</td>
                    <td>{s.podCount ?? DASH}</td>
                    <td>{freeIps(s.availableIps, s.capacity)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          <p className="dim">{SUBNET_NOTE}</p>
          {pods.outside > 0 && <p className="dim">{outsideNote(pods.outside)}</p>}
        </Section>
      )}
      <Section title={PODS_TABLE_LABEL}>
        <ListFind find={find} placeholder={POD_FILTER_PLACEHOLDER} count={found.length} />
        {found.length === 0 ? (
          <p className="dim">{PODS_EMPTY}</p>
        ) : (
          <table className="k8s-table" aria-label={PODS_TABLE_LABEL}>
            <thead>
              <tr>
                <th>{H_NAMESPACE}</th><th>{H_POD}</th><th>{H_IP}</th><th>{H_NODE}</th><th>{H_SUBNET}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={`${p.namespace}/${p.name}`}>
                  <td className="mono">{p.namespace}</td>
                  <td>
                    <button className="link mono tone-nav" aria-label={openLink("Pod", p.name)} title={openLink("Pod", p.name)} onClick={() => onOpenObject({ kind: PODS, namespace: p.namespace, name: p.name })}>
                      {p.name}
                    </button>
                  </td>
                  <td className="mono">
                    {p.ip}
                    {p.hostNetwork && <span className="k8s-chip" title={H_HOST_NETWORK}>{HOST_NETWORK_MARK}</span>}
                  </td>
                  <td className="mono">{p.node ?? DASH}</td>
                  <td className="mono">{p.subnetId ? (names.get(p.subnetId) ?? p.subnetId) : DASH}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {found.length > shown.length && <p className="dim">{podsShown(shown.length, found.length)}</p>}
      </Section>
    </div>
  );
}
