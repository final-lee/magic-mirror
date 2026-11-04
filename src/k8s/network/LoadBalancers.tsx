import { useMemo, type RefObject } from "react";
import { ListFind, useListFind } from "../../components/ListFind";
import { fuzzyKeep } from "../../lib/fuzzy";
import { ListTable, type ListColumn } from "../../iam/ListTable";
import { ErrorState } from "../../components/ErrorState";
import { INGRESSES, SERVICES } from "../kinds";
import type { ObjectRef } from "../types";
import { NetDetail, Section } from "./Detail";
import { healthCounts, listenersText, refOfLink, rowHighlight, rowKey, shortHost } from "./logic";
import {
  DASH, H_ACTION, H_ADDRESS, H_CONDITIONS, H_DEFAULT_ACTION, H_LINK, H_LISTENERS, H_LOAD_BALANCER, H_MATCH, H_PORT, H_PRIORITY, H_PROTOCOL_PORT, H_REASON,
  H_RULE_COUNT, H_SCHEME, H_SOURCE, H_STACK, H_STATE, H_TARGET, H_TARGET_HEALTH, H_TLS_POLICY, H_TYPE, H_ZONE, HEALTH_CHECK_OFF, L_CLASS, L_DNS, L_GROUP,
  L_HEALTH_CHECK, L_HOSTNAMES, L_MATCH, L_NAME, L_PORTS, L_RULES, L_SCHEME, L_SECURITY_GROUPS, L_STATE, L_TYPE, L_VPC, L_ZONES, LB_EMPTY, LB_FILTER_PLACEHOLDER, LB_KIND_LABELS, NET_NO_MATCH,
  LB_TABLE_LABEL, MATCHED_BY_LABELS, NO_LISTENERS, NO_TARGET_GROUPS, NO_TARGETS, OPEN_IN_WORKLOADS, OPEN_LB_IN_VPC, OPEN_VPC_UNKNOWN, SEC_LISTENERS,
  SEC_LOAD_BALANCER, SEC_SUMMARY, SEC_TARGET_GROUPS, SOURCE_LABELS, STATE_LABELS, UNCLAIMED_NOTE, UNCLAIMED_TITLE, UNMATCHED_LABELS, UNMATCHED_SHORT,
  gapLine, healthCheckText, healthSummary, openLink, ruleCount, targetGroupTitle,
} from "./text";
import type { LbRow, LoadBalancerView, Network, TargetGroupView, UnclaimedLb } from "./types";
import { SECTION_LABELS } from "./text";

/** 대상 상태 칩: 정상은 초록, 비정상은 빨강, 그 밖은 노랑 */
function HealthChips({ lb }: { lb: LoadBalancerView | null }) {
  if (!lb) return <span className="dim">{DASH}</span>;
  const c = healthCounts(lb);
  if (c.healthy + c.unhealthy + c.other === 0) return <span className="dim">{NO_TARGETS}</span>;
  return (
    <span className={`net-chip ${c.unhealthy > 0 ? "bad" : c.other > 0 ? "warn" : "ok"}`}>{healthSummary(c.healthy, c.unhealthy, c.other)}</span>
  );
}

const sourceText = (r: LbRow) => `${r.namespace}/${r.name}`;
const addressOf = (r: LbRow) => r.hostnames[0] ?? r.ips[0] ?? "";

function columns(): ListColumn<LbRow>[] {
  return [
    { key: "source", label: H_SOURCE, render: (r) => SOURCE_LABELS[r.kind], sort: (r) => `${r.kind}/${r.namespace}/${r.name}` },
    { key: "name", label: "이름", render: (r) => <span className="mono">{sourceText(r)}</span>, sort: sourceText },
    {
      key: "address",
      label: H_ADDRESS,
      render: (r) => (addressOf(r) ? <span className="mono" title={[...r.hostnames, ...r.ips].join("\n")}>{shortHost(addressOf(r))}</span> : <span className="dim">{DASH}</span>),
      sort: addressOf,
    },
    {
      key: "lb",
      label: H_LOAD_BALANCER,
      render: (r) =>
        r.loadBalancer ? (
          <span title={r.loadBalancer.arn}>
            {r.loadBalancer.kind ? <span className="k8s-chip">{LB_KIND_LABELS[r.loadBalancer.kind]}</span> : null} {r.loadBalancer.name}
          </span>
        ) : (
          <span className="dim" title={r.unmatched ? UNMATCHED_LABELS[r.unmatched] : undefined}>{r.unmatched ? UNMATCHED_SHORT[r.unmatched] : DASH}</span>
        ),
      sort: (r) => r.loadBalancer?.name ?? null,
    },
    { key: "listeners", label: H_LISTENERS, render: (r) => <span className="mono">{listenersText(r.loadBalancer) || DASH}</span> },
    { key: "health", label: H_TARGET_HEALTH, render: (r) => <HealthChips lb={r.loadBalancer} /> },
    {
      key: "match",
      label: H_MATCH,
      render: (r) => <span className="dim">{r.matchedBy ? MATCHED_BY_LABELS[r.matchedBy] : DASH}</span>,
    },
  ];
}

interface ListProps {
  network: Network;
  /** null이면 모든 네임스페이스 */
  namespace: string | null;
  selected: string | null;
  onSelect: (key: string) => void;
  onClear: () => void;
  /** ⌘F를 받는 상자: 이 목록과 위에 뜨는 상세를 감싼 네트워크 화면 */
  host: RefObject<HTMLElement>;
}

function UnclaimedTable({ items }: { items: UnclaimedLb[] }) {
  return (
    <section className="net-unclaimed" aria-label={UNCLAIMED_TITLE}>
      <h4>{UNCLAIMED_TITLE}</h4>
      <p className="dim">{UNCLAIMED_NOTE}</p>
      <table className="k8s-table">
        <thead>
          <tr><th>{L_NAME}</th><th>{H_TYPE}</th><th>{H_SCHEME}</th><th>{H_STATE}</th><th>{H_STACK}</th></tr>
        </thead>
        <tbody>
          {items.map((u) => (
            <tr key={u.arn} title={u.arn}>
              <td className="mono">{u.name}</td>
              <td>{u.kind ? LB_KIND_LABELS[u.kind] : DASH}</td>
              <td>{u.scheme ?? DASH}</td>
              <td>{u.state ?? DASH}</td>
              <td className="mono">{u.stack ?? DASH}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** Service(LoadBalancer)·Ingress 목록. 행을 고르면 오른쪽에 로드 밸런서 상세가 뜬다. */
export function LoadBalancers({ network, namespace, selected, onSelect, onClear, host }: ListProps) {
  const cols = useMemo(columns, []);
  const find = useListFind(host);
  const scoped = (network.loadBalancers ?? []).filter((r) => namespace === null || r.namespace === namespace);
  const rows = fuzzyKeep(scoped, find.query, (r) => [
    sourceText(r),
    SOURCE_LABELS[r.kind],
    ...r.hostnames,
    ...r.ips,
    r.loadBalancer?.name,
    r.loadBalancer?.kind ? LB_KIND_LABELS[r.loadBalancer.kind] : null,
  ]);
  if (network.loadBalancers === null) return null;
  return (
    <div className="net-content">
      <ListFind find={find} placeholder={LB_FILTER_PLACEHOLDER} count={rows.length} />
      <ListTable
        label={LB_TABLE_LABEL}
        rows={rows}
        columns={cols}
        rowKey={rowKey}
        selectedId={selected}
        onSelect={onSelect}
        onClear={onClear}
        onOpen={onSelect}
        empty={scoped.length === 0 ? LB_EMPTY : NET_NO_MATCH}
        vimKeys
      />
      {network.unclaimed.length > 0 && <UnclaimedTable items={network.unclaimed} />}
    </div>
  );
}

const Kv = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <>
    <dt>{label}</dt>
    <dd>{children}</dd>
  </>
);

function TargetGroup({ group, onOpenObject }: { group: TargetGroupView; onOpenObject: (ref: ObjectRef) => void }) {
  const counts = healthCounts({ targetGroups: [group] } as LoadBalancerView);
  const hc = group.healthCheck;
  return (
    <div className="net-tg">
      <div className="net-tg-head">
        <b className="mono">{targetGroupTitle(group.name, group.protocol, group.port, group.targetType)}</b>
        <span className={`net-chip ${counts.unhealthy > 0 ? "bad" : counts.other > 0 ? "warn" : "ok"}`}>{healthSummary(counts.healthy, counts.unhealthy, counts.other)}</span>
        <span className="dim">{L_HEALTH_CHECK}: {hc ? healthCheckText(hc.protocol, hc.port, hc.path) || DASH : HEALTH_CHECK_OFF}</span>
      </div>
      {group.targets.length === 0 ? (
        <p className="dim">{NO_TARGETS}</p>
      ) : (
        <table className="k8s-table" aria-label={group.name}>
          <thead>
            <tr><th>{H_TARGET}</th><th>{H_PORT}</th><th>{H_ZONE}</th><th>{H_STATE}</th><th>{H_REASON}</th><th>{H_LINK}</th></tr>
          </thead>
          <tbody>
            {group.targets.map((t) => {
              const ref = t.link ? refOfLink(t.link) : null;
              return (
                <tr key={`${t.id}:${t.port}`} className={t.state === "unhealthy" ? "k8s-warn" : undefined}>
                  <td className="mono">{t.id}</td>
                  <td>{t.port ?? DASH}</td>
                  <td>{t.zone ?? DASH}</td>
                  <td>
                    <span className={`net-chip ${t.state === "healthy" ? "ok" : t.state === "unhealthy" ? "bad" : "warn"}`}>{STATE_LABELS[t.state] ?? t.state}</span>
                  </td>
                  <td className="k8s-wrap" title={t.description ?? undefined}>
                    {t.reason ? <span className="mono">{t.reason}</span> : null}
                    {t.description ? <div className="dim">{t.description}</div> : null}
                  </td>
                  <td>
                    {t.link && ref ? (
                      <button className="link mono" aria-label={openLink(t.link.kind, t.link.name)} title={openLink(t.link.kind, t.link.name)} onClick={() => onOpenObject(ref)}>
                        {t.link.kind}/{t.link.namespace ? `${t.link.namespace}/` : ""}{t.link.name}
                      </button>
                    ) : (
                      <span className="dim">{DASH}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Listeners({ lb }: { lb: LoadBalancerView }) {
  if (lb.listeners.length === 0) return <p className="dim">{NO_LISTENERS}</p>;
  return (
    <table className="k8s-table" aria-label={SEC_LISTENERS}>
      <thead>
        <tr><th>{H_PROTOCOL_PORT}</th><th>{H_TLS_POLICY}</th><th>{H_DEFAULT_ACTION}</th><th>{H_RULE_COUNT}</th></tr>
      </thead>
      <tbody>
        {lb.listeners.map((l) => (
          <ListenerRows key={l.arn} listener={l} />
        ))}
      </tbody>
    </table>
  );
}

function ListenerRows({ listener: l }: { listener: LoadBalancerView["listeners"][number] }) {
  return (
    <>
      <tr>
        <td className="mono">{l.protocol}:{l.port}</td>
        <td className="mono">{l.sslPolicy ?? DASH}</td>
        <td className="mono k8s-wrap">{l.defaultAction || DASH}</td>
        <td>{l.rules.length > 0 ? ruleCount(l.rules.length) : DASH}</td>
      </tr>
      {l.rules.map((r) => (
        <tr key={r.priority} className="net-rule">
          <td colSpan={4}>
            <span className="dim">{H_PRIORITY} {r.priority}</span> <span className="dim">{H_CONDITIONS}</span> <span className="mono k8s-wrap">{r.conditions || DASH}</span>{" "}
            <span className="dim">→ {H_ACTION}</span> <span className="mono k8s-wrap">{r.action || DASH}</span>
          </td>
        </tr>
      ))}
    </>
  );
}

interface DetailProps {
  row: LbRow;
  widthPct: number;
  onClose: () => void;
  onOpenObject: (ref: ObjectRef) => void;
  /** 이 로드 밸런서를 강조해서 VPC 다이어그램을 연다. 없으면 열 수 없다 */
  onOpenVpc: ((ids: string[]) => void) | null;
  profile: string;
  onRetry: () => void;
}

/** Service·Ingress 한 행의 상세: 요약, 로드 밸런서, 리스너, 대상 그룹과 대상 상태 */
export function LbDetail({ row, widthPct, onClose, onOpenObject, onOpenVpc, profile, onRetry }: DetailProps) {
  const lb = row.loadBalancer;
  const kindRef = row.kind === "service" ? SERVICES : INGRESSES;
  const ids = rowHighlight(row);
  return (
    <NetDetail
      title={SOURCE_LABELS[row.kind]}
      subtitle={sourceText(row)}
      widthPct={widthPct}
      onClose={onClose}
      toolbar={
        <>
          <button className="btn tone-nav" onClick={() => onOpenObject({ kind: kindRef, namespace: row.namespace, name: row.name })}>
            {OPEN_IN_WORKLOADS}
          </button>
          <button
            className="btn tone-nav"
            disabled={onOpenVpc === null || ids.length === 0}
            title={onOpenVpc === null ? OPEN_VPC_UNKNOWN : ids.length === 0 ? UNMATCHED_LABELS[row.unmatched ?? "notFound"] : undefined}
            aria-description={onOpenVpc === null ? OPEN_VPC_UNKNOWN : ids.length === 0 ? UNMATCHED_LABELS[row.unmatched ?? "notFound"] : undefined}
            onClick={() => onOpenVpc?.(ids)}
          >
            {OPEN_LB_IN_VPC}
          </button>
        </>
      }
    >
      <Section title={SEC_SUMMARY}>
        <dl className="kv">
          {row.class && <Kv label={L_CLASS}>{row.class}</Kv>}
          {row.group && <Kv label={L_GROUP}>{row.group}</Kv>}
          <Kv label={L_HOSTNAMES}>
            {row.hostnames.length + row.ips.length === 0 ? DASH : [...row.hostnames, ...row.ips].map((h) => <div key={h} className="mono k8s-wrap">{h}</div>)}
          </Kv>
          <Kv label={row.kind === "service" ? L_PORTS : L_RULES}>
            {row.ports.length === 0 ? DASH : row.ports.map((p) => <div key={p} className="mono k8s-wrap">{p}</div>)}
          </Kv>
          <Kv label={L_MATCH}>{row.matchedBy ? MATCHED_BY_LABELS[row.matchedBy] : row.unmatched ? UNMATCHED_LABELS[row.unmatched] : DASH}</Kv>
        </dl>
      </Section>
      {lb && (
        <>
          <Section title={SEC_LOAD_BALANCER}>
            <dl className="kv">
              <Kv label={L_NAME}>{lb.name}</Kv>
              <Kv label={L_DNS}><span className="mono k8s-wrap">{lb.dnsName}</span></Kv>
              <Kv label={L_TYPE}>{lb.kind ? LB_KIND_LABELS[lb.kind] : DASH}</Kv>
              <Kv label={L_SCHEME}>{lb.scheme ?? DASH}</Kv>
              <Kv label={L_STATE}>{lb.state ?? DASH}</Kv>
              <Kv label={L_VPC}><span className="mono">{lb.vpcId ?? DASH}</span></Kv>
              <Kv label={L_ZONES}>{lb.zones.length === 0 ? DASH : lb.zones.map((z) => <div key={z.zone} className="mono">{z.zone} · {z.subnetId ?? DASH}</div>)}</Kv>
              <Kv label={L_SECURITY_GROUPS}><span className="mono">{lb.securityGroups.join(", ") || DASH}</span></Kv>
            </dl>
          </Section>
          {lb.gaps.map((g, i) => (
            <div key={`${g.section}-${i}`} className="k8s-gap">
              <p className="dim">{gapLine([g.subject ? `${SECTION_LABELS[g.section]} (${g.subject})` : SECTION_LABELS[g.section]])}</p>
              <ErrorState error={g.error} profile={profile} compact onRetry={onRetry} onLoggedIn={onRetry} />
            </div>
          ))}
          <Section title={SEC_LISTENERS}>
            <Listeners lb={lb} />
          </Section>
          <Section title={SEC_TARGET_GROUPS}>
            {lb.targetGroups.length === 0 ? <p className="dim">{NO_TARGET_GROUPS}</p> : lb.targetGroups.map((g) => <TargetGroup key={g.arn} group={g} onOpenObject={onOpenObject} />)}
          </Section>
        </>
      )}
    </NetDetail>
  );
}
