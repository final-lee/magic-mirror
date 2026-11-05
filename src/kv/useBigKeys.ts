import { useCallback, useRef, useState } from "react";
import { kvApi } from "./api";
import type { KvBigKey, KvBigKeysMessage, KvTarget } from "./types";

/** 큰 키 찾기의 상태. 탭이 들고 있어서 다른 화면을 보고 돌아와도 진행과 결과가 남는다. */
export type BigKeysState =
  | { status: "idle" }
  | { status: "running"; scanned: number; total: number; stopping: boolean }
  | { status: "done"; basis: "memory" | "length"; keys: KvBigKey[]; scanned: number; stopped: boolean }
  | { status: "error"; error: unknown };

/** 찾을 상위 키 수 */
export const BIGKEYS_LIMIT = 50;

export function useBigKeys(target: KvTarget) {
  const [state, setState] = useState<BigKeysState>({ status: "idle" });
  // 오래된 실행의 메시지가 새 실행의 상태를 덮지 않게 실행마다 번호를 둔다
  const run = useRef(0);

  const start = useCallback(() => {
    const mine = ++run.current;
    setState({ status: "running", scanned: 0, total: 0, stopping: false });
    const onMessage = (m: KvBigKeysMessage) => {
      if (run.current !== mine) return;
      if (m.type === "progress") setState((s) => (s.status === "running" ? { ...s, scanned: m.scanned, total: m.total } : s));
      else setState({ status: "done", basis: m.basis, keys: m.keys, scanned: m.scanned, stopped: m.stopped });
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

  return { state, start, stop, reset };
}
