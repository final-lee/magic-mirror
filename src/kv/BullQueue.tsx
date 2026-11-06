import { useEffect, useRef, useState } from "react";
import { FlowFull } from "./graph/FlowFull";
import { TransitionsPanel } from "./graph/TransitionsPanel";
import { BULL_STATES, defaultJobState, formatMs, progressPercent, rebin, STATE_LABEL } from "./bull";
import { Histogram, ThroughputChart } from "./BullCharts";
import { BullJob } from "./BullJob";
import * as bt from "./bullText";
import { formatCount, formatDuration, formatUnix } from "./format";
import { KvError } from "./KvError";
import { useKvBullJobs, useKvBullQueue } from "./queries";
import * as t from "./text";
import type { KvBullJobRow, KvBullPercentiles, KvBullQueueView, KvBullState, KvTarget } from "./types";

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** 24시간 그림은 10분씩 묶는다(1440칸을 600px에 그리면 너무 가늘다) */
const DAILY_BIN = 10;

function Percentiles({ title, p, histogram, samples }: { title: string; p: KvBullPercentiles | null; histogram: KvBullQueueView["waitHistogram"]; samples: number }) {
  return (
    <div className="kv-timing">
      <h5>{title}</h5>
      {p === null || samples === 0 ? (
        <p className="dim">{bt.TIMING_NONE}</p>
      ) : (
        <>
          <dl className="kv-pct">
            <div>
              <dt>p50</dt>
              <dd className="mono">{formatMs(p.p50)}</dd>
            </div>
            <div>
              <dt>p95</dt>
              <dd className="mono">{formatMs(p.p95)}</dd>
            </div>
            <div>
              <dt>{bt.MAX}</dt>
              <dd className="mono">{formatMs(p.max)}</dd>
            </div>
          </dl>
          <Histogram buckets={histogram} label={bt.HISTOGRAM(title)} />
        </>
      )}
    </div>
  );
}

function ProgressCell({ progress }: { progress: string | null }) {
  const pct = progressPercent(progress);
  if (pct !== null) {
    return (
      <span className="kv-prog">
        <span className="kv-meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <span style={{ width: `${pct}%` }} />
        </span>
        <span className="mono">{pct}%</span>
      </span>
    );
  }
  return <span className="mono dim">{progress ?? t.DASH}</span>;
}

function JobRows({ rows, onOpen }: { rows: KvBullJobRow[]; onOpen: (id: string) => void }) {
  return (
    <table className="kv-table" aria-label={bt.JOBS_LABEL}>
      <thead>
        <tr>
          {Object.values(bt.JOBS_COLS).map((c) => (
            <th key={c} scope="col" className="nosort">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((j) => (
          <tr key={`${j.state}-${j.id}`} className="kv-job-row" onClick={() => onOpen(j.id)}>
            <td className="mono kv-nowrap">{j.name || t.DASH}</td>
            <td className="mono kv-nowrap">
              <button type="button" className="link" onClick={() => onOpen(j.id)}>
                {j.id}
              </button>
            </td>
            <td className="mono kv-nowrap">{j.timestamp === null ? t.DASH : formatUnix(j.timestamp / 1000)}</td>
            <td className="mono num kv-nowrap">{j.attemptsMade}</td>
            <td>
              <ProgressCell progress={j.progress} />
            </td>
            <td className="kv-reason" title={j.failedReason ?? undefined}>
              {j.failedReason ?? t.DASH}
            </td>
            <td className="mono">
              {j.delayUntil !== null ? bt.DELAY_UNTIL(formatUnix(j.delayUntil / 1000)) : j.priority ? bt.PRIORITY(j.priority) : t.DASH}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function JobTable({ target, prefix, name, state, onOpen }: { target: KvTarget; prefix: string; name: string; state: KvBullState; onOpen: (id: string) => void }) {
  const q = useKvBullJobs(target, prefix, name, state);
  const rows = (q.data?.pages ?? []).flatMap((p) => p.jobs);
  const total = q.data?.pages[q.data.pages.length - 1]?.total ?? 0;
  if (!q.data) return q.isError ? <KvError error={q.error} target={target} /> : <div className="empty small">{t.LOADING}</div>;
  return (
    <>
      {q.isError && <KvError compact error={q.error} target={target} />}
      {rows.length === 0 ? (
        <div className="empty small">{bt.JOBS_EMPTY}</div>
      ) : (
        <>
          <JobRows rows={rows} onOpen={onOpen} />
          <div className="kv-more">
            <span className="dim">{bt.JOBS_READ(rows.length, total)}</span>
            {q.hasNextPage && (
              <button type="button" className="btn small tone-secondary" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
                {q.isFetchingNextPage ? t.READING : t.MORE}
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}

interface Props {
  target: KvTarget;
  prefix: string;
  name: string;
  /** 작업 표가 보이는 상태. 없으면 실패가 있으면 실패, 아니면 비어 있지 않은 첫 상태 */
  state: KvBullState | undefined;
  /** 작업 상세가 열려 있는 작업 */
  jobId: string | undefined;
  onBack: () => void;
  onState: (state: KvBullState) => void;
  /** 작업 상세를 연다. queue는 이 큐일 수도, 흐름에서 건너간 다른 큐일 수도 있다 */
  onOpenJob: (queue: string, id: string) => void;
  onCloseJob: () => void;
  active: boolean;
}

/**
 * 🐂 큐 상세: 상태별 작업 수(누르면 그 상태의 작업 표), 일시정지·워커·반복 작업·가장 오래 기다린 작업·다음 지연 작업,
 * 처리량(최근 60분, 지표가 있으면 24시간), 대기·처리 시간(p50·p95와 분포), 실패 이유, 워커 표, 작업 표.
 * 작업을 누르면 목록의 70%를 덮는 작업 상세가 열린다. 5초마다 다시 읽는다(끌 수 있다).
 */
export function BullQueue({ target, prefix, name, state, jobId, onBack, onState, onOpenJob, onCloseJob, active }: Props) {
  const [auto, setAuto] = useState(true);
  // 작업 상세의 흐름 그래프를 이 큐 화면 전체에 크게 보는 중이면 그 작업
  const [bigFlow, setBigFlow] = useState<{ queue: string; id: string } | null>(null);
  const q = useKvBullQueue(target, prefix, name, auto && active);
  const view = q.data;
  const jobs = useRef<HTMLDivElement>(null);
  const shown: KvBullState | null = view ? (state ?? defaultJobState(view.queue.counts)) : null;
  // 상태 칸을 누르면 그 상태의 작업 표가 보이게 내려간다. 처음 그릴 때(기본 상태)는 움직이지 않는다.
  const picked = useRef(false);
  useEffect(() => {
    if (picked.current) jobs.current?.scrollIntoView?.({ block: "nearest" });
  }, [state]);

  return (
    <section className="center detail-host kv-screen kv-bull-queue" aria-label={name}>
      <div className="kv-bar">
        <button className="btn small tone-nav" onClick={onBack}>
          ‹ {bt.BACK_TO_LIST}
        </button>
        <b className="mono">{name}</b>
        {view && (
          <>
            <span className="iam-chip">
              {bt.FLAVOR[view.queue.flavor]}
              {view.queue.version ? ` ${view.queue.version.replace(/^bullmq:/, "")}` : ""}
            </span>
            {view.queue.paused && <span className="iam-chip kv-q-paused">{bt.PAUSED_BADGE}</span>}
          </>
        )}
        <span className="kv-bar-end">
          <label className="kv-check">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            {bt.AUTO_REFRESH}
          </label>
          <button className="btn small tone-refresh" onClick={() => void q.refetch()} disabled={q.isFetching}>
            {q.isFetching ? t.READING : t.REREAD}
          </button>
        </span>
      </div>
      {!view ? (
        q.isError ? (
          <KvError error={q.error} target={target} />
        ) : (
          <div className="empty">{t.LOADING}</div>
        )
      ) : (
        <div className="kv-pane kv-bq">
          {q.isError && <KvError compact error={q.error} target={target} />}
          <div className="kv-tiles" role="group" aria-label={bt.STATE_TILES}>
            {BULL_STATES.map((s) => (
              <button
                key={s}
                type="button"
                className={`kv-tile kv-s-${s}${shown === s ? " on" : ""}${s === "failed" && view.queue.counts.failed > 0 ? " bad" : ""}`}
                aria-pressed={shown === s}
                onClick={() => {
                  picked.current = true;
                  onState(s);
                }}
              >
                <span className="kv-tile-label">{STATE_LABEL[s]}</span>
                <b className="mono">{formatCount(view.queue.counts[s])}</b>
              </button>
            ))}
          </div>
          <dl className="kv-facts">
            <div>
              <dt>{bt.OVERVIEW_PAUSED}</dt>
              <dd>{view.queue.paused ? bt.YES : bt.NO}</dd>
            </div>
            <div>
              <dt>{bt.WORKERS}</dt>
              <dd className={view.queue.workers === 0 ? "kv-failed" : undefined}>{view.queue.workers === null ? bt.WORKERS_UNKNOWN : view.queue.workers === 0 ? bt.NO_WORKERS : formatCount(view.queue.workers)}</dd>
            </div>
            <div>
              <dt>{bt.REPEATABLES}</dt>
              <dd>{formatCount(view.queue.repeatables)}</dd>
            </div>
            <div>
              <dt>{bt.OLDEST_WAITING}</dt>
              <dd>{view.oldestWaitingAt === null ? t.DASH : bt.AGO(formatMs(Math.max(0, Date.now() - view.oldestWaitingAt)))}</dd>
            </div>
            <div>
              <dt>{bt.NEXT_DELAYED}</dt>
              <dd>{view.nextDelayedAt === null ? t.DASH : view.nextDelayedAt >= Date.now() ? bt.IN(formatMs(view.nextDelayedAt - Date.now())) : bt.AGO(formatMs(Date.now() - view.nextDelayedAt))}</dd>
            </div>
          </dl>

          <div className="kv-twocol">
            <div>
              <h4 className="kv-section">{bt.THROUGHPUT}</h4>
              <p className="kv-note dim">
                {bt.THROUGHPUT_60} · <i className="kv-dot kv-bar-c" /> {bt.COMPLETED} <i className="kv-dot kv-bar-f" /> {bt.FAILED}
              </p>
              <ThroughputChart
                completed={view.queue.recent.completed}
                failed={view.queue.recent.failed}
                from={hhmm(view.bucketStart)}
                to={bt.NOW}
                label={bt.CHART_SUMMARY(bt.THROUGHPUT_60, sum(view.queue.recent.completed), sum(view.queue.recent.failed))}
                title={(i, c, f) => `${hhmm(view.bucketStart + i * 60_000)} · ${bt.COMPLETED} ${c} · ${bt.FAILED} ${f}`}
              />
              {view.daily && (
                <>
                  <p className="kv-note dim">{bt.THROUGHPUT_24H}</p>
                  <ThroughputChart
                    completed={rebin(view.daily.completed, DAILY_BIN)}
                    failed={rebin(view.daily.failed, DAILY_BIN)}
                    from={hhmm(view.daily.start)}
                    to={bt.NOW}
                    label={bt.CHART_SUMMARY(bt.THROUGHPUT_24H, sum(view.daily.completed), sum(view.daily.failed))}
                    title={(i, c, f) => `${hhmm(view.daily!.start + i * DAILY_BIN * 60_000)} · ${bt.COMPLETED} ${c} · ${bt.FAILED} ${f}`}
                  />
                </>
              )}
            </div>
            <div>
              <h4 className="kv-section">{bt.TIMING}</h4>
              <p className="kv-note dim">{bt.TIMING_NOTE(view.samples)}</p>
              <div className="kv-timings">
                <Percentiles title={bt.WAIT_TIME} p={view.waitMs} histogram={view.waitHistogram} samples={view.samples} />
                <Percentiles title={bt.PROCESS_TIME} p={view.processMs} histogram={view.processHistogram} samples={view.samples} />
              </div>
            </div>
          </div>

          <div className="kv-twocol">
            <div>
              <h4 className="kv-section">{bt.FAILURE_REASONS}</h4>
              {view.failedReasons.length === 0 ? (
                <p className="kv-note dim">{bt.NO_FAILURES}</p>
              ) : (
                <>
                  <p className="kv-note dim">{bt.FAILURE_NOTE}</p>
                  <table className="kv-table kv-reasons" aria-label={bt.FAILURE_REASONS}>
                    <thead>
                      <tr>
                        {[bt.REASON_COL, bt.COUNT_COL, bt.LAST_COL].map((c) => (
                          <th key={c} scope="col" className="nosort">
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {view.failedReasons.map((r) => (
                        <tr key={r.reason}>
                          <td className="kv-reason">{r.reason}</td>
                          <td className="mono num">{formatCount(r.count)}</td>
                          <td className="mono">{r.lastAt === null ? t.DASH : formatUnix(r.lastAt / 1000)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
            <div>
              <h4 className="kv-section">{bt.WORKERS_TITLE}</h4>
              {view.workers === null ? (
                <p className="kv-note dim">{bt.WORKERS_UNAVAILABLE}</p>
              ) : view.workers.length === 0 ? (
                <p className="kv-note dim">{bt.WORKERS_NONE}</p>
              ) : (
                <table className="kv-table" aria-label={bt.WORKERS_TITLE}>
                  <thead>
                    <tr>
                      {Object.values(bt.WORKERS_COLS).map((c) => (
                        <th key={c} scope="col" className="nosort">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {view.workers.map((w, i) => (
                      <tr key={`${w.addr}-${i}`}>
                        <td className="mono">{w.name}</td>
                        <td className="mono">{w.addr}</td>
                        <td className="mono num">{formatDuration(w.age)}</td>
                        <td className="mono num">{formatDuration(w.idle)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <TransitionsPanel target={target} prefix={prefix} name={name} counts={view.queue.counts} />

          <div ref={jobs}>
            <h4 className="kv-section">
              {bt.JOBS_TITLE} · {shown ? STATE_LABEL[shown] : ""}
            </h4>
            {shown && <JobTable key={shown} target={target} prefix={prefix} name={name} state={shown} onOpen={(id) => onOpenJob(name, id)} />}
          </div>
        </div>
      )}
      {jobId && <BullJob key={`${name}:${jobId}`} target={target} prefix={prefix} queue={name} id={jobId} onClose={onCloseJob} onOpenJob={onOpenJob} onBigFlow={(fq, fid) => setBigFlow({ queue: fq, id: fid })} />}
      {bigFlow && (
        <FlowFull
          target={target}
          prefix={prefix}
          queue={bigFlow.queue}
          id={bigFlow.id}
          onClose={() => setBigFlow(null)}
          onOpen={(nq, nid) => {
            setBigFlow(null);
            onOpenJob(nq, nid);
          }}
        />
      )}
    </section>
  );
}

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);
