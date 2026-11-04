import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useRef } from "react";
import { useListFind } from "../components/ListFind";
import * as invokeModule from "../api/invoke";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../test/utils";
import { k8sApi } from "./api";
import { matchRanges, searchPattern } from "./logSearch";
import { PodLogs } from "./PodLogs";
import { findFor, findInput, findInputs, pressFind } from "./testFind";
import {
  LOG_CONTAINER, LOG_EMPTY, LOG_ENDED, LOG_FIELDS_HIDE, LOG_FIELDS_SHOW, LOG_LEVEL_NONE, LOG_PAUSE, LOG_PREVIOUS, LOG_RESUME, LOG_SEARCH, LOG_VIEW_PRETTY,
  LOG_VIEW_RAW, logMatches, logPending,
} from "./text";
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
const chunk = (lines: string[], pod = "web-1", container = "app", ts: string | null = null): K8sLogMessage => ({ type: "lines", pod, container, lines: lines.map((text) => ({ ts, text })) });
const logText = () => (screen.getByLabelText("web-1") as HTMLElement).textContent;
const lastOptions = (): K8sLogOptions => m.logs.mock.lastCall![3];

test("opens the first app container, following the last 500 lines, and shows the lines", async () => {
  setup();
  await vi.waitFor(() => expect(m.logs).toHaveBeenCalledWith(T, "prod", "web-1", { container: "app", follow: true, tailLines: 500, previous: false, sinceSeconds: null }, "p", expect.any(Function)));
  send(0, chunk(["one", "two"]));
  send(0, chunk(["three"]));
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
  send(0, chunk(["from app"]));
  fireEvent.change(screen.getByLabelText(LOG_CONTAINER), { target: { value: "sidecar" } });
  await vi.waitFor(() => expect(emit).toHaveLength(2));
  expect(m.unwatch).toHaveBeenCalledWith(1);
  expect(lastOptions()).toMatchObject({ container: "sidecar", previous: false });
  expect(logText()).toBe("");
  send(0, chunk(["late"]));
  send(1, chunk(["from sidecar"]));
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

test("there is no search box until ⌘F opens the find line inside the log; Esc clears the marks and closes it", async () => {
  setup();
  await vi.waitFor(() => expect(emit).toHaveLength(1));
  send(0, chunk(["GET /a 200", "POST /b 500"]));
  expect(findInputs()).toHaveLength(0);
  expect(screen.queryByLabelText(LOG_SEARCH)).toBeNull();
  screen.getByRole("checkbox", { name: LOG_PREVIOUS }).focus();
  expect(pressFind()).toBe(true);
  expect(findInput()).toHaveFocus();
  expect(findInput()).toHaveAttribute("placeholder", LOG_SEARCH);
  fireEvent.change(findInput(), { target: { value: "post" } });
  expect(Array.from(document.querySelectorAll(".k8s-log mark")).map((e) => e.textContent)).toEqual(["POST"]);
  fireEvent.keyDown(findInput(), { key: "Escape" });
  expect(findInputs()).toHaveLength(0);
  expect(document.querySelectorAll(".k8s-log mark")).toHaveLength(0);
});

function InsideList() {
  const outer = useRef<HTMLDivElement>(null);
  const find = useListFind(outer);
  return (
    <div ref={outer}>
      <span data-testid="outer-find">{find.open ? "open" : "closed"}</span>
      <PodLogs target={T} ssoProfile="p" live namespace="prod" pod="web-1" containers={[c("app")]} />
    </div>
  );
}

test("⌘F with the cursor in a log opens the log's find line, not the find line of the list the detail covers", async () => {
  render(withClientAndSso(<InsideList />, newQueryClient(), ssoLoginStub()));
  await vi.waitFor(() => expect(emit).toHaveLength(1));
  screen.getByRole("checkbox", { name: LOG_PREVIOUS }).focus();
  pressFind();
  expect(findInputs()).toHaveLength(1);
  expect(screen.getByTestId("outer-find")).toHaveTextContent("closed");
});

test("search marks the matches and counts the matching lines", async () => {
  setup();
  await vi.waitFor(() => expect(emit).toHaveLength(1));
  send(0, chunk(["GET /a 200", "POST /b 500", "get /c 200"]));
  findFor("get");
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
  findFor("err");
  send(0, chunk(Array.from({ length: 1500 }, (_, i) => (i % 500 === 0 ? `ERR ${i}` : `ok ${i}`))));
  expect(screen.getByText(logMatches(3))).toBeInTheDocument();
  send(0, chunk(["err again"]));
  expect(screen.getByText(logMatches(4))).toBeInTheDocument();
});

test("pause holds the view and counts what is waiting; resume shows it", async () => {
  setup();
  await vi.waitFor(() => expect(emit).toHaveLength(1));
  send(0, chunk(["a"]));
  fireEvent.click(screen.getByRole("button", { name: LOG_PAUSE }));
  send(0, chunk(["b", "c"]));
  expect(logText()).toBe("a\n");
  expect(screen.getByText(logPending(2))).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: LOG_RESUME }));
  expect(logText()).toBe("a\nb\nc\n");
});

test("an expired SSO session in the stream is reported for the exec profile", async () => {
  const report = vi.spyOn(invokeModule, "reportSsoExpired");
  setup();
  await vi.waitFor(() => expect(emit).toHaveLength(1));
  send(0, { type: "error", error: { kind: "ssoExpired", profile: "p" } as never, pod: null, container: null });
  expect(report).toHaveBeenCalledWith("p", expect.any(Number));
});

test("a broken stream shows the error and retry reopens it", async () => {
  setup();
  await vi.waitFor(() => expect(emit).toHaveLength(1));
  send(0, { type: "error", error: { kind: "other", message: "끊겼어요" }, pod: null, container: null });
  expect(screen.getByText("끊겼어요")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  await vi.waitFor(() => expect(emit).toHaveLength(2));
  expect(screen.queryByText("끊겼어요")).toBeNull();
});

describe("JSON view", () => {
  const ok = JSON.stringify({ "log.level": "info", timestamp: "2026-11-02T06:40:58.776Z", service: "azit", "request.id": "r-1", "http.status_code": 200, message: "GET /health/readiness 200" });
  const failed = JSON.stringify({ "log.level": "warn", timestamp: "2026-11-02T06:41:00.000Z", "request.id": "r-9", "error.message": "no such azit", message: "PUT /v1/communities/x 404" });
  const rows = () => Array.from(document.querySelectorAll<HTMLElement>(".lj-row"));

  test("is the default: time, level and message on one line, error fields beside, ▸ opens every field, raw shows lines as received", async () => {
    setup();
    await vi.waitFor(() => expect(emit).toHaveLength(1));
    expect(screen.getByRole("button", { name: LOG_VIEW_PRETTY })).toHaveAttribute("aria-pressed", "true");
    send(0, chunk([ok, "plain text", failed]));
    const [first, second] = rows();
    expect(first).toHaveClass("lj-info");
    expect(within(first).getByText("GET /health/readiness 200")).toBeInTheDocument();
    expect(first.querySelector(".lj-time")).toHaveAttribute("title", "2026-11-02T06:40:58.776Z");
    expect(first.querySelector(".lj-time")!.textContent).toMatch(/^\d\d-\d\d \d\d:\d\d:\d\d\.776$/);
    // 나머지 필드는 접어 둔다
    expect(first.textContent).not.toContain("r-1");
    expect(logText()).toContain("plain text\n");
    expect(second).toHaveClass("lj-warn");
    expect(second.textContent).toContain('error.message="no such azit"');
    fireEvent.click(within(first).getByRole("button", { name: LOG_FIELDS_SHOW }));
    expect(within(first).getByRole("button", { name: LOG_FIELDS_HIDE })).toHaveAttribute("aria-expanded", "true");
    expect(within(first).getByText("request.id")).toBeInTheDocument();
    expect(within(first).getByText("r-1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: LOG_VIEW_RAW }));
    expect(logText()).toBe(`${ok}\nplain text\n${failed}\n`);
  });

  test("search finds a folded field: the line counts and the field shows beside the message, marked", async () => {
    setup();
    await vi.waitFor(() => expect(emit).toHaveLength(1));
    send(0, chunk([ok, failed]));
    findFor("r-9");
    expect(screen.getByText(logMatches(1))).toBeInTheDocument();
    expect(rows()[1].textContent).toContain("request.id=r-9");
    expect(Array.from(document.querySelectorAll(".k8s-log mark")).map((e) => e.textContent)).toEqual(["r-9"]);
    expect(rows()[0].textContent).not.toContain("request.id");
  });

  test("level filter: several levels at once, counts per level, plain lines by their leading level word, search counts only what is shown", async () => {
    setup();
    await vi.waitFor(() => expect(emit).toHaveLength(1));
    const debug = JSON.stringify({ level: "debug", msg: "cache hit" });
    send(0, chunk([ok, failed, debug, "[WARNING] plugin/health: slow", "GET /plain 200"]));
    const chip = (name: RegExp) => screen.getByRole("button", { name });
    expect(chip(/^경고 2$/)).toHaveAttribute("aria-pressed", "false");
    expect(chip(/^기타 1$/)).toBeInTheDocument();
    fireEvent.click(chip(/^경고/));
    fireEvent.click(chip(/^디버그/));
    expect(chip(/^경고/)).toHaveAttribute("aria-pressed", "true");
    expect(logText()).toContain("[WARNING] plugin/health: slow\n");
    expect(logText()).toContain("cache hit");
    expect(logText()).not.toContain("GET /health/readiness 200");
    expect(logText()).not.toContain("GET /plain 200");
    findFor("GET");
    expect(screen.getByText(logMatches(0))).toBeInTheDocument();
    // 다 끄면 모든 줄
    fireEvent.click(chip(/^경고/));
    fireEvent.click(chip(/^디버그/));
    expect(screen.getByText(logMatches(2))).toBeInTheDocument();
  });

  test("a filter that hides every line says so", async () => {
    setup();
    await vi.waitFor(() => expect(emit).toHaveLength(1));
    send(0, chunk([ok]));
    fireEvent.click(screen.getByRole("button", { name: /^오류/ }));
    expect(screen.getByText(LOG_LEVEL_NONE)).toBeInTheDocument();
    expect(logText()).toBe("");
  });
});
