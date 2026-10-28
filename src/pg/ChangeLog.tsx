import { useMemo } from "react";
import { formatDateTime } from "../iam/format";
import { arrange, batchKey, usePrepare } from "../lib/changeLog";
import { pgApi } from "./api";
import { PgError } from "./PgError";
import { usePgChangeLog } from "./queries";
import type { PgChange, PgChangeLogEntry, PgTarget } from "./types";

interface Props {
  target: PgTarget;
  /** 이 대상의 ARN. 기록은 모든 대상의 것이 한 파일에 있어서, 이 ARN의 기록만 보여 준다 */
  targetArn: string;
  /** 이 대상에서 바꿀 수 없는 이유(changeBlockReason). 있으면 [되돌리기]와 [묶음 되돌리기]를 끄고 이 글을 제목과 설명으로 단다. 바꿀 수 있으면 null */
  blockReason: string | null;
  /** 되돌리기: 역변경 하나를 변경 흐름(미리보기 → 적용)으로 넘긴다. undoOf에 기록 id가 들어 있다 */
  onStart: (change: PgChange, opts: { undoOf: string }) => void;
  /** 여러 변경이 필요한 되돌리기(만든 역할)와 묶음 되돌리기: 그 데이터베이스의 묶음 흐름으로 넘긴다. undoOf는 되돌리는 기록 id들이다(기록마다 하나) */
  onStartBatch: (database: string, changes: PgChange[], opts: { undoOf: string[] }) => void;
}

/** 되돌릴 역변경이 있는가: 비어 있는 역변경은 되돌릴 것이 없는 것과 같다(백엔드도 같게 본다) */
const hasInverse = (e: PgChangeLogEntry) => e.inverse !== null && e.inverse.length > 0;

/** 이 기록은 되돌릴 수 있는가: 성공했고, 아직 되돌리지 않았고, 역변경이 있다 */
const canUndo = (e: PgChangeLogEntry) => e.ok && !e.undone && hasInverse(e);

/**
 * 변경 기록 화면: 이 앱으로 이 대상에 한 변경을 최신순으로 보여주고, 되돌릴 수 있는 변경은 [되돌리기]로 역변경 미리보기를 연다.
 * 묶음으로 한 변경은 묶음 머리 밑에 모으고, 머리의 [묶음 되돌리기]는 묶음 전체의 역변경 미리보기를 연다.
 * 되돌리기는 역변경을 받아 일반 변경 흐름으로 넘기는 것뿐이다. 적용은 거기서 미리보기를 다시 거쳐 한다.
 * 이 대상에서 바꿀 수 없으면(읽기 전용 복제본, 역할을 관리할 수 없는 DB 사용자) 되돌리기도 막는다. 눌러 봐야 서버가 거절할 것이다.
 */
export function ChangeLog({ target, targetArn, blockReason, onStart, onStartBatch }: Props) {
  const q = usePgChangeLog();
  const { busy, errors, prepare } = usePrepare();
  const entries = q.data;
  const lines = useMemo(() => arrange((entries ?? []).filter((e) => e.targetArn === targetArn)), [entries, targetArn]);
  const reread = () => void q.refetch();

  const undo = (entry: PgChangeLogEntry) =>
    prepare(entry.id, async () => {
      const inverse = await pgApi.undo(entry.id);
      // 변경 하나로 되돌리면 하나짜리 흐름으로, 여럿(만든 역할의 뒷정리 등)이면 한 트랜잭션으로 묶음 흐름으로 보낸다
      if (inverse.changes.length === 1) onStart(inverse.changes[0], { undoOf: entry.id });
      else onStartBatch(inverse.database, inverse.changes, { undoOf: inverse.undoOf });
    });

  const undoBatch = (batchId: string) =>
    prepare(batchKey(batchId), async () => {
      const inverse = await pgApi.undoBatch(batchId);
      onStartBatch(inverse.database, inverse.changes, { undoOf: inverse.undoOf });
    });

  if (!entries) {
    return (
      <section className="center">
        {q.isError ? <PgError error={q.error} target={target} onRetry={reread} /> : <div className="empty">변경 기록을 불러오는 중…</div>}
      </section>
    );
  }

  return (
    <section className="center iam-log">
      {q.isError && <PgError compact error={q.error} target={target} onRetry={reread} />}
      {lines.length === 0 ? (
        <div className="empty small">변경 기록이 없어요</div>
      ) : (
        <div className="tbl">
          <table aria-label="변경 기록">
            <thead>
              <tr>
                <th scope="col" className="nosort">시각</th>
                <th scope="col" className="nosort">DB 사용자 · 데이터베이스</th>
                <th scope="col" className="nosort">내용</th>
                <th scope="col" className="nosort">결과</th>
                <th scope="col" className="nosort">조치</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => {
                if (line.kind === "batch") {
                  const key = batchKey(line.batchId);
                  return (
                    <tr key={key} className="cl-batch">
                      <td colSpan={4}>
                        {/* 목록이 최신순이라 첫 기록이 묶음에서 가장 최근 기록이다. 머리의 시각도 그 시각이다 */}
                        <div>{`묶음 · 변경 ${line.entries.length}개 · ${formatDateTime(line.entries[0].at)}`}</div>
                        {key in errors && <PgError compact error={errors[key]} target={target} onRetry={() => void undoBatch(line.batchId)} />}
                      </td>
                      <td className="cl-act">
                        <BatchAction entries={line.entries} busy={busy === key} blockReason={blockReason} onUndo={() => void undoBatch(line.batchId)} />
                      </td>
                    </tr>
                  );
                }
                const e = line.entry;
                return (
                  <tr key={e.id} className={line.inBatch ? "cl-in" : undefined}>
                    <td>{formatDateTime(e.at)}</td>
                    <td>
                      <span>{e.loginUser}</span> <span className="mono dim">{e.database}</span>
                    </td>
                    <td className="cl-sum">
                      <div>{e.summary}</div>
                      {!e.ok && e.error && <div className="err">{e.error}</div>}
                      {e.id in errors && <PgError compact error={errors[e.id]} target={target} onRetry={() => void undo(e)} />}
                    </td>
                    <td className="cl-state">
                      <span className={`iam-chip ${e.ok ? "allowed" : "denied"}`}>{e.ok ? "성공" : "실패"}</span>
                      {e.undone && <span className="iam-chip">되돌렸어요</span>}
                      {e.undoOf && <span className="iam-chip">되돌리기 기록</span>}
                    </td>
                    <td className="cl-act">
                      <Action entry={e} busy={busy === e.id} blockReason={blockReason} onUndo={() => void undo(e)} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * 되돌리기 버튼 하나. 이 대상에서 바꿀 수 없으면 끄고, 그 이유를 제목(마우스를 올리면 보인다)과 설명(보조 기기가 읽는다)으로 단다.
 * 표의 모든 줄에 같은 글을 적어 넣으면 시끄러워서 보이는 글은 따로 두지 않는다.
 */
function UndoButton({ label, busy, blockReason, onUndo }: { label: string; busy: boolean; blockReason: string | null; onUndo: () => void }) {
  return (
    <button
      className="btn small"
      disabled={busy || blockReason !== null}
      title={blockReason ?? undefined}
      aria-description={blockReason ?? undefined}
      onClick={onUndo}
    >
      {busy ? "준비 중…" : label}
    </button>
  );
}

function Action({ entry, busy, blockReason, onUndo }: { entry: PgChangeLogEntry; busy: boolean; blockReason: string | null; onUndo: () => void }) {
  if (!entry.ok || entry.undone) return null;
  if (!hasInverse(entry)) return <span className="dim">되돌릴 수 없어요</span>;
  return <UndoButton label="되돌리기" busy={busy} blockReason={blockReason} onUndo={onUndo} />;
}

/**
 * 묶음 머리의 [묶음 되돌리기]. IAM과 같은 규칙으로, 되돌릴 수 있는 기록이 하나라도 있으면 켠다.
 * 이미 되돌렸거나, 실패했거나, 역변경이 없는 기록은 백엔드의 pg_undo_batch가 건너뛰고 되돌릴 수 있는 나머지만 되돌린다(IAM의 undo_batch_of와 같다).
 * 되돌릴 것이 하나도 없으면 이유와 함께 끈다. 이 대상에서 바꿀 수 없을 때는 UndoButton이 끈다.
 */
function BatchAction({ entries, busy, blockReason, onUndo }: { entries: PgChangeLogEntry[]; busy: boolean; blockReason: string | null; onUndo: () => void }) {
  if (!entries.some(canUndo)) {
    return (
      <>
        <button className="btn small" disabled>
          묶음 되돌리기
        </button>
        <div className="dim cl-why">되돌릴 변경이 없어요</div>
      </>
    );
  }
  return <UndoButton label="묶음 되돌리기" busy={busy} blockReason={blockReason} onUndo={onUndo} />;
}
