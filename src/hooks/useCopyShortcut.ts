import type { RefObject } from "react";
import { desktop } from "../api/desktop";
import { useCommand } from "../keymap/registry";

/**
 * ⌘C(`list.copyId`): 목록에서 고른 항목의 ID를 복사한다. value가 null이면(고른 행이 없음) 처리기가 없는 것으로 본다.
 * 입력칸에 커서가 있거나 글자를 골랐을 때는 키가 이 처리기까지 오지 않아 기본 복사가 그대로 동작한다(keybindings.ts의 when).
 */
export function useCopyShortcut(value: string | null, host?: RefObject<HTMLElement>) {
  useCommand("list.copyId", () => void desktop.copy(value as string), { host, enabled: value !== null });
}
