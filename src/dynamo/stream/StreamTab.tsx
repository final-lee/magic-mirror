import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ErrorState } from "../../components/ErrorState";
import type { AppError } from "../../api/types";
import { fuzzyKeep } from "../../lib/fuzzy";
import { Findings } from "../Findings";
import type { DetailContext } from "../TableDetail";
import { streamApi } from "./api";
import * as t from "./text";
import type { StreamRecord } from "./types";
import { appendRecords } from "./records";

import "./stream.css";
export const connectionsKey = (profile: string, region: string, table: string) => ["dynamo", profile, region, "connections", table] as const;
export function useConnections(profile: string, region: string, table: string, enabled: boolean) {
  return useQuery({ queryKey: connectionsKey(profile, region, table), queryFn: () => streamApi.connections(profile, region, table), enabled, staleTime: 60_000, retry: false });
}
function ImageDiff({ record }: { record: StreamRecord }) {
  const names = Array.from(new Set([...Object.keys(record.oldImage ?? {}), ...Object.keys(record.newImage ?? {})])).sort();
  if (!names.length) return <p className="dim">{t.MISSING}</p>;
  return <table className="ddb-table ddb-stream-diff"><thead><tr><th>{t.ATTRIBUTE}</th><th>{t.OLD}</th><th>{t.NEW}</th></tr></thead><tbody>{names.map(name => {
    const old = record.oldImage?.[name], next = record.newImage?.[name];
    return <tr key={name} className={JSON.stringify(old) !== JSON.stringify(next) ? "ddb-stream-changed" : ""}><td>{name}</td><td><code>{old === undefined ? "—" : JSON.stringify(old)}</code></td><td><code>{next === undefined ? "—" : JSON.stringify(next)}</code></td></tr>;
  })}</tbody></table>;
}
export function StreamTab({ profile, region, table, active, onOpenLambda }: DetailContext) {
  const q = useConnections(profile, region, table.name, active);
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [from, setFrom] = useState("LATEST");
  const [records, setRecords] = useState<StreamRecord[]>([]);
  const [filter, setFilter] = useState("");
  const [kinds, setKinds] = useState<string[]>(["INSERT", "MODIFY", "REMOVE"]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const [status, setStatus] = useState({ shards: 0, behind: 0 });
  const [error, setError] = useState<AppError | null>(null);
  useEffect(() => {
    if (!active || !running || !table.stream) return;
    let cancelled = false, session: string | null = null, timer: number | undefined;
    async function start() {
      try {
        const opened = await streamApi.start(profile, region, table.name, from);
        if (cancelled) { void streamApi.stop(opened.streamId); return; }
        session = opened.streamId;
        async function poll() {
          if (cancelled || !session) return;
          if (pausedRef.current) { timer = window.setTimeout(poll, 2000); return; }
          try {
            const page = await streamApi.poll(session);
            if (cancelled) return;
            setRecords(old => appendRecords(old, page.records));
            setStatus({ shards: page.shards, behind: page.behind });
            timer = window.setTimeout(poll, 2000);
          } catch (e) { if (!cancelled) { setError(e as AppError); setRunning(false); } }
        }
        timer = window.setTimeout(poll, 2000);
      } catch (e) { if (!cancelled) { setError(e as AppError); setRunning(false); } }
    }
    void start();
    return () => { cancelled = true; clearTimeout(timer); if (session) void streamApi.stop(session); };
  }, [active, running, profile, region, table.name, table.stream?.arn, from]);
  useEffect(() => { setRunning(false); setRecords([]); setError(null); }, [profile, region, table.name, active]);
  const visible = useMemo(() => fuzzyKeep(records.filter(r => kinds.includes(r.event)), filter, r => [r.event, JSON.stringify(r.keys), JSON.stringify(r.oldImage), JSON.stringify(r.newImage)]).slice().reverse(), [records, kinds, filter]);
  return <div className="ddb-stream">
    <section className="ddb-card"><div className="ddb-card-head"><h4>{t.CONNECTIONS}</h4><button className="btn small tone-refresh" onClick={() => void q.refetch()} disabled={q.isFetching}>{t.REFRESH}</button></div>
      {q.isError ? <ErrorState compact error={q.error} profile={profile} onRetry={() => void q.refetch()} /> : !q.data ? <p className="dim">{t.LOADING}</p> : <>
        <div className="ddb-stream-graph"><div className="ddb-stream-node"><b>{table.name}</b></div>
          {q.data.stream && <div className="ddb-stream-branch"><div className="ddb-stream-node"><b>{t.STREAM}</b><small>{q.data.stream.viewType}</small></div><div className="ddb-stream-children">
            {q.data.esms.map(e => <div className="ddb-stream-node" key={e.id}><b>Lambda {e.function.split(":function:")[1] ?? e.function}</b><small>{e.state} · {t.batchAge(e.batchSize, e.iteratorAgeMs)}</small><details><summary>{t.MAPPING_SETTINGS}</summary><pre>{JSON.stringify({ startingPosition: e.startingPosition, parallelization: e.parallelization, bisect: e.bisect, retries: e.retries, maxAge: e.maxAge, failureDestination: e.failureDestination, filters: e.filters }, null, 2)}</pre></details>{onOpenLambda && <button className="btn small tone-nav" onClick={() => onOpenLambda(e.function)}>{t.JUMP}</button>}</div>)}
            {q.data.pipes.map(p => <div className="ddb-stream-node" key={p.name}><b>Pipe {p.name}</b><small>{p.state}</small><small>{p.target}</small></div>)}
            {!q.data.esms.length && !q.data.pipes.length && !q.data.kinesis.length && !q.data.gaps.some(g => ["lambda", "pipes", "kinesis"].includes(g.section)) && <span className="dim">{t.NO_CONSUMERS}</span>}
          </div></div>}
          {q.data.kinesis.map(k => <div className="ddb-stream-branch" key={k.arn}><div className="ddb-stream-node"><b>Kinesis</b><small>{k.arn}</small><small>{k.state} · {k.precision}</small></div></div>)}
          {q.data.replicas.map(r => <div className="ddb-stream-branch" key={r.region}><div className="ddb-stream-node"><b>↔ {r.region}</b><small>{r.status} · {r.class ?? "STANDARD"} · {t.seconds(r.latencyMs)}</small></div></div>)}
        </div>
        {!q.data.stream && <p className="dim">{t.NO_STREAM}</p>}
        {q.data.gaps.map((g, i) => <p className="ddb-stream-gap" key={i}>{t.GAP}: {g.section} — {g.error}</p>)}
        {q.data.findings.length > 0 && <><h5>{t.FINDINGS}</h5><Findings findings={q.data.findings} /></>}
      </>}
    </section>
    {table.stream && <section className="ddb-card"><h4>{t.LIVE}</h4><div className="ddb-stream-controls">
      <select aria-label={t.START_POSITION} value={from} disabled={running} onChange={e => setFrom(e.target.value)}><option value="LATEST">{t.LATEST}</option><option value="TRIM_HORIZON">{t.TRIM}</option></select>
      {!running ? <button className="btn small tone-primary" onClick={() => { setError(null); setRecords([]); setPaused(false); setRunning(true); }}>{t.START}</button> : <><button className={`btn small ${paused ? "tone-warn" : "tone-caution"}`} onClick={() => setPaused(!paused)}>{paused ? t.RESUME : t.PAUSE}</button><button className="btn small tone-caution" onClick={() => setRunning(false)}>{t.STOP}</button></>}
      {running && <span className="dim">{t.SHARDS(status.shards, status.behind)}</span>}
    </div>{from === "TRIM_HORIZON" && <p className="dim">{t.TRIM_WARNING}</p>}
      {error && <ErrorState compact error={error} profile={profile} onRetry={() => { setError(null); setRunning(true); }} />}
      <div className="ddb-stream-controls"><input aria-label={t.FILTER} placeholder={t.FILTER} value={filter} onChange={e => setFilter(e.target.value)} />{Object.entries(t.EVENT).map(([kind,label]) => <button key={kind} className="btn small tone-secondary" aria-pressed={kinds.includes(kind)} onClick={() => setKinds(old => old.includes(kind) ? old.filter(k => k !== kind) : [...old, kind])}>{label}</button>)}</div>
      {!visible.length ? <p className="dim">{t.EMPTY}</p> : <div className="ddb-stream-records">{visible.map((r,i) => <details key={`${r.id}-${i}`} className="ddb-stream-record"><summary><time>{r.time == null ? "—" : new Date(r.time * 1000).toLocaleString()}</time><b className={`ddb-stream-event ddb-stream-${r.event.toLowerCase()}`}>{t.EVENT[r.event as keyof typeof t.EVENT] ?? r.event}</b><code>{JSON.stringify(r.keys)}</code><span>{r.size == null ? "—" : `${r.size} B`}</span></summary><ImageDiff record={r} /></details>)}</div>}
    </section>}
  </div>;
}
