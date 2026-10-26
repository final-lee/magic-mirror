import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../api/errors";
import { iamApi } from "./api";
import { iamKeys, refreshIam } from "./queries";
import type { ChangePreview, IamChange } from "./types";

/** 적용한 뒤 IAM이 반영될 때까지 기다렸다가 한 번 더 읽는 시간 */
export const REFRESH_DELAY_MS = 3_000;
/** 완료 안내가 저절로 사라지는 시간. 함께 알릴 일(notes)이 있는 안내는 닫을 때까지 남는다 */
export const NOTICE_MS = 10_000;

/** 적용을 마친 뒤의 안내 하나 */
export interface ApplyNotice {
  id: number;
  summary: string;
  /** IAM은 바꿨지만 하지 못한 일(변경 기록을 저장하지 못함 등). 있으면 사용자가 닫을 때까지 남기고, 다음 성공 안내가 덮지 않는다 */
  notes: string[];
}

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

/**
 * 미리보기를 적용해도 되는지. 화면의 [적용] 버튼과 훅의 apply가 같은 규칙을 쓴다.
 * - 막힘(block) 경고가 있으면 무엇을 입력해도 안 된다.
 * - 확인 문구가 있으면 한 글자도 다르지 않게(대소문자·공백 포함) 입력해야 한다.
 * - 확인(confirm) 경고가 있는데 입력할 문구를 받지 못했다면 확인할 방법이 없으니 적용하지 않는다.
 */
export function applyGate(preview: ChangePreview, typed: string): ApplyGate {
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
 */
export function useIamChange(profile: string) {
  const qc = useQueryClient();
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [notices, setNotices] = useState<ApplyNotice[]>([]);
  const noticeSeq = useRef(0);
  // 여러 이벤트가 같은 렌더 안에서 연달아 와도 판단이 맞도록, 상태와 같은 값을 ref에도 바로 반영한다.
  const pendingRef = useRef<PendingChange | null>(null);
  const profileRef = useRef(profile);
  profileRef.current = profile;
  const seq = useRef(0);
  const inFlight = useRef(false);
  const onApplied = useRef<(() => void) | undefined>(undefined);
  const refreshTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const commit = useCallback((next: PendingChange | null) => {
    pendingRef.current = next;
    setPending(next);
  }, []);

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
    [commit],
  );

  const start = useCallback(
    (change: IamChange, opts?: StartOptions) => {
      if (pendingRef.current?.phase === "applying") return; // 적용 중인 변경을 덮어쓰지 않는다
      onApplied.current = opts?.onApplied;
      void load(profileRef.current, change, opts?.undoOf ?? null);
    },
    [load],
  );

  const retryPreview = useCallback(() => {
    const cur = pendingRef.current;
    if (cur && cur.phase !== "applying") void load(cur.profile, cur.change, cur.undoOf);
  }, [load]);

  const cancel = useCallback(() => {
    if (pendingRef.current?.phase === "applying") return; // 이미 보낸 요청은 되돌릴 수 없다
    seq.current++;
    onApplied.current = undefined;
    commit(null);
  }, [commit]);

  const dismissNotice = useCallback((id: number) => {
    setNotices((all) => all.filter((n) => n.id !== id));
  }, []);

  /** 성공 안내를 띄운다. 알릴 일이 남은 안내는 그대로 두고, 그렇지 않은 이전 안내만 새 안내로 바꾼다 */
  const announce = useCallback((summary: string, notes: string[]) => {
    const id = ++noticeSeq.current;
    clearTimeout(noticeTimer.current);
    setNotices((all) => [...all.filter((n) => n.notes.length > 0), { id, summary, notes }]);
    if (notes.length === 0) {
      noticeTimer.current = setTimeout(() => setNotices((all) => all.filter((n) => n.id !== id)), NOTICE_MS);
    }
  }, []);

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
          void qc.invalidateQueries({ queryKey: iamKeys.root(cur.profile) });
          void qc.invalidateQueries({ queryKey: iamKeys.changeLog });
          const timer = setTimeout(() => {
            refreshTimers.current.delete(timer);
            void refreshIam(qc, cur.profile);
          }, REFRESH_DELAY_MS);
          refreshTimers.current.add(timer);
          const done = onApplied.current;
          onApplied.current = undefined;
          done?.();
        } catch (e) {
          // 실패도 기록에 남으므로 기록만 다시 읽는다. 큰 계정의 스냅숏을 헛되이 다시 만들지 않는다.
          void qc.invalidateQueries({ queryKey: iamKeys.changeLog });
          commit({ ...cur, phase: "ready", error: { kind: "apply", message: errorMessage(e) }, stale: true });
        } finally {
          inFlight.current = false;
        }
      })();
    },
    [announce, commit, qc],
  );

  // 프로필이 바뀌면 열려 있던 변경을 버린다: 다른 계정에 낡은 미리보기를 적용하면 안 된다.
  useEffect(() => {
    seq.current++;
    onApplied.current = undefined;
    if (pendingRef.current?.phase !== "applying") commit(null);
  }, [profile, commit]);

  useEffect(
    () => () => {
      refreshTimers.current.forEach(clearTimeout);
      clearTimeout(noticeTimer.current);
    },
    [],
  );

  return { pending, notices, start, apply, retryPreview, cancel, dismissNotice };
}
