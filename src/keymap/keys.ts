/**
 * 키 표기: VS Code처럼 `shift+cmd+r`, `cmd+f`, `escape`, `f7`, `:`. 수식 키는 이 순서(ctrl, alt, shift, cmd)로 쓴다.
 * 글자 키는 소문자로 적고, 쉬프트로 바뀌는 기호(`:`, `?`)는 그 기호 자체로 적는다(쉬프트를 따로 적지 않는다).
 */

const MOD_ORDER = ["ctrl", "alt", "shift", "cmd"] as const;

const NAMED: Record<string, string> = {
  Escape: "escape",
  Enter: "enter",
  Tab: "tab",
  Backspace: "backspace",
  Delete: "delete",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  " ": "space",
};

/** 쉬프트를 눌러야 나오는 기호. 이 키들은 표기에 shift를 붙이지 않는다 */
const SHIFTED_SYMBOLS: Record<string, true> = Object.fromEntries(["?", ":", "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "+", "{", "}", "|", "\"", "<", ">", "~"].map((s) => [s, true]));

/** 키 이벤트를 표기 하나로 바꾼다. 수식 키만 눌렀으면 null */
export function eventKey(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): string | null {
  if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return null;
  let base = NAMED[e.key] ?? e.key;
  if (/^F\d{1,2}$/.test(base)) base = base.toLowerCase();
  const symbol = base.length === 1 && SHIFTED_SYMBOLS[base] === true;
  if (base.length === 1) base = base.toLowerCase();
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  // 대문자 글자(G)는 shift+g로 적는다. 쉬프트로 나온 기호는 기호 그대로 둔다
  if (e.shiftKey && !symbol) mods.push("shift");
  if (e.metaKey) mods.push("cmd");
  return [...mods, base].join("+");
}

/** 표기를 수식 키 순서대로 고쳐 쓴다(표를 쓸 때 순서를 틀려도 같은 키로 본다) */
export function normalizeKey(key: string): string {
  const parts = key.toLowerCase().split("+");
  const base = parts.pop() ?? "";
  const mods = MOD_ORDER.filter((m) => parts.includes(m));
  return [...mods, base].join("+");
}

const LABEL: Record<string, string> = {
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
  cmd: "⌘",
  escape: "⎋",
  enter: "↩",
  tab: "⇥",
  backspace: "⌫",
  delete: "⌦",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  space: "Space",
};

/** 화면에 보이는 표기(⇧⌘R, ⌘F, F7, ⌃D) */
export function keyLabel(key: string): string {
  const parts = normalizeKey(key).split("+");
  const base = parts.pop() ?? "";
  const mods = parts.map((m) => LABEL[m] ?? m).join("");
  const shown = LABEL[base] ?? base.toUpperCase();
  return `${mods}${shown}`;
}
