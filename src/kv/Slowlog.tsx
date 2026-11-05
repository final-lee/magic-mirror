import { useMemo, useRef } from "react";
import { ListFind, useListFind } from "../components/ListFind";
import { fuzzyKeep } from "../lib/fuzzy";
import { formatMicros, formatUnix } from "./format";
import { KvError } from "./KvError";
import { useKvSlowlog } from "./queries";
import * as t from "./text";
import type { KvOverview, KvSlowEntry, KvTarget } from "./types";

/** 명령 인자를 한 줄로. 앞 COMMAND_LIMIT자만 보인다 */
export function commandText(entry: KvSlowEntry): string {
  const text = entry.args.join(" ");
  return text.length > t.COMMAND_LIMIT ? `${text.slice(0, t.COMMAND_LIMIT)}…` : text;
}

/** Slow log: 노드별 SLOWLOG GET(Valkey 8.1+은 COMMANDLOG). 서버리스는 막혀 있어 이유만 보인다. */
export function Slowlog({ target, overview, active }: { target: KvTarget; overview: KvOverview; active: boolean }) {
  const off = overview.unsupported.includes("slowlog");
  const q = useKvSlowlog(target, !off);
  const box = useRef<HTMLElement>(null);
  const find = useListFind(box, { enabled: active && !off });
  // 최근 것이 위
  const rows = useMemo(() => [...(q.data ?? [])].sort((a, b) => b.time - a.time || b.id - a.id), [q.data]);
  const listed = fuzzyKeep(rows, find.query, (e) => [commandText(e), e.node, e.client, e.name]);
  if (off) {
    return (
      <section className="center kv-screen">
        <div className="empty">{t.UNSUPPORTED.slowlog}</div>
      </section>
    );
  }
  return (
    <section className="center kv-screen kv-slowlog" ref={box}>
      <div className="kv-bar">
        <span className="kv-bar-end">
          <button className="btn small" onClick={() => void q.refetch()} disabled={q.isFetching}>
            {q.isFetching ? t.READING : t.REREAD}
          </button>
        </span>
      </div>
      <ListFind find={find} count={listed.length} />
      {!q.data ? (
        q.isError ? (
          <KvError error={q.error} target={target} />
        ) : (
          <div className="empty">{t.LOADING}</div>
        )
      ) : (
        <div className="kv-pane">
          {q.isError && <KvError compact error={q.error} target={target} />}
          {listed.length === 0 ? (
            <div className="empty small">{rows.length === 0 ? t.SLOWLOG_EMPTY : t.SLOWLOG_NO_MATCH}</div>
          ) : (
            <table className="kv-table" aria-label={t.SLOWLOG_LABEL}>
              <thead>
                <tr>
                  {Object.values(t.SLOWLOG_COLS).map((c) => (
                    <th key={c} scope="col" className="nosort">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {listed.map((e) => (
                  <tr key={`${e.node}-${e.id}`}>
                    <td className="mono">{formatUnix(e.time)}</td>
                    <td className="mono">{e.node}</td>
                    <td className="mono num">{formatMicros(e.micros)}</td>
                    <td className="mono kv-cmd">{commandText(e)}</td>
                    <td className="mono">
                      {e.client}
                      {e.name && <span className="dim"> {e.name}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
