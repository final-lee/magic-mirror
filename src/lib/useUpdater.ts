import { useCallback, useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type UpdaterState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate" }
  | { kind: "available"; version: string; notes: string | null }
  | { kind: "downloading"; version: string; percent: number | null }
  | { kind: "error"; message: string };

/** 시작할 때와 6시간마다 새 버전을 확인한다. 설치는 사용자가 고를 때만 한다. */
export function useUpdater() {
  const [state, setState] = useState<UpdaterState>({ kind: "idle" });
  const [dismissed, setDismissed] = useState<string | null>(null);
  const update = useRef<Update | null>(null);
  const busy = useRef(false);

  const checkNow = useCallback(async (manual = false) => {
    if (busy.current) return;
    busy.current = true;
    if (manual) setState({ kind: "checking" });
    try {
      const found = await check();
      update.current = found;
      if (found) {
        setState({ kind: "available", version: found.version, notes: found.body ?? null });
        if (manual) setDismissed(null);
      } else {
        setState({ kind: "upToDate" });
      }
    } catch (e) {
      // 자동 확인 실패(오프라인 등)는 조용히 넘기고, 직접 누른 확인만 오류를 보여준다.
      setState(manual ? { kind: "error", message: String(e) } : { kind: "idle" });
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    void checkNow();
    const id = window.setInterval(() => void checkNow(), CHECK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [checkNow]);

  const install = useCallback(async () => {
    const u = update.current;
    if (!u) return;
    let total = 0;
    let done = 0;
    setState({ kind: "downloading", version: u.version, percent: null });
    try {
      await u.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? 0;
        else if (ev.event === "Progress") {
          done += ev.data.chunkLength;
          setState({ kind: "downloading", version: u.version, percent: total ? Math.min(100, Math.round((done / total) * 100)) : null });
        }
      });
      await relaunch();
    } catch (e) {
      setState({ kind: "error", message: String(e) });
    }
  }, []);

  const showBanner =
    (state.kind === "available" && dismissed !== state.version) || state.kind === "downloading";

  return {
    state,
    showBanner,
    checkNow: () => checkNow(true),
    install,
    dismiss: () => state.kind === "available" && setDismissed(state.version),
  };
}

export type Updater = ReturnType<typeof useUpdater>;
