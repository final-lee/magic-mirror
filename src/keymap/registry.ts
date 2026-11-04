import { useEffect, useRef, type MutableRefObject, type RefObject } from "react";
import { eventKey, normalizeKey } from "./keys";
import { KEYBINDINGS } from "./keybindings";

/**
 * 명령 처리기 등록과 키 디스패처(창 하나의 keydown). 화면은 `useCommand`로 "이 범위에서 이 명령"만 등록하고,
 * 어떤 키가 그 명령인지는 keybindings.ts 표가 정한다.
 */

interface Entry {
  command: string;
  run: MutableRefObject<() => void>;
  enabled: MutableRefObject<() => boolean>;
  /** 처리기가 속한 화면의 상자. 숨은 탭 안이면 부르지 않고, 포커스·마지막 누름으로 고를 때 쓴다 */
  host?: RefObject<HTMLElement>;
}

const entries: Entry[] = [];
/** 앱이 정하는 문맥 키(VS Code의 setContext). DOM으로 알 수 있는 키는 아래 builtin이 따진다 */
const contexts: Record<string, boolean> = {};
let lastPointer: Element | null = null;

export function setContext(key: string, value: boolean) {
  contexts[key] = value;
}

const TEXT_INPUT = 'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="range"]), textarea, select, [contenteditable="true"], .cm-editor';

const visibleModal = () => Array.from(document.querySelectorAll(".modal")).some((m) => !m.closest("[hidden]"));

function builtin(key: string): boolean | undefined {
  const active = document.activeElement as HTMLElement | null;
  switch (key) {
    case "inputFocus":
      return !!active?.closest(TEXT_INPUT) && !active.closest(".xterm");
    case "terminalFocus":
      return !!active?.closest(".xterm");
    case "findOpen":
      return !!active?.closest(".list-find");
    case "dialogOpen":
      return visibleModal();
    case "textSelected":
      return (window.getSelection()?.toString() ?? "").length > 0;
    default:
      return undefined;
  }
}

/** `a && !b || c`. 괄호는 쓰지 않는다(&&가 ||보다 먼저) */
export function evalWhen(when: string | undefined, lookup: (key: string) => boolean): boolean {
  if (!when || !when.trim()) return true;
  return when.split("||").some((any) =>
    any.split("&&").every((term) => {
      const t = term.trim();
      return t.startsWith("!") ? !lookup(t.slice(1).trim()) : lookup(t);
    }),
  );
}

const lookup = (key: string) => builtin(key) ?? contexts[key] ?? false;

function visible(e: Entry): boolean {
  if (!e.host) return true;
  const el = e.host.current;
  return !!el && el.isConnected && !el.closest("[hidden]");
}

/** 명령을 처리할 등록 하나: 포커스가 든 host > 마지막으로 누른 host > 마지막에 등록한 것(숨은 host 제외) */
function pick(command: string): Entry | undefined {
  const candidates = entries.filter((e) => e.command === command && visible(e) && e.enabled.current());
  if (candidates.length === 0) return undefined;
  const active = document.activeElement;
  const within = (target: Element | null) => candidates.filter((e) => !!target && !!e.host?.current?.contains(target));
  const last = (list: Entry[]) => list[list.length - 1];
  return last(within(active)) ?? last(within(lastPointer)) ?? last(candidates);
}

/** 명령을 실행한다(명령 팔레트·버튼). 처리할 곳이 없으면 false */
export function runCommand(command: string): boolean {
  const entry = pick(command);
  if (!entry) return false;
  entry.run.current();
  return true;
}

/** 지금 실행할 수 있는 명령인가(명령 팔레트가 목록을 거른다) */
export function canRun(command: string): boolean {
  return pick(command) !== undefined;
}

/** keydown 하나를 표에서 찾아 처리했으면 true. 컴포넌트가 이미 처리한(preventDefault) 키는 건드리지 않는다 */
export function dispatchKey(e: KeyboardEvent): boolean {
  if (e.defaultPrevented) return false;
  const key = eventKey(e);
  if (!key) return false;
  for (const b of KEYBINDINGS) {
    if (b.handler !== "registry" || normalizeKey(b.key) !== key || !evalWhen(b.when, lookup)) continue;
    const entry = pick(b.command);
    if (!entry) continue;
    e.preventDefault();
    entry.run.current();
    return true;
  }
  return false;
}

/** 앱에 한 번: 창의 keydown을 디스패처로, 누른 위치를 기억(처리기 고르기용) */
export function useKeymapListener() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => void dispatchKey(e);
    const onPointerDown = (e: PointerEvent) => {
      lastPointer = e.target as Element | null;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, []);
}

/**
 * 명령 처리기를 등록한다. host를 주면 그 상자가 보일 때만, 여러 곳이 같은 명령을 등록했을 때는 포커스·마지막 누름으로 고른다.
 * enabled가 false면 이 처리기는 없는 것으로 본다(다른 처리기나 기본 동작으로 넘어간다). 함수를 주면 키를 누를 때마다 따진다(커서 위치처럼 그때 DOM을 봐야 알 수 있는 조건).
 */
export function useCommand(command: string, handler: () => void, options: { host?: RefObject<HTMLElement>; enabled?: boolean | (() => boolean) } = {}) {
  const run = useRef(handler);
  run.current = handler;
  const on = options.enabled ?? true;
  const enabled = useRef<() => boolean>(() => true);
  enabled.current = typeof on === "function" ? on : () => on;
  const host = options.host;
  useEffect(() => {
    const entry: Entry = { command, run, enabled, host };
    entries.push(entry);
    return () => {
      const i = entries.indexOf(entry);
      if (i >= 0) entries.splice(i, 1);
    };
  }, [command, host]);
}

/** 시험에서 모듈 상태를 비운다 */
export function resetKeymap() {
  entries.splice(0, entries.length);
  for (const k of Object.keys(contexts)) delete contexts[k];
  lastPointer = null;
}
