import { useCallback, useRef, useState } from "react";
import { kvApi } from "./api";
import type { KvBigKey, KvBigKeysMessage, KvBigKeysReport, KvTarget } from "./types";

/**
 * 큰 키 찾기의 상태. 탭이 들고 있어서 다른 화면을 보고 돌아와도 진행과 결과가 남는다.
 * 끝난 결과는 백엔드가 대상·DB마다 저장해 두어, 연결하면 다음 찾기 전까지 그 결과(done)로 시작한다.
 */
export type BigKeysState =
  | { status: "idle" }
  | {
      status: "running";
      scanned: number;
      total: number;
      stopping: boolean;
      /** 시작한 시각(ms). 남은 시간을 어림한다 */
      startedAt: number;
      /** 5만 개마다 오는 그때까지의 상위 키와, 그때 훑은 수(아직 없으면 null) */
      partial: { keys: KvBigKey[]; scanned: number } | null;
    }
  | ({ status: "done" } & KvBigKeysReport)
  | { status: "error"; error: unknown };

/** 찾을 상위 키 수 */
export const BIGKEYS_LIMIT = 50;

export function useBigKeys(target: KvTarget) {
  const [state, setState] = useState<BigKeysState>({ status: "idle" });
  // 오래된 실행·불러오기의 응답이 새 상태를 덮지 않게 번호를 둔다
  const run = useRef(0);

  const start = useCallback(() => {
    const mine = ++run.current;
    setState({ status: "running", scanned: 0, total: 0, stopping: false, startedAt: Date.now(), partial: null });
    const onMessage = (m: KvBigKeysMessage) => {
      if (run.current !== mine) return;
      if (m.type === "progress") {
        setState((s) => (s.status === "running" ? { ...s, scanned: m.scanned, total: m.total, partial: m.keys ? { keys: m.keys, scanned: m.scanned } : s.partial } : s));
      } else {
        const { type: _done, ...report } = m;
        setState({ status: "done", ...report });
      }
    };
    kvApi.bigkeys(target, BIGKEYS_LIMIT, onMessage).then(
      // 결과(done)가 채널로 오지 않고 끝났으면 처음 상태로 돌린다
      () => run.current === mine && setState((s) => (s.status === "running" ? { status: "idle" } : s)),
      (error: unknown) => run.current === mine && setState({ status: "error", error }),
    );
  }, [target]);

  const stop = useCallback(() => {
    setState((s) => (s.status === "running" ? { ...s, stopping: true } : s));
    kvApi.bigkeysStop(target).catch((e: unknown) => console.error("큰 키 찾기를 중단하지 못했어요", e));
  }, [target]);

  /** 연결이 바뀌었을 때: 이전 연결의 결과를 버리고, 돌고 있던 실행의 메시지는 무시한다 */
  const reset = useCallback(() => {
    run.current++;
    setState({ status: "idle" });
  }, []);

  /** 연결된 대상·DB의 저장한 결과를 불러온다. 찾는 중이거나 이미 결과가 있으면 그대로 둔다 */
  const loadSaved = useCallback(() => {
    const mine = run.current;
    kvApi.bigkeysReport(target).then(
      (report) => {
        if (report && run.current === mine) setState((s) => (s.status === "idle" ? { status: "done", ...report } : s));
      },
      (e: unknown) => console.error("저장한 큰 키 결과를 읽지 못했어요", e),
    );
  }, [target]);

  return { state, start, stop, reset, loadSaved };
}
