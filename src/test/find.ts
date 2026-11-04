import { act, fireEvent, screen } from "@testing-library/react";
import { dispatchKey } from "../keymap/registry";

/** ⌘F를 디스패처에 보낸다. 처리한 목록이 있으면 true(숨은 탭이나 목록이 없으면 false) */
export function pressFindKey(): boolean {
  let handled = false;
  act(() => {
    handled = dispatchKey(new KeyboardEvent("keydown", { key: "f", metaKey: true, cancelable: true }));
  });
  return handled;
}

/** ⌘F를 눌러(디스패처를 거쳐) 보고 있는 목록의 찾기 줄을 열고 그 줄을 돌려준다 */
export function pressFind() {
  pressFindKey();
  return screen.getByRole("textbox", { name: "목록에서 찾기" });
}

/** ⌘F로 찾기 줄을 열고 검색어를 친다. 이미 열려 있으면 그 줄에 다시 친다 */
export function findFor(query: string) {
  const input = pressFind();
  fireEvent.change(input, { target: { value: query } });
  return input;
}
