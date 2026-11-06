import { useMemo, useRef, useState } from "react";
import { ErrorState } from "../components/ErrorState";
import { Highlight } from "../components/Highlight";
import { ListFind, useListFind } from "../components/ListFind";
import { fuzzyFilter, tokenize } from "../lib/fuzzy";
import { cronKey, runsByCron } from "./catalogData";
import { relTime } from "./catalogFormat";
import { useTokenGate } from "./catalogHooks";
import { PhaseCell, RunsBar } from "./catalogParts";
import {
  CAT_LOADING,
  CAT_NO_CRON_MATCH,
  CAT_NO_CRONS,
  CRON_COL_LAST,
  CRON_COL_NEXT,
  CRON_COL_POLICY,
  CRON_COL_RUNS,
  CRON_COL_SCHEDULE,
  CRON_COL_STATE,
  CRON_MISSED,
  CRON_NEVER_RAN,
  CRON_SEARCH,
  CRON_SUSPENDED,
  COL_NAME,
  COL_NAMESPACE,
  cronLastScheduled,
} from "./catalogText";
import { scheduleText } from "./cronText";
import { useCrons } from "./queries";
import { ManifestEditor } from "./ManifestEditor";
import type { ArgoWfConn, CronRow, WfRow } from "./types";

interface Props {
  conn: ArgoWfConn;
  live: boolean;
  namespace?: string | null;
  workflows: WfRow[];
  selected: { namespace: string; name: string } | null;
  onOpen: (namespace: string, name: string) => void;
  onTokenError: (message: string) => void;
}

const byName = (a: CronRow, b: CronRow) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name);

/** CronWorkflow 목록. 마지막 결과와 최근 10회 막대는 Workflow 목록의 cron-workflow 레이블로 모은다. */
export function CronList({ conn, live, namespace = null, workflows, selected, onOpen, onTokenError }: Props) {
  const q = useCrons(conn, namespace, live);
  useTokenGate([q.error], onTokenError);
  const listRef = useRef<HTMLDivElement>(null);
  const find = useListFind(listRef);
  const search = find.query;
  const [creating, setCreating] = useState(false);
  const runs = useMemo(() => runsByCron(workflows), [workflows]);
  const sorted = useMemo(() => (q.data ?? []).filter((c) => !namespace || c.namespace === namespace).sort(byName), [q.data, namespace]);
  const tokens = useMemo(() => tokenize(search), [search]);
  const rows = useMemo(
    () =>
      fuzzyFilter(sorted, search, (c) => [
        c.name,
        c.namespace,
        ...c.schedules.map((s) => scheduleText(s, c.timezone)),
        ...c.schedules,
        c.timezone,
        ...Object.values(c.labels),
      ]),
    [sorted, search],
  );
  const now = Date.now();

  return (
    <div className="awc">
      {q.isError && <ErrorState error={q.error} profile={conn.ssoProfile ?? ""} compact onRetry={() => void q.refetch()} />}
      <div className="awc-bar">
        <h2 className="awc-title">CronWorkflows</h2>
        <div className="awc-bar-end">
          <button className="btn tone-create small" onClick={() => setCreating(true)}>
            만들기…
          </button>
        </div>
      </div>
      <div className="awc-scroll" ref={listRef}>
        <ListFind find={find} placeholder={CRON_SEARCH} count={rows.length} />
        {q.isPending ? (
          <div className="empty">{CAT_LOADING}</div>
        ) : sorted.length === 0 ? (
          !q.isError && <div className="empty">{CAT_NO_CRONS}</div>
        ) : rows.length === 0 ? (
          <div className="empty">{CAT_NO_CRON_MATCH}</div>
        ) : (
          <table className="k8s-table awc-table" aria-label={CRON_SEARCH}>
            <thead>
              <tr>
                <th>{COL_NAME}</th>
                <th>{COL_NAMESPACE}</th>
                <th>{CRON_COL_SCHEDULE}</th>
                <th>{CRON_COL_NEXT}</th>
                <th>{CRON_COL_LAST}</th>
                <th>{CRON_COL_RUNS}</th>
                <th>{CRON_COL_STATE}</th>
                <th>{CRON_COL_POLICY}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const list = runs.get(cronKey(c.namespace, c.name)) ?? [];
                const last = list[0];
                const on = selected !== null && selected.namespace === c.namespace && selected.name === c.name;
                const open = () => onOpen(c.namespace, c.name);
                return (
                  <tr
                    key={cronKey(c.namespace, c.name)}
                    className={`awc-row${on ? " on" : ""}${c.suspended ? " awc-off" : ""}`}
                    tabIndex={0}
                    aria-selected={on}
                    onClick={open}
                    onKeyDown={(e) => e.key === "Enter" && open()}
                  >
                    <td className="mono k8s-wrap">
                      <Highlight text={c.name} tokens={tokens} />
                    </td>
                    <td className="mono">
                      <Highlight text={c.namespace} tokens={tokens} />
                    </td>
                    <td>
                      {c.schedules.map((s) => {
                        const human = scheduleText(s, c.timezone);
                        return (
                          <div key={s}>
                            <div>{human}</div>
                            {(human !== s || c.timezone) && (
                              <div className="mono dim">
                                {s}
                                {c.timezone && ` · ${c.timezone}`}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </td>
                    <td title={c.nextRuns[0] ?? ""}>{c.suspended ? <span className="dim">–</span> : relTime(c.nextRuns[0] ?? null, now)}</td>
                    <td>
                      {last ? (
                        <>
                          <PhaseCell row={last} />{" "}
                          <span className="dim" title={last.startedAt ?? ""}>
                            {relTime(last.startedAt, now)}
                          </span>
                        </>
                      ) : c.lastScheduledTime ? (
                        <span className="dim" title={c.lastScheduledTime}>
                          {cronLastScheduled(relTime(c.lastScheduledTime, now))}
                        </span>
                      ) : (
                        <span className="dim">{CRON_NEVER_RAN}</span>
                      )}
                    </td>
                    <td>
                      <RunsBar runs={list} now={now} />
                    </td>
                    <td>
                      {c.suspended && <span className="awc-badge">{CRON_SUSPENDED}</span>}
                      {c.missed && <span className="awc-badge warn">{CRON_MISSED}</span>}
                    </td>
                    <td className="dim">{c.concurrencyPolicy}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {creating && (
        <ManifestEditor
          conn={conn}
          kind="CronWorkflow"
          mode="create"
          namespace={namespace}
          onClose={() => setCreating(false)}
          onSaved={(r) => {
            setCreating(false);
            void q.refetch();
            if (r.namespace) onOpen(r.namespace, r.name);
          }}
        />
      )}
    </div>
  );
}
