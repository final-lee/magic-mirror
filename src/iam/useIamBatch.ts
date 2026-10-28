import { useCallback } from "react";
import { errorMessage } from "../api/errors";
import { iamApi } from "./api";
import type { BatchPreview, BatchResult, IamChange, PreviewWarning } from "./types";
import { useApplyNotices, useIamRefresh, usePendingFlow } from "./useApplyFlow";
import { applyGate, type ApplyGate } from "./useIamChange";

export interface BatchStartOptions {
  /** 되돌리기 묶음일 때 changes와 같은 길이로, i번째 변경이 되돌리는 기록의 id. iam_apply_batch에 그대로 넘긴다 */
  undoOf?: string[];
  /**
   * 변경이 하나라도 적용됐을 때 적용된 변경만 적용 순서대로 넘겨 부른다(중간에 멈췄으면 멈추기 전까지).
   * 장바구니에서 적용한 변경을 빼는 데 쓴다. 다른 흐름이 시작되거나 프로필이 바뀌면 버려진다.
   */
  onApplied?: (applied: IamChange[]) => void;
}

/**
 * 열려 있는 묶음 하나. 미리보기와 적용은 늘 이 객체 하나(같은 프로필, 같은 변경 목록)를 기준으로 하므로
 * 미리보기를 보지 않은 묶음이나 다른 프로필의 묶음이 적용될 수 없다.
 */
export interface PendingBatch {
  profile: string;
  /** 시작할 때 받은 변경(받은 순서). 미리보기와 적용에 그대로 보내고, 정렬은 백엔드가 한다. undoOf와 같은 순서다 */
  changes: IamChange[];
  /** 되돌리기 묶음이면 changes와 같은 길이로 짝지은 기록 id */
  undoOf: string[] | null;
  /** 미리보기를 새로 받을 때마다 오른다. 화면이 입력해 둔 확인 문구를 버리는 기준이다 */
  rev: number;
  /** loading: 미리보기를 받는 중 · ready: 확인을 기다림 · applying: 적용 중 · result: 중간에 멈춘 결과를 보여 줌 */
  phase: "loading" | "ready" | "applying" | "result";
  preview: BatchPreview | null;
  error: { kind: "preview" | "apply"; message: string } | null;
  /** 적용 요청이 거부됐다. 상태가 바뀌었을 수 있어서 미리보기를 다시 받기 전에는 적용할 수 없다 */
  stale: boolean;
  /** phase가 "result"일 때만 있다: 중간에 멈춘 적용의 결과(failed가 있다) */
  result: BatchResult | null;
}

type Stopped = NonNullable<BatchResult["failed"]>;

/** 묶음 전체의 경고와 변경마다의 경고를 한데 모은 목록. 어느 쪽의 막힘·확인이든 묶음 전체에 걸린다 */
export const batchWarnings = (p: BatchPreview): PreviewWarning[] => [...p.warnings, ...p.changes.flatMap((i) => i.warnings)];

/** 묶음 미리보기를 적용해도 되는지. 변경 하나짜리와 같은 규칙(applyGate)을 모든 경고에 적용한다 */
export const batchGate = (p: BatchPreview, typed: string): ApplyGate => applyGate({ warnings: batchWarnings(p), confirmText: p.confirmText }, typed);

/** 어느 변경에서 왜 멈췄는지. index는 0부터라서 "몇 번째"는 index + 1이다 */
const stopDetail = (failed: Stopped): string => `${failed.index + 1}번째에서 멈췄어요: ${failed.summary}: ${failed.message}`;

/** 묶음이 중간에 멈췄음을 알리는 문장. 멈춘 변경 앞의 index개는 적용됐다 */
export const stopMessage = (total: number, failed: Stopped): string => `${total}개 중 ${failed.index}개를 적용하고 ${stopDetail(failed)}`;

/**
 * 묶음 변경 흐름: start(변경 목록) → iam_preview_batch → 미리보기 창 → apply(확인 문구) → iam_apply_batch.
 * useIamChange와 같은 규칙으로 움직인다: 적용 전에는 이 묶음으로 받은 미리보기가 있어야 하고 막힘·확인 문구 규칙(batchGate)을
 * 지켜야 하며, 적용 요청이 거부되면 미리보기를 다시 받기 전에는 적용하지 않는다. 안내, 다시 읽기, 열려 있는 흐름을 들고 있는
 * 뼈대는 두 훅이 같은 코드(useApplyFlow)를 쓴다.
 *
 * 적용을 시작한 뒤에는 결과가 둘이다.
 * - 끝까지 적용: 창을 닫고 "변경 N개를 적용했어요"를 알린다.
 * - 중간에 멈춤(failed): 창을 닫지 않고 phase "result"로 결과를 보여 준다. 앞의 변경은 이미 적용됐다.
 * 어느 쪽이든 적용된 변경이 있을 수 있으므로, 창을 정리한 다음 onApplied로 알리고(장바구니가 비어야 다시 읽은 개요가 "이미 … 뺐어요"로
 * 되돌려 알리지 않는다) 그 뒤에 IAM 쿼리를 바로 무효화하고 3초 뒤에 overview를 force=true로 한 번 더 읽는다.
 */
export function useIamBatch(profile: string) {
  // alive: 탭이 닫힌 뒤에 온 응답은 장바구니와 안내를 건드리지 않는다
  const { pending, pendingRef, profileRef, seq, inFlight, onApplied, alive, commit, cancel } = usePendingFlow<PendingBatch, (applied: IamChange[]) => void>(profile);
  const { notices, announce, dismissNotice } = useApplyNotices();
  const { invalidate, refreshLater } = useIamRefresh();

  const load = useCallback(
    async (p: string, changes: IamChange[], undoOf: string[] | null) => {
      const rev = ++seq.current;
      commit({ profile: p, changes, undoOf, rev, phase: "loading", preview: null, error: null, stale: false, result: null });
      let outcome: Pick<PendingBatch, "preview" | "error">;
      try {
        outcome = { preview: await iamApi.previewBatch(p, changes), error: null };
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
    (changes: IamChange[], opts?: BatchStartOptions) => {
      if (pendingRef.current?.phase === "applying") return; // 적용 중인 묶음을 덮어쓰지 않는다
      onApplied.current = opts?.onApplied;
      void load(profileRef.current, changes, opts?.undoOf ?? null);
    },
    [load, onApplied, pendingRef, profileRef],
  );

  const retryPreview = useCallback(() => {
    const cur = pendingRef.current;
    // 결과 창에서는 받지 않는다: 이미 일부가 적용된 변경으로 미리보기를 다시 만들 일이 아니다
    if (cur && cur.phase !== "applying" && cur.phase !== "result") void load(cur.profile, cur.changes, cur.undoOf);
  }, [load, pendingRef]);

  const apply = useCallback(
    (typed: string): void => {
      const cur = pendingRef.current;
      if (!cur || !cur.preview || cur.phase !== "ready" || cur.stale || inFlight.current) return;
      if (!batchGate(cur.preview, typed).ok) return;
      const preview = cur.preview;
      inFlight.current = true;
      commit({ ...cur, phase: "applying", error: null });
      const confirmText = preview.confirmText ? typed : null;
      /** 응답이 왔을 때 이 묶음의 프로필이 아직 지금 프로필이고 탭도 열려 있는가. 아니면 결과나 오류 창을 새로 띄우지 않는다 */
      const stillHere = () => alive.current && cur.profile === profileRef.current;

      void (async () => {
        let result: BatchResult;
        try {
          // changes와 undoOf는 받은 순서 그대로 보낸다. 백엔드가 정렬하면서 둘을 짝지어 옮긴다
          result = await iamApi.applyBatch(cur.profile, cur.changes, confirmText, cur.undoOf);
        } catch (e) {
          inFlight.current = false;
          // 적용 전에 거부됐다면 아무것도 바뀌지 않았다. 그래도 응답을 받지 못한 경우처럼 일부가 적용됐을 수 있어서 IAM 화면도 다시 읽는다.
          // 아무것도 쓰지 않은 거부였다면 백엔드는 캐시한 스냅숏을 그대로 주고, 썼다면 백엔드가 이미 그 스냅숏을 버렸다
          invalidate(cur.profile);
          commit(stillHere() ? { ...cur, phase: "ready", error: { kind: "apply", message: errorMessage(e) }, stale: true } : null);
          return;
        }
        inFlight.current = false;

        const stopped = result.failed;
        // 적용된 변경은 적용 순서의 앞에서부터 stopped.index개다(끝까지 적용했으면 전부)
        const applied = preview.changes.slice(0, stopped ? stopped.index : undefined).map((item) => item.change);
        const total = preview.changes.length;
        const notes = result.notes ?? [];
        const live = alive.current;
        const done = onApplied.current;
        onApplied.current = undefined;

        // 먼저 "적용 중"에서 벗어난다. 아래에서 부르는 콜백이 던져도 창이 적용 중에 갇히지 않는다.
        if (stopped && stillHere()) {
          commit({ ...cur, phase: "result", result, error: null, stale: false });
        } else {
          commit(null);
          // 결과를 보여 줄 창이 없으면 안내로 남긴다. 멈춘 이유는 닫을 때까지 남도록 알릴 일(notes)로 둔다
          if (live && stopped) announce(`변경 ${total}개 중 ${stopped.index}개를 적용했어요`, [stopDetail(stopped), ...notes]);
          else if (live) announce(`변경 ${total}개를 적용했어요`, notes);
        }

        // 그다음 장바구니다: 다시 읽은 개요가 오기 전에 적용한 변경이 장바구니에 남아 있으면 "이미 … 뺐어요"로 되돌려 알린다.
        // 콜백의 오류는 알리고 넘어간다. 그래도 아래 다시 읽기는 해야 한다.
        if (live && applied.length > 0) {
          try {
            done?.(applied);
          } catch (e) {
            console.error("적용 완료 알림을 처리하다 오류가 났어요", e);
          }
        }

        invalidate(cur.profile);
        if (live) refreshLater(cur.profile);
      })();
    },
    [alive, announce, commit, inFlight, invalidate, onApplied, pendingRef, profileRef, refreshLater],
  );

  return { pending, notices, start, apply, retryPreview, cancel, dismissNotice };
}
