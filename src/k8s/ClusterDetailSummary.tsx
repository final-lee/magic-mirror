import { ErrorState } from "../components/ErrorState";
import { ClusterSummary, RecentWarnings } from "./ClusterSummary";
import { K8sError } from "./K8sError";
import { useK8sMetrics, useK8sOverview, useUsageSampler } from "./queries";
import { CLUSTER_DETAIL_NO_CONTEXT, LOADING, SEC_CLUSTER_USAGE, SEC_WARNINGS, STATE_CONNECTING } from "./text";
import type { K8sTarget } from "./types";
import { historyKey } from "./usageHistory";
import { useK8sConnection } from "./useK8sConnection";

/**
 * 탐색기에서 EKS 클러스터를 골랐을 때 오른쪽 상세에 붙는 요약: 개요 맨 위와 같은 클러스터 사용량(고리·그래프)과 최근 경고.
 * EKS 탭과 같은 연결·쿼리를 나눠 쓴다. context를 고르지 않았으면 EKS 탭으로 안내한다("EKS 탭에서 열기" 단추는 상세의 도구 모음에 있다).
 */
export function ClusterDetailSummary({ target }: { target: K8sTarget }) {
  const { settingsReady, ctx, chosen, session, ssoProfile, live } = useK8sConnection(target);
  const overview = useK8sOverview(target, chosen ?? "", ssoProfile, live && chosen !== null);
  const metrics = useK8sMetrics(target, chosen, null, ssoProfile, live);
  // 상세를 보는 동안 그래프 기록을 모은다(EKS 탭이 열려 있으면 같은 쿼리를 나눠 쓴다)
  useUsageSampler(target, chosen, null, ssoProfile, live);
  let body;
  if (!settingsReady || ctx.isPending) body = <div className="empty small">{STATE_CONNECTING}</div>;
  else if (ctx.isError) body = <K8sError error={ctx.error} target={target} ssoProfile={target.profile} compact />;
  else if (chosen === null) body = <p className="dim">{CLUSTER_DETAIL_NO_CONTEXT}</p>;
  else if (session.isError) body = <K8sError error={session.error} target={target} ssoProfile={ssoProfile} compact />;
  else if (overview.isError) {
    body = <ErrorState error={overview.error} profile={target.profile} compact onRetry={() => void overview.refetch()} onLoggedIn={() => void overview.refetch()} />;
  } else if (!overview.data) body = <div className="empty small">{live ? LOADING : STATE_CONNECTING}</div>;
  else {
    const o = overview.data;
    const liveNodes = metrics.data && metrics.data.nodesUnavailable === null
      ? new Map(metrics.data.nodes.map((n) => [n.name, { cpuMilli: n.cpuMilli, memoryBytes: n.memoryBytes }]))
      : null;
    body = (
      <>
        {o.nodes && <ClusterSummary nodes={o.nodes} live={liveNodes} historyKey={historyKey(target, chosen)} metrics={o.metrics || liveNodes !== null} />}
        <h4>{SEC_WARNINGS}</h4>
        <RecentWarnings target={target} context={chosen} sessionEpoch={session.dataUpdatedAt} ssoProfile={ssoProfile} live={live} />
      </>
    );
  }
  return (
    <section className="k8s-cluster-detail" aria-label={SEC_CLUSTER_USAGE}>
      <div className="sect">{SEC_CLUSTER_USAGE}</div>
      {body}
    </section>
  );
}
