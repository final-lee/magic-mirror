import { useRef, useState } from "react";
import { K8sError } from "../K8sError";
import { DETAIL_PCT, LaneResizer, type Lane } from "../lanes";
import type { ObjectRef, K8sTarget } from "../types";
import { Gaps } from "./Gaps";
import { LbDetail, LoadBalancers } from "./LoadBalancers";
import { rowKey } from "./logic";
import { NodesSubnets } from "./NodesSubnets";
import { PodIps } from "./PodIps";
import { PolicyDetail, Policies } from "./Policies";
import { useK8sNetwork } from "./queries";
import {
  LOADING, NETWORK_TABS_LABEL, OPEN_VPC, OPEN_VPC_TITLE, OPEN_VPC_UNKNOWN, REFRESH, TAB_LOAD_BALANCERS, TAB_NODES_SUBNETS, TAB_POD_IPS, TAB_POLICIES,
} from "./text";
import type { VpcOpen } from "./types";

type NetworkTab = "lb" | "nodes" | "pods" | "policies";

const TABS: { id: NetworkTab; label: string }[] = [
  { id: "lb", label: TAB_LOAD_BALANCERS },
  { id: "nodes", label: TAB_NODES_SUBNETS },
  { id: "pods", label: TAB_POD_IPS },
  { id: "policies", label: TAB_POLICIES },
];

interface Props {
  target: K8sTarget;
  context: string;
  ssoProfile: string;
  live: boolean;
  /** null이면 모든 네임스페이스 */
  namespace: string | null;
  /** 서비스·Ingress·노드·Pod·NetworkPolicy를 워크로드 화면에서 연다 */
  onOpenObject: (ref: ObjectRef) => void;
  /** VPC 다이어그램을 강조와 함께 연다. 없으면 열 수 없다 */
  onOpenVpc?: (open: VpcOpen) => void;
  /** 레인 너비(useLaneWidths): 상세 비율을 쓴다 */
  lanes: {
    width: (lane: Lane) => number | undefined;
    resize: (lane: Lane, width: number) => void;
    commit: (lane: Lane, width: number) => void;
  };
}

/** 네트워크: 로드 밸런서, 노드·서브넷, Pod IP, NetworkPolicy. 읽기만 한다. */
export function NetworkView({ target, context, ssoProfile, live, namespace, onOpenObject, onOpenVpc, lanes }: Props) {
  const q = useK8sNetwork(target, context, ssoProfile, live);
  const [tab, setTab] = useState<NetworkTab>("lb");
  // ⌘F를 받는 상자: 보이는 목록과 그 위에 뜨는 상세를 함께 감싼다(상세에 커서가 있어도 ⌘F는 목록으로 간다)
  const pane = useRef<HTMLDivElement>(null);
  const [lbSel, setLbSel] = useState<string | null>(null);
  const [policySel, setPolicySel] = useState<string | null>(null);
  const refetch = () => void q.refetch();
  if (q.isError) return <K8sError error={q.error} target={target} ssoProfile={target.profile} />;
  if (!q.data) return <div className="empty">{LOADING}</div>;
  const n = q.data;
  const vpcId = n.vpcId;
  const openVpc = (ids: string[]) => {
    if (!vpcId || !onOpenVpc) return;
    onOpenVpc({ vpcId, name: `${target.cluster} VPC`, region: target.region, highlight: { ids, label: target.cluster } });
  };
  const noVpc = !vpcId || !onOpenVpc;
  const detailPct = lanes.width("detailPct") ?? DETAIL_PCT;
  const lbRow = lbSel ? (n.loadBalancers ?? []).find((r) => rowKey(r) === lbSel) : undefined;
  const policy = policySel ? (n.policies ?? []).find((p) => rowKey({ kind: "policy", namespace: p.namespace, name: p.name }) === policySel) : undefined;
  const detailOpen = (tab === "lb" && lbRow) || (tab === "policies" && policy);
  return (
    <div className="k8s-workloads">
      <div className="k8s-list-pane net-pane" ref={pane}>
        <div className="net-top">
          <div role="tablist" className="k8s-tabs" aria-label={NETWORK_TABS_LABEL}>
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="net-actions">
            <button
              className="btn tone-nav"
              disabled={noVpc}
              title={noVpc ? OPEN_VPC_UNKNOWN : OPEN_VPC_TITLE}
              aria-description={noVpc ? OPEN_VPC_UNKNOWN : OPEN_VPC_TITLE}
              onClick={() => openVpc(n.highlight)}
            >
              {OPEN_VPC}
            </button>
            <button className="btn tone-refresh" onClick={refetch} disabled={q.isFetching}>
              {REFRESH}
            </button>
          </div>
        </div>
        <Gaps gaps={n.gaps} awsProfile={target.profile} k8sProfile={ssoProfile} onRetry={refetch} />
        {tab === "lb" && n.loadBalancers && (
          <LoadBalancers network={n} namespace={namespace} selected={lbSel} onSelect={setLbSel} onClear={() => setLbSel(null)} host={pane} />
        )}
        {tab === "nodes" && <NodesSubnets network={n} onOpenObject={onOpenObject} host={pane} />}
        {tab === "pods" && <PodIps network={n} namespace={namespace} onOpenObject={onOpenObject} host={pane} />}
        {tab === "policies" && n.policies && (
          <Policies policies={n.policies} namespaces={n.namespaces} namespace={namespace} selected={policySel} onSelect={setPolicySel} onClear={() => setPolicySel(null)} host={pane} />
        )}
        {detailOpen && <LaneResizer lane="detailPct" onResize={lanes.resize} onCommit={lanes.commit} style={{ right: `${detailPct}%` }} />}
        {tab === "lb" && lbRow && (
          <LbDetail
            key={lbSel}
            row={lbRow}
            widthPct={detailPct}
            onClose={() => setLbSel(null)}
            onOpenObject={onOpenObject}
            onOpenVpc={noVpc ? null : openVpc}
            profile={target.profile}
            onRetry={refetch}
          />
        )}
        {tab === "policies" && policy && <PolicyDetail key={policySel} policy={policy} widthPct={detailPct} onClose={() => setPolicySel(null)} onOpenObject={onOpenObject} />}
      </div>
    </div>
  );
}
