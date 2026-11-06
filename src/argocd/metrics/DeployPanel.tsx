import { useMemo, useState } from "react";
import { envOf } from "../argoEnv";
import { rowKey } from "../argoGroup";
import { useArgoEvents } from "../queries";
import { ARGO_ENV_TEXT } from "../text";
import type { ArgoAppRow } from "../types";
import { WINDOWS, computeStats, coverageStartOf, deploysOf, groupStats, incidentsOf, type DoraGroup, type DoraStats, type WindowDays } from "./dora";
import { duration, localTime, perDay, ratio } from "./format";
import { useDeployHistory } from "./queries";
import { METRICS_TEXT as T } from "./text";

const GROUPS: [DoraGroup, string][] = [["env", T.groupEnv], ["project", T.groupProject], ["app", T.groupApp]];

function Stats({ stats }: { stats: DoraStats }) {
  return (
    <>
      <td>{T.deploysText(stats.deployments, perDay(stats.perDay))}</td>
      <td>{stats.failureRate === null ? "—" : T.failureText(stats.failures, ratio(stats.failureRate))}</td>
      <td>{stats.restores === 0 && stats.openIncidents === 0 ? "—" : T.restoreText(duration(stats.restoreMedianMs), stats.restores, stats.openIncidents)}</td>
      <td>{stats.syncSamples === 0 ? "—" : T.syncText(duration(stats.syncP50Ms), duration(stats.syncP95Ms), stats.syncSamples)}</td>
    </>
  );
}

/** 배포 지표: 로컬 이벤트 기록과 서버 이력을 합쳐 환경·프로젝트·앱별 배포 빈도, 실패율, 복구 시간, sync 소요 시간 */
export function DeployPanel({ url, rows }: { url: string; rows: ArgoAppRow[] }) {
  const events = useArgoEvents(url, null);
  const history = useDeployHistory(url, true);
  const [days, setDays] = useState<WindowDays>(30);
  const [group, setGroup] = useState<DoraGroup>("env");
  const model = useMemo(() => {
    const all = events.data ?? [];
    const deploys = deploysOf(all, history.data ?? []);
    const incidents = incidentsOf(all);
    const coverage = coverageStartOf(all);
    const byApp = new Map(rows.map((r) => [rowKey(r.namespace, r.name), r]));
    const groupOf = (app: string) => {
      const row = byApp.get(app);
      if (!row) return null;
      return group === "project" ? row.values.project ?? null : envOf(row).env;
    };
    const now = Date.now();
    return {
      coverage,
      total: computeStats(deploys, incidents, days, now, coverage, deploys.length ? deploys[0].at : null),
      rows: groupStats(deploys, incidents, group, groupOf, days, now, coverage),
    };
  }, [events.data, history.data, rows, days, group]);
  const label = (key: string) => (key === "" ? T.unknownGroup : group === "env" ? ARGO_ENV_TEXT[key as keyof typeof ARGO_ENV_TEXT] ?? key : key);
  return (
    <div className="argo-metrics-scroll">
      <div className="argo-metrics-bar">
        <label className="k8s-field">
          {T.window}
          <select value={days} onChange={(e) => setDays(Number(e.target.value) as WindowDays)}>
            {WINDOWS.map((d) => <option key={d} value={d}>{T.windowDays(d)}</option>)}
          </select>
        </label>
        <label className="k8s-field">
          {T.groupBy}
          <select value={group} onChange={(e) => setGroup(e.target.value as DoraGroup)}>
            {GROUPS.map(([id, text]) => <option key={id} value={id}>{text}</option>)}
          </select>
        </label>
        <span>{model.coverage === null ? T.coverageNone : T.coverage(localTime(model.coverage))}</span>
      </div>
      <div className="argo-metrics-note">{T.coverageNote}</div>
      {history.isError && <div className="argo-metrics-note err">{T.deployFailed}</div>}
      <table className="argo-metrics-table">
        <thead>
          <tr><th>{T.colGroup}</th><th>{T.colDeploys}</th><th>{T.colFailure}</th><th>{T.colRestore}</th><th>{T.colSync}</th></tr>
        </thead>
        <tbody>
          <tr className="total"><th>{T.total}</th><Stats stats={model.total} /></tr>
          {model.rows.map((r) => <tr key={r.key}><th>{label(r.key)}</th><Stats stats={r.stats} /></tr>)}
        </tbody>
      </table>
    </div>
  );
}
