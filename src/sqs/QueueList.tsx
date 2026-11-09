import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { Highlight } from "../components/Highlight";
import { ListFind, useListFind } from "../components/ListFind";
import { formatCount } from "../kv/format";
import { tokenize } from "../lib/fuzzy";
import { hasProblem, listRows, queueHealth } from "./group";
import * as t from "./text";
import type { SqsQueue } from "./types";

interface Props {
  queues: SqsQueue[];
  selectedUrl: string | null;
  onSelect: (url: string) => void;
  /** 이 목록이 보일 때만 ⌘F를 받는다 */
  active: boolean;
  problemOnly: boolean;
  onProblemOnly: (on: boolean) => void;
}

/** 왼쪽 큐 목록: 원본 큐 아래에 DLQ를 들여 쓰고, 이름 퍼지 찾기(⌘F)와 "문제 있는 큐만" 거르기를 둔다 */
export function QueueList({ queues, selectedUrl, onSelect, active, problemOnly, onProblemOnly }: Props) {
  const box = useRef<HTMLElement>(null);
  const find = useListFind(box, { enabled: active });
  const rows = useMemo(() => listRows(queues, { problemOnly, query: find.query }), [queues, problemOnly, find.query]);
  const problems = useMemo(() => queues.filter(hasProblem).length, [queues]);
  const tokens = useMemo(() => tokenize(find.query), [find.query]);
  const selectedAt = rows.findIndex((r) => r.queue.url === selectedUrl);

  const selectedRow = useRef<HTMLDivElement>(null);
  useEffect(() => {
    selectedRow.current?.scrollIntoView?.({ block: "nearest" });
  }, [selectedUrl]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    if (rows.length === 0) return;
    const next = e.key === "ArrowDown" ? Math.min(rows.length - 1, selectedAt + 1) : Math.max(0, selectedAt < 0 ? 0 : selectedAt - 1);
    onSelect(rows[next].queue.url);
  };

  return (
    <section className="sqs-list" ref={box} aria-label={t.LIST_LABEL}>
      <ListFind find={find} placeholder={t.FIND_PLACEHOLDER} count={rows.length} />
      <div className="sqs-list-tools">
        <button type="button" className="sqs-chip" aria-pressed={problemOnly} onClick={() => onProblemOnly(!problemOnly)}>
          {t.PROBLEM_ONLY}
          {problems > 0 && <span className="sqs-chip-n">{problems}</span>}
        </button>
        <span className="dim sqs-list-count">{t.queueCount(rows.length)}</span>
      </div>
      <div className="sqs-row sqs-row-head" aria-hidden="true">
        <span />
        <span />
        <span className="sqs-num">{t.COL_VISIBLE}</span>
        <span className="sqs-num">{t.COL_IN_FLIGHT}</span>
        <span className="sqs-num">{t.COL_DELAYED}</span>
      </div>
      <div className="sqs-rows" role="listbox" aria-label={t.LIST_LABEL} tabIndex={0} onKeyDown={onKeyDown}>
        {rows.length === 0 && <div className="empty small">{queues.length === 0 ? t.NO_QUEUES : t.NO_MATCH}</div>}
        {rows.map(({ queue: q, depth, sourceCount }) => {
          const health = t.HEALTH[queueHealth(q)];
          const selected = q.url === selectedUrl;
          return (
            <div
              key={q.url}
              ref={selected ? selectedRow : undefined}
              role="option"
              aria-selected={selected}
              className={`sqs-row${selected ? " selected" : ""}${depth === 1 ? " nested" : ""}`}
              title={depth === 1 ? t.NESTED_DLQ : undefined}
              onClick={() => onSelect(q.url)}
            >
              <span className={`dot ${health.dot}`} role="img" aria-label={health.label} title={health.label} />
              <span className="sqs-row-name">
                <span className="mono sqs-row-title">
                  <Highlight text={q.name} tokens={tokens} />
                </span>
                {q.fifo && <span className="iam-chip">{t.BADGE_FIFO}</span>}
                {q.isDlq && <span className="iam-chip">{t.BADGE_DLQ}</span>}
                {depth === 0 && sourceCount > 1 && <span className="iam-chip">{t.sourceBadge(sourceCount)}</span>}
              </span>
              <span className={`sqs-num${q.isDlq && q.visible > 0 ? " bad" : ""}`}>{formatCount(q.visible)}</span>
              <span className="sqs-num">{formatCount(q.inFlight)}</span>
              <span className="sqs-num">{formatCount(q.delayed)}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
