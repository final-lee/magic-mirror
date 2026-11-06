import { AttributeDiff } from "../items/AttributeDiff";
import { diffImages } from "../items/diff";
import * as t from "./text";
import type { DynamoPreview } from "./types";

/** 이 줄 수를 넘는 요청 인자는 접어 둔다 */
const LARGE_PARAMS_LINES = 8;

type Plain = Record<string, unknown>;

const isPlain = (value: unknown): value is Plain => typeof value === "object" && value !== null && !Array.isArray(value);

/** 보낼 요청 하나: API 이름과 인자. 인자가 길면 접되, 인자는 그대로(들여쓴 JSON) 남는다 */
export function CallView({ call }: { call: DynamoPreview["calls"][number] }) {
  const text = JSON.stringify(call.params, null, 2);
  const lines = text.split("\n").length;
  return <div className="ddb-call">
    <code>{call.api}</code>
    {lines > LARGE_PARAMS_LINES
      ? <details><summary>{t.paramsSummary(lines)}</summary><pre>{text}</pre></details>
      : <pre>{text}</pre>}
  </div>;
}

function RawJson({ value }: { value: unknown }) {
  return <details><summary>{t.RAW_DIFF}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>;
}

function settingText(name: string, value: unknown): string {
  if (value === undefined || value === null) return t.NO_VALUE;
  if (typeof value === "boolean") return value ? t.ON : t.OFF;
  if (name === "mode" || name === "class") return t.SETTING_VALUE[String(value)] ?? String(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** 설정 변경: 바뀌는 항목의 이전·변경 후 값을 맞댄다 */
function SettingDiff({ before, after }: { before: Plain | null; after: Plain | null }) {
  const rows = diffImages(before, after).filter(row => row.name !== "kind");
  return <table className="ddb-table ddb-diff">
    <thead><tr><th>{t.SETTING}</th><th>{t.BEFORE}</th><th>{t.AFTER}</th></tr></thead>
    <tbody>{rows.map(row => <tr key={row.name} className={row.changed ? "ddb-changed" : ""}>
      <td>{t.FIELD[row.name] ?? row.name}</td>
      <td>{settingText(row.name, row.before)}</td>
      <td>{settingText(row.name, row.after)}</td>
    </tr>)}</tbody>
  </table>;
}

/**
 * 변경 전후. 설정 변경은 항목별 표로, 아이템 하나의 변경은 속성별 표로 보이고,
 * 그 밖의 모양(여러 아이템 삭제·복원)은 원본 JSON을 접어 둔다.
 */
export function DiffView({ diff }: { diff: unknown }) {
  if (!isPlain(diff)) return <RawJson value={diff} />;
  const unwrap = (value: unknown) => Array.isArray(value) && value.length === 1 ? value[0] : value;
  const before = unwrap(diff.before);
  const after = unwrap(diff.after);
  const single = (value: unknown): value is Plain | null | undefined => value == null || isPlain(value);
  if (!single(before) || !single(after)) return <RawJson value={diff} />;
  const isSetting = typeof before?.kind === "string" || typeof after?.kind === "string";
  if (isSetting) return <SettingDiff before={before ?? null} after={after ?? null} />;
  return <AttributeDiff changes={diffImages(before, after)} attribute={t.ATTRIBUTE} before={t.BEFORE} after={t.AFTER} />;
}
