import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "../../api/errors";
import { usePendingFlow } from "../../iam/useApplyFlow";
import { applyGate } from "../../iam/useIamChange";
import { sqsApi } from "../api";
import { sqsKeys } from "../queries";
import type { SqsApplyResult, SqsChange, SqsPreview } from "../types";

export interface PendingSqsChange {
  profile: string;
  region: string;
  url: string;
  change: SqsChange;
  rev: number;
  phase: "loading" | "ready" | "applying";
  preview: SqsPreview | null;
  error: { kind: "preview" | "apply"; message: string } | null;
  stale: boolean;
}

export function useSqsChange(profile: string, region: string, url: string, onDone?: (change: SqsChange, result: SqsApplyResult) => void) {
  const { pending, pendingRef, seq, inFlight, alive, commit, cancel } = usePendingFlow<PendingSqsChange, never>(profile);
  const qc = useQueryClient();
  const done = useRef(onDone);
  done.current = onDone;
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    cancel();
    setNotice(null);
  }, [profile, region, url, cancel]);
  const load = useCallback(async (p: string, r: string, u: string, change: SqsChange) => {
    const rev = ++seq.current;
    commit({ profile: p, region: r, url: u, change, rev, phase: "loading", preview: null, error: null, stale: false });
    try {
      const preview = await sqsApi.preview(p, r, u, change);
      if (seq.current === rev && pendingRef.current) commit({ ...pendingRef.current, preview, phase: "ready" });
    } catch (e) {
      if (seq.current === rev && pendingRef.current) commit({ ...pendingRef.current, phase: "ready", error: { kind: "preview", message: errorMessage(e) } });
    }
  }, [commit, pendingRef, seq]);
  const start = useCallback((change: SqsChange) => {
    if (pendingRef.current?.phase === "applying") return;
    setNotice(null);
    void load(profile, region, url, change);
  }, [load, pendingRef, profile, region, url]);
  const retryPreview = useCallback(() => {
    const cur = pendingRef.current;
    if (cur && cur.phase !== "applying") void load(cur.profile, cur.region, cur.url, cur.change);
  }, [load, pendingRef]);
  const apply = useCallback((typed: string) => {
    const cur = pendingRef.current;
    if (!cur?.preview || cur.phase !== "ready" || cur.stale || inFlight.current || !applyGate({ confirmText: cur.preview.confirmName, warnings: cur.preview.warnings }, typed).ok) return;
    inFlight.current = true;
    commit({ ...cur, phase: "applying", error: null });
    void (async () => {
      try {
        const result = await sqsApi.apply(cur.profile, cur.region, cur.url, cur.change, cur.preview!.expectedVersion, cur.preview!.confirmName ? typed : null);
        void qc.invalidateQueries({ queryKey: sqsKeys.region(cur.profile, cur.region) });
        // 수신 요청은 취소할 수 없어서 화면이 사라진 뒤 응답하면 여기서 세션을 놓아줘요.
        if (!alive.current && result.peek) void sqsApi.release(cur.profile, result.peek.peekId).catch(() => {});
        if (alive.current) {
          seq.current++;
          commit(null);
          setNotice(result.message);
          done.current?.(cur.change, result);
        }
      } catch (e) {
        void qc.invalidateQueries({ queryKey: sqsKeys.region(cur.profile, cur.region) });
        commit({ ...cur, phase: "ready", stale: true, error: { kind: "apply", message: errorMessage(e) } });
      } finally {
        inFlight.current = false;
      }
    })();
  }, [alive, commit, inFlight, pendingRef, qc, seq]);
  return { pending, notice, start, apply, retryPreview, cancel };
}
