import type { ReactNode } from "react";
import { ErrorState } from "../components/ErrorState";
import { formatBytes, formatCpu, percent } from "./format";
import { EKS_SECTIONS, useK8sMetrics, useK8sOverview } from "./queries";
import {
  COL_NAME, COL_NAMESPACE, CORDONED, GROUP_KIND_LABELS, H_ADDON, H_CAPACITY_TYPE, H_CHECK, H_CPU_REQUESTED, H_CPU_USED, H_CURRENT_API, H_CURRENT_VERSION,
  H_INSTANCE_TYPE, H_ISSUES, H_KIND, H_KUBELET, H_LATEST_VERSION, H_MEMORY_REQUESTED, H_MEMORY_USED, H_NEW_API, H_POD_COUNT, H_NODEGROUP, H_REASON,
  H_SIZE_RANGE, H_STATE, H_VERSION, H_ZONE, L_AUTH_MODE, L_CIDRS, L_ENDPOINT, L_LOGGING, L_OIDC, L_PLATFORM, L_PRIVATE, L_PUBLIC,
  L_SECRETS_ENCRYPTION, L_STATUS, L_VERSION, LOADING, METRICS_UNAVAILABLE, NO_INSIGHTS, NO_METRICS, NO_SKEW, NONE, OFF, ON, REFRESH, REQUESTS_PARTIAL,
  SECTION_LABELS, SEC_ADDONS, SEC_CLUSTER, SEC_CLUSTER_USAGE, SEC_FARGATE, SEC_NAMESPACE_USAGE, SEC_WARNINGS, SUB_TOP_CPU, SUB_TOP_MEMORY, SEC_NODEGROUPS, SEC_NODEPOOLS, SEC_NODES, SEC_UPGRADE, SUB_INSIGHTS, SUB_REMOVED,
  SUB_SKEW, UP_TO_DATE, gapText, noRemoved, removedTitle, skewText,
} from "./text";
import type { K8sNodeView, K8sOverview, K8sOverviewSection, K8sTarget } from "./types";
import { namespaceTotals, top, type NamespaceUsage } from "./usage";
import { ClusterSummary, RecentWarnings } from "./ClusterSummary";
import { historyKey } from "./usageHistory";

interface Props {
  target: K8sTarget;
  context: string;
  ssoProfile: string;
  live: boolean;
  /** 탭이 보이는 동안에만 네임스페이스별 사용량을 15초마다 읽는다. 없으면 보이는 것으로 본다 */
  visible?: boolean;
  onOpenNode: (name: string) => void;
  /** 최근 경고 감시가 새 연결에서 다시 시작되게 하는 세션 시각 */
  sessionEpoch: number;
  /** 이벤트 화면으로 간다 */
  onOpenEvents: () => void;
}

const Sect = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="k8s-sect" aria-label={title}>
    <h4>{title}</h4>
    {children}
  </section>
);

const TOP_NAMESPACES = 10;

/** 사용량이 큰 네임스페이스 표 */
function NamespaceTop({ title, rows }: { title: string; rows: NamespaceUsage[] }) {
  return (
    <>
      <h5>{title}</h5>
      <table className="k8s-table" aria-label={title}>
        <thead>
          <tr><th>{COL_NAMESPACE}</th><th>{H_CPU_USED}</th><th>{H_MEMORY_USED}</th><th>{H_POD_COUNT}</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.namespace}>
              <td className="mono">{r.namespace}</td><td>{formatCpu(r.cpuMilli)}</td><td>{formatBytes(r.memoryBytes)}</td><td>{r.pods}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** CPU 상위·메모리 상위 두 표. Pod가 없으면 아무것도 그리지 않는다 */
function NamespaceTops({ totals }: { totals: NamespaceUsage[] }) {
  if (totals.length === 0) return null;
  return (
    <>
      <NamespaceTop title={SUB_TOP_CPU} rows={top(totals, "cpuMilli", TOP_NAMESPACES)} />
      <NamespaceTop title={SUB_TOP_MEMORY} rows={top(totals, "memoryBytes", TOP_NAMESPACES)} />
    </>
  );
}

function nodeStatus(n: K8sNodeView): string {
  return [n.ready ? "Ready" : "NotReady", n.unschedulable ? CORDONED : null, n.pressures.length > 0 ? n.pressures.join(", ") : null].filter(Boolean).join(" · ");
}

export function OverviewView({ target, context, ssoProfile, live, visible = true, onOpenNode, sessionEpoch, onOpenEvents }: Props) {
  const q = useK8sOverview(target, context, ssoProfile, live);
  const usage = useK8sMetrics(target, context, null, ssoProfile, live && visible);
  const refetch = () => void q.refetch();
  if (q.isError) return <ErrorState error={q.error} profile={target.profile} onRetry={refetch} onLoggedIn={refetch} />;
  if (!q.data) return <div className="empty">{LOADING}</div>;
  const o: K8sOverview = q.data;
  const gaps = (...sections: K8sOverviewSection[]) =>
    o.gaps
      .filter((g) => sections.includes(g.section))
      .map((g, i) => (
        <div key={`${g.section}-${i}`} className="k8s-gap">
          <p className="dim">{gapText(SECTION_LABELS[g.section])}</p>
          <ErrorState error={g.error} profile={EKS_SECTIONS.has(g.section) ? target.profile : ssoProfile} compact onRetry={refetch} onLoggedIn={refetch} />
        </div>
      ));
  const c = o.cluster;
  // 노드 사용량은 15초마다 다시 읽은 값을 쓴다(읽을 수 없으면 개요를 읽을 때의 값)
  const liveNodes = usage.data && usage.data.nodesUnavailable === null
    ? new Map(usage.data.nodes.map((n) => [n.name, { cpuMilli: n.cpuMilli, memoryBytes: n.memoryBytes }]))
    : null;
  return (
    <div className="k8s-overview">
      <div className="k8s-actions">
        <button className="btn tone-refresh" onClick={refetch} disabled={q.isFetching}>{REFRESH}</button>
      </div>
      {o.nodes && (
        <Sect title={SEC_CLUSTER_USAGE}>
          <ClusterSummary nodes={o.nodes} live={liveNodes} historyKey={historyKey(target, context)} metrics={o.metrics || liveNodes !== null} />
        </Sect>
      )}
      <Sect title={SEC_WARNINGS}>
        <RecentWarnings target={target} context={context} sessionEpoch={sessionEpoch} ssoProfile={ssoProfile} live={live} onOpenEvents={onOpenEvents} />
      </Sect>
      <Sect title={SEC_CLUSTER}>
        {gaps("cluster")}
        {c && (
          <dl className="kv">
            <dt>{L_VERSION}</dt><dd>{c.version}</dd>
            <dt>{L_PLATFORM}</dt><dd>{c.platformVersion ?? NONE}</dd>
            <dt>{L_STATUS}</dt><dd>{c.status ?? NONE}</dd>
            <dt>{L_ENDPOINT}</dt><dd>{[c.endpointPublic ? L_PUBLIC : null, c.endpointPrivate ? L_PRIVATE : null].filter(Boolean).join(", ")}</dd>
            <dt>{L_CIDRS}</dt><dd className="mono">{c.publicCidrs.join(", ") || NONE}</dd>
            <dt>{L_LOGGING}</dt><dd>{c.logging.length > 0 ? c.logging.join(", ") : OFF}</dd>
            <dt>{L_SECRETS_ENCRYPTION}</dt><dd>{c.secretsEncrypted ? ON : OFF}</dd>
            <dt>{L_OIDC}</dt><dd className="mono k8s-wrap">{c.oidcIssuer ?? NONE}</dd>
            <dt>{L_AUTH_MODE}</dt><dd>{c.authenticationMode ?? NONE}</dd>
          </dl>
        )}
      </Sect>
      <Sect title={SEC_NODES}>
        {gaps("nodes", "metrics")}
        {o.nodes && (
          <table className="k8s-table">
            <thead>
              <tr>
                <th>{COL_NAME}</th><th>{H_STATE}</th><th>{H_INSTANCE_TYPE}</th><th>{H_ZONE}</th><th>{H_NODEGROUP}</th><th>{H_KUBELET}</th>
                <th>{H_CPU_REQUESTED}</th><th>{H_MEMORY_REQUESTED}</th>
                {o.metrics && <><th>{H_CPU_USED}</th><th>{H_MEMORY_USED}</th></>}
              </tr>
            </thead>
            <tbody>
              {o.nodes.map((n) => (
                <tr key={n.name} className={n.ready ? undefined : "k8s-warn"}>
                  <td><button className="link mono tone-nav" onClick={() => onOpenNode(n.name)}>{n.name}</button></td>
                  <td>{nodeStatus(n)}</td>
                  <td>{n.instanceType ?? ""}</td>
                  <td>{n.zone ?? ""}</td>
                  <td>{GROUP_KIND_LABELS[n.groupKind]}{n.group ? ` ${n.group}` : ""}</td>
                  <td className="mono">{n.kubeletVersion}</td>
                  <td>{`${formatCpu(n.requested.cpuMilli)} / ${formatCpu(n.allocatable.cpuMilli)} (${percent(n.requested.cpuMilli, n.allocatable.cpuMilli)})`}</td>
                  <td>{`${formatBytes(n.requested.memoryBytes)} / ${formatBytes(n.allocatable.memoryBytes)} (${percent(n.requested.memoryBytes, n.allocatable.memoryBytes)})`}</td>
                  {o.metrics && (
                    <>
                      <td>{n.usage ? `${formatCpu(n.usage.cpuMilli)} / ${formatCpu(n.allocatable.cpuMilli)} (${percent(n.usage.cpuMilli, n.allocatable.cpuMilli)})` : ""}</td>
                      <td>{n.usage ? `${formatBytes(n.usage.memoryBytes)} / ${formatBytes(n.allocatable.memoryBytes)} (${percent(n.usage.memoryBytes, n.allocatable.memoryBytes)})` : ""}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {o.nodes && !o.metrics && !o.gaps.some((g) => g.section === "metrics") && <p className="dim">{NO_METRICS}</p>}
        {o.requestsPartial && <p className="dim">{REQUESTS_PARTIAL}</p>}
      </Sect>
      {usage.data && (usage.data.podsUnavailable === null || o.metrics) && (
        <Sect title={SEC_NAMESPACE_USAGE}>
          {usage.data.podsUnavailable ? (
            <p className="dim">{METRICS_UNAVAILABLE[usage.data.podsUnavailable]}</p>
          ) : (
            <NamespaceTops totals={namespaceTotals(usage.data)} />
          )}
        </Sect>
      )}
      <Sect title={SEC_NODEGROUPS}>
        {gaps("nodegroups")}
        {o.nodegroups && o.nodegroups.length > 0 && (
          <table className="k8s-table">
            <thead>
              <tr><th>{COL_NAME}</th><th>{H_STATE}</th><th>{H_VERSION}</th><th>{H_INSTANCE_TYPE}</th><th>{H_CAPACITY_TYPE}</th><th>{H_SIZE_RANGE}</th></tr>
            </thead>
            <tbody>
              {o.nodegroups.map((g) => (
                <tr key={g.name}>
                  <td className="mono">{g.name}</td><td>{g.status ?? ""}</td><td>{g.version ?? ""}</td><td>{g.instanceTypes.join(", ")}</td>
                  <td>{g.capacityType ?? ""}</td><td>{`${g.min ?? "-"} / ${g.desired ?? "-"} / ${g.max ?? "-"}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Sect>
      {(o.fargateProfiles?.length ?? 0) > 0 || o.gaps.some((g) => g.section === "fargate") ? (
        <Sect title={SEC_FARGATE}>
          {gaps("fargate")}
          <ul className="k8s-links">{o.fargateProfiles?.map((p) => <li key={p} className="mono">{p}</li>)}</ul>
        </Sect>
      ) : null}
      {(o.nodePools !== null || o.gaps.some((g) => g.section === "nodePools")) && (
        <Sect title={SEC_NODEPOOLS}>
          {gaps("nodePools")}
          <ul className="k8s-links">{o.nodePools?.map((p) => <li key={p} className="mono">{p}</li>)}</ul>
        </Sect>
      )}
      <Sect title={SEC_ADDONS}>
        {gaps("addons")}
        {o.addons && (
          <table className="k8s-table">
            <thead>
              <tr><th>{H_ADDON}</th><th>{H_CURRENT_VERSION}</th><th>{H_LATEST_VERSION}</th><th>{H_STATE}</th><th>{H_ISSUES}</th></tr>
            </thead>
            <tbody>
              {o.addons.map((a) => (
                <tr key={a.name}>
                  <td className="mono">{a.name}</td><td className="mono">{a.version ?? ""}</td>
                  <td className="mono">{a.latest !== null && a.latest === a.version ? UP_TO_DATE : a.latest ?? ""}</td>
                  <td>{a.status ?? ""}</td>
                  <td>{a.issues.map((i) => <div key={i}>{i}</div>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Sect>
      <Sect title={SEC_UPGRADE}>
        <h5>{SUB_INSIGHTS}</h5>
        {gaps("insights")}
        {o.insights &&
          (o.insights.length === 0 ? (
            <p className="dim">{NO_INSIGHTS}</p>
          ) : (
            <table className="k8s-table">
              <thead>
                <tr><th>{H_CHECK}</th><th>{H_STATE}</th><th>{H_REASON}</th></tr>
              </thead>
              <tbody>
                {o.insights.map((i) => (
                  <tr key={i.name} title={i.description ?? ""}><td>{i.name}</td><td>{i.status ?? ""}</td><td>{i.reason ?? ""}</td></tr>
                ))}
              </tbody>
            </table>
          ))}
        <h5>{SUB_REMOVED}</h5>
        {gaps("removedApis")}
        {o.nextVersion && o.removedApis && (
          o.removedApis.length === 0 ? (
            <p className="dim">{noRemoved(o.nextVersion)}</p>
          ) : (
            <>
              <p>{removedTitle(o.nextVersion)}</p>
              <table className="k8s-table">
                <thead>
                  <tr><th>{H_KIND}</th><th>{COL_NAME}</th><th>{H_CURRENT_API}</th><th>{H_NEW_API}</th></tr>
                </thead>
                <tbody>
                  {o.removedApis.map((r) => (
                    <tr key={`${r.kind}|${r.namespace}|${r.name}`}>
                      <td>{r.kind}</td><td className="mono">{r.namespace ? `${r.namespace}/${r.name}` : r.name}</td>
                      <td className="mono">{r.apiVersion}</td><td className="mono">{r.replacement}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )
        )}
        <h5>{SUB_SKEW}</h5>
        {o.cluster && o.nodes && (o.skew.length === 0 ? (
          <p className="dim">{NO_SKEW}</p>
        ) : (
          <ul className="k8s-links">
            {o.skew.map((s) => (
              <li key={s.node}><span className="mono">{s.node}</span> ({s.kubeletVersion}): {skewText(s.minorsBehind)}</li>
            ))}
          </ul>
        ))}
      </Sect>
    </div>
  );
}
