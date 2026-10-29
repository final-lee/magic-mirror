import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { errorMessage } from "../api/errors";
import { useApplyNotices, usePendingFlow } from "../iam/useApplyFlow";
import { applyGate, type ApplyGate, type Gated } from "../iam/useIamChange";
import { pgApi } from "./api";
import { REFRESH_FAILED_TEXT, refreshPgAfterChange } from "./queries";
import { targetKey } from "./targets";
import type { PgBatchPreview, PgChange, PgTarget, PgWarning } from "./types";

export interface PgBatchStartOptions {
  /**
   * 되돌리기 묶음일 때 되돌리는 기록의 id들(기록마다 하나). changes와 길이가 같지 않을 수 있다: changes는 그 기록들의 역변경을 차례로 이은 것이고,
   * 기록 하나가 변경 여럿으로 되돌려지기도 한다(만든 역할). pg_apply_batch에 그대로 넘기면 백엔드가 기록의 역변경과 changes를 맞춰 본다.
   */
  undoOf?: string[];
  /**
   * 적용에 성공했을 때 적용된 변경을 받은 순서대로 넘겨 부른다. 장바구니에서 적용한 변경을 빼는 데 쓴다.
   * 다른 흐름이 시작되거나 대상이 바뀌면 버려진다. 탭이 닫힌 뒤에 온 응답에는 부르지 않는다.
   */
  onApplied?: (applied: PgChange[]) => void;
}

/**
 * 열려 있는 묶음 하나. 미리보기와 적용은 늘 이 객체 하나(같은 대상, 같은 데이터베이스, 같은 변경 목록)를 기준으로 하므로
 * 미리보기를 보지 않은 묶음이나 다른 대상의 묶음이 적용될 수 없다.
 */
export interface PendingPgBatch {
  target: PgTarget;
  /** 묶음이 실행될 데이터베이스. 묶음 하나는 데이터베이스 하나에서 한 트랜잭션으로 돈다 */
  database: string;
  /** 시작할 때 받은 변경(받은 순서). 미리보기와 적용에 그대로 보내고, 순서는 백엔드가 정한다. 되돌리기 묶음이면 undoOf의 기록들의 역변경을 차례로 이은 것이다 */
  changes: PgChange[];
  /** 되돌리기 묶음이면 되돌리는 기록의 id들(기록마다 하나). changes와 일대일이 아니다 */
  undoOf: string[] | null;
  /** 미리보기를 새로 받을 때마다 오른다. 화면이 입력해 둔 확인 문구를 버리는 기준이다 */
  rev: number;
  /** loading: 미리보기를 받는 중 · ready: 확인을 기다림 · applying: 적용 중 */
  phase: "loading" | "ready" | "applying";
  preview: PgBatchPreview | null;
  error: { kind: "preview" | "apply"; message: string } | null;
  /** 적용에 실패했다. 상태가 바뀌었을 수 있어서 미리보기를 다시 받기 전에는 적용할 수 없다 */
  stale: boolean;
}

/** 묶음 전체의 경고와 변경마다의 경고를 한데 모은 목록. 어느 쪽의 막힘·확인이든 묶음 전체에 걸린다 */
export const pgBatchWarnings = (p: PgBatchPreview): PgWarning[] => [...p.warnings, ...p.items.flatMap((i) => i.warnings)];

/** 묶음 미리보기에서 적용해도 되는지를 가르는 데 보는 것: 모든 경고와 확인 문구. 화면의 [적용]과 이 훅의 apply가 같은 것을 본다 */
export const pgBatchGated = (p: PgBatchPreview): Gated => ({ warnings: pgBatchWarnings(p), confirmText: p.confirmText });

/** 묶음 미리보기를 적용해도 되는지. 변경 하나짜리와 같은 규칙(applyGate)을 모든 경고에 적용한다 */
export const pgBatchGate = (p: PgBatchPreview, typed: string): ApplyGate => applyGate(pgBatchGated(p), typed);

/**
 * PostgreSQL 묶음 흐름: start(데이터베이스, 변경 목록) → pg_preview_batch → 미리보기 창 → apply(확인 문구) → pg_apply_batch.
 * usePgChange와 같은 규칙으로 움직인다. 장바구니와 변경 기록의 되돌리기(여러 변경)가 이 길을 지난다.
 *
 * 묶음은 한 트랜잭션이라 IAM 묶음과 달리 중간에 멈춘 결과가 없다: 모두 적용되거나, 아무것도 적용되지 않고 오류가 난다.
 * 성공하면 창을 닫고 백엔드의 요약("변경 N개")을 알린 다음 onApplied로 적용한 변경을 알린다(장바구니가 비어야 다시 읽은 개요가 "이미 …"로
 * 되돌려 알리지 않는다). 화면은 바로 다시 읽는다(refreshPgAfterChange). 적용은 됐는데 목록을 다시 읽지 못했으면 같은 안내에 그 말을 더해
 * 닫을 때까지 남긴다. 탭이 닫힌 뒤에 온 응답은 어디에도 쓰지 않는다: 상태도, 안내도, 장바구니도, 다시 읽기도 없다.
 */
export function usePgBatch(target: PgTarget) {
  const qc = useQueryClient();
  const { pending, pendingRef, seq, inFlight, onApplied, alive, commit, cancel } = usePendingFlow<PendingPgBatch, (applied: PgChange[]) => void>(targetKey(target));
  const { notices, announce, dismissNotice, dropNote } = useApplyNotices();
  // 대상은 객체지만 흐름을 가르는 것은 키다. 부모가 같은 대상을 새 객체로 넘겨도 흐름을 버리지 않으려고 최신 대상을 ref에 둔다.
  const targetRef = useRef(target);
  targetRef.current = target;

  const load = useCallback(
    async (t: PgTarget, database: string, changes: PgChange[], undoOf: string[] | null) => {
      const rev = ++seq.current;
      commit({ target: t, database, changes, undoOf, rev, phase: "loading", preview: null, error: null, stale: false });
      let outcome: Pick<PendingPgBatch, "preview" | "error">;
      try {
        outcome = { preview: await pgApi.previewBatch(t, database, changes), error: null };
      } catch (e) {
        outcome = { preview: null, error: { kind: "preview", message: errorMessage(e) } };
      }
      const cur = pendingRef.current;
      if (rev !== seq.current || !cur) return; // 그 사이 취소했거나 다른 묶음을 시작했다
      commit({ ...cur, ...outcome, phase: "ready", stale: false });
    },
    [commit, pendingRef, seq],
  );

  const start = useCallback(
    (database: string, changes: PgChange[], opts?: PgBatchStartOptions) => {
      if (pendingRef.current?.phase === "applying") return; // 적용 중인 묶음을 덮어쓰지 않는다
      onApplied.current = opts?.onApplied;
      void load(targetRef.current, database, changes, opts?.undoOf ?? null);
    },
    [load, onApplied, pendingRef],
  );

  const retryPreview = useCallback(() => {
    const cur = pendingRef.current;
    if (cur && cur.phase !== "applying") void load(cur.target, cur.database, cur.changes, cur.undoOf);
  }, [load, pendingRef]);

  const apply = useCallback(
    (typed: string): void => {
      const cur = pendingRef.current;
      if (!cur || !cur.preview || cur.phase !== "ready" || cur.stale || inFlight.current) return;
      if (!pgBatchGate(cur.preview, typed).ok) return;
      inFlight.current = true;
      commit({ ...cur, phase: "applying", error: null });
      const confirmText = cur.preview.confirmText ? typed : null;

      void (async () => {
        try {
          // changes는 받은 순서 그대로, undoOf는 기록마다 하나씩 보낸다. 둘을 맞춰 보고(기록의 역변경을 undoOf 순서로 이은 것이 changes와 같은가)
          // 순서를 정하는 것은 백엔드다
          const result = await pgApi.applyBatch(cur.target, cur.database, cur.changes, confirmText, cur.undoOf);
          if (!alive.current) return; // 탭이 닫혔다: 보여 줄 곳도, 비울 장바구니도, 다시 읽을 화면도 없다
          seq.current++;
          // 먼저 "적용 중"에서 벗어난다. 아래에서 부르는 콜백이 던져도 창이 적용 중에 갇히지 않는다.
          commit(null);
          const done = onApplied.current;
          onApplied.current = undefined;
          const notes = result.notes ?? [];
          const noticeId = announce(result.summary, notes);
          // 그다음 장바구니다: 다시 읽은 개요가 오기 전에 적용한 변경이 장바구니에 남아 있으면 "이미 … 뺐어요"로 되돌려 알린다.
          // 콜백의 오류는 알리고 넘어간다. 적용은 이미 끝났고, 아래 다시 읽기는 해야 한다.
          try {
            done?.(cur.changes);
          } catch (e) {
            console.error("적용 완료 알림을 처리하다 오류가 났어요", e);
          }
          // 목록을 다시 읽지 못했으면 화면이 낡은 채로 있으니, 같은 안내에 그 말을 더해 닫을 때까지 남긴다
          void refreshPgAfterChange(qc, cur.target, cur.database, (read) => {
            if (!read && alive.current) announce(result.summary, [...notes, REFRESH_FAILED_TEXT], noticeId);
          });
        } catch (e) {
          if (!alive.current) return;
          // 실패도 기록에 남고, 계획을 다시 비교하느라 백엔드가 새로 읽었으며, COMMIT 중에 끊겼다면 적용됐을 수도 있다
          void refreshPgAfterChange(qc, cur.target, cur.database);
          commit({ ...cur, phase: "ready", error: { kind: "apply", message: errorMessage(e) }, stale: true });
        } finally {
          inFlight.current = false;
        }
      })();
    },
    [alive, announce, commit, inFlight, onApplied, pendingRef, qc, seq],
  );

  return { pending, notices, start, apply, retryPreview, cancel, dismissNotice, dropNote };
}
