import type { AttributeChange } from "./diff";
import type { Attribute } from "./types";
import { plainText } from "./value";

/** 값 하나: 타입 배지와 일반 값. 없으면 대시 */
export function TypedValue({ value }: { value: unknown }) {
  if (value === undefined || value === null) return <span className="dim">—</span>;
  const attribute = value as Attribute;
  return <><span className="iam-chip">{Object.keys(attribute)[0]}</span> <span className="ddb-typed-value">{plainText(attribute)}</span></>;
}

interface Props {
  changes: AttributeChange[];
  attribute: string;
  before: string;
  after: string;
}

/** 이전·새 값을 속성별로 맞댄 표. 바뀐 속성은 칠한다 */
export function AttributeDiff({ changes, attribute, before, after }: Props) {
  return (
    <table className="ddb-table ddb-diff">
      <thead>
        <tr>
          <th>{attribute}</th>
          <th>{before}</th>
          <th>{after}</th>
        </tr>
      </thead>
      <tbody>
        {changes.map((change) => (
          <tr key={change.name} className={change.changed ? "ddb-changed" : ""}>
            <td>{change.name}</td>
            <td><TypedValue value={change.before} /></td>
            <td><TypedValue value={change.after} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
