import { useMemo, useState, type ReactNode } from "react";
import { CopyButton } from "./CopyButton";
import { decodeBase64, formatScore, HEX_LIMIT, hexRows, bytesPreview, parseJsonDocument } from "./format";
import { JsonTree } from "./JsonTree";
import * as t from "./text";
import type { KvBytes, KvValue } from "./types";
import { loadedCount } from "./value";

/** 바이트 값 하나를 복사할 글. UTF-8이 아니면 정확한 바이트인 base64 */
const copyOf = (b: KvBytes) => b.text ?? b.base64;

/** 한 칸에 보이는 값: 글이면 그대로, 바이너리면 배지와 앞쪽 16진수와 크기 */
function Cell({ value }: { value: KvBytes }) {
  const p = bytesPreview(value);
  if (!p.binary) return <span className="kv-text mono">{p.text}</span>;
  return (
    <span className="kv-binary">
      <span className="iam-chip">{t.BINARY_VALUE}</span> <span className="mono">{p.text}</span> <span className="dim">{t.BYTES(value.bytes)}</span>
    </span>
  );
}

type TextMode = "json" | "text" | "hex" | "base64";
const MODE_LABEL: Record<TextMode, string> = { json: t.VIEW_JSON, text: t.VIEW_TEXT, hex: t.VIEW_HEX, base64: t.VIEW_BASE64 };

/** 16진수 보기 전체를 복사할 글 */
const hexText = (base64: string) =>
  hexRows(decodeBase64(base64), Number.POSITIVE_INFINITY)
    .map((r) => `${r.offset}  ${r.hex.padEnd(47)}  ${r.ascii}`)
    .join("\n");

function HexView({ base64, bytes }: { base64: string; bytes: number }) {
  const rows = useMemo(() => hexRows(decodeBase64(base64)), [base64]);
  return (
    <>
      <table className="kv-hex" aria-label={t.VIEW_HEX}>
        <tbody>
          {rows.map((r) => (
            <tr key={r.offset}>
              <td className="dim mono">{r.offset}</td>
              <td className="mono">{r.hex}</td>
              <td className="mono dim">{r.ascii}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {bytes > HEX_LIMIT && <p className="dim">{t.HEX_TRUNCATED("64KiB")}</p>}
    </>
  );
}

/**
 * 문자열(과 JSON 타입)의 값. UTF-8이면 글(JSON으로 읽히면 접고 펼치는 트리가 먼저), 아니면 16진수와 Base64.
 * 글이어도 정확한 바이트를 보고 싶을 수 있어서 16진수·Base64 보기를 함께 둔다(base64가 있을 때).
 */
export function StringValue({ text, base64, bytes, truncated }: { text: string | null; base64: string | null; bytes: number; truncated: boolean }) {
  const doc = useMemo(() => (text === null ? undefined : parseJsonDocument(text)), [text]);
  const modes: TextMode[] = [...(doc !== undefined ? (["json"] as const) : []), ...(text !== null ? (["text"] as const) : []), ...(base64 !== null ? (["hex", "base64"] as const) : [])];
  const [mode, setMode] = useState<TextMode>(modes[0] ?? "text");
  const copyText = () => (mode === "hex" ? hexText(base64!) : mode === "base64" ? base64! : (text ?? ""));
  return (
    <div className="kv-string">
      <div className="kv-string-bar">
        <div className="kv-seg" role="group" aria-label={t.VIEW_GROUP}>
          {modes.map((m) => (
            <button key={m} type="button" className={`kv-seg-btn${mode === m ? " on" : ""}`} aria-pressed={mode === m} onClick={() => setMode(m)}>
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
        <span className="dim">{t.BYTES(bytes)}</span>
        <span className="kv-string-end">
          <CopyButton text={copyText} ariaLabel="값 복사" />
        </span>
      </div>
      {truncated && <div className="notice">{t.TRUNCATED}</div>}
      {mode === "json" && doc !== undefined ? (
        <JsonTree value={doc} />
      ) : mode === "hex" && base64 !== null ? (
        <HexView base64={base64} bytes={bytes} />
      ) : mode === "base64" && base64 !== null ? (
        <pre className="kv-pre mono">{base64}</pre>
      ) : (
        <pre className="kv-pre mono">{text}</pre>
      )}
    </div>
  );
}

function Table({ label, columns, children, fields }: { label: string; columns: string[]; children: ReactNode; fields?: boolean }) {
  return (
    <table className={`kv-table${fields ? " kv-fields" : ""}`} aria-label={label}>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c} scope="col" className="nosort">
              {c}
            </th>
          ))}
          <th scope="col" className="nosort kv-col-copy" />
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

const Copy = ({ value }: { value: KvBytes }) => (
  <td className="kv-col-copy">
    <CopyButton text={copyOf(value)} />
  </td>
);

function Collection({ value }: { value: Exclude<KvValue, { type: "string" | "json" | "other" }> }) {
  switch (value.type) {
    case "hash":
      return (
        <Table label="해시 필드" columns={[t.COL_FIELD, t.COL_VALUE]} fields>
          {value.entries.map((e, i) => (
            <tr key={`${e.field.base64}-${i}`}>
              <td>
                <Cell value={e.field} />
              </td>
              <td>
                <Cell value={e.value} />
              </td>
              <Copy value={e.value} />
            </tr>
          ))}
        </Table>
      );
    case "list":
      return (
        <Table label="리스트 원소" columns={[t.COL_INDEX, t.COL_VALUE]}>
          {value.items.map((b, i) => (
            <tr key={i}>
              <td className="dim num">{value.start + i}</td>
              <td>
                <Cell value={b} />
              </td>
              <Copy value={b} />
            </tr>
          ))}
        </Table>
      );
    case "set":
      return (
        <Table label="셋 멤버" columns={[t.COL_MEMBER]}>
          {value.members.map((b, i) => (
            <tr key={`${b.base64}-${i}`}>
              <td>
                <Cell value={b} />
              </td>
              <Copy value={b} />
            </tr>
          ))}
        </Table>
      );
    case "zset":
      return (
        <Table label="정렬 셋 멤버" columns={[t.COL_RANK, t.COL_SCORE, t.COL_MEMBER]}>
          {value.members.map((m, i) => (
            <tr key={`${m.member.base64}-${i}`}>
              <td className="dim num">{value.start + i}</td>
              <td className="mono num">{formatScore(m.score)}</td>
              <td>
                <Cell value={m.member} />
              </td>
              <Copy value={m.member} />
            </tr>
          ))}
        </Table>
      );
    case "stream":
      return (
        <>
          {value.summary && (
            <dl className="kv kv-stream-summary">
              <dt>{t.STREAM_LENGTH}</dt>
              <dd>{value.summary.length.toLocaleString("ko-KR")}</dd>
              <dt>{t.STREAM_GROUPS}</dt>
              <dd>{value.summary.groups}</dd>
              <dt>{t.STREAM_FIRST}</dt>
              <dd className="mono">{value.summary.firstId ?? t.DASH}</dd>
              <dt>{t.STREAM_LAST}</dt>
              <dd className="mono">{value.summary.lastId ?? t.DASH}</dd>
            </dl>
          )}
          <table className="kv-table" aria-label="스트림 항목">
            <thead>
              <tr>
                <th scope="col" className="nosort">
                  {t.COL_ID}
                </th>
                <th scope="col" className="nosort">
                  {t.COL_ENTRY}
                </th>
              </tr>
            </thead>
            <tbody>
              {value.entries.map((e) => (
                <tr key={e.id}>
                  <td className="mono">{e.id}</td>
                  <td>
                    {e.fields.map((f, i) => (
                      <div key={`${f.field.base64}-${i}`} className="kv-stream-field">
                        <span className="dim">
                          <Cell value={f.field} />
                        </span>
                        <span className="dim">=</span>
                        <Cell value={f.value} />
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      );
  }
}

interface Props {
  value: KvValue;
  /** 키의 전체 길이(알 때). 읽은 항목 수 옆에 보인다 */
  total: number | null;
  hasMore: boolean;
  fetching: boolean;
  onMore: () => void;
}

/** 키의 값을 타입에 맞게 보인다. 컬렉션은 읽은 만큼 보이고 [더 읽기]로 이어 읽는다. */
export function ValueViewer({ value, total, hasMore, fetching, onMore }: Props) {
  if (value.type === "string") return <StringValue text={value.value.text} base64={value.value.base64} bytes={value.value.bytes} truncated={value.truncated} />;
  if (value.type === "json") return <StringValue text={value.text} base64={null} bytes={new TextEncoder().encode(value.text).length} truncated={value.truncated} />;
  if (value.type === "other") return <div className="empty small">{t.OTHER_TYPE(value.typeName)}</div>;
  const read = loadedCount(value) ?? 0;
  return (
    <div className="kv-collection">
      {read === 0 && !hasMore ? <div className="empty small">{t.EMPTY_COLLECTION}</div> : <Collection value={value} />}
      <div className="kv-more">
        <span className="dim">{t.VALUE_READ(read, total)}</span>
        {hasMore && (
          <button type="button" className="btn small" disabled={fetching} onClick={onMore}>
            {fetching ? t.READING : t.MORE}
          </button>
        )}
      </div>
    </div>
  );
}
