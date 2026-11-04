import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { eventKey } from "../../keymap/keys";
import { useCommand } from "../../keymap/registry";
import { k8sApi } from "../api";
import type { K8sShellMessage } from "../types";
import { LEAVE_KEY, focusTab, terminalTheme } from "./xterm";

type State = { phase: "opening" } | { phase: "running"; input: boolean } | { phase: "ended"; code: number | null; reason: string | null } | { phase: "error"; error: unknown };
type Open = (cols: number, rows: number, onMessage: (message: K8sShellMessage) => void) => Promise<{ id: number; input: boolean }>;

/** 로컬과 Pod 터미널이 공유하는 xterm과 세션 수명. */
export function useXterm(visible: boolean, profile: string, open: Open, launch?: { claimed: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const idRef = useRef<number | null>(null);
  const [state, setState] = useState<State>({ phase: "opening" });
  const [nonce, setNonce] = useState(0);
  const restart = () => setNonce((n) => n + 1);
  useCommand("terminal.leave", () => { termRef.current?.blur(); focusTab(); }, { host: wrap, enabled: visible });

  useEffect(() => {
    setState({ phase: "opening" });
    if (launch?.claimed) {
      setState({ phase: "ended", code: null, reason: null });
      return;
    }
    const el = host.current;
    if (!el) return;
    if (launch) launch.claimed = true;
    const term = new Terminal({ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12, theme: terminalTheme(), cursorBlink: true, scrollback: 5000 });
    const themeObserver = new MutationObserver(() => { term.options.theme = terminalTheme(); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.attachCustomKeyEventHandler((e) => eventKey(e) !== LEAVE_KEY);
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
    open(term.cols, term.rows, onMessage).then((opened) => {
      if (gone) { void k8sApi.shellClose(opened.id); return; }
      id = opened.id;
      idRef.current = id;
      input = opened.input;
      setState((s) => s.phase === "opening" ? { phase: "running", input } : s);
      void k8sApi.shellResize(id, term.cols, term.rows);
      term.focus();
    }).catch((error: unknown) => { if (!gone) setState({ phase: "error", error }); });
    const data = term.onData((d) => { if (id !== null && input) void k8sApi.shellInput(id, d); });
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
    // 대상은 컴포넌트의 key가 고정한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, profile]);

  useEffect(() => {
    if (!visible) return;
    fitRef.current?.fit();
    const term = termRef.current;
    if (term && idRef.current !== null) void k8sApi.shellResize(idRef.current, term.cols, term.rows);
    term?.focus();
  }, [visible]);
  return { wrap, host, state, restart };
}
