import { RecordDiff } from "./RecordDiff";
import * as t from "./text";
import type { StreamRecord } from "./types";

const timeLabel = (time: number | null) => (time === null ? t.NONE_VALUE : new Date(time * 1000).toLocaleString());

function RecordRow({ record }: { record: StreamRecord }) {
  return (
    <details className="ddb-stream-record">
      <summary>
        <time>{timeLabel(record.time)}</time>
        <b className={`ddb-stream-event ddb-stream-${record.event.toLowerCase()}`}>{t.eventLabel(record.event)}</b>
        <code>{JSON.stringify(record.keys)}</code>
        <span>{t.sizeLabel(record.size)}</span>
      </summary>
      <RecordDiff record={record} />
    </details>
  );
}

/** 레코드 목록(받은 순서 그대로). 한 줄을 펼치면 이미지 비교가 보인다 */
export function RecordList({ records }: { records: StreamRecord[] }) {
  if (records.length === 0) return <p className="dim">{t.EMPTY}</p>;
  return (
    <div className="ddb-stream-records">
      {records.map((record) => (
        <RecordRow key={record.id} record={record} />
      ))}
    </div>
  );
}
