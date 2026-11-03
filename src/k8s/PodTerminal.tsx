import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { ErrorState } from "../components/ErrorState";
import { k8sApi } from "./api";
import { ATTACH_OUTPUT_ONLY, SHELL_OPENING, SHELL_REOPEN, SHELL_LABEL, shellExited } from "./text";
import type { K8sShellMessage, K8sShellMode, K8sTarget } from "./types";

/** xterm은 CSS 변수를 해석하지 않으므로 현재 테마의 실제 색을 읽는다. */
function terminalTheme() {
  const style = getComputedStyle(document.documentElement);
  const color = (name: string) => style.getPropertyValue(name).trim();
  return {
    background: color("--terminal-bg"), foreground: color("--text"), cursor: color("--text"), selectionBackground: color("--accent-soft"),
    black: color("--surface-3"), red: color("--red"), green: color("--green"), yellow: color("--yellow"),
    blue: color("--accent"), magenta: color("--chart-purple"), cyan: color("--syntax-property"), white: color("--text"),
    brightBlack: color("--dim"), brightRed: color("--red"), brightGreen: color("--green"), brightYellow: color("--yellow"),
    brightBlue: color("--accent"), brightMagenta: color("--chart-purple"), brightCyan: color("--syntax-property"), brightWhite: color("--text"),
  };
}

type State = { phase: "opening" } | { phase: "running"; input: boolean } | { phase: "ended"; code: number | null; reason: string | null } | { phase: "error"; error: unknown };

interface Props {
  target: K8sTarget;
  ssoProfile: string;
  namespace: string;
  pod: string;
  container: string;
  mode: K8sShellMode;
  /** 위험한 대상에서 입력한 이름(필요 없으면 null). 노드 셸은 쓰지 않는다 */
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
    const term = new Terminal({ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12, theme: terminalTheme(), cursorBlink: true, scrollback: 5000 });
    const themeObserver = new MutationObserver(() => { term.options.theme = terminalTheme(); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    let gone = false;
    let id: number | null = null;
    let input = false;
    const onMessage = (m: K8sShellMessage) => {
      if (gone) return;
      if (m.type === "output") term.write(m.data);
      else setState({ phase: "ended", code: m.code, reason: m.reason });
    };
    // 노드 셸은 변경 틀로 만든 디버그 Pod(pod)에 들어간다. 컨테이너·확인 문구는 필요 없다
    const opening =
      mode === "node"
        ? k8sApi.nodeShellOpen(target, namespace, pod, ssoProfile, onMessage)
        : (mode === "attach" ? k8sApi.attachOpen : k8sApi.shellOpen)(target, namespace, pod, container, confirmText, ssoProfile, onMessage);
    opening
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
      themeObserver.disconnect();
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
            {/* 노드 셸 Pod는 세션이 끝나면 지워지니 같은 Pod로 다시 열 수 없다 */}
            {mode !== "node" && (
              <button className="btn tone-secondary" onClick={restart}>
                {SHELL_REOPEN}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
