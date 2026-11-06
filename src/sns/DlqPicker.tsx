import { useEffect, useMemo, useRef, useState } from "react";
import { useResources } from "../api/queries";
import { ErrorState } from "../components/ErrorState";
import { useModal } from "../iam/useModal";
import { fuzzyKeep } from "../lib/fuzzy";
import * as t from "./changeText";
import { SQS_QUEUES, SQS_SERVICE, dlqCandidates } from "./dlq";
import { endpointLabel } from "./format";
import type { SnsTopicRef } from "./targets";
import type { SnsSubscription, SnsTopic } from "./types";

interface Props {
  target: SnsTopicRef;
  topic: SnsTopic;
  subscription: SnsSubscription;
  /** [미리 보기…]: 고른 큐의 ARN으로 변경 대화창을 연다 */
  onPick: (dlqArn: string) => void;
  onClose: () => void;
}

/**
 * DLQ 고르기: 이 리전의 SQS 큐(리소스 브라우저가 읽는 목록과 같은 쿼리) 가운데 이 구독에 붙일 수 있는 큐만 보여 준다.
 * 종류 규칙: FIFO 구독은 FIFO 큐, 표준 구독은 표준 큐(SQS가 아닌 구독은 주제의 종류를 따른다). 같은 계정·리전이 아니거나 엔드포인트 큐 자신은 뺀다.
 * 고르는 것만 하고 아무것도 바꾸지 않는다: [미리 보기…]가 변경 대화창(SnsChangeDialog)으로 이어진다.
 */
export function DlqPicker({ target, topic, subscription, onPick, onClose }: Props) {
  const q = useResources(target.profile, target.region, SQS_SERVICE, SQS_QUEUES);
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { sheetRef, trapTab } = useModal(onClose);
  useEffect(() => cancelRef.current?.focus(), []);

  const candidates = useMemo(() => (q.data ? dlqCandidates(q.data.items, subscription, topic) : null), [q.data, subscription, topic]);
  const shown = useMemo(() => (candidates ? fuzzyKeep(candidates.queues, filter, (queue) => [queue.name, queue.arn]) : []), [candidates, filter]);
  const label = endpointLabel(subscription, topic).name;
  const title = `${t.DLQ_TITLE} · ${label}`;

  return (
    <div className="modal">
      <div className="sheet pk" role="dialog" aria-modal="true" aria-label={title} ref={sheetRef} onKeyDown={trapTab}>
        <h3>{t.DLQ_TITLE}</h3>
        <p className="mono dim sns-dlq-sub">{label}</p>
        {!candidates ? (
          q.isError ? (
            <ErrorState compact error={q.error} profile={target.profile} onRetry={() => void q.refetch()} />
          ) : (
            <p role="status">{t.DLQ_LOADING}</p>
          )
        ) : (
          <>
            <p className="sns-note">{t.DLQ_RULE(candidates.fifo)}</p>
            {candidates.queues.length > 8 && <input className="pk-search field-input" aria-label={t.DLQ_FILTER} placeholder={t.DLQ_FILTER} value={filter} autoFocus onChange={(e) => setFilter(e.target.value)} />}
            {candidates.queues.length === 0 ? (
              <p className="cp-none" role="status">
                {t.DLQ_EMPTY}
              </p>
            ) : shown.length === 0 ? (
              <p className="cp-none" role="status">
                {t.DLQ_NO_MATCH}
              </p>
            ) : (
              <ul className="pk-list sns-dlq-list" role="radiogroup" aria-label={t.DLQ_LIST}>
                {shown.map((queue) => (
                  <li key={queue.arn} className={`pk-opt${picked === queue.arn ? " on" : ""}`}>
                    <label className="sns-dlq-opt">
                      <input type="radio" name="sns-dlq" checked={picked === queue.arn} onChange={() => setPicked(queue.arn)} />
                      <span className="pk-name">{queue.name}</span>
                      <span className="dim sns-dlq-type">{candidates.fifo ? "FIFO" : "표준"}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {candidates.hidden > 0 && <p className="pk-note dim">{t.DLQ_HIDDEN(candidates.hidden)}</p>}
            {q.data?.truncated && <p className="pk-note dim">{t.DLQ_TRUNCATED}</p>}
          </>
        )}
        <div className="foot">
          <button ref={cancelRef} className="btn plain tone-ghost" onClick={onClose}>
            {t.CANCEL}
          </button>
          <button className="btn plain tone-primary" disabled={!picked} title={picked ? undefined : t.DLQ_NEED_PICK} onClick={() => picked && onPick(picked)}>
            {t.DLQ_PREVIEW}
          </button>
        </div>
      </div>
    </div>
  );
}
