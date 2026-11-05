import { errorMessage } from "../../api/errors";
import { useKubeContexts, useServerKubeContext } from "../ops/queries";
import { type ControllerPoint, type Latency } from "./controller";
import { seconds } from "./format";
import { useControllerMetrics } from "./queries";
import { useServerSettings } from "./serverSettings";
import { Spark } from "./Spark";
import { METRICS_TEXT as T } from "./text";

const DEFAULT_NAMESPACE = "argocd";

function latencyText(latency: Latency | null): string {
  if (latency === null) return "—";
  if (latency.p50 === null && latency.p95 === null) return T.ctlNoData;
  return `${seconds(latency.p50)} / ${seconds(latency.p95)}${latency.cumulative ? ` ${T.ctlCumulative}` : ""}`;
}

/** 분당 값의 합. 하나라도 모르면 null */
function totalRate(rates: { perMin: number | null }[]): number | null {
  return rates.length === 0 || rates.some((r) => r.perMin === null) ? null : rates.reduce((a, r) => a + (r.perMin as number), 0);
}

const rate = (value: number | null) => (value === null ? "—" : T.ctlRatePerMin(value));

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="argo-metrics-card"><h5>{title}</h5>{children}</div>;
}

function Rows({ rows }: { rows: [string, string][] }) {
  return <div className="rows">{rows.map(([k, v]) => <div key={k}><span>{k}</span><span>{v}</span></div>)}</div>;
}

/** ArgoCD 자체 상태: 컨트롤러·repo-server·server·ApplicationSet 컨트롤러의 `/metrics`를 대상 클러스터의 서비스 프록시로 읽는다 */
export function ControllerPanel({ url, live, onSettings }: { url: string; live: boolean; onSettings: () => void }) {
  const { kubeContext } = useServerKubeContext(url);
  const { server } = useServerSettings(url);
  const contexts = useKubeContexts();
  const namespace = server?.argocdNamespace || DEFAULT_NAMESPACE;
  const metrics = useControllerMetrics(url, kubeContext, namespace, live);
  if (!kubeContext) {
    return (
      <div className="argo-metrics-scroll">
        <div>{T.ctlNeedContext}</div>
        <div><button className="btn small tone-primary" disabled={contexts.isError} onClick={onSettings}>{T.settings}</button></div>
      </div>
    );
  }
  const point: ControllerPoint | undefined = metrics.data?.point;
  const history = metrics.data?.history ?? [];
  return (
    <div className="argo-metrics-scroll">
      <div className="argo-metrics-bar">
        <span>{T.ctlContext}: <b className="mono">{kubeContext}</b> · {T.ctlNamespace}: <b className="mono">{namespace}</b></span>
        <span className="argo-metrics-note">{T.ctlPoll}</span>
        <span className="argo-metrics-note">{T.ctlHistory(history.length)}</span>
        <button className="btn small tone-secondary" onClick={onSettings}>{T.settings}</button>
      </div>
      {metrics.isError && <div className="err" role="alert">{errorMessage(metrics.error)}</div>}
      {!point && !metrics.isError && <div className="argo-metrics-note">{metrics.isFetching || !live ? T.ctlWaiting : T.loading}</div>}
      {point && (
        <Card title={T.ctlComponents}>
          <div className="rows">{point.components.map((c) => <div key={c.component}><span className="mono">{c.component}</span>{c.ok ? <span>{T.ctlOk}</span> : <span className="err">{c.error}</span>}</div>)}</div>
        </Card>
      )}
      {point && (
        <div className="argo-metrics-cards">
          <Card title={T.ctlReconcile}>
            <b>{latencyText(point.reconcile)}</b>
            <Spark values={history.map((p) => p.reconcile?.p95 ?? null)} label={T.ctlReconcile} />
          </Card>
          <Card title={T.ctlSync}>
            <Rows rows={point.syncByPhase.map((s) => [s.key, `${s.total} · ${rate(s.perMin)}`])} />
            <Spark values={history.map((p) => totalRate(p.syncByPhase))} label={T.ctlSync} />
          </Card>
          <Card title={T.ctlGitLatency}>
            <b>{latencyText(point.gitLatency)}</b>
            <Spark values={history.map((p) => p.gitLatency?.p95 ?? null)} label={T.ctlGitLatency} />
            <Rows rows={[...point.gitRequests.map((g): [string, string] => [g.key, `${g.total} · ${rate(g.perMin)}`]), [T.ctlRepoPending, point.repoPending === null ? "—" : String(point.repoPending)]]} />
          </Card>
          <Card title={T.ctlQueues}>
            <Rows rows={point.queues.map((q) => [`${q.component} · ${q.name}`, String(q.depth)])} />
            <Spark values={history.map((p) => p.queues.reduce((a, q) => Math.max(a, q.depth), 0))} label={T.ctlQueues} />
          </Card>
          <Card title={T.ctlExec}>
            <b>{point.execPending === null ? "—" : point.execPending}</b>
            <Spark values={history.map((p) => p.execPending)} label={T.ctlExec} />
          </Card>
          <Card title={T.ctlAppset}>
            <b>{point.appsetErrors === null ? "—" : T.ctlErrorsTotal(point.appsetErrors.total)}</b>
            {point.appsetErrors && <span className="argo-metrics-note">{rate(point.appsetErrors.perMin)}</span>}
            <Spark values={history.map((p) => p.appsetErrors?.perMin ?? null)} label={T.ctlAppset} />
          </Card>
        </div>
      )}
      {point && point.clusters.length > 0 && (
        <>
          <h4>{T.ctlClusters}</h4>
          <table className="argo-metrics-table">
            <thead><tr><th>{T.ctlCluster}</th><th>{T.ctlConnected}</th><th>{T.ctlObjects}</th><th>{T.ctlResources}</th><th>{T.ctlCacheAge}</th><th>{T.ctlEvents}</th></tr></thead>
            <tbody>
              {point.clusters.map((c) => (
                <tr key={c.server}>
                  <th>{c.name ?? c.server}{c.version && <div className="argo-metrics-note">{c.version}</div>}</th>
                  <td className={c.connected === false ? "err" : ""}>{c.connected === null ? "—" : c.connected ? T.ctlConnected : T.ctlDisconnected}</td>
                  <td className="num">{c.objects ?? "—"}</td>
                  <td className="num">{c.resources ?? "—"}</td>
                  <td className="num">{c.cacheAgeSeconds === null ? "—" : T.cacheAge(c.cacheAgeSeconds)}</td>
                  <td className="num">{rate(c.eventsPerMin)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
