import { useMemo, useRef, useState } from "react";
import { QueueMap } from "./graph/QueueMap";
import { ListFind, useListFind } from "../components/ListFind";
import { fuzzyKeep } from "../lib/fuzzy";
import { BACKLOG_WARN, BULL_OPEN_STATES, orderQueues, RECENT_MINUTES, STATE_LABEL, type QueueHealth } from "./bull";
import { Sparkline } from "./BullCharts";
import * as bt from "./bullText";
import { formatCount } from "./format";
import { KvError } from "./KvError";
import { BULL_AUTO_SCAN_LIMIT, useKvBullQueues } from "./queries";
import * as t from "./text";
import type { KvBullQueue, KvTarget } from "./types";

/** 카드에 위험·주의가 붙은 이유(글) */
function reasons(q: KvBullQueue, h: QueueHealth): string[] {
  const out: string[] = [];
  if (h.stalled) out.push(bt.REASON_STALLED);
  if (h.failing) out.push(bt.REASON_FAILING(h.failedRecent, RECENT_MINUTES));
  if (h.backlog >= BACKLOG_WARN) out.push(bt.REASON_BACKLOG(h.backlog));
  if (q.paused && h.backlog + q.counts.paused > 0) out.push(bt.REASON_PAUSED);
  return out;
}

const workersText = (workers: number | null) => (workers === null ? bt.WORKERS_UNKNOWN : workers === 0 ? bt.NO_WORKERS : formatCount(workers));

function QueueCard({ queue, health, onOpen }: { queue: KvBullQueue; health: QueueHealth; onOpen: () => void }) {
  const open = BULL_OPEN_STATES.map((s) => ({ state: s, n: queue.counts[s] }));
  const total = open.reduce((n, s) => n + s.n, 0);
  const why = reasons(queue, health);
  return (
    <div
      className={`kv-qcard${health.attention ? ` ${health.attention}` : ""}`}
      role="button"
      tabIndex={0}
      aria-label={`${queue.name} ${t.OVERVIEW_LABEL}`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="kv-qcard-head">
        <b className="mono kv-qname">{queue.name}</b>
        <span className="iam-chip">
          {bt.FLAVOR[queue.flavor]}
          {queue.version ? ` ${queue.version.replace(/^bullmq:/, "")}` : ""}
        </span>
        {queue.paused && <span className="iam-chip kv-q-paused">{bt.PAUSED_BADGE}</span>}
        {health.attention && (
          <span className={`iam-chip kv-q-${health.attention}`} title={why.join("\n")}>
            {bt.ATTENTION[health.attention]}
          </span>
        )}
      </div>
      <div className="kv-statebar" role="img" aria-label={open.filter((s) => s.n > 0).map((s) => `${STATE_LABEL[s.state]} ${s.n}`).join(", ") || bt.QUEUE_EMPTY}>
        {total === 0 ? <span className="empty-bar" /> : open.filter((s) => s.n > 0).map((s) => <span key={s.state} className={`kv-s-${s.state}`} style={{ width: `${(s.n / total) * 100}%` }} />)}
      </div>
      <div className="kv-legend">
        {open.filter((s) => s.n > 0).map((s) => (
          <span key={s.state}>
            <i className={`kv-dot kv-s-${s.state}`} />
            {STATE_LABEL[s.state]} <b className="mono">{formatCount(s.n)}</b>
          </span>
        ))}
        {total === 0 && <span className="dim">{bt.QUEUE_EMPTY}</span>}
      </div>
      <div className="kv-qstats">
        <span>
          {bt.COMPLETED_TOTAL} <b className="mono">{formatCount(queue.counts.completed)}</b>
        </span>
        <span className={queue.counts.failed > 0 ? "kv-failed" : undefined}>
          {bt.FAILED_TOTAL} <b className="mono">{formatCount(queue.counts.failed)}</b>
        </span>
        <span className={queue.workers === 0 ? "kv-failed" : undefined}>
          {bt.WORKERS} <b className="mono">{workersText(queue.workers)}</b>
        </span>
      </div>
      <div className="kv-qspark">
        <Sparkline completed={queue.recent.completed} failed={queue.recent.failed} label={`${queue.name} ${bt.RECENT_60}`} />
        <small className="dim">{bt.RECENT_60}</small>
      </div>
      {why.length > 0 && <div className="kv-qwhy">{why[0]}</div>}
    </div>
  );
}

interface Props {
  target: KvTarget;
  /** 큐를 찾는 prefix(대상별로 기억한다) */
  prefix: string;
  onPrefix: (prefix: string) => void;
  onOpenQueue: (name: string) => void;
  /** 이 탭이 보이는 탭이고 이 화면이 보일 때만 5초마다 다시 읽는다 */
  active: boolean;
}

/**
 * 🐂 큐 목록: prefix 아래의 큐를 카드로 보인다. 실패가 늘거나 대기가 쌓였는데 워커가 없는 큐가 위로 가고 노랑·빨강 테두리가 붙는다.
 * 5초마다 다시 읽는다(끌 수 있고, 화면이 보일 때만). 큐를 찾는 SCAN이 길어지면 이어서 찾는다.
 */
export function BullQueues({ target, prefix, onPrefix, onOpenQueue, active }: Props) {
  const box = useRef<HTMLElement>(null);
  const find = useListFind(box, { enabled: active });
  const [auto, setAuto] = useState(true);
  // 카드(기본)와 지도(큐·부모→자식 연결·워커 호스트의 그래프)
  const [mode, setMode] = useState<"cards" | "map">("cards");
  const [input, setInput] = useState(prefix);
  const q = useKvBullQueues(target, prefix, auto && active);
  const pages = q.data?.pages;
  const queues = useMemo(() => {
    const seen = new Map<string, KvBullQueue>();
    for (const p of pages ?? []) for (const queue of p.queues) seen.set(`${queue.prefix}:${queue.name}`, queue);
    return [...seen.values()];
  }, [pages]);
  const kept = useMemo(() => fuzzyKeep(queues, find.query, (queue) => [queue.name]), [queues, find.query]);
  const ordered = useMemo(() => orderQueues(kept), [kept]);
  // 지도가 카드와 같은 건강 상태 색을 쓰게 넘긴다
  const attention = useMemo(() => new Map(orderQueues(queues).map((o) => [o.queue.name, o.health.attention])), [queues]);
  const last = pages?.[pages.length - 1];
  const scanned = pages?.reduce((n, p) => n + p.scanned, 0) ?? 0;
  const tooBig = (pages?.[0]?.scanned ?? 0) > BULL_AUTO_SCAN_LIMIT;

  return (
    <section className="center kv-screen kv-bull" ref={box} aria-label={bt.BULL_TITLE}>
      <div className="kv-bar">
        <form
          className="kv-pattern"
          onSubmit={(e) => {
            e.preventDefault();
            const next = input.trim() || "bull";
            setInput(next);
            if (next === prefix) void q.refetch();
            else onPrefix(next);
          }}
        >
          <label className="kv-pattern-field">
            <small className="dim">{bt.PREFIX_LABEL}</small>
            <input className="field-input mono" aria-label={bt.PREFIX_LABEL} value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false} autoComplete="off" />
          </label>
          <button type="submit" className="btn small">
            {bt.PREFIX_FIND}
          </button>
        </form>
        {pages && (
          <span className="dim">
            {bt.QUEUE_COUNT(queues.length)} · {bt.SCANNED(scanned)}
          </span>
        )}
        <div className="kv-seg kv-view-seg" role="group" aria-label={t.MAP_VIEW}>
          {(["cards", "map"] as const).map((m) => (
            <button key={m} type="button" className={`kv-seg-btn${mode === m ? " on" : ""}`} aria-pressed={mode === m} onClick={() => setMode(m)}>
              {m === "cards" ? t.MAP_CARDS : t.MAP_MAP}
            </button>
          ))}
        </div>
        <span className="kv-bar-end">
          <label className="kv-check" title={tooBig ? bt.AUTO_OFF_BIG : undefined}>
            <input type="checkbox" checked={auto && !tooBig} disabled={tooBig} onChange={(e) => setAuto(e.target.checked)} />
            {bt.AUTO_REFRESH}
          </label>
          <button className="btn small" onClick={() => void q.refetch()} disabled={q.isFetching}>
            {q.isFetching ? t.READING : t.REREAD}
          </button>
        </span>
      </div>
      {last && last.cursor !== null && (
        <div className="notice kv-partial" role="status">
          <span>{bt.PARTIAL}</span>
          <button className="btn small" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {q.isFetchingNextPage ? t.READING : bt.FIND_MORE}
          </button>
        </div>
      )}
      <ListFind find={find} count={kept.length} />
      {!pages ? (
        q.isError ? (
          <KvError error={q.error} target={target} />
        ) : (
          <div className="empty">{bt.SEARCHING}</div>
        )
      ) : (
        <div className="kv-pane">
          {q.isError && <KvError compact error={q.error} target={target} />}
          {mode === "map" && queues.length > 0 ? (
            <QueueMap target={target} prefix={prefix} attention={attention} onOpenQueue={onOpenQueue} />
          ) : ordered.length === 0 ? (
            <div className="empty small">{queues.length === 0 ? bt.NO_QUEUES(prefix) : t.KEYS_NO_MATCH}</div>
          ) : (
            <div className="kv-qgrid">
              {ordered.map(({ queue, health }) => (
                <QueueCard key={`${queue.prefix}:${queue.name}`} queue={queue} health={health} onOpen={() => onOpenQueue(queue.name)} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
