import { attributeChanges } from "./records";
import * as t from "./text";
import type { StreamRecord } from "./types";

const show = (value: unknown) => (value === undefined ? t.NONE_VALUE : JSON.stringify(value));

/** 이전·새 이미지를 속성별로 맞댄 표. 바뀐 속성은 칠한다. 뷰 타입이 이미지를 담지 않으면(KEYS_ONLY) 안내만 보인다 */
export function RecordDiff({ record }: { record: StreamRecord }) {
  const changes = attributeChanges(record);
  if (changes.length === 0) return <p className="dim">{t.MISSING}</p>;
  return (
    <table className="ddb-table ddb-stream-diff">
      <thead>
        <tr>
          <th>{t.ATTRIBUTE}</th>
          <th>{t.OLD}</th>
          <th>{t.NEW}</th>
        </tr>
      </thead>
      <tbody>
        {changes.map((change) => (
          <tr key={change.name} className={change.changed ? "ddb-stream-changed" : ""}>
            <td>{change.name}</td>
            <td>
              <code>{show(change.before)}</code>
            </td>
            <td>
              <code>{show(change.after)}</code>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
