import { useState } from "react";
import { COLLAPSE_ALL, EXPAND_ALL } from "./text";

/** 한 번에 그리는 자식 수. 큰 배열은 이만큼씩 더 본다 */
const CHUNK = 200;
/** 처음 펼쳐 두는 깊이(0이 맨 위) */
const DEFAULT_OPEN_DEPTH = 2;

const isContainer = (v: unknown): v is Record<string, unknown> | unknown[] => typeof v === "object" && v !== null;

function Primitive({ value }: { value: unknown }) {
  if (typeof value === "string") return <span className="kv-json-str">{JSON.stringify(value)}</span>;
  if (typeof value === "number") return <span className="kv-json-num">{String(value)}</span>;
  return <span className="kv-json-lit">{String(value)}</span>;
}

function Node({ label, value, depth, openDepth }: { label: string | null; value: unknown; depth: number; openDepth: number }) {
  const [open, setOpen] = useState(depth < openDepth);
  const [shown, setShown] = useState(CHUNK);
  const key = label === null ? null : <span className="kv-json-key">{label}</span>;
  if (!isContainer(value)) {
    return (
      <div className="kv-json-line">
        {key}
        {key && ": "}
        <Primitive value={value} />
      </div>
    );
  }
  const array = Array.isArray(value);
  const entries: [string, unknown][] = array ? value.map((v, i) => [String(i), v]) : Object.entries(value);
  const [openBrace, closeBrace] = array ? ["[", "]"] : ["{", "}"];
  return (
    <div className="kv-json-node">
      <button type="button" className="kv-json-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        {key}
        {key && ": "}
        {openBrace}
        {!open && (
          <span className="dim">
            {" "}
            {entries.length}
            {array ? "개" : "개 키"} {closeBrace}
          </span>
        )}
      </button>
      {open && (
        <div className="kv-json-children">
          {entries.slice(0, shown).map(([k, v]) => (
            <Node key={k} label={array ? null : JSON.stringify(k)} value={v} depth={depth + 1} openDepth={openDepth} />
          ))}
          {entries.length > shown && (
            <button type="button" className="link" onClick={() => setShown(shown + CHUNK)}>
              {`… ${(entries.length - shown).toLocaleString("ko-KR")}개 더 보기`}
            </button>
          )}
          <div className="kv-json-line">{closeBrace}</div>
        </div>
      )}
    </div>
  );
}

/** JSON 문서를 접고 펼 수 있는 트리로 보인다. 위쪽 단추로 전부 펼치거나 접는다. */
export function JsonTree({ value }: { value: unknown }) {
  // 단추를 누를 때마다 트리를 새로 그려 모든 노드가 새 기본 깊이를 따르게 한다
  const [view, setView] = useState({ openDepth: DEFAULT_OPEN_DEPTH, epoch: 0 });
  const set = (openDepth: number) => setView((v) => ({ openDepth, epoch: v.epoch + 1 }));
  return (
    <div className="kv-json">
      <div className="kv-json-tools">
        <button type="button" className="link" onClick={() => set(Number.POSITIVE_INFINITY)}>
          {EXPAND_ALL}
        </button>
        <button type="button" className="link" onClick={() => set(1)}>
          {COLLAPSE_ALL}
        </button>
      </div>
      <div className="kv-json-body mono" role="group" aria-label="JSON">
        <Node key={view.epoch} label={null} value={value} depth={0} openDepth={view.openDepth} />
      </div>
    </div>
  );
}
