import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { dispatchKey, resetKeymap } from "../../keymap/registry";
import { k8sApi } from "../api";
import { shellExited } from "../text";
import type { K8sShellMessage } from "../types";
import { terminalApi } from "./api";
import { TERMINAL_EMPTY, TERMINAL_NEW, TERMINAL_PINNED, TERMINAL_RESTART, TERMINAL_CLOSE_TAB, terminalClose, terminalTitle } from "./text";
import { TerminalView } from "./TerminalView";
import { useTerminals } from "./useTerminals";

// jsdom에서는 xterm이 그려지지 않으니 받은 것만 기록하는 가짜 터미널로 바꾼다(vi.mock보다 먼저 만들어야 해서 hoisted)
const { terms, FakeTerm } = vi.hoisted(() => {
  const terms: { written: string[]; disposed: boolean; onDataCb: (d: string) => void; keyHandler: (e: KeyboardEvent) => boolean; blurred: boolean; area: HTMLTextAreaElement | null }[] = [];
  class FakeTerm {
    cols = 100;
    rows = 30;
    written: string[] = [];
    disposed = false;
    onDataCb: (d: string) => void = () => {};
    keyHandler: (e: KeyboardEvent) => boolean = () => true;
    blurred = false;
    area: HTMLTextAreaElement | null = null;
    constructor() {
      terms.push(this);
    }
    loadAddon() {}
    attachCustomKeyEventHandler(cb: (e: KeyboardEvent) => boolean) {
      this.keyHandler = cb;
    }
    open(el: HTMLElement) {
      const box = document.createElement("div");
      box.className = "xterm";
      this.area = document.createElement("textarea");
      box.appendChild(this.area);
      el.appendChild(box);
    }
    focus() {
      this.area?.focus();
    }
    blur() {
      this.blurred = true;
      this.area?.blur();
    }
    write(d: string) {
      this.written.push(d);
    }
    onData(cb: (d: string) => void) {
      this.onDataCb = cb;
      return { dispose: () => {} };
    }
    dispose() {
      this.disposed = true;
    }
  }
  return { terms, FakeTerm };
});
vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerm }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("../api", () => ({ k8sApi: { shellInput: vi.fn(), shellResize: vi.fn(), shellClose: vi.fn() } }));
vi.mock("./api", () => ({ terminalApi: { open: vi.fn() } }));
vi.mock("../../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
const k = vi.mocked(k8sApi);
const open = vi.mocked(terminalApi.open);
const T = { profile: "app", region: "r", cluster: "c" };

let emit: ((msg: K8sShellMessage) => void)[] = [];
let nextId = 0;

/** 탭 목록 상태까지 쥐는 한 화면(K8sTab이 하는 일) */
function Screen({ visible = true, plugin }: { visible?: boolean; plugin?: { command: string; title: string } }) {
  const terminals = useTerminals();
  return (
    <div>
      <button onClick={() => terminals.open(plugin?.command ?? null, plugin?.title)}>run</button>
      <TerminalView
        target={T}
        context="prod-admin"
        ssoProfile="p"
        visible={visible}
        tabs={terminals.tabs}
        active={terminals.active}
        onSelect={terminals.select}
        onClose={terminals.close}
        onNew={() => terminals.open(null)}
      />
    </div>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetKeymap();
  emit = [];
  terms.length = 0;
  nextId = 0;
  k.shellClose.mockResolvedValue(null);
  k.shellInput.mockResolvedValue(null);
  k.shellResize.mockResolvedValue(null);
  open.mockImplementation(async (_t, _command, _cols, _rows, _p, onMessage) => {
    emit.push(onMessage);
    return { id: ++nextId, input: true };
  });
});

const tabNames = () => screen.getAllByRole("tab").map((t) => t.textContent);
const panes = () => Array.from(document.querySelectorAll(".k8s-shell-host")) as HTMLElement[];

test("the header shows the pinned context and an empty view offers a new terminal", async () => {
  render(<Screen />);
  expect(screen.getByLabelText(TERMINAL_PINNED)).toHaveTextContent("prod-admin");
  expect(screen.getByText(TERMINAL_EMPTY)).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole("button", { name: TERMINAL_NEW })[0]);
  await act(async () => {});
  expect(screen.queryByText(TERMINAL_EMPTY)).not.toBeInTheDocument();
  expect(tabNames()).toEqual([terminalTitle(1)]);
  // 이 탭의 대상으로, 로그인 셸(명령 없음)을, 화면 크기로 연다
  expect(open).toHaveBeenCalledWith(T, null, 100, 30, "p", expect.any(Function));
  expect(k.shellResize).toHaveBeenCalledWith(1, 100, 30);
});

test("several terminals live as tabs: switching only hides, closing one ends only its session and moves to a neighbour", async () => {
  render(<Screen />);
  const add = () => fireEvent.click(screen.getAllByRole("button", { name: TERMINAL_NEW })[0]);
  add();
  await act(async () => {});
  add();
  await act(async () => {});
  add();
  await act(async () => {});
  expect(tabNames()).toEqual([terminalTitle(1), terminalTitle(2), terminalTitle(3)]);
  expect(panes().map((p) => p.hidden)).toEqual([true, true, false]);
  act(() => emit[0]({ type: "output", data: "one\r\n" }));
  act(() => emit[2]({ type: "output", data: "three\r\n" }));
  expect(terms.map((t) => t.written)).toEqual([["one\r\n"], [], ["three\r\n"]]);
  // 키 입력은 보이는 터미널의 세션으로 간다
  terms[2].onDataCb("ls\r");
  expect(k.shellInput).toHaveBeenCalledWith(3, "ls\r");

  fireEvent.click(screen.getByRole("tab", { name: terminalTitle(1) }));
  expect(panes().map((p) => p.hidden)).toEqual([false, true, true]);
  expect(k.shellClose).not.toHaveBeenCalled();
  expect(terms.every((t) => !t.disposed)).toBe(true);

  // 보던 탭(1)을 닫으면 이웃(2)이 보이고, 세션 1만 끝난다. 번호는 다시 쓰지 않는다
  fireEvent.click(screen.getByRole("button", { name: terminalClose(terminalTitle(1)) }));
  expect(k.shellClose).toHaveBeenCalledTimes(1);
  expect(k.shellClose).toHaveBeenCalledWith(1);
  expect(tabNames()).toEqual([terminalTitle(2), terminalTitle(3)]);
  expect(screen.getByRole("tab", { name: terminalTitle(2) })).toHaveAttribute("aria-selected", "true");
  add();
  await act(async () => {});
  expect(tabNames()).toEqual([terminalTitle(2), terminalTitle(3), terminalTitle(4)]);
});

test("hiding the whole view keeps every session; leaving the tab closes them all", async () => {
  const { rerender, unmount } = render(<Screen />);
  fireEvent.click(screen.getAllByRole("button", { name: TERMINAL_NEW })[0]);
  await act(async () => {});
  rerender(<Screen visible={false} />);
  expect(document.querySelector(".k8s-term-view")).toHaveAttribute("hidden");
  expect(k.shellClose).not.toHaveBeenCalled();
  rerender(<Screen />);
  unmount();
  expect(k.shellClose).toHaveBeenCalledWith(1);
});

test("a plugin tab runs the confirmed command, shows it, and has no restart once it ends", async () => {
  render(<Screen plugin={{ command: "kubectl logs 'web-1'", title: "로그 보기" }} />);
  fireEvent.click(screen.getByRole("button", { name: "run" }));
  await act(async () => {});
  expect(open).toHaveBeenCalledWith(T, "kubectl logs 'web-1'", 100, 30, "p", expect.any(Function));
  expect(tabNames()).toEqual(["로그 보기"]);
  expect(screen.getByText("kubectl logs 'web-1'", { selector: ".k8s-term-command" })).toBeInTheDocument();
  act(() => emit[0]({ type: "exit", code: 1, reason: null }));
  expect(screen.getByText(shellExited(1, null))).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: TERMINAL_RESTART })).not.toBeInTheDocument();
  // 탭 닫기는 이 탭만 닫는다
  fireEvent.click(screen.getByRole("button", { name: TERMINAL_CLOSE_TAB }));
  expect(screen.queryAllByRole("tab")).toHaveLength(0);
  expect(open).toHaveBeenCalledTimes(1);
});

test("a login shell that ends can be reopened in the same tab", async () => {
  render(<Screen />);
  fireEvent.click(screen.getAllByRole("button", { name: TERMINAL_NEW })[0]);
  await act(async () => {});
  act(() => emit[0]({ type: "exit", code: 0, reason: null }));
  fireEvent.click(screen.getByRole("button", { name: TERMINAL_RESTART }));
  await act(async () => {});
  expect(open).toHaveBeenCalledTimes(2);
  expect(tabNames()).toEqual([terminalTitle(1)]);
  expect(k.shellClose).toHaveBeenCalledWith(1);
});

test("an open that fails shows the error in that tab only", async () => {
  open.mockRejectedValueOnce({ kind: "accessDenied", action: "create pods/exec" });
  render(<Screen />);
  fireEvent.click(screen.getAllByRole("button", { name: TERMINAL_NEW })[0]);
  await act(async () => {});
  expect(screen.getByText(/pods\/exec/)).toBeInTheDocument();
  expect(k.shellClose).not.toHaveBeenCalled();
});

test("⌘⎋ leaves the shown terminal back to the app tab, and a hidden terminal does not answer", async () => {
  render(
    <div>
      <div className="tabbar" role="tablist">
        <button role="tab" aria-selected className="tab-title">클러스터</button>
      </div>
      <Screen />
    </div>,
  );
  const add = () => fireEvent.click(screen.getAllByRole("button", { name: TERMINAL_NEW })[0]);
  add();
  await act(async () => {});
  add();
  await act(async () => {});
  const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", { cancelable: true, bubbles: true, ...init });
  expect(terms[1].keyHandler(key({ key: "Escape", metaKey: true }))).toBe(false);
  expect(terms[1].keyHandler(key({ key: "a" }))).toBe(true);
  terms[1].area!.focus();
  expect(dispatchKey(key({ key: "Escape", metaKey: true }))).toBe(true);
  expect(terms[1].blurred).toBe(true);
  expect(terms[0].blurred).toBe(false);
  const bar = screen.getAllByRole("tablist")[0];
  expect(within(bar).getByRole("tab", { name: "클러스터" })).toHaveFocus();
});
