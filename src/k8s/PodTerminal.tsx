import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { ErrorState } from "../components/ErrorState";
import { k8sApi } from "./api";
import { ATTACH_OUTPUT_ONLY, SHELL_OPENING, SHELL_REOPEN, SHELL_LABEL, shellExited } from "./text";
import type { K8sShellMode, K8sTarget } from "./types";

/** 앱의 어두운 테마에 맞춘 터미널 색 */
const TERM_THEME = {
  background: "#1a1a1c", foreground: "#e6e6e8", cursor: "#e6e6e8", selectionBackground: "#0a84ff55",
  black: "#1e1e20", red: "#ff453a", green: "#30d158", yellow: "#ffd60a", blue: "#0a84ff", magenta: "#bf5af2", cyan: "#64d2ff", white: "#e6e6e8",
  brightBlack: "#6e6e73", brightRed: "#ff6961", brightGreen: "#4ae08a", brightYellow: "#ffe45c", brightBlue: "#409cff", brightMagenta: "#da8fff", brightCyan: "#8de3ff", brightWhite: "#ffffff",
};

type State = { phase: "opening" } | { phase: "running"; input: boolean } | { phase: "ended"; code: number | null; reason: string | null } | { phase: "error"; error: unknown };

interface Props {
  target: K8sTarget;
  ssoProfile: string;
  namespace: string;
  pod: string;
  container: string;
  mode: K8sShellMode;
  /** 위험한 네임스페이스에서 입력한 Pod 이름 */
  confirmText: string | null;
  /** 보이는 동안만 크기를 맞추고 입력을 받는다(숨겨도 세션은 유지된다) */
  visible: boolean;
}

/**
 * 셸(exec)이나 attach 세션 하나를 xterm.js로 보여 준다. 마운트될 때 열고 사라질 때 닫는다.
 * 키 입력과 크기 변경은 백엔드로 보내고, 출력은 채널로 받아 그린다. 입력·출력은 어디에도 남기지 않는다.
 */
export function PodTerminal({ target, ssoProfile, namespace, pod, container, mode, confirmText, visible }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const idRef = useRef<number | null>(null);
  const [state, setState] = useState<State>({ phase: "opening" });
  const [nonce, setNonce] = useState(0);
  const restart = () => setNonce((n) => n + 1);

  useEffect(() => {
    setState({ phase: "opening" });
    const el = host.current;
    if (!el) return;
    const term = new Terminal({ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12, theme: TERM_THEME, cursorBlink: true, scrollback: 5000 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    let gone = false;
    let id: number | null = null;
    let input = false;
    const open = mode === "attach" ? k8sApi.attachOpen : k8sApi.shellOpen;
    open(target, namespace, pod, container, confirmText, ssoProfile, (m) => {
      if (gone) return;
      if (m.type === "output") term.write(m.data);
      else setState({ phase: "ended", code: m.code, reason: m.reason });
    })
      .then((opened) => {
        if (gone) {
          void k8sApi.shellClose(opened.id);
          return;
        }
        id = opened.id;
        idRef.current = id;
        input = opened.input;
        // 끝났다는 메시지가 열림 응답보다 먼저 올 수 있으니 끝난 상태를 덮어쓰지 않는다
        setState((s) => (s.phase === "opening" ? { phase: "running", input: opened.input } : s));
        void k8sApi.shellResize(id, term.cols, term.rows);
        term.focus();
      })
      .catch((e: unknown) => {
        if (gone) return;
        setState({ phase: "error", error: e });
      });
    const data = term.onData((d) => {
      if (id !== null && input) void k8sApi.shellInput(id, d);
    });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      fit.fit();
      if (id !== null) void k8sApi.shellResize(id, term.cols, term.rows);
    });
    resize?.observe(el);
    return () => {
      gone = true;
      resize?.disconnect();
      data.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      if (id !== null) void k8sApi.shellClose(id);
      idRef.current = null;
    };
    // 대상과 컨테이너와 방식은 이 컴포넌트의 key가 담는다(바뀌면 새로 연다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, ssoProfile]);

  // 숨겨졌다 다시 보이면 크기를 맞추고 포커스를 준다
  useEffect(() => {
    if (!visible) return;
    fitRef.current?.fit();
    const term = termRef.current;
    if (term && idRef.current !== null) void k8sApi.shellResize(idRef.current, term.cols, term.rows);
    term?.focus();
  }, [visible]);

  return (
    <div className="k8s-shell-wrap" aria-label={SHELL_LABEL}>
      {state.phase === "error" && <ErrorState error={state.error} profile={ssoProfile} compact onRetry={restart} onLoggedIn={restart} />}
      {state.phase === "running" && mode === "attach" && !state.input && <p className="dim k8s-hint">{ATTACH_OUTPUT_ONLY}</p>}
      <div className="k8s-term-box">
        <div ref={host} className="k8s-term" aria-label={pod} />
        {state.phase === "opening" && <p className="dim k8s-hint k8s-term-note">{SHELL_OPENING}</p>}
        {state.phase === "ended" && (
          <div className="k8s-term-over">
            <p>{shellExited(state.code, state.reason)}</p>
            <button className="btn" onClick={restart}>
              {SHELL_REOPEN}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
