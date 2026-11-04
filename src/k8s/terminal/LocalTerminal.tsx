import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { ErrorState } from "../../components/ErrorState";
import { eventKey } from "../../keymap/keys";
import { useCommand } from "../../keymap/registry";
import { k8sApi } from "../api";
import { shellExited } from "../text";
import type { K8sShellMessage, K8sTarget } from "../types";
import { terminalApi } from "./api";
import { TERMINAL_CLOSE_TAB, TERMINAL_OPENING, TERMINAL_RESTART } from "./text";
import { LEAVE_KEY, focusTab, terminalTheme } from "./xterm";

type State = { phase: "opening" } | { phase: "running" } | { phase: "ended"; code: number | null; reason: string | null } | { phase: "error"; error: unknown };

interface Props {
  target: K8sTarget;
  ssoProfile: string;
  /** 확인을 거친 플러그인 명령. null이면 로그인 셸 */
  command: string | null;
  /** 탭 이름(접근성 이름) */
  title: string;
  /** 보이는 동안만 크기를 맞추고 입력을 받는다(숨겨도 세션은 유지된다) */
  visible: boolean;
  onClose: () => void;
}

/**
 * 이 탭의 클러스터에 고정된 로컬 셸(또는 플러그인 명령) 하나를 xterm.js로 보여 준다. 마운트될 때 열고 사라질 때 닫는다.
 * 키 입력과 크기 변경은 백엔드로 보내고, 출력은 채널로 받아 그린다. 입력·출력은 어디에도 남기지 않는다.
 */
export function LocalTerminal({ target, ssoProfile, command, title, visible, onClose }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const idRef = useRef<number | null>(null);
  const [state, setState] = useState<State>({ phase: "opening" });
  const [nonce, setNonce] = useState(0);
  const restart = () => setNonce((n) => n + 1);
  // ⌘⎋: 터미널에서 빠져나와 커서를 앱 탭으로 돌린다(그 밖의 키는 모두 터미널로 간다)
  useCommand(
    "terminal.leave",
    () => {
      termRef.current?.blur();
      focusTab();
    },
    { host: wrap, enabled: visible },
  );

  useEffect(() => {
    setState({ phase: "opening" });
    const el = host.current;
    if (!el) return;
    const term = new Terminal({ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12, theme: terminalTheme(), cursorBlink: true, scrollback: 5000 });
    const themeObserver = new MutationObserver(() => { term.options.theme = terminalTheme(); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // 빠져나오는 키만 xterm이 처리하지 않게 해서 창의 키 처리기로 올려 보낸다
    term.attachCustomKeyEventHandler((e) => eventKey(e) !== LEAVE_KEY);
    term.open(el);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    let gone = false;
    let id: number | null = null;
    const onMessage = (m: K8sShellMessage) => {
      if (gone) return;
      if (m.type === "output") term.write(m.data);
      else setState({ phase: "ended", code: m.code, reason: m.reason });
    };
    terminalApi
      .open(target, command, term.cols, term.rows, ssoProfile, onMessage)
      .then((opened) => {
        if (gone) {
          void k8sApi.shellClose(opened.id);
          return;
        }
        id = opened.id;
        idRef.current = id;
        // 끝났다는 메시지가 열림 응답보다 먼저 올 수 있으니 끝난 상태를 덮어쓰지 않는다
        setState((s) => (s.phase === "opening" ? { phase: "running" } : s));
        void k8sApi.shellResize(id, term.cols, term.rows);
        term.focus();
      })
      .catch((e: unknown) => {
        if (gone) return;
        setState({ phase: "error", error: e });
      });
    const data = term.onData((d) => {
      if (id !== null) void k8sApi.shellInput(id, d);
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
    // 대상과 명령은 이 컴포넌트의 key가 담는다(바뀌면 새로 연다)
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
    <div ref={wrap} className="k8s-shell-wrap">
      {state.phase === "error" && <ErrorState error={state.error} profile={ssoProfile} compact onRetry={restart} onLoggedIn={restart} />}
      <div className="k8s-term-box">
        <div ref={host} className="k8s-term" aria-label={title} />
        {state.phase === "opening" && <p className="dim k8s-hint k8s-term-note">{TERMINAL_OPENING}</p>}
        {state.phase === "ended" && (
          <div className="k8s-term-over">
            <p>{shellExited(state.code, state.reason)}</p>
            {/* 플러그인 명령은 확인을 거쳐 한 번 실행한 것이라 같은 명령을 다시 돌리지 않는다 */}
            {command === null ? (
              <button className="btn tone-secondary" onClick={restart}>{TERMINAL_RESTART}</button>
            ) : (
              <button className="btn tone-secondary" onClick={onClose}>{TERMINAL_CLOSE_TAB}</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
