import { useMemo, useRef, useState } from "react";
import { ListFind, useListFind } from "../components/ListFind";
import { fuzzyKeep } from "../lib/fuzzy";
import { formatDuration } from "./format";
import { ClientMap } from "./graph/ClientMap";
import { KvError } from "./KvError";
import { useKvClients } from "./queries";
import * as t from "./text";
import type { KvOverview, KvTarget } from "./types";

/**
 * 클라이언트: 노드별 CLIENT LIST를 표나 지도(호스트 → 연결 이름 → 노드)로 본다. 찾기는 둘 다 거른다.
 * 이 앱의 연결(magic-mirror)에 "이 앱"이 붙는다. 서버리스는 막혀 있어 이유만 보인다.
 */
export function Clients({ target, overview, active }: { target: KvTarget; overview: KvOverview; active: boolean }) {
  const off = overview.unsupported.includes("clients");
  const q = useKvClients(target, !off);
  const box = useRef<HTMLElement>(null);
  const find = useListFind(box, { enabled: active && !off });
  const [mode, setMode] = useState<"table" | "map">("table");
  // 오래 연결된 것이 위
  const rows = useMemo(() => [...(q.data ?? [])].sort((a, b) => b.age - a.age), [q.data]);
  const listed = useMemo(() => fuzzyKeep(rows, find.query, (c) => [c.addr, c.name, c.user, c.cmd, c.node, c.flags]), [rows, find.query]);
  if (off) {
    return (
      <section className="center kv-screen">
        <div className="empty">{t.UNSUPPORTED.clients}</div>
      </section>
    );
  }
  return (
    <section className="center kv-screen kv-clients" ref={box}>
      <div className="kv-bar">
        <div className="kv-seg" role="group" aria-label={t.MAP_VIEW}>
          {(["table", "map"] as const).map((m) => (
            <button key={m} type="button" className={`kv-seg-btn${mode === m ? " on" : ""}`} aria-pressed={mode === m} onClick={() => setMode(m)}>
              {m === "table" ? t.CLIENTS_TABLE : t.MAP_MAP}
            </button>
          ))}
        </div>
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
        <div className={`kv-pane${mode === "map" && listed.length > 0 ? " kv-pane-map" : ""}`}>
          {q.isError && <KvError compact error={q.error} target={target} />}
          {listed.length === 0 ? (
            <div className="empty small">{rows.length === 0 ? t.CLIENTS_EMPTY : t.SLOWLOG_NO_MATCH}</div>
          ) : mode === "map" ? (
            <ClientMap clients={listed} />
          ) : (
            <table className="kv-table" aria-label={t.CLIENTS_LABEL}>
              <thead>
                <tr>
                  {Object.values(t.CLIENTS_COLS).map((c) => (
                    <th key={c} scope="col" className="nosort">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {listed.map((c) => (
                  <tr key={`${c.node}-${c.id}`}>
                    <td className="mono">
                      {c.addr}
                      {c.own && <span className="iam-chip kv-own">{t.OWN_CLIENT}</span>}
                    </td>
                    <td className="mono">{c.name || t.DASH}</td>
                    <td className="mono">{c.user || t.DASH}</td>
                    <td className="mono num">{c.db}</td>
                    <td className="mono num">{formatDuration(c.age)}</td>
                    <td className="mono num">{formatDuration(c.idle)}</td>
                    <td className="mono">{c.cmd || t.DASH}</td>
                    <td className="mono">{c.flags}</td>
                    <td className="mono">{c.node}</td>
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
