import { useMemo, useState } from "react";
import { formatDateTime } from "../iam/format";
import { DASH, collate } from "./labels";
import { PgError } from "./PgError";
import { usePgSessions } from "./queries";
import type { PgSession, PgTarget } from "./types";

/** 다른 사용자의 세션 상세가 이 DB 사용자에게 가려져 있을 때 표 아래에 밝히는 말 */
export const SESSIONS_FOOTNOTE = "빈 칸은 이 DB 사용자에게 보이지 않는 정보예요. 다른 사용자의 세션을 자세히 보려면 pg_read_all_stats 권한이 필요해요";

/**
 * 상세가 가려진 세션. 이 DB 사용자가 볼 수 없는 다른 사용자의 세션은 상태, 클라이언트, 시작, 대기를 비워서 온다.
 * 이 앱의 연결(own)은 늘 보이므로, own이 아니면서 상태가 없는 줄을 가려진 것으로 본다.
 */
const detailsHidden = (s: PgSession) => !s.own && s.state === null;

const DETAIL_COLUMNS = ["데이터베이스", "클라이언트", "application_name", "상태", "시작", "대기"];

interface TableProps {
  sessions: PgSession[];
  /** 역할 열을 맨 앞에 둔다. 세션 화면은 여러 역할의 세션을 늘어놓지만, 역할 상세는 그 역할 하나의 것이라 두지 않는다. */
  withRole?: boolean;
}

/**
 * 세션 표(세션 화면과 역할 상세의 세션 탭이 함께 쓴다). 값이 없는 칸은 다른 표처럼 줄표로 보이고,
 * 상세가 가려진 세션이 있으면 그 이유를 표 아래에 밝힌다. 이 앱의 연결에는 "이 앱"이 붙는다.
 */
export function SessionTable({ sessions, withRole = false }: TableProps) {
  const columns = withRole ? ["역할", ...DETAIL_COLUMNS] : DETAIL_COLUMNS;
  return (
    <>
      <table className="pg-sessions" aria-label="세션 목록">
        <thead>
          <tr>
            {columns.map((label) => (
              <th key={label} scope="col" className="nosort">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.pid}>
              {withRole && <td>{s.role ?? DASH}</td>}
              <td>{s.database ?? DASH}</td>
              <td className="mono">{s.clientAddr ?? DASH}</td>
              <td>
                {s.applicationName || DASH}
                {s.own && <span className="iam-chip pg-own">이 앱</span>}
              </td>
              <td>{s.state ?? DASH}</td>
              <td>{formatDateTime(s.backendStart) || DASH}</td>
              <td>{s.waitEvent ?? DASH}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {sessions.some(detailsHidden) && (
        <p className="pg-footnote" role="note">
          {SESSIONS_FOOTNOTE}
        </p>
      )}
    </>
  );
}

/** 모든 역할 */
const ALL_ROLES = "";

/**
 * 세션: 지금 이 클러스터에 붙어 있는 연결. 세션은 계속 바뀌어서 화면을 열 때마다 새로 읽고, [다시 읽기]로 다시 읽는다.
 * 역할로 거를 수 있다. 역할이 없는 세션(백그라운드 프로세스)은 거름 선택지에 넣지 않고, 역할을 고르면 보이지 않는다.
 */
export function Sessions({ target }: { target: PgTarget }) {
  const q = usePgSessions(target);
  const [role, setRole] = useState(ALL_ROLES);
  const sessions = q.data;

  // 선택지: 세션이 있는 역할들. 고른 역할의 세션이 다 끝났어도 고른 채로 보이게 남겨 둔다(표가 비는 까닭을 선택이 말해 준다).
  const roles = useMemo(() => {
    const names = new Set((sessions ?? []).flatMap((s) => (s.role === null ? [] : [s.role])));
    if (role !== ALL_ROLES) names.add(role);
    return [...names].sort(collate);
  }, [sessions, role]);
  const shown = useMemo(() => (sessions ?? []).filter((s) => role === ALL_ROLES || s.role === role), [sessions, role]);

  return (
    <section className="center pg-screen">
      <div className="pg-bar">
        <label className="sel pg-picker">
          <small>역할</small>
          <select aria-label="역할" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value={ALL_ROLES}>모든 역할</option>
            {roles.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <span className="pg-bar-end">
          <button className="btn small" onClick={() => void q.refetch()} disabled={q.isFetching}>
            {q.isFetching ? "읽는 중…" : "다시 읽기"}
          </button>
        </span>
      </div>
      {!sessions ? (
        q.isError ? (
          <PgError error={q.error} target={target} />
        ) : (
          <div className="empty">불러오는 중…</div>
        )
      ) : (
        <div className="pg-pane">
          {q.isError && <PgError compact error={q.error} target={target} />}
          {shown.length === 0 ? <div className="empty small">{sessions.length === 0 ? "세션이 없어요" : "조건에 맞는 세션이 없어요"}</div> : <SessionTable sessions={shown} withRole />}
        </div>
      )}
    </section>
  );
}
