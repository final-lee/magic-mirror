import { useState } from "react";
import type { SqsQueue } from "../types";
import { SqsChangeDialog } from "./SqsChangeDialog";
import * as t from "./text";
import { useSqsChange } from "./useSqsChange";

interface Props {
  profile: string;
  region: string;
  queue: SqsQueue;
  queues: SqsQueue[];
}

export function QueueActions(props: Props) {
  return <Actions key={`${props.profile}:${props.region}:${props.queue.url}`} {...props} />;
}

function Actions({ profile, region, queue, queues }: Props) {
  const [open, setOpen] = useState(false);
  const [destination, setDestination] = useState("");
  const [rate, setRate] = useState("");
  const flow = useSqsChange(profile, region, queue.url, () => setOpen(false));
  const validRate = rate === "" || (/^\d+$/.test(rate) && Number(rate) >= 1 && Number(rate) <= 500);

  return (
    <div className="sqs-change-actions">
      {queue.isDlq && <button className="btn small tone-primary" onClick={() => setOpen(true)}>{t.REDRIVE}</button>}
      <button className="btn small tone-danger" onClick={() => flow.start({ kind: "purge" })}>{t.PURGE}</button>
      {flow.notice && <p className="notice sqs-change-notice" role="status">{flow.notice}</p>}
      {open && !flow.pending && (
        <div className="sqs-change-form">
          <label>
            {t.DESTINATION}
            <select value={destination} onChange={(e) => setDestination(e.target.value)}>
              <option value="">{t.ORIGINAL_SOURCE}</option>
              {queues.filter((q) => q.url !== queue.url).map((q) => <option key={q.arn} value={q.arn}>{q.name}</option>)}
            </select>
          </label>
          <label>
            {t.RATE}
            <input type="number" min="1" max="500" placeholder={t.OPTIMIZED} value={rate} onChange={(e) => setRate(e.target.value)} />
          </label>
          <button className="btn tone-ghost" onClick={() => setOpen(false)}>{t.CANCEL}</button>
          <button className="btn tone-primary" disabled={!validRate} title={!validRate ? t.INVALID_RATE : undefined}
            onClick={() => flow.start({ kind: "moveTask", destinationArn: destination || null, maxPerSecond: rate ? Number(rate) : null })}>
            {t.PREVIEW}
          </button>
        </div>
      )}
      {flow.pending && <SqsChangeDialog pending={flow.pending} onApply={flow.apply} onRetry={flow.retryPreview} onCancel={flow.cancel} />}
    </div>
  );
}
