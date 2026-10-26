import { useRef, useState } from "react";
import { errorMessage } from "../api/errors";
import { ErrorState } from "../components/ErrorState";
import { iamApi } from "./api";
import { formatDateTime } from "./format";
import { useChangeLog } from "./queries";
import type { ChangeLogEntry, IamChange } from "./types";
import type { StartOptions } from "./useIamChange";

interface Props {
  profile: string;
  /** 지금 보고 있는 계정. 다른 계정에서 한 변경은 여기서 되돌릴 수 없다 */
  accountId: string;
  /** 되돌리기: 역변경을 변경 흐름(미리보기 → 적용)으로 넘긴다. undoOf에 기록 id가 들어 있다 */
  onStart: (change: IamChange, opts: StartOptions) => void;
}

/** 변경 기록 화면: 이 앱으로 한 IAM 변경을 최신순으로 보여주고, 되돌릴 수 있는 변경은 [되돌리기]로 역변경 미리보기를 연다. */
export function ChangeLog({ profile, accountId, onStart }: Props) {
  const q = useChangeLog();
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const inFlight = useRef(false);

  const undo = async (entry: ChangeLogEntry) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(entry.id);
    setErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => id !== entry.id)));
    try {
      const inverse = await iamApi.undoChange(entry.id);
      onStart(inverse, { undoOf: entry.id });
    } catch (e) {
      setErrors((prev) => ({ ...prev, [entry.id]: errorMessage(e) }));
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  const entries = q.data;
  if (!entries) {
    return (
      <section className="center">
        {q.isError ? <ErrorState error={q.error} profile={profile} onRetry={() => void q.refetch()} /> : <div className="empty">변경 기록을 불러오는 중…</div>}
      </section>
    );
  }

  return (
    <section className="center iam-log">
      {q.isError && <ErrorState compact error={q.error} profile={profile} onRetry={() => void q.refetch()} />}
      {entries.length === 0 ? (
        <div className="empty small">변경 기록이 없어요</div>
      ) : (
        <div className="tbl">
          <table aria-label="변경 기록">
            <thead>
              <tr>
                <th scope="col" className="nosort">시각</th>
                <th scope="col" className="nosort">프로필 · 계정</th>
                <th scope="col" className="nosort">내용</th>
                <th scope="col" className="nosort">결과</th>
                <th scope="col" className="nosort">조치</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>{formatDateTime(e.at)}</td>
                  <td>
                    <span>{e.profile}</span> <span className="mono dim">{e.accountId}</span>
                  </td>
                  <td className="cl-sum">
                    <div>{e.summary}</div>
                    {!e.ok && e.error && <div className="err">{e.error}</div>}
                    {errors[e.id] && <div className="err">{errors[e.id]}</div>}
                  </td>
                  <td className="cl-state">
                    <span className={`iam-chip ${e.ok ? "allowed" : "denied"}`}>{e.ok ? "성공" : "실패"}</span>
                    {e.undone && <span className="iam-chip">되돌림</span>}
                    {e.undoOf && <span className="iam-chip">되돌리기 기록</span>}
                  </td>
                  <td className="cl-act">
                    <Action entry={e} sameAccount={e.accountId === accountId} busy={busy === e.id} onUndo={() => void undo(e)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Action({ entry, sameAccount, busy, onUndo }: { entry: ChangeLogEntry; sameAccount: boolean; busy: boolean; onUndo: () => void }) {
  if (!entry.ok || entry.undone) return null;
  if (!entry.inverse) return <span className="dim">되돌릴 수 없어요</span>;
  if (!sameAccount) {
    // 다른 계정에서 한 변경의 역변경을 이 계정에 적용하면 이름이 같은 엉뚱한 대상이 바뀔 수 있다
    return (
      <>
        <button className="btn small" disabled>
          되돌리기
        </button>
        <div className="dim cl-why">다른 계정({entry.accountId})에서 한 변경이라 그 계정으로 열어야 되돌릴 수 있어요</div>
      </>
    );
  }
  return (
    <button className="btn small" disabled={busy} onClick={onUndo}>
      {busy ? "준비 중…" : "되돌리기"}
    </button>
  );
}
