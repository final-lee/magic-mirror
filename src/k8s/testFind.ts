import { act, fireEvent, screen } from "@testing-library/react";
import { dispatchKey } from "../keymap/registry";

/** ⌘F를 누른다(디스패처에 직접 보내서 시험마다 창 리스너를 달 필요가 없다). 처리한 곳이 있으면 true */
export function pressFind(): boolean {
  let handled = false;
  act(() => {
    handled = dispatchKey(new KeyboardEvent("keydown", { key: "f", metaKey: true, cancelable: true, bubbles: true }));
  });
  return handled;
}

/** 열려 있는 찾기 줄의 입력칸 */
export const findInput = () => screen.getByRole("textbox", { name: "목록에서 찾기" });
export const findInputs = () => screen.queryAllByRole("textbox", { name: "목록에서 찾기" });

/** ⌘F로 줄을 열고(이미 열려 있으면 그대로) 검색어를 넣는다 */
export function findFor(text: string) {
  if (findInputs().length === 0) pressFind();
  fireEvent.change(findInput(), { target: { value: text } });
}
