import { useCallback } from "react";
import { errorMessage } from "../api/errors";
import { iamApi } from "./api";
import type { ChangePreview, IamChange, PreviewWarning } from "./types";
import { useApplyNotices, useIamRefresh, usePendingFlow } from "./useApplyFlow";

export interface StartOptions {
  /** 되돌리기일 때 되돌리는 기록의 id. iam_apply에 그대로 넘겨서 기록에 "되돌림"으로 남긴다 */
  undoOf?: string;
  /** 적용에 성공했을 때 부른다(변경을 만든 편집기를 닫는 데 쓴다) */
  onApplied?: () => void;
}

/**
 * 열려 있는 변경 하나. 미리보기와 적용은 늘 이 객체 하나(같은 프로필, 같은 변경)를 기준으로 하므로
 * 미리보기를 보지 않은 변경이나 다른 프로필의 변경이 적용될 수 없다.
 */
export interface PendingChange {
  profile: string;
  change: IamChange;
  undoOf: string | null;
  /** 미리보기를 새로 받을 때마다 오른다. 화면이 입력해 둔 확인 문구를 버리는 기준이다 */
  rev: number;
  /** loading: 미리보기를 받는 중 · ready: 확인을 기다림 · applying: 적용 중 */
  phase: "loading" | "ready" | "applying";
  preview: ChangePreview | null;
  error: { kind: "preview" | "apply"; message: string } | null;
  /** 적용에 실패했다. 상태가 바뀌었을 수 있어서 미리보기를 다시 받기 전에는 적용할 수 없다 */
  stale: boolean;
}

export type ApplyGate = { ok: true } | { ok: false; reason: "blocked" | "text" | "noText" };

/** applyGate가 보는 것: 미리보기의 경고와 확인 문구. 묶음은 변경마다의 경고까지 모아서 준다 */
export interface Gated {
  warnings: PreviewWarning[];
  confirmText: string | null;
}

/**
 * 미리보기를 적용해도 되는지. 화면의 [적용] 버튼과 훅의 apply가 같은 규칙을 쓴다.
 * - 막힘(block) 경고가 있으면 무엇을 입력해도 안 된다.
 * - 확인 문구가 있으면 한 글자도 다르지 않게(대소문자·공백 포함) 입력해야 한다.
 * - 확인(confirm) 경고가 있는데 입력할 문구를 받지 못했다면 확인할 방법이 없으니 적용하지 않는다.
 */
export function applyGate(preview: Gated, typed: string): ApplyGate {
  if (preview.warnings.some((w) => w.level === "block")) return { ok: false, reason: "blocked" };
  if (preview.confirmText) return typed === preview.confirmText ? { ok: true } : { ok: false, reason: "text" };
  if (preview.warnings.some((w) => w.level === "confirm")) return { ok: false, reason: "noText" };
  return { ok: true };
}

/**
 * IAM 변경 흐름: start(변경) → iam_preview → 미리보기 창 → apply(확인 문구) → iam_apply.
 *
 * 적용 전에는 반드시 이 변경으로 받은 미리보기가 있어야 하고, 막힘·확인 문구 규칙(applyGate)을 통과해야 한다.
 * 적용에 실패하면 창을 연 채 오류를 보여 주고, 미리보기를 다시 받기 전에는 적용하지 않는다.
 * 성공하면 IAM 쿼리를 바로 무효화하고 3초 뒤에 overview를 force=true로 한 번 더 읽는다(IAM 반영 지연).
 * 성공 안내(notices)는 10초 뒤 사라지지만, 백엔드가 함께 알린 일(변경 기록을 저장하지 못함 등)이 있으면 닫을 때까지 남는다.
 * 안내, 다시 읽기, 열려 있는 흐름을 들고 있는 뼈대는 묶음 흐름(useIamBatch)과 함께 쓰는 useApplyFlow의 조각이다.
 */
export function useIamChange(profile: string) {
  const { pending, pendingRef, profileRef, seq, inFlight, onApplied, commit, cancel } = usePendingFlow<PendingChange, () => void>(profile);
  const { notices, announce, dismissNotice } = useApplyNotices();
  const { invalidate, refreshLater } = useIamRefresh();

  const load = useCallback(
    async (p: string, change: IamChange, undoOf: string | null) => {
      const rev = ++seq.current;
      commit({ profile: p, change, undoOf, rev, phase: "loading", preview: null, error: null, stale: false });
      let result: Pick<PendingChange, "preview" | "error">;
      try {
        result = { preview: await iamApi.preview(p, change), error: null };
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
    (change: IamChange, opts?: StartOptions) => {
      if (pendingRef.current?.phase === "applying") return; // 적용 중인 변경을 덮어쓰지 않는다
      onApplied.current = opts?.onApplied;
      void load(profileRef.current, change, opts?.undoOf ?? null);
    },
    [load, onApplied, pendingRef, profileRef],
  );

  const retryPreview = useCallback(() => {
    const cur = pendingRef.current;
    if (cur && cur.phase !== "applying") void load(cur.profile, cur.change, cur.undoOf);
  }, [load, pendingRef]);

  const apply = useCallback(
    (typed: string): void => {
      const cur = pendingRef.current;
      if (!cur || !cur.preview || cur.phase !== "ready" || cur.stale || inFlight.current) return;
      if (!applyGate(cur.preview, typed).ok) return;
      inFlight.current = true;
      commit({ ...cur, phase: "applying", error: null });
      const confirmText = cur.preview.confirmText ? typed : null;

      void (async () => {
        try {
          const result = await iamApi.apply(cur.profile, cur.change, confirmText, cur.undoOf);
          seq.current++;
          commit(null);
          announce(result.summary, result.notes ?? []);
          invalidate(cur.profile);
          refreshLater(cur.profile);
          const done = onApplied.current;
          onApplied.current = undefined;
          done?.();
        } catch (e) {
          // 실패도 기록에 남는다. 앞의 호출이 이미 적용됐을 수 있어서(버전을 지운 뒤 새 버전 만들기가 실패 등) IAM 화면도 다시 읽는다.
          // 아무것도 쓰지 않은 거부였다면 백엔드는 캐시한 스냅숏을 그대로 주고, 썼다면 백엔드가 이미 그 스냅숏을 버렸다
          invalidate(cur.profile);
          commit({ ...cur, phase: "ready", error: { kind: "apply", message: errorMessage(e) }, stale: true });
        } finally {
          inFlight.current = false;
        }
      })();
    },
    [announce, commit, inFlight, invalidate, onApplied, pendingRef, refreshLater, seq],
  );

  return { pending, notices, start, apply, retryPreview, cancel, dismissNotice };
}
