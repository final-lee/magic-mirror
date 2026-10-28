import { useMemo, useRef, useState } from "react";
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
  /** 묶음 되돌리기: 역변경 묶음을 묶음 흐름으로 넘긴다. undoOf[i]는 changes[i]가 되돌리는 기록 id다 */
  onStartBatch: (changes: IamChange[], opts: { undoOf: string[] }) => void;
}

/** 표에 그릴 줄: 묶음 머리, 또는 기록 하나(묶음 안에 있는지) */
type Line = { kind: "batch"; batchId: string; entries: ChangeLogEntry[] } | { kind: "entry"; entry: ChangeLogEntry; inBatch: boolean };

/**
 * 같은 묶음의 기록을 그 묶음에서 가장 최근 기록의 자리에 모아 머리 밑에 둔다. 다른 기록이 사이에 끼어 있었어도 한 덩어리다.
 * 그 밖의 순서는 받은 그대로(최신순)다.
 */
function arrange(entries: ChangeLogEntry[]): Line[] {
  const groups = new Map<string, ChangeLogEntry[]>();
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

/** 이 기록은 되돌릴 수 있는가: 성공했고, 아직 되돌리지 않았고, 역변경이 있다 */
const canUndo = (e: ChangeLogEntry) => e.ok && !e.undone && e.inverse !== null;

// 묶음의 바쁨·오류 키. 기록 id와 겹치지 않는다
const batchKey = (batchId: string) => `batch:${batchId}`;

/**
 * 변경 기록 화면: 이 앱으로 한 IAM 변경을 최신순으로 보여주고, 되돌릴 수 있는 변경은 [되돌리기]로 역변경 미리보기를 연다.
 * 묶음으로 한 변경은 묶음 머리 밑에 모으고, 머리의 [묶음 되돌리기]는 묶음 전체의 역변경 미리보기를 연다.
 */
export function ChangeLog({ profile, accountId, onStart, onStartBatch }: Props) {
  const q = useChangeLog();
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const inFlight = useRef(false);
  const entries = q.data;
  const lines = useMemo(() => arrange(entries ?? []), [entries]);

  /** 되돌리기 준비 하나. key는 바쁨·오류를 붙일 자리(기록 id 또는 묶음 키)이고, 한 번에 하나만 돌린다 */
  const prepare = async (key: string, task: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(key);
    setErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== key)));
    try {
      await task();
    } catch (e) {
      setErrors((prev) => ({ ...prev, [key]: errorMessage(e) }));
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  const undo = (entry: ChangeLogEntry) =>
    prepare(entry.id, async () => {
      const inverse = await iamApi.undoChange(entry.id);
      onStart(inverse, { undoOf: entry.id });
    });

  const undoBatch = (batchId: string) =>
    prepare(batchKey(batchId), async () => {
      const inverse = await iamApi.undoBatch(batchId);
      onStartBatch(inverse.changes, { undoOf: inverse.undoOf });
    });

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
              {lines.map((line) => {
                if (line.kind === "batch") {
                  const key = batchKey(line.batchId);
                  return (
                    <tr key={key} className="cl-batch">
                      <td colSpan={4}>
                        {/* 목록이 최신순이라 첫 기록이 묶음에서 가장 최근 기록이다. 머리의 시각도 그 시각이다 */}
                        <div>{`묶음 · 변경 ${line.entries.length}개 · ${formatDateTime(line.entries[0].at)}`}</div>
                        {errors[key] && <div className="err">{errors[key]}</div>}
                      </td>
                      <td className="cl-act">
                        <BatchAction entries={line.entries} accountId={accountId} busy={busy === key} onUndo={() => void undoBatch(line.batchId)} />
                      </td>
                    </tr>
                  );
                }
                const e = line.entry;
                return (
                  <tr key={e.id} className={line.inBatch ? "cl-in" : undefined}>
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
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** 꺼진 버튼과 그 이유 */
function Blocked({ label, reason }: { label: string; reason: string }) {
  return (
    <>
      <button className="btn small" disabled>
        {label}
      </button>
      <div className="dim cl-why">{reason}</div>
    </>
  );
}

// 다른 계정에서 한 변경의 역변경을 이 계정에 적용하면 이름이 같은 엉뚱한 대상이 바뀔 수 있다
const otherAccountReason = (accountId: string) => `다른 계정(${accountId})에서 한 변경이라 그 계정으로 열어야 되돌릴 수 있어요`;

function Action({ entry, sameAccount, busy, onUndo }: { entry: ChangeLogEntry; sameAccount: boolean; busy: boolean; onUndo: () => void }) {
  if (!entry.ok || entry.undone) return null;
  if (!entry.inverse) return <span className="dim">되돌릴 수 없어요</span>;
  if (!sameAccount) return <Blocked label="되돌리기" reason={otherAccountReason(entry.accountId)} />;
  return (
    <button className="btn small" disabled={busy} onClick={onUndo}>
      {busy ? "준비 중…" : "되돌리기"}
    </button>
  );
}

/** 묶음 머리의 [묶음 되돌리기]. 되돌릴 것이 하나도 없거나 다른 계정에서 한 묶음이면 이유와 함께 끈다 */
function BatchAction({ entries, accountId, busy, onUndo }: { entries: ChangeLogEntry[]; accountId: string; busy: boolean; onUndo: () => void }) {
  if (!entries.some(canUndo)) return <Blocked label="묶음 되돌리기" reason="되돌릴 변경이 없어요" />;
  const other = entries.find((e) => e.accountId !== accountId);
  if (other) return <Blocked label="묶음 되돌리기" reason={otherAccountReason(other.accountId)} />;
  return (
    <button className="btn small" disabled={busy} onClick={onUndo}>
      {busy ? "준비 중…" : "묶음 되돌리기"}
    </button>
  );
}
