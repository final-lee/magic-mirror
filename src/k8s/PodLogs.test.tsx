import { act, fireEvent, render, screen } from "@testing-library/react";
import * as invokeModule from "../api/invoke";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../test/utils";
import { k8sApi } from "./api";
import { PodLogs, matchRanges, searchPattern } from "./PodLogs";
import { LOG_CONTAINER, LOG_EMPTY, LOG_ENDED, LOG_PAUSE, LOG_PREVIOUS, LOG_RESUME, LOG_SEARCH, logMatches, logPending } from "./text";
import type { K8sContainer, K8sLogMessage, K8sLogOptions } from "./types";

vi.mock("./api", () => ({ k8sApi: { logs: vi.fn(), unwatch: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
const m = vi.mocked(k8sApi);
const T = { profile: "app", region: "r", cluster: "c" };

const c = (name: string, init = false): K8sContainer => ({ name, image: "x", init, state: "running", ready: true, restarts: 0, reason: null, message: null, lastTermination: null });
let emit: ((msg: K8sLogMessage) => void)[] = [];
let nextId = 0;

beforeEach(() => {
  vi.clearAllMocks();
  emit = [];
  nextId = 0;
  m.unwatch.mockResolvedValue(null);
  m.logs.mockImplementation(async (_t, _ns, _pod, _opts, _p, onMessage) => {
    emit.push(onMessage);
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
