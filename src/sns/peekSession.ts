import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../api/invoke";

/** 엿볼 수 있는지 큐마다의 판정. 막힌 큐는 reason, 엿볼 수 있지만 조심할 큐는 warning(큐 이름을 입력해야 시작) */
export interface PeekVerdict {
  queueArn: string;
  queueName: string;
  queueUrl: string;
  eligible: boolean;
  /** DLQ면 true, 소비자 없는 구독 큐면 false */
  dlq: boolean;
  warning: string | null;
  reason: string | null;
}

/** 받은 메시지 하나. body는 SNS 봉투를 푼 Message(raw 전달이면 본문 그대로), attributes는 봉투의 MessageAttributes 또는 SQS 메시지 속성 */
export interface PeekMessage {
  messageId: string;
  body: string;
  attributes: unknown;
  topicArn: string | null;
  timestamp: string | null;
  snsMessageId: string | null;
  /** 같은 MessageId의 배달 실패 로그 줄(원문 JSON) */
  failureLines: string[];
}

export interface PeekEvent {
  session: string;
  kind: "message" | "done" | "error";
  message?: PeekMessage | null;
  error?: unknown;
}

export const peekApi = {
  eligibility: (profile: string, region: string, topicArn: string) =>
    invoke<PeekVerdict[]>("sns_peek_eligibility", { profile, region, topicArn }),
  /** 서버가 판정을 다시 확인하고 세션 id를 돌려준다. 메시지는 `sns-peek` 이벤트로 온다 */
  start: (profile: string, region: string, topicArn: string, queueArn: string, follow: boolean, confirmedName: string | null) =>
    invoke<string>("sns_peek_start", { profile, region, topicArn, queueArn, follow, confirmedName }),
  /** 받기를 멈추고 들고 있던 메시지를 바로 다시 보이게 돌려놓는다. 끝난 세션이면 아무 일도 없다 */
  stop: (session: string) => invoke<void>("sns_peek_stop", { session }),
  onEvent: (cb: (ev: PeekEvent) => void) => listen<PeekEvent>("sns-peek", (e) => cb(e.payload)),
};

export type PeekStatus = "idle" | "starting" | "running" | "stopping" | "done" | "error";

export interface PeekSessionState {
  status: PeekStatus;
  queueArn: string | null;
  messages: PeekMessage[];
  error: unknown;
}

const IDLE: PeekSessionState = { status: "idle", queueArn: null, messages: [], error: null };

/** 이벤트 하나를 세션 상태에 더한다. 같은 MessageId는 한 번만 둔다 */
export function applyPeekEvent(state: PeekSessionState, ev: PeekEvent): PeekSessionState {
  switch (ev.kind) {
    case "message": {
      const m = ev.message;
      if (!m || state.messages.some((x) => x.messageId === m.messageId)) return state;
      return { ...state, messages: [...state.messages, m] };
    }
    case "done":
      return { ...state, status: state.status === "error" ? "error" : "done" };
    case "error":
      return { ...state, status: "error", error: ev.error ?? null };
  }
}

/**
 * 엿보기 세션 하나. 시작 전에 `sns-peek`을 듣기 시작하고, start가 세션 id를 돌려주기 전에 온 이벤트는 모아 뒀다가 붙인다.
 * 화면이 사라지면(탭 닫기·다른 화면) 세션을 멈춰서 메시지를 돌려놓는다.
 */
export function usePeekSession(profile: string, region: string, topicArn: string) {
  const [state, setState] = useState<PeekSessionState>(IDLE);
  const session = useRef<string | null>(null);
  const pending = useRef<PeekEvent[]>([]);
  const unlisten = useRef<null | (() => void)>(null);
  // 화면이 사라진 뒤에 끝난 start·listen은 바로 정리한다(돌려놓지 않은 세션이 남지 않게)
  const alive = useRef(true);

  const stopListening = () => {
    unlisten.current?.();
    unlisten.current = null;
  };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      const id = session.current;
      session.current = null;
      stopListening();
      if (id) void peekApi.stop(id).catch(() => {});
    };
  }, []);

  const start = useCallback(
    async (queueArn: string, follow: boolean, confirmedName: string | null) => {
      if (session.current) await peekApi.stop(session.current).catch(() => {});
      session.current = null;
      pending.current = [];
      setState({ status: "starting", queueArn, messages: [], error: null });
      stopListening();
      const off = await peekApi.onEvent((ev) => {
        if (session.current === null) {
          pending.current.push(ev);
          return;
        }
        if (ev.session === session.current) setState((s) => applyPeekEvent(s, ev));
      });
      if (!alive.current) {
        off();
        return;
      }
      unlisten.current = off;
      try {
        const id = await peekApi.start(profile, region, topicArn, queueArn, follow, confirmedName);
        if (!alive.current) {
          void peekApi.stop(id).catch(() => {});
          return;
        }
        session.current = id;
        const early = pending.current.filter((ev) => ev.session === id);
        pending.current = [];
        setState((s) => early.reduce(applyPeekEvent, { ...s, status: "running" }));
      } catch (error) {
        stopListening();
        if (typeof error === "object" && error !== null && "kind" in error && error.kind === "peekConfirm") {
          setState(IDLE);
          return error;
        }
        setState((s) => ({ ...s, status: "error", error }));
      }
    },
    [profile, region, topicArn],
  );

  const stop = useCallback(async () => {
    const id = session.current;
    if (!id) return;
    setState((s) => ({ ...s, status: "stopping" }));
    try {
      await peekApi.stop(id);
      setState((s) => ({ ...s, status: s.status === "error" ? "error" : "done" }));
    } catch (error) {
      setState((s) => ({ ...s, status: "error", error }));
    }
  }, []);

  return { state, start, stop };
}
