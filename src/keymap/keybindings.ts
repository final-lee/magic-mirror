/**
 * 고정 키 바인딩 표(VS Code의 keybindings.json과 같은 모양). 디스패처, 단축키 보기, 명령 팔레트, 버튼 툴팁이 모두 이 표를 읽는다.
 * 설계: docs/superpowers/specs/2026-11-04-keymap-design.md
 */

import { keyLabel } from "./keys";

/** 단축키 보기에서 묶는 범위 */
export type KeyScope = "app" | "list" | "dialog" | "terminal" | "explorer" | "diff" | "k8s";

export interface Keybinding {
  /** keys.ts 표기(`shift+cmd+r`) */
  key: string;
  command: string;
  /** 사용자가 정의한 명령의 이름 */
  title?: string;
  /** `inputFocus`, `dialogOpen` 같은 문맥 키와 `!`, `&&`, `||`로 쓴 조건. 비우면 늘 */
  when?: string;
  scope: KeyScope;
  /**
   * 키를 누가 처리하는가. `registry`면 디스패처가 등록된 명령 처리기를 부른다.
   * `component`면 목록·대화상자 컴포넌트가 포커스 안에서 직접 처리하고, 표는 단축키 보기에 보이기만 한다.
   */
  handler: "registry" | "component";
}

export interface CommandInfo {
  /** 명령 팔레트와 단축키 보기의 이름 */
  title: string;
  scope: KeyScope;
}

/** 명령 이름. 키가 없는 명령도 여기 올리면 명령 팔레트에서 실행할 수 있다 */
export const COMMANDS: Record<string, CommandInfo> = {
  "app.findResource": { title: "리소스 찾기", scope: "app" },
  "app.commandPalette": { title: "명령 팔레트", scope: "app" },
  "app.showShortcuts": { title: "단축키 보기", scope: "app" },
  "app.refresh": { title: "새로 고침", scope: "app" },
  "app.hardReset": { title: "리소스 캐시 모두 비우기", scope: "app" },
  "app.openSettings": { title: "서비스 설정 열기", scope: "app" },
  "tab.back": { title: "뒤로", scope: "app" },
  "tab.forward": { title: "앞으로", scope: "app" },
  "list.find": { title: "목록에서 찾기", scope: "list" },
  "list.findClose": { title: "찾기 지우고 닫기", scope: "list" },
  "list.findToList": { title: "찾기에서 목록으로", scope: "list" },
  "list.move": { title: "행 이동", scope: "list" },
  "list.open": { title: "고른 행 열기", scope: "list" },
  "list.clearSelection": { title: "선택 해제·상세 닫기", scope: "list" },
  "list.copyId": { title: "고른 리소스 ID 복사", scope: "list" },
  "dialog.close": { title: "대화상자 닫기", scope: "dialog" },
  "terminal.leave": { title: "터미널에서 빠져나오기", scope: "terminal" },
  "k8s.terminal": { title: "EKS 터미널 열기", scope: "k8s" },
  "k8s.pluginMenuClose": { title: "플러그인 메뉴 닫기", scope: "k8s" },
  "explorer.compare": { title: "로컬·S3 파일 비교", scope: "explorer" },
  "explorer.delete": { title: "고른 S3 객체 삭제", scope: "explorer" },
  "explorer.switchPane": { title: "로컬·S3 칸 바꾸기", scope: "explorer" },
  "diff.next": { title: "다음 차이", scope: "diff" },
  "diff.prev": { title: "이전 차이", scope: "diff" },
  "k8s.goto": { title: "종류·메뉴로 이동(명령 줄)", scope: "k8s" },
  "list.first": { title: "맨 위 행", scope: "k8s" },
  "list.last": { title: "맨 아래 행", scope: "k8s" },
  "k8s.describe": { title: "describe 보기", scope: "k8s" },
  "k8s.yaml": { title: "YAML 보기", scope: "k8s" },
  "k8s.edit": { title: "YAML 편집", scope: "k8s" },
  "k8s.logs": { title: "로그 보기", scope: "k8s" },
  "k8s.shell": { title: "셸 열기 · scale 미리보기", scope: "k8s" },
  "k8s.attach": { title: "attach 열기", scope: "k8s" },
  "k8s.forward": { title: "포트포워딩 줄로 이동", scope: "k8s" },
  "k8s.restart": { title: "rollout restart 미리보기", scope: "k8s" },
  "k8s.cordon": { title: "cordon 미리보기", scope: "k8s" },
  "k8s.uncordon": { title: "uncordon 미리보기", scope: "k8s" },
  "k8s.delete": { title: "삭제 미리보기", scope: "k8s" },
  "k8s.allNamespaces": { title: "모든 네임스페이스 보기", scope: "k8s" },
};

/** EKS 목록에 커서가 있고 입력칸·터미널·대화상자가 아닐 때(한 글자 키의 조건) */
const K8S_LIST = "k8sListFocus && !dialogOpen && !inputFocus && !terminalFocus";
const K8S_BODY = "k8sFocus && !dialogOpen && !inputFocus && !terminalFocus";

export const KEYBINDINGS: Keybinding[] = [
  { key: "cmd+k", command: "app.findResource", when: "!dialogOpen", scope: "app", handler: "registry" },
  { key: "shift+cmd+p", command: "app.commandPalette", when: "!dialogOpen", scope: "app", handler: "registry" },
  { key: "cmd+/", command: "app.showShortcuts", when: "!dialogOpen", scope: "app", handler: "registry" },
  { key: "cmd+r", command: "app.refresh", scope: "app", handler: "registry" },
  { key: "shift+cmd+r", command: "app.hardReset", scope: "app", handler: "registry" },
  { key: "cmd+[", command: "tab.back", when: "!dialogOpen && !inputFocus", scope: "app", handler: "registry" },
  { key: "cmd+]", command: "tab.forward", when: "!dialogOpen && !inputFocus", scope: "app", handler: "registry" },
  { key: "cmd+f", command: "list.find", when: "!dialogOpen && !terminalFocus", scope: "list", handler: "registry" },
  { key: "escape", command: "list.findClose", when: "findOpen", scope: "list", handler: "component" },
  { key: "down", command: "list.findToList", when: "findOpen", scope: "list", handler: "component" },
  { key: "up", command: "list.move", scope: "list", handler: "component" },
  { key: "down", command: "list.move", scope: "list", handler: "component" },
  { key: "enter", command: "list.open", scope: "list", handler: "component" },
  { key: "escape", command: "list.clearSelection", when: "!findOpen", scope: "list", handler: "component" },
  { key: "cmd+c", command: "list.copyId", when: "!inputFocus && !textSelected && !dialogOpen", scope: "list", handler: "registry" },
  { key: "escape", command: "dialog.close", when: "dialogOpen", scope: "dialog", handler: "component" },
  { key: "escape", command: "k8s.pluginMenuClose", when: "!dialogOpen", scope: "k8s", handler: "registry" },
  { key: "cmd+escape", command: "terminal.leave", when: "terminalFocus", scope: "terminal", handler: "registry" },
  { key: "cmd+d", command: "explorer.compare", when: "!dialogOpen && !inputFocus", scope: "explorer", handler: "registry" },
  { key: "cmd+backspace", command: "explorer.delete", when: "!dialogOpen && !inputFocus", scope: "explorer", handler: "registry" },
  { key: "tab", command: "explorer.switchPane", when: "!dialogOpen && !inputFocus", scope: "explorer", handler: "registry" },
  { key: "f7", command: "diff.next", scope: "diff", handler: "registry" },
  { key: "shift+f7", command: "diff.prev", scope: "diff", handler: "registry" },
  // EKS 탭: k9s식 명령 줄과 한 글자 키(설계: 키맵 설계 "EKS 목록의 k9s식 한 글자 키")
  { key: ":", command: "k8s.goto", when: "!dialogOpen && !inputFocus && !terminalFocus", scope: "k8s", handler: "registry" },
  { key: "/", command: "list.find", when: K8S_BODY, scope: "k8s", handler: "registry" },
  { key: "j", command: "list.move", scope: "k8s", handler: "component" },
  { key: "k", command: "list.move", scope: "k8s", handler: "component" },
  { key: "g", command: "list.first", scope: "k8s", handler: "component" },
  { key: "shift+g", command: "list.last", scope: "k8s", handler: "component" },
  { key: "d", command: "k8s.describe", when: K8S_LIST, scope: "k8s", handler: "registry" },
  { key: "y", command: "k8s.yaml", when: K8S_LIST, scope: "k8s", handler: "registry" },
  { key: "e", command: "k8s.edit", when: K8S_LIST, scope: "k8s", handler: "registry" },
  { key: "l", command: "k8s.logs", when: K8S_LIST, scope: "k8s", handler: "registry" },
  { key: "s", command: "k8s.shell", when: K8S_LIST, scope: "k8s", handler: "registry" },
  { key: "a", command: "k8s.attach", when: K8S_LIST, scope: "k8s", handler: "registry" },
  { key: "shift+f", command: "k8s.forward", when: K8S_LIST, scope: "k8s", handler: "registry" },
  { key: "r", command: "k8s.restart", when: K8S_LIST, scope: "k8s", handler: "registry" },
  { key: "c", command: "k8s.cordon", when: K8S_LIST, scope: "k8s", handler: "registry" },
  { key: "u", command: "k8s.uncordon", when: K8S_LIST, scope: "k8s", handler: "registry" },
  { key: "ctrl+d", command: "k8s.delete", when: K8S_LIST, scope: "k8s", handler: "registry" },
  { key: "0", command: "k8s.allNamespaces", when: K8S_LIST, scope: "k8s", handler: "registry" },
];

/** 버튼 title: 명령에 키가 묶여 있으면 `이름 (⌘R)` */
export function shortcutTitle(title: string, command: string): string {
  const binding = KEYBINDINGS.find((b) => b.command === command);
  return binding ? `${title} (${keyLabel(binding.key)})` : title;
}
