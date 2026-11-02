import { act, fireEvent, render, screen } from "@testing-library/react";
import * as invokeModule from "../api/invoke";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../test/utils";
import { k8sApi } from "./api";
import { PodLogs, matchRanges, searchPattern } from "./PodLogs";
import { LNAV_EXITED, LNAV_MISSING, LOG_CONTAINER, LOG_EMPTY, LOG_ENDED, LOG_PAUSE, LOG_PREVIOUS, LOG_RESTART, LOG_RESUME, LOG_SEARCH, LOG_VIEW_LNAV, LOG_VIEW_TEXT, logMatches, logPending } from "./text";
import type { K8sContainer, K8sLnavMessage, K8sLogMessage, K8sLogOptions } from "./types";

// jsdom에서는 xterm이 그려지지 않으니 받은 것만 기록하는 가짜 터미널로 바꾼다(vi.mock보다 먼저 만들어야 해서 hoisted)
const { terms, FakeTerm } = vi.hoisted(() => {
  const terms: { written: string[]; disposed: boolean; onDataCb: (d: string) => void }[] = [];
  class FakeTerm {
    cols = 120;
    rows = 40;
    written: string[] = [];
    disposed = false;
    onDataCb: (d: string) => void = () => {};
    constructor() {
      terms.push(this);
    }
    loadAddon() {}
    open() {}
    focus() {}
    write(d: Uint8Array) {
      this.written.push(new TextDecoder().decode(d));
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
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("./api", () => ({ k8sApi: { logs: vi.fn(), unwatch: vi.fn(), lnavAvailable: vi.fn(), lnav: vi.fn(), lnavInput: vi.fn(), lnavResize: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
const m = vi.mocked(k8sApi);
const T = { profile: "app", region: "r", cluster: "c" };

const c = (name: string, init = false): K8sContainer => ({ name, image: "x", init, state: "running", ready: true, restarts: 0, reason: null, message: null, lastTermination: null });
let emit: ((msg: K8sLogMessage) => void)[] = [];
let lnavEmit: ((msg: K8sLnavMessage) => void)[] = [];
let nextId = 0;

beforeEach(() => {
  vi.clearAllMocks();
  emit = [];
  lnavEmit = [];
  terms.length = 0;
  nextId = 0;
  m.unwatch.mockResolvedValue(null);
  // 아래 텍스트 보기 시험은 lnav가 없는 환경에서 돈다(lnav 시험이 따로 켠다)
  m.lnavAvailable.mockResolvedValue(false);
  m.logs.mockImplementation(async (_t, _ns, _pod, _opts, _p, onMessage) => {
    emit.push(onMessage);
    return ++nextId;
  });
  m.lnav.mockImplementation(async (_t, _ns, _pod, _opts, _cols, _rows, _p, onMessage) => {
    lnavEmit.push(onMessage);
    return ++nextId;
  });
});

function setup(containers = [c("init-db", true), c("app"), c("sidecar")]) {
  return render(withClientAndSso(<PodLogs target={T} ssoProfile="p" live namespace="prod" pod="web-1" containers={containers} />, newQueryClient(), ssoLoginStub()));
}
const send = (i: number, msg: K8sLogMessage) => act(() => emit[i](msg));
const logText = () => (screen.getByLabelText("web-1") as HTMLElement).textContent;
const lastOptions = (): K8sLogOptions => m.logs.mock.lastCall![3];

test("opens the first app container, following the last 500 lines, and shows the lines", async () => {
  setup();
  await vi.waitFor(() => expect(m.logs).toHaveBeenCalledWith(T, "prod", "web-1", { container: "app", follow: true, tailLines: 500, previous: false }, "p", expect.any(Function)));
  send(0, { type: "lines", lines: ["one", "two"] });
  send(0, { type: "lines", lines: ["three"] });
  expect(logText()).toBe("one\ntwo\nthree\n");
  send(0, { type: "end" });
  expect(screen.getByText(LOG_ENDED)).toBeInTheDocument();
});

test("an empty finished log says so", async () => {
  setup();
  await vi.waitFor(() => expect(emit).toHaveLength(1));
  send(0, { type: "end" });
  expect(screen.getByText(LOG_EMPTY)).toBeInTheDocument();
});

test("changing the container or previous reopens; the old stream is stopped and its late lines are ignored", async () => {
  setup();
  await vi.waitFor(() => expect(emit).toHaveLength(1));
  send(0, { type: "lines", lines: ["from app"] });
  fireEvent.change(screen.getByLabelText(LOG_CONTAINER), { target: { value: "sidecar" } });
  await vi.waitFor(() => expect(emit).toHaveLength(2));
  expect(m.unwatch).toHaveBeenCalledWith(1);
  expect(lastOptions()).toMatchObject({ container: "sidecar", previous: false });
  expect(logText()).toBe("");
  send(0, { type: "lines", lines: ["late"] });
  send(1, { type: "lines", lines: ["from sidecar"] });
  expect(logText()).toBe("from sidecar\n");
  fireEvent.click(screen.getByLabelText(LOG_PREVIOUS));
  await vi.waitFor(() => expect(emit).toHaveLength(3));
  expect(m.unwatch).toHaveBeenCalledWith(2);
  expect(lastOptions()).toMatchObject({ container: "sidecar", previous: true });
});

test("a single container has no picker", async () => {
  setup([c("only")]);
  await vi.waitFor(() => expect(lastOptions()).toMatchObject({ container: "only" }));
  expect(screen.queryByLabelText(LOG_CONTAINER)).toBeNull();
});

test("leaving stops the stream, also when its id arrives after leaving", async () => {
  let release: (id: number) => void = () => {};
  m.logs.mockImplementationOnce(() => new Promise<number>((r) => (release = r)));
  const r = setup();
  await vi.waitFor(() => expect(m.logs).toHaveBeenCalled());
  r.unmount();
  expect(m.unwatch).not.toHaveBeenCalled();
  await act(async () => release(7));
  expect(m.unwatch).toHaveBeenCalledWith(7);
});

test("search marks the matches and counts the matching lines", async () => {
  setup();
  await vi.waitFor(() => expect(emit).toHaveLength(1));
  send(0, { type: "lines", lines: ["GET /a 200", "POST /b 500", "get /c 200"] });
  fireEvent.change(screen.getByLabelText(LOG_SEARCH), { target: { value: "get" } });
  expect(screen.getByText(logMatches(2))).toBeInTheDocument();
  expect(Array.from(document.querySelectorAll(".k8s-log mark")).map((e) => e.textContent)).toEqual(["GET", "get"]);
  expect(logText()).toBe("GET /a 200\nPOST /b 500\nget /c 200\n");
});

test("highlights stay on the matched text when case folding changes the length (İ)", () => {
  expect(matchRanges("İabc", searchPattern("a")!)).toEqual([[1, 2]]);
  expect(matchRanges("a.b a.b", searchPattern("A.B")!)).toEqual([[0, 3], [4, 7]]);
  expect(matchRanges("axb", searchPattern("a.b")!)).toEqual([]);
});

test("the match count follows new lines while following", async () => {
  setup();
  await vi.waitFor(() => expect(emit).toHaveLength(1));
  fireEvent.change(screen.getByLabelText(LOG_SEARCH), { target: { value: "err" } });
  send(0, { type: "lines", lines: Array.from({ length: 1500 }, (_, i) => (i % 500 === 0 ? `ERR ${i}` : `ok ${i}`)) });
  expect(screen.getByText(logMatches(3))).toBeInTheDocument();
  send(0, { type: "lines", lines: ["err again"] });
  expect(screen.getByText(logMatches(4))).toBeInTheDocument();
});

test("pause holds the view and counts what is waiting; resume shows it", async () => {
  setup();
  await vi.waitFor(() => expect(emit).toHaveLength(1));
  send(0, { type: "lines", lines: ["a"] });
  fireEvent.click(screen.getByRole("button", { name: LOG_PAUSE }));
  send(0, { type: "lines", lines: ["b", "c"] });
  expect(logText()).toBe("a\n");
  expect(screen.getByText(logPending(2))).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: LOG_RESUME }));
  expect(logText()).toBe("a\nb\nc\n");
});

test("an expired SSO session in the stream is reported for the exec profile", async () => {
  const report = vi.spyOn(invokeModule, "reportSsoExpired");
  setup();
  await vi.waitFor(() => expect(emit).toHaveLength(1));
  send(0, { type: "error", error: { kind: "ssoExpired", profile: "p" } as never });
  expect(report).toHaveBeenCalledWith("p", expect.any(Number));
});

test("a broken stream shows the error and retry reopens it", async () => {
  setup();
  await vi.waitFor(() => expect(emit).toHaveLength(1));
  send(0, { type: "error", error: { kind: "other", message: "끊겼어요" } });
  expect(screen.getByText("끊겼어요")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  await vi.waitFor(() => expect(emit).toHaveLength(2));
  expect(screen.queryByText("끊겼어요")).toBeNull();
});

describe("lnav view", () => {
  const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  const lnavSend = (i: number, msg: K8sLnavMessage) => act(() => lnavEmit[i](msg));

  test("is the default when lnav is installed: opens at the terminal's size, draws its output and passes keys", async () => {
    m.lnavAvailable.mockResolvedValue(true);
    setup();
    await vi.waitFor(() => expect(m.lnav).toHaveBeenCalledTimes(1));
    expect(m.lnav).toHaveBeenCalledWith(T, "prod", "web-1", { container: "app", follow: true, tailLines: 500, previous: false }, 120, 40, "p", expect.any(Function));
    expect(m.logs).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: LOG_VIEW_LNAV })).toHaveAttribute("aria-pressed", "true");
    lnavSend(0, { type: "output", data: b64("로그 화면") });
    expect(terms[0].written).toEqual(["로그 화면"]);
    await act(async () => {});
    terms[0].onDataCb("q");
    expect(m.lnavInput).toHaveBeenCalledWith(1, "q");
  });

  test("closing lnav offers to reopen it; changing an option or leaving stops it", async () => {
    m.lnavAvailable.mockResolvedValue(true);
    const r = setup();
    await vi.waitFor(() => expect(m.lnav).toHaveBeenCalledTimes(1));
    lnavSend(0, { type: "exit" });
    expect(screen.getByText(LNAV_EXITED)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: LOG_RESTART }));
    await vi.waitFor(() => expect(m.lnav).toHaveBeenCalledTimes(2));
    expect(m.unwatch).toHaveBeenCalledWith(1);
    expect(terms[0].disposed).toBe(true);
    fireEvent.click(screen.getByLabelText(LOG_PREVIOUS));
    await vi.waitFor(() => expect(m.lnav).toHaveBeenCalledTimes(3));
    expect(m.unwatch).toHaveBeenCalledWith(2);
    expect(m.lnav.mock.lastCall![3]).toMatchObject({ previous: true });
    r.unmount();
    expect(m.unwatch).toHaveBeenCalledWith(3);
  });

  test("switching to text stops lnav and streams plain lines", async () => {
    m.lnavAvailable.mockResolvedValue(true);
    setup();
    await vi.waitFor(() => expect(m.lnav).toHaveBeenCalledTimes(1));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: LOG_VIEW_TEXT }));
    await vi.waitFor(() => expect(m.logs).toHaveBeenCalledTimes(1));
    expect(m.unwatch).toHaveBeenCalledWith(1);
    send(0, { type: "lines", lines: ["plain"] });
    expect(logText()).toBe("plain\n");
  });

  test("without lnav the text view opens, says how to install lnav, and the lnav button is off", async () => {
    setup();
    await vi.waitFor(() => expect(m.logs).toHaveBeenCalledTimes(1));
    expect(screen.getByText(LNAV_MISSING)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: LOG_VIEW_LNAV })).toBeDisabled();
    expect(screen.getByRole("button", { name: LOG_VIEW_TEXT })).toHaveAttribute("aria-pressed", "true");
    expect(m.lnav).not.toHaveBeenCalled();
  });
});
