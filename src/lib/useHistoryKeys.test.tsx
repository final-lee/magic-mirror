import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { resetKeymap, useKeymapListener } from "../keymap/registry";
import { useHistoryKeys } from "./useHistoryKeys";

let mouseNav: ((dir: "back" | "forward") => void) | null = null;
vi.mock("../explorer/api", () => ({
  onMouseNav: vi.fn(async (cb: (dir: "back" | "forward") => void) => {
    mouseNav = cb;
    return () => {
      if (mouseNav === cb) mouseNav = null;
    };
  }),
}));

// 앱처럼: 탭 상자는 보이지 않을 때 [hidden] 안에 있고, 키는 창의 디스패처 하나가 받는다
function Probe({ active, back, forward }: { active: boolean; back: () => void; forward: () => void }) {
  useKeymapListener();
  const root = useRef<HTMLDivElement>(null);
  useHistoryKeys(root, active, back, forward);
  return (
    <div hidden={!active}>
      <div ref={root}>
        <input aria-label="입력" />
      </div>
    </div>
  );
}

const metaKey = (key: "[" | "]") => fireEvent.keyDown(window, { key, metaKey: true });

function setup(active = true) {
  const back = vi.fn();
  const forward = vi.fn();
  const view = render(<Probe active={active} back={back} forward={forward} />);
  return { back, forward, ...view };
}

beforeEach(() => {
  resetKeymap();
  mouseNav = null;
  document.querySelectorAll(".modal").forEach((e) => e.remove());
});

test("⌘[ goes back and ⌘] goes forward, and only with ⌘", () => {
  const { back, forward } = setup();
  metaKey("[");
  expect(back).toHaveBeenCalledTimes(1);
  metaKey("]");
  expect(forward).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(window, { key: "[" });
  fireEvent.keyDown(window, { key: "x", metaKey: true });
  expect(back).toHaveBeenCalledTimes(1);
  expect(forward).toHaveBeenCalledTimes(1);
});

test("a handled key is not passed on to the page", () => {
  setup();
  // fireEvent는 기본 동작이 막히지 않았을 때만 true를 돌려준다
  expect(fireEvent.keyDown(window, { key: "[", metaKey: true, cancelable: true })).toBe(false);
  expect(fireEvent.keyDown(window, { key: "]", metaKey: true, cancelable: true })).toBe(false);
  expect(fireEvent.keyDown(window, { key: "x", metaKey: true, cancelable: true })).toBe(true);
});

test("a tab that is not showing ignores the keys and does not listen to the mouse", async () => {
  const { back, forward } = setup(false);
  metaKey("[");
  metaKey("]");
  expect(back).not.toHaveBeenCalled();
  expect(forward).not.toHaveBeenCalled();
  await act(async () => {});
  expect(mouseNav).toBeNull();
});

test("the keys are left alone while a dialog is open or while typing", () => {
  const { back, getByLabelText } = setup();
  const modal = document.body.appendChild(document.createElement("div"));
  modal.className = "modal";
  metaKey("[");
  expect(back).not.toHaveBeenCalled();
  modal.remove();

  getByLabelText("입력").focus();
  metaKey("[");
  expect(back).not.toHaveBeenCalled();
  getByLabelText("입력").blur();
  metaKey("[");
  expect(back).toHaveBeenCalledTimes(1);
});

test("the mouse back and forward buttons (native mouse-nav event) navigate, except under a dialog", async () => {
  const { back, forward } = setup();
  await waitFor(() => expect(mouseNav).not.toBeNull());
  act(() => mouseNav!("back"));
  act(() => mouseNav!("forward"));
  expect(back).toHaveBeenCalledTimes(1);
  expect(forward).toHaveBeenCalledTimes(1);

  const modal = document.body.appendChild(document.createElement("div"));
  modal.className = "modal";
  act(() => mouseNav!("back"));
  expect(back).toHaveBeenCalledTimes(1);
  modal.remove();
});

test("stops listening when the tab stops showing or unmounts", async () => {
  const { rerender, unmount, back, forward } = setup();
  await waitFor(() => expect(mouseNav).not.toBeNull());
  rerender(<Probe active={false} back={back} forward={forward} />);
  await waitFor(() => expect(mouseNav).toBeNull());
  metaKey("[");
  expect(back).not.toHaveBeenCalled();

  rerender(<Probe active back={back} forward={forward} />);
  await waitFor(() => expect(mouseNav).not.toBeNull());
  unmount();
  await waitFor(() => expect(mouseNav).toBeNull());
  metaKey("[");
  expect(back).not.toHaveBeenCalled();
});
