import { useMemo, useRef, useState } from "react";
import { ErrorState } from "../components/ErrorState";
import { formatDateTime } from "../iam/format";
import * as t from "./changeText";
import { useSnsChanges } from "./queries";
import { SnsChangeDialog } from "./SnsChangeDialog";
import type { SnsTopicRef } from "./targets";
import type { SnsChangeRecord } from "./types";

/** 되돌릴 수 없는 이유. 되돌릴 수 있으면 null(그 밖의 거절은 되돌리기 미리보기가 알려 준다) */
export function undoBlockReason(record: SnsChangeRecord): string | null {
  if (record.undoBlocked) return record.undoBlocked;
  if (record.undone) return t.UNDO_WHY_DONE;
  if (record.undoOf !== null) return t.UNDO_WHY_IS_UNDO;
  if (record.calls.length === 0) return t.UNDO_WHY_NO_CALLS;
  if (record.request.kind === "replay") return "다시 보낸 메시지는 되돌릴 수 없어요";
  if (record.request.kind === "publish") return t.UNDO_WHY_PUBLISH;
  return null;
}

/**
 * 변경 기록 화면: 이 주제에 이 앱으로 한 변경을 최신순으로 보여 주고, 되돌릴 수 있는 기록은 [되돌리기…]로 되돌리기 미리보기(SnsChangeDialog)를 연다.
 * 기록은 프로필의 모든 주제가 한 파일에 있어서, 이 주제·리전의 것만 걸러 보여 준다.
 */
export function ChangeLog({ target }: { target: SnsTopicRef }) {
  const q = useSnsChanges(target.profile);
  const [undoing, setUndoing] = useState<{ id: string; nonce: number } | null>(null);
  const nonce = useRef(0);
  const mine = useMemo(() => (q.data ?? []).filter((r) => r.topicArn === target.topicArn && r.region === target.region), [q.data, target.topicArn, target.region]);
  const reread = () => void q.refetch();

  if (!q.data) {
    return <section className="center sns-screen">{q.isError ? <ErrorState error={q.error} profile={target.profile} onRetry={reread} /> : <div className="empty" role="status">{t.LOG_LOADING}</div>}</section>;
  }

  return (
    <section className="center sns-screen iam-log" aria-label={t.LOG_LABEL}>
      {q.isError && <ErrorState compact error={q.error} profile={target.profile} onRetry={reread} />}
      <div className="sns-log-head">
        <button className="btn small tone-refresh" disabled={q.isFetching} title={q.isFetching ? "읽고 있어요" : undefined} onClick={reread}>
          {q.isFetching ? "읽는 중…" : "다시 읽기"}
        </button>
      </div>
      {mine.length === 0 ? (
        <div className="empty small">{t.LOG_EMPTY}</div>
      ) : (
        <div className="tbl">
          <table aria-label={t.LOG_LABEL}>
            <thead>
              <tr>
                <th scope="col" className="nosort">{t.LOG_COLS.at}</th>
                <th scope="col" className="nosort">{t.LOG_COLS.summary}</th>
                <th scope="col" className="nosort">{t.LOG_COLS.calls}</th>
                <th scope="col" className="nosort">{t.LOG_COLS.state}</th>
                <th scope="col" className="nosort">{t.LOG_COLS.action}</th>
              </tr>
            </thead>
            <tbody>
              {mine.map((r) => {
                const why = undoBlockReason(r);
                return (
                  <tr key={r.id}>
                    <td className="sns-nowrap">{formatDateTime(r.at)}</td>
                    <td className="cl-sum">
                      {t.requestSummary(r.request)}
                      {t.recordDetail(r) && <div className="dim mono sns-log-why">{t.recordDetail(r)}</div>}
                    </td>
                    <td>
                      <ul className="sns-log-calls" aria-label={t.LOG_COLS.calls}>
                        {r.calls.map((c, i) => (
                          <li key={i}>
                            <b className="mono">{c.api}</b> <span className="mono dim">{c.target}</span>
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className="cl-state">
                      {r.undone && <span className="iam-chip">{t.LOG_UNDONE}</span>}
                      {r.undoOf !== null && <span className="iam-chip">{t.LOG_IS_UNDO}</span>}
                      {t.needsReconfirm(r) && <span className="iam-chip">{t.LOG_RECONFIRM}</span>}
                    </td>
                    <td className="cl-act">
                      <button className="btn small tone-caution" disabled={why !== null} title={why ?? undefined} aria-description={why ?? undefined} onClick={() => setUndoing({ id: r.id, nonce: ++nonce.current })}>
                        {t.UNDO_OPEN}
                      </button>
                      {why !== null && <div className="dim sns-log-why">{why}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {undoing && <SnsChangeDialog key={undoing.nonce} profile={target.profile} region={target.region} request={{ kind: "undo", id: undoing.id }} onClose={() => setUndoing(null)} />}
    </section>
  );
}
