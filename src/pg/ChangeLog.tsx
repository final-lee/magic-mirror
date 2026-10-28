import { useMemo, useRef, useState } from "react";
import { formatDateTime } from "../iam/format";
import { pgApi } from "./api";
import { PgError } from "./PgError";
import { usePgChangeLog } from "./queries";
import type { PgChange, PgChangeLogEntry, PgTarget } from "./types";

interface Props {
  target: PgTarget;
  /** 이 대상의 ARN. 기록은 모든 대상의 것이 한 파일에 있어서, 이 ARN의 기록만 보여 준다 */
  targetArn: string;
  /** 되돌리기: 역변경 하나를 변경 흐름(미리보기 → 적용)으로 넘긴다. undoOf에 기록 id가 들어 있다 */
  onStart: (change: PgChange, opts: { undoOf: string }) => void;
  /** 여러 변경이 필요한 되돌리기(만든 역할)와 묶음 되돌리기: 그 데이터베이스의 묶음 흐름으로 넘긴다. undoOf[i]는 되돌리는 기록 id다 */
  onStartBatch: (database: string, changes: PgChange[], opts: { undoOf: string[] }) => void;
}

/** 표에 그릴 줄: 묶음 머리, 또는 기록 하나(묶음 안에 있는지) */
type Line = { kind: "batch"; batchId: string; entries: PgChangeLogEntry[] } | { kind: "entry"; entry: PgChangeLogEntry; inBatch: boolean };

/**
 * 같은 묶음의 기록을 그 묶음에서 가장 최근 기록의 자리에 모아 머리 밑에 둔다. 다른 기록이 사이에 끼어 있었어도 한 덩어리다.
 * 그 밖의 순서는 받은 그대로(최신순)다.
 */
function arrange(entries: PgChangeLogEntry[]): Line[] {
  const groups = new Map<string, PgChangeLogEntry[]>();
  for (const e of entries) {
    if (!e.batchId) continue;
    const members = groups.get(e.batchId);
    if (members) members.push(e);
    else groups.set(e.batchId, [e]);
  }
  const lines: Line[] = [];
  const placed = new Set<string>();
  for (const e of entries) {
    if (!e.batchId) {
      lines.push({ kind: "entry", entry: e, inBatch: false });
    } else if (!placed.has(e.batchId)) {
      placed.add(e.batchId);
      const members = groups.get(e.batchId) ?? [];
      lines.push({ kind: "batch", batchId: e.batchId, entries: members });
      for (const member of members) lines.push({ kind: "entry", entry: member, inBatch: true });
    }
  }
  return lines;
}

/** 되돌릴 역변경이 있는가: 비어 있는 역변경은 되돌릴 것이 없는 것과 같다(백엔드도 같게 본다) */
const hasInverse = (e: PgChangeLogEntry) => e.inverse !== null && e.inverse.length > 0;

/** 이 기록은 되돌릴 수 있는가: 성공했고, 아직 되돌리지 않았고, 역변경이 있다 */
const canUndo = (e: PgChangeLogEntry) => e.ok && !e.undone && hasInverse(e);

// 묶음의 바쁨·오류 키. 기록 id와 겹치지 않는다
const batchKey = (batchId: string) => `batch:${batchId}`;

/**
 * 변경 기록 화면: 이 앱으로 이 대상에 한 변경을 최신순으로 보여주고, 되돌릴 수 있는 변경은 [되돌리기]로 역변경 미리보기를 연다.
 * 묶음으로 한 변경은 묶음 머리 밑에 모으고, 머리의 [묶음 되돌리기]는 묶음 전체의 역변경 미리보기를 연다.
 * 되돌리기는 역변경을 받아 일반 변경 흐름으로 넘기는 것뿐이다. 적용은 거기서 미리보기를 다시 거쳐 한다.
 */
export function ChangeLog({ target, targetArn, onStart, onStartBatch }: Props) {
  const q = usePgChangeLog();
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, unknown>>({});
  const inFlight = useRef(false);
  const entries = q.data;
  const lines = useMemo(() => arrange((entries ?? []).filter((e) => e.targetArn === targetArn)), [entries, targetArn]);
  const reread = () => void q.refetch();

  /** 되돌리기 준비 하나. key는 바쁨·오류를 붙일 자리(기록 id 또는 묶음 키)이고, 한 번에 하나만 돌린다 */
  const prepare = async (key: string, task: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(key);
    setErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== key)));
    try {
      await task();
    } catch (e) {
      setErrors((prev) => ({ ...prev, [key]: e }));
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

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
                        <BatchAction entries={line.entries} busy={busy === key} onUndo={() => void undoBatch(line.batchId)} />
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
                      <Action entry={e} busy={busy === e.id} onUndo={() => void undo(e)} />
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

function Action({ entry, busy, onUndo }: { entry: PgChangeLogEntry; busy: boolean; onUndo: () => void }) {
  if (!entry.ok || entry.undone) return null;
  if (!hasInverse(entry)) return <span className="dim">되돌릴 수 없어요</span>;
  return (
    <button className="btn small" disabled={busy} onClick={onUndo}>
      {busy ? "준비 중…" : "되돌리기"}
    </button>
  );
}

/** 묶음 머리의 [묶음 되돌리기]. 되돌릴 것이 하나도 없으면 이유와 함께 끈다 */
function BatchAction({ entries, busy, onUndo }: { entries: PgChangeLogEntry[]; busy: boolean; onUndo: () => void }) {
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
  return (
    <button className="btn small" disabled={busy} onClick={onUndo}>
      {busy ? "준비 중…" : "묶음 되돌리기"}
    </button>
  );
}
