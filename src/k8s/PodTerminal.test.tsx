import { act, fireEvent, render, screen } from "@testing-library/react";
import { k8sApi } from "./api";
import { PodTerminal } from "./PodTerminal";
import { ATTACH_OUTPUT_ONLY, SHELL_REOPEN, shellExited } from "./text";
import type { K8sShellMessage } from "./types";

// jsdom에서는 xterm이 그려지지 않으니 받은 것만 기록하는 가짜 터미널로 바꾼다(vi.mock보다 먼저 만들어야 해서 hoisted)
const { terms, FakeTerm } = vi.hoisted(() => {
  const terms: { written: string[]; disposed: boolean; onDataCb: (d: string) => void; cols: number; rows: number }[] = [];
  class FakeTerm {
    cols = 100;
    rows = 30;
    written: string[] = [];
    disposed = false;
    onDataCb: (d: string) => void = () => {};
    constructor() {
      terms.push(this);
    }
    loadAddon() {}
    open() {}
    focus() {}
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
vi.mock("./api", () => ({ k8sApi: { shellOpen: vi.fn(), attachOpen: vi.fn(), nodeShellOpen: vi.fn(), shellInput: vi.fn(), shellResize: vi.fn(), shellClose: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
const m = vi.mocked(k8sApi);
const T = { profile: "app", region: "r", cluster: "c" };

let emit: ((msg: K8sShellMessage) => void)[] = [];

function setup(over: Partial<Parameters<typeof PodTerminal>[0]> = {}) {
  return render(<PodTerminal target={T} ssoProfile="p" namespace="dev" pod="web-1" container="app" mode="exec" confirmText={null} visible {...over} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  emit = [];
  terms.length = 0;
  m.shellClose.mockResolvedValue(null);
  m.shellInput.mockResolvedValue(null);
  m.shellResize.mockResolvedValue(null);
  const opener = async (_t: unknown, _ns: string, _pod: string, _c: string, _confirm: string | null, _p: string, onMessage: (msg: K8sShellMessage) => void) => {
    emit.push(onMessage);
    return { id: 7, input: true };
  };
  m.shellOpen.mockImplementation(opener);
  m.attachOpen.mockImplementation(opener);
  m.nodeShellOpen.mockImplementation(async (_t, _ns, _pod, _p, onMessage) => {
    emit.push(onMessage);
    return { id: 11, input: true };
  });
});

test("opens the shell for the container, draws output, sends keystrokes and the size, and closes on unmount", async () => {
  const { unmount } = setup({ confirmText: "web-1" });
  await act(async () => {});
  expect(m.shellOpen).toHaveBeenCalledWith(T, "dev", "web-1", "app", "web-1", "p", expect.any(Function));
  expect(m.shellResize).toHaveBeenCalledWith(7, 100, 30);
  act(() => emit[0]({ type: "output", data: "hello\r\n" }));
  expect(terms[0].written).toEqual(["hello\r\n"]);
  terms[0].onDataCb("ls\r");
  expect(m.shellInput).toHaveBeenCalledWith(7, "ls\r");
  unmount();
  expect(terms[0].disposed).toBe(true);
  expect(m.shellClose).toHaveBeenCalledWith(7);
});

test("attach uses the attach command", async () => {
  setup({ mode: "attach" });
  await act(async () => {});
  expect(m.attachOpen).toHaveBeenCalled();
  expect(m.shellOpen).not.toHaveBeenCalled();
});

test("attach to a container without stdin/tty sends no keystrokes and says so", async () => {
  m.attachOpen.mockImplementation(async (_t, _ns, _pod, _c, _confirm, _p, onMessage) => {
    emit.push(onMessage);
    return { id: 9, input: false };
  });
  setup({ mode: "attach" });
  await act(async () => {});
  expect(screen.getByText(ATTACH_OUTPUT_ONLY)).toBeInTheDocument();
  terms[0].onDataCb("x");
  expect(m.shellInput).not.toHaveBeenCalled();
});

test("when the process exits, the exit code shows with a reopen that starts a new session", async () => {
  setup();
  await act(async () => {});
  act(() => emit[0]({ type: "exit", code: 130, reason: null }));
  expect(screen.getByText(shellExited(130, null))).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: SHELL_REOPEN }));
  await act(async () => {});
  expect(m.shellOpen).toHaveBeenCalledTimes(2);
  expect(terms[0].disposed).toBe(true);
  expect(m.shellClose).toHaveBeenCalledWith(7);
});

test("an open that finishes after the component is gone is closed right away", async () => {
  let resolve: (v: { id: number; input: boolean }) => void = () => {};
  m.shellOpen.mockImplementation(() => new Promise((r) => (resolve = r)));
  const { unmount } = setup();
  unmount();
  await act(async () => resolve({ id: 3, input: true }));
  expect(m.shellClose).toHaveBeenCalledWith(3);
  expect(m.shellInput).not.toHaveBeenCalled();
});

test("a refused open (no permission) shows the error and no session closes", async () => {
  m.shellOpen.mockRejectedValue({ kind: "accessDenied", action: "create pods/exec" });
  setup();
  await act(async () => {});
  expect(screen.getByText(/pods\/exec/)).toBeInTheDocument();
  expect(m.shellClose).not.toHaveBeenCalled();
});

test("a node shell opens on the debug pod with no container or confirmation, and cannot be reopened once it ends", async () => {
  setup({ mode: "node", pod: "mm-node-shell-x", container: "", confirmText: null });
  await act(async () => {});
  expect(m.nodeShellOpen).toHaveBeenCalledWith(T, "dev", "mm-node-shell-x", "p", expect.any(Function));
  expect(m.shellOpen).not.toHaveBeenCalled();
  terms[0].onDataCb("hostname\r");
  expect(m.shellInput).toHaveBeenCalledWith(11, "hostname\r");
  act(() => emit[0]({ type: "exit", code: 0, reason: null }));
  expect(screen.getByText(shellExited(0, null))).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: SHELL_REOPEN })).not.toBeInTheDocument();
});
