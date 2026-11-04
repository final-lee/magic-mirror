import { useMemo, type RefObject } from "react";
import { ListFind, useListFind } from "../../components/ListFind";
import { fuzzyKeep } from "../../lib/fuzzy";
import { ListTable, type ListColumn } from "../../iam/ListTable";
import { NETWORK_POLICIES } from "../kinds";
import type { ObjectRef } from "../types";
import { NetDetail, Section } from "./Detail";
import { directionView, rowKey } from "./logic";
import {
  ALLOW_ALL, ANYWHERE, DASH, DENY_ALL, DIRECTION_LABELS, H_DIRECTIONS, H_EGRESS, H_INGRESS, H_NAMESPACE, H_POD_SELECTOR, H_POLICY, NET_NO_MATCH, NOT_ISOLATED, NS_SYSTEM_NOTE,
  NS_WITHOUT_NONE, NS_WITHOUT_TITLE, OPEN_POLICY_IN_WORKLOADS, POLICY_EMPTY, POLICY_FILTER_PLACEHOLDER, POLICY_NOTE, POLICY_TABLE_LABEL, SEC_POLICY_EGRESS, SEC_POLICY_INGRESS,
  SEC_POLICY_SUMMARY, nsWithoutCount, policyPods, ruleFrom, rulePorts, ruleNumber,
} from "./text";
import type { NamespacePolicies, PolicyView } from "./types";

const keyOf = (p: PolicyView) => rowKey({ kind: "policy", namespace: p.namespace, name: p.name });

function columns(): ListColumn<PolicyView>[] {
  return [
    { key: "namespace", label: H_NAMESPACE, render: (p) => <span className="mono">{p.namespace}</span>, sort: (p) => `${p.namespace}/${p.name}` },
    { key: "name", label: H_POLICY, render: (p) => <span className="mono">{p.name}</span>, sort: (p) => p.name },
    { key: "pods", label: H_POD_SELECTOR, render: (p) => <span className="mono">{policyPods(p.podSelector)}</span>, sort: (p) => p.podSelector },
    { key: "types", label: H_DIRECTIONS, render: (p) => p.types.map((t) => DIRECTION_LABELS[t] ?? t).join(", ") || DASH },
    { key: "ingress", label: H_INGRESS, numeric: true, render: (p) => (p.types.includes("Ingress") ? p.ingress.length : DASH), sort: (p) => p.ingress.length },
    { key: "egress", label: H_EGRESS, numeric: true, render: (p) => (p.types.includes("Egress") ? p.egress.length : DASH), sort: (p) => p.egress.length },
  ];
}

interface Props {
  policies: PolicyView[];
  namespaces: NamespacePolicies[] | null;
  /** null이면 모든 네임스페이스 */
  namespace: string | null;
  selected: string | null;
  onSelect: (key: string) => void;
  onClear: () => void;
  /** ⌘F를 받는 상자: 이 목록과 위에 뜨는 상세를 감싼 네트워크 화면 */
  host: RefObject<HTMLElement>;
}

/** 정책이 하나도 없는 네임스페이스(시스템 네임스페이스는 흐리게) */
function WithoutPolicy({ namespaces }: { namespaces: NamespacePolicies[] }) {
  const without = namespaces.filter((n) => n.policies === 0);
  const user = without.filter((n) => !n.system);
  return (
    <section className="net-without" aria-label={NS_WITHOUT_TITLE}>
      <h4>
        {NS_WITHOUT_TITLE} <span className="k8s-chip warn">{nsWithoutCount(user.length)}</span>
      </h4>
      {without.length === 0 ? (
        <p className="dim">{NS_WITHOUT_NONE}</p>
      ) : (
        <div className="net-ns-list">
          {without.map((n) => (
            <span key={n.name} className={`tag mono${n.system ? " net-unused" : ""}`} title={n.system ? NS_SYSTEM_NOTE : undefined}>
              {n.name}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

export function Policies({ policies, namespaces, namespace, selected, onSelect, onClear, host }: Props) {
  const cols = useMemo(columns, []);
  const find = useListFind(host);
  const scoped = policies.filter((p) => namespace === null || p.namespace === namespace);
  const rows = fuzzyKeep(scoped, find.query, (p) => [`${p.namespace}/${p.name}`, policyPods(p.podSelector), ...p.types]);
  return (
    <div className="net-content">
      {namespaces && <WithoutPolicy namespaces={namespaces} />}
      <p className="dim net-note">{POLICY_NOTE}</p>
      <ListFind find={find} placeholder={POLICY_FILTER_PLACEHOLDER} count={rows.length} />
      <ListTable label={POLICY_TABLE_LABEL} rows={rows} columns={cols} rowKey={keyOf} selectedId={selected} onSelect={onSelect} onClear={onClear} onOpen={onSelect} empty={scoped.length === 0 ? POLICY_EMPTY : NET_NO_MATCH} />
    </div>
  );
}

function Direction({ direction, policy }: { direction: "Ingress" | "Egress"; policy: PolicyView }) {
  const view = directionView(direction, policy.types, direction === "Ingress" ? policy.ingress : policy.egress);
  const side = direction === "Ingress" ? "ingress" : "egress";
  if (view.mode === "open") return <p className="dim">{NOT_ISOLATED}</p>;
  if (view.mode === "deny") return <p className="net-deny">{DENY_ALL}</p>;
  return (
    <ol className="net-rules">
      {view.rules.map((r, i) => (
        <li key={i}>
          <b>{ruleNumber(i + 1)}</b>
          {r.allowAll ? (
            <span> {ALLOW_ALL}</span>
          ) : (
            <ul>
              <li>{ruleFrom(side, r.peers.length > 0 ? r.peers.join(" / ") : ANYWHERE)}</li>
              <li>{rulePorts(r.ports)}</li>
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
}

interface DetailProps {
  policy: PolicyView;
  widthPct: number;
  onClose: () => void;
  onOpenObject: (ref: ObjectRef) => void;
}

/** NetworkPolicy 한 개의 상세: 대상 Pod와 들어오고 나가는 규칙 요약(YAML은 워크로드 화면에서) */
export function PolicyDetail({ policy, widthPct, onClose, onOpenObject }: DetailProps) {
  return (
    <NetDetail
      title="NetworkPolicy"
      subtitle={`${policy.namespace}/${policy.name}`}
      widthPct={widthPct}
      onClose={onClose}
      toolbar={
        <button className="btn tone-nav" onClick={() => onOpenObject({ kind: NETWORK_POLICIES, namespace: policy.namespace, name: policy.name })}>
          {OPEN_POLICY_IN_WORKLOADS}
        </button>
      }
    >
      <Section title={SEC_POLICY_SUMMARY}>
        <dl className="kv">
          <dt>{H_POD_SELECTOR}</dt>
          <dd className="mono k8s-wrap">{policyPods(policy.podSelector)}</dd>
          <dt>{H_DIRECTIONS}</dt>
          <dd>{policy.types.map((t) => DIRECTION_LABELS[t] ?? t).join(", ") || DASH}</dd>
        </dl>
      </Section>
      <Section title={SEC_POLICY_INGRESS}>
        <Direction direction="Ingress" policy={policy} />
      </Section>
      <Section title={SEC_POLICY_EGRESS}>
        <Direction direction="Egress" policy={policy} />
      </Section>
      <p className="dim">{POLICY_NOTE}</p>
    </NetDetail>
  );
}
