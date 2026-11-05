import { useMemo } from "react";
import { useArgoEvents } from "../queries";
import type { ArgoAppRow } from "../types";
import { coverageStartOf } from "./dora";
import { outOfSyncRanking, outOfSyncTrend, policyGaps } from "./drift";
import { duration, localTime } from "./format";
import { Spark } from "./Spark";
import { METRICS_TEXT as T } from "./text";

const TREND_DAYS = 7;
const TREND_STEPS = 28;
const RANK_MAX = 20;
const NAMES_MAX = 12;

function AppList({ title, rows, onOpen }: { title: string; rows: ArgoAppRow[]; onOpen: (row: ArgoAppRow) => void }) {
  return (
    <div className="argo-metrics-card">
      <h5>{title}</h5>
      <b>{rows.length}</b>
      {rows.length === 0 ? <span className="argo-metrics-note">{T.noneApps}</span> : (
        <ul className="argo-metrics-list">
          {rows.slice(0, NAMES_MAX).map((r) => <li key={`${r.namespace}/${r.name}`}><button className="argo-metrics-link" onClick={() => onOpen(r)}>{r.name}</button></li>)}
          {rows.length > NAMES_MAX && <li className="argo-metrics-note">{T.moreApps(rows.length - NAMES_MAX)}</li>}
        </ul>
      )}
    </div>
  );
}

/** 드리프트: 지금 OutOfSync 수와 추이, 오래 어긋난 앱 순위, 자동 sync·selfHeal·prune이 꺼진 앱 */
export function DriftPanel({ url, rows, onOpen }: { url: string; rows: ArgoAppRow[]; onOpen: (row: ArgoAppRow) => void }) {
  const events = useArgoEvents(url, null);
  const model = useMemo(() => {
    const all = events.data ?? [];
    const now = Date.now();
    const coverage = coverageStartOf(all);
    const ranking = outOfSyncRanking(rows, all, now, coverage);
    return { ranking, trend: outOfSyncTrend(all, ranking.length, now, TREND_DAYS, TREND_STEPS, coverage), gaps: policyGaps(rows), now };
  }, [events.data, rows]);
  return (
    <div className="argo-metrics-scroll">
      <div className="argo-metrics-cards">
        <div className="argo-metrics-card">
          <h5>{T.outOfSyncNow}</h5>
          <b>{T.outOfSyncCount(model.ranking.length)}</b>
          <Spark values={model.trend.map((p) => p.count)} label={T.trend(TREND_DAYS)} />
          <span className="argo-metrics-note">{T.trend(TREND_DAYS)} · {T.trendUnknown}</span>
        </div>
      </div>
      <h4>{T.ranking}</h4>
      {model.ranking.length === 0 ? <div className="argo-metrics-note">{T.rankingEmpty}</div> : (
        <table className="argo-metrics-table">
          <thead><tr><th>{T.colApp}</th><th>{T.colSince}</th><th>{T.colLasted}</th></tr></thead>
          <tbody>
            {model.ranking.slice(0, RANK_MAX).map((d) => (
              <tr key={`${d.row.namespace}/${d.row.name}`}>
                <td><button className="argo-metrics-link" onClick={() => onOpen(d.row)}>{d.row.name}</button></td>
                <td>{d.since === null ? T.beforeRecording : localTime(d.since)}</td>
                <td>{d.atLeast ? (d.durationMs > 0 ? T.atLeast(duration(d.durationMs)) : "—") : duration(d.durationMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h4>{T.policies}</h4>
      <div className="argo-metrics-cards">
        <AppList title={T.autoSyncOff} rows={model.gaps.autoSyncOff} onOpen={onOpen} />
        <AppList title={T.selfHealOff} rows={model.gaps.selfHealOff} onOpen={onOpen} />
        <AppList title={T.pruneOff} rows={model.gaps.pruneOff} onOpen={onOpen} />
      </div>
    </div>
  );
}
