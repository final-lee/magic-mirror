import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { errorMessage } from "../api/errors";
import { useApplyNotices, usePendingFlow } from "../iam/useApplyFlow";
import { applyGate } from "../iam/useIamChange";
import { pgApi } from "./api";
import { REFRESH_FAILED_TEXT, refreshPgAfterChange } from "./queries";
import { targetKey } from "./targets";
import type { PgChange, PgPreview, PgTarget } from "./types";

export interface PgStartOptions {
  /** 되돌리기일 때 되돌리는 기록의 id. pg_apply에 그대로 넘겨서 기록에 "되돌림"으로 남긴다 */
  undoOf?: string;
  /** 적용에 성공했을 때 부른다(변경을 만든 편집기를 닫는 데 쓴다) */
  onApplied?: () => void;
}

/**
 * 열려 있는 변경 하나. 미리보기와 적용은 늘 이 객체 하나(같은 대상, 같은 변경)를 기준으로 하므로
 * 미리보기를 보지 않은 변경이나 다른 대상의 변경이 적용될 수 없다.
 */
export interface PendingPgChange {
  target: PgTarget;
  change: PgChange;
  undoOf: string | null;
  /** 미리보기를 새로 받을 때마다 오른다. 화면이 입력해 둔 확인 문구를 버리는 기준이다 */
  rev: number;
  /** loading: 미리보기를 받는 중 · ready: 확인을 기다림 · applying: 적용 중 · password: 적용했고 새 비밀번호를 보여 주는 중 */
  phase: "loading" | "ready" | "applying" | "password";
  preview: PgPreview | null;
  error: { kind: "preview" | "apply"; message: string } | null;
  /** 적용에 실패했다. 상태가 바뀌었을 수 있어서 미리보기를 다시 받기 전에는 적용할 수 없다 */
  stale: boolean;
  /**
   * phase가 "password"일 때만 있다: 적용 결과가 돌려준 새 비밀번호. 비밀번호가 놓이는 곳은 여기 하나뿐이다.
   * 완료 안내, 쿼리 캐시, 로그에는 넣지 않고, 창을 닫으면(cancel) 이 상태와 함께 사라진다.
   */
  password: string | null;
}

/**
 * PostgreSQL 변경 흐름: start(변경) → pg_preview → 미리보기 창 → apply(확인 문구) → pg_apply.
 *
 * useIamChange와 같은 규칙으로 움직인다. 적용 전에는 반드시 이 변경으로 받은 미리보기가 있어야 하고, 막힘·확인 문구 규칙(applyGate)을
 * 통과해야 한다. 적용에 실패하면 창을 연 채 오류를 보여 주고, 미리보기를 다시 받기 전에는 적용하지 않는다.
 * 안내, 열려 있는 흐름을 들고 있는 뼈대는 묶음 흐름(usePgBatch)과 함께 쓰는 iam/useApplyFlow의 조각이다.
 *
 * IAM과 다른 점
 * - 적용이 끝나면 화면을 바로 다시 읽는다(refreshPgAfterChange): 커밋은 바로 보이니 IAM처럼 몇 초 기다렸다 한 번 더 읽지 않는다.
 *   성공만이 아니라 실패한 뒤에도 읽는다. 실패도 변경 기록에 남고, 연결이 COMMIT 중에 끊겼다면 적용됐을 수도 있다.
 *   적용은 됐는데 목록을 다시 읽지 못했으면 같은 안내에 그 말을 더해 닫을 때까지 남긴다(화면이 낡은 채로 있다는 것을 알리려는 것이다).
 * - 결과에 새 비밀번호(password)가 있으면 창을 닫지 않고 phase "password"로 바꿔 한 번만 보여 준다. 그 사이에 새 흐름은 시작할 수 없다.
 * - 탭이 닫힌 뒤에 온 응답은 어디에도 쓰지 않는다: 상태도, 안내도, 콜백도, 다시 읽기도 없다.
 */
export function usePgChange(target: PgTarget) {
  const qc = useQueryClient();
  const { pending, pendingRef, seq, inFlight, onApplied, alive, commit, cancel } = usePendingFlow<PendingPgChange, () => void>(targetKey(target));
  const { notices, announce, dismissNotice, dropNote } = useApplyNotices();
  // 대상은 객체지만 흐름을 가르는 것은 키다. 부모가 같은 대상을 새 객체로 넘겨도 흐름을 버리지 않으려고 최신 대상을 ref에 둔다.
  const targetRef = useRef(target);
  targetRef.current = target;

  const load = useCallback(
    async (t: PgTarget, change: PgChange, undoOf: string | null) => {
      const rev = ++seq.current;
      commit({ target: t, change, undoOf, rev, phase: "loading", preview: null, error: null, stale: false, password: null });
      let result: Pick<PendingPgChange, "preview" | "error">;
      try {
        result = { preview: await pgApi.preview(t, change), error: null };
      } catch (e) {
        result = { preview: null, error: { kind: "preview", message: errorMessage(e) } };
      }
      const cur = pendingRef.current;
      if (rev !== seq.current || !cur) return; // 그 사이 취소했거나 다른 변경을 시작했다
      commit({ ...cur, ...result, phase: "ready", stale: false });
    },
    [commit, pendingRef, seq],
  );

  const start = useCallback(
    (change: PgChange, opts?: PgStartOptions) => {
      // 적용 중인 변경과 아직 닫지 않은 새 비밀번호는 덮어쓰지 않는다: 비밀번호는 한 번만 보여 줄 수 있다
      const phase = pendingRef.current?.phase;
      if (phase === "applying" || phase === "password") return;
      onApplied.current = opts?.onApplied;
      void load(targetRef.current, change, opts?.undoOf ?? null);
    },
    [load, onApplied, pendingRef],
  );

  const retryPreview = useCallback(() => {
    const cur = pendingRef.current;
    if (cur && cur.phase !== "applying" && cur.phase !== "password") void load(cur.target, cur.change, cur.undoOf);
  }, [load, pendingRef]);

  const apply = useCallback(
    (typed: string): void => {
      const cur = pendingRef.current;
      if (!cur || !cur.preview || cur.phase !== "ready" || cur.stale || inFlight.current) return;
      if (!applyGate(cur.preview, typed).ok) return;
      inFlight.current = true;
      commit({ ...cur, phase: "applying", error: null });
      const confirmText = cur.preview.confirmText ? typed : null;
      // 어느 데이터베이스에서 실행했는지는 미리보기가 안다(그 데이터베이스의 보기를 다시 읽는다)
      const database = cur.preview.database;

      void (async () => {
        try {
          const result = await pgApi.apply(cur.target, cur.change, confirmText, cur.undoOf);
          if (!alive.current) return; // 탭이 닫혔다: 보여 줄 곳도, 다시 읽을 화면도 없다
          seq.current++;
          // 새 비밀번호가 있으면 창을 닫지 않고 비밀번호 단계로 바꾼다. 비밀번호는 이 상태에만 두고 안내에는 요약과 알릴 일만 넣는다.
          commit(result.password ? { ...cur, phase: "password", password: result.password, error: null, stale: false } : null);
          const done = onApplied.current;
          onApplied.current = undefined;
          const notes = result.notes ?? [];
          const noticeId = announce(result.summary, notes);
          // 목록을 다시 읽지 못했으면 화면이 낡은 채로 있으니, 같은 안내에 그 말을 더해 닫을 때까지 남긴다
          void refreshPgAfterChange(qc, cur.target, database, (read) => {
            if (!read && alive.current) announce(result.summary, [...notes, REFRESH_FAILED_TEXT], noticeId);
          });
          // 콜백이 던져도 적용은 이미 끝났다. 실패로 다루지 않는다.
          try {
            done?.();
          } catch (e) {
            console.error("적용 완료 알림을 처리하다 오류가 났어요", e);
          }
        } catch (e) {
          if (!alive.current) return;
          // 실패도 기록에 남고, 계획을 다시 비교하느라 백엔드가 새로 읽었으며, COMMIT 중에 끊겼다면 적용됐을 수도 있다
          void refreshPgAfterChange(qc, cur.target, database);
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
