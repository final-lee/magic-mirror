import { KEYBINDINGS } from "../../keymap/keybindings";
import { normalizeKey } from "../../keymap/keys";

/** xterm은 CSS 변수를 해석하지 않으므로 현재 테마의 실제 색을 읽는다. */
export function terminalTheme() {
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

/** 터미널에서 빠져나오는 키(⌘⎋). xterm이 삼키지 않고 앱의 키 처리기까지 올라가야 한다 */
export const LEAVE_KEY = normalizeKey(KEYBINDINGS.find((b) => b.command === "terminal.leave")?.key ?? "");

/** ⌘⎋: 터미널에서 빠져나와 커서를 앱 탭으로 돌린다 */
export function focusTab() {
  document.querySelector<HTMLElement>('.tabbar .tab-title[aria-selected="true"]')?.focus();
}
