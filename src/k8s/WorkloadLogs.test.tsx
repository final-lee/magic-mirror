import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { desktop } from "../api/desktop";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../test/utils";
import { k8sApi } from "./api";
import { DEPLOYMENTS } from "./kinds";
import { PodLogs, WorkloadLogs } from "./PodLogs";
import {
  LOG_ALL_CONTAINERS, LOG_CONTAINER, LOG_REVEAL, LOG_SAVE, LOG_SINCE, LOG_SOURCES, LOG_TIME, LOG_WRAP, logSaved, logSaveFailed, logSourceError,
} from "./text";
import type { K8sContainer, K8sLogMessage, K8sLogOptions } from "./types";

vi.mock("./api", () => ({ k8sApi: { logs: vi.fn(), workloadLogs: vi.fn(), logsSave: vi.fn(), unwatch: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
const m = vi.mocked(k8sApi);
const T = { profile: "app", region: "r", cluster: "c" };

const c = (name: string, init = false): K8sContainer => ({ name, image: "x", init, state: "running", ready: true, restarts: 0, reason: null, message: null, lastTermination: null });
const A = "web-7d9f8c6b5-abcde";
const B = "web-7d9f8c6b5-fghij";
let emit: ((msg: K8sLogMessage) => void)[] = [];
let nextId = 0;

beforeEach(() => {
  vi.clearAllMocks();
  emit = [];
  nextId = 0;
  m.unwatch.mockResolvedValue(null);
  const open = async (...args: unknown[]) => {
    emit.push(args[args.length - 1] as (msg: K8sLogMessage) => void);
    return ++nextId;
  };
  m.logs.mockImplementation(open as never);
  m.workloadLogs.mockImplementation(open as never);
});

const wrap = (ui: React.ReactElement) => withClientAndSso(ui, newQueryClient(), ssoLoginStub());
function workload(containers: K8sContainer[] = []) {
  return render(wrap(<WorkloadLogs target={T} ssoProfile="p" live kind={DEPLOYMENTS} namespace="prod" name="web" containers={containers} />));
}
const send = (i: number, msg: K8sLogMessage) => act(() => emit[i](msg));
const lines = (pod: string, container: string, texts: string[], ts: string | null = null): K8sLogMessage => ({ type: "lines", pod, container, lines: texts.map((text) => ({ ts, text })) });
const source = (pod: string, container: string, state: "attached" | "ended"): K8sLogMessage => ({ type: "source", pod, container, state });
const logBox = () => screen.getByLabelText("web") as HTMLElement;
const logText = () => logBox().textContent;
const lastOptions = (): K8sLogOptions => m.workloadLogs.mock.lastCall![4];
const chip = (name: RegExp) => within(screen.getByRole("group", { name: LOG_SOURCES })).getByRole("button", { name });
const prefixes = () => Array.from(logBox().querySelectorAll<HTMLElement>(".k8s-log-src"));

/** 두 Pod가 붙은 워크로드 로그 */
async function twoPods() {
  workload();
  await vi.waitFor(() => expect(emit).toHaveLength(1));
  send(0, source(A, "app", "attached"));
  send(0, source(B, "app", "attached"));
  send(0, lines(A, "app", ["a one", "a two"]));
  send(0, lines(B, "app", ["b one"]));
}

test("opens the workload's logs for every container, following the last 500 lines", async () => {
  workload();
  await vi.waitFor(() => expect(m.workloadLogs).toHaveBeenCalledWith(T, DEPLOYMENTS, "prod", "web", { container: null, follow: true, tailLines: 500, previous: false, sinceSeconds: null }, "p", expect.any(Function)));
  expect(m.logs).not.toHaveBeenCalled();
});

test("one source shows plain lines: no prefix, no chips", async () => {
  workload();
  await vi.waitFor(() => expect(emit).toHaveLength(1));
  send(0, source(A, "app", "attached"));
  send(0, lines(A, "app", ["only"]));
  expect(logText()).toBe("only\n");
  expect(screen.queryByRole("group", { name: LOG_SOURCES })).toBeNull();
});

describe("several sources", () => {
  test("each line starts with its short pod name, colored per pod from the palette; the same pod keeps one color", async () => {
    await twoPods();
    expect(logText()).toBe("abcde a one\nabcde a two\nfghij b one\n");
    const [a1, a2, b1] = prefixes();
    expect(a1.textContent).toBe("abcde ");
    expect(a1.title).toBe(`${A}/app`);
    expect(a1.className).toMatch(/\blc[1-8]\b/);
    expect(a2.className).toBe(a1.className);
    // 이름이 다르면 해시가 달라 색이 달라질 수 있다: 같은 이름은 늘 같은 색이다
    send(0, lines(B, "app", ["b two"]));
    expect(prefixes()[3].className).toBe(b1.className);
  });

  test("a pod with several containers adds the container name; chips count the lines per source", async () => {
    workload();
    await vi.waitFor(() => expect(emit).toHaveLength(1));
    send(0, lines(A, "app", ["x"]));
    send(0, lines(A, "sidecar", ["y", "z"]));
    // Pod가 하나면 컨테이너 이름만 붙는다
    expect(logText()).toBe("app x\nsidecar y\nsidecar z\n");
    send(0, lines(B, "app", ["w"]));
    expect(logText()).toContain("abcde/app x\n");
    expect(logText()).toContain("fghij/app w\n");
    expect(chip(/^abcde\/app 1$/)).toBeInTheDocument();
    expect(chip(/^abcde\/sidecar 2$/)).toBeInTheDocument();
  });

  test("chips show and hide each source's lines and say how many lines each has", async () => {
    await twoPods();
    expect(chip(/^abcde 2$/)).toHaveAttribute("aria-pressed", "true");
    expect(chip(/^fghij 1$/)).toBeInTheDocument();
    fireEvent.click(chip(/^abcde/));
    expect(chip(/^abcde/)).toHaveAttribute("aria-pressed", "false");
    expect(logText()).toBe("fghij b one\n");
    // 감춘 출처의 새 줄은 세지만 보이지 않는다
    send(0, lines(A, "app", ["a three"]));
    expect(chip(/^abcde 3$/)).toBeInTheDocument();
    expect(logText()).toBe("fghij b one\n");
    fireEvent.click(chip(/^abcde/));
    expect(logText()).toContain("abcde a three\n");
  });

  test("a pod that attaches later joins: its chip and lines appear, and the first pod's lines get a prefix", async () => {
    workload();
    await vi.waitFor(() => expect(emit).toHaveLength(1));
    send(0, lines(A, "app", ["early"]));
    expect(logText()).toBe("early\n");
    send(0, source(B, "app", "attached"));
    send(0, lines(B, "app", ["late"]));
    expect(logText()).toBe("abcde early\nfghij late\n");
    expect(chip(/^fghij 1$/)).toBeInTheDocument();
  });

  test("an ended source is dimmed and keeps its lines; attaching again undoes it", async () => {
    await twoPods();
    send(0, source(A, "app", "ended"));
    expect(chip(/^abcde/)).toHaveClass("ended");
    expect(chip(/^abcde/)).toHaveAttribute("title", `${A}/app (끝났어요)`);
    expect(logText()).toContain("abcde a one\n");
    expect(chip(/^fghij/)).not.toHaveClass("ended");
    send(0, source(A, "app", "attached"));
    expect(chip(/^abcde/)).not.toHaveClass("ended");
  });

  test("an error on one source is shown inline and the other sources keep streaming", async () => {
    await twoPods();
    send(0, { type: "error", error: { kind: "other", message: "컨테이너가 아직 시작하지 않았어요" }, pod: A, container: "app" });
    expect(screen.getByText(logSourceError(`${A}/app`, "컨테이너가 아직 시작하지 않았어요"))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull();
    send(0, lines(B, "app", ["b still here"]));
    expect(logText()).toContain("fghij b still here\n");
    expect(chip(/^abcde/)).toHaveClass("ended");
    // 끊긴 흐름이 다시 붙으면 오류를 지운다
    send(0, source(A, "app", "attached"));
    expect(screen.queryByText(logSourceError(`${A}/app`, "컨테이너가 아직 시작하지 않았어요"))).toBeNull();
  });

  test("an error without a pod ends the whole stream and offers retry; a notice is shown as a hint", async () => {
    await twoPods();
    send(0, { type: "notice", message: "Pod가 너무 많아 일부만 붙였어요" });
    expect(screen.getByText("Pod가 너무 많아 일부만 붙였어요")).toBeInTheDocument();
    send(0, { type: "error", error: { kind: "other", message: "끊겼어요" }, pod: null, container: null });
    expect(screen.getByText("끊겼어요")).toBeInTheDocument();
    expect(logText()).toContain("abcde a one\n");
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await vi.waitFor(() => expect(emit).toHaveLength(2));
    expect(screen.queryByText("끊겼어요")).toBeNull();
    expect(logText()).toBe("");
  });

  test("json lines keep the prefix on the same row", async () => {
    workload();
    await vi.waitFor(() => expect(emit).toHaveLength(1));
    const json = JSON.stringify({ level: "info", msg: "hello" });
    send(0, lines(A, "app", [json]));
    send(0, lines(B, "app", ["plain"]));
    const row = logBox().querySelector(".lj-row") as HTMLElement;
    expect(row.querySelector(".k8s-log-src")?.textContent).toBe("abcde ");
    expect(within(row).getByText("hello")).toBeInTheDocument();
  });
});

describe("controls", () => {
  test("since reopens the stream with sinceSeconds and stops the old one; 전체 clears it", async () => {
    workload();
    await vi.waitFor(() => expect(emit).toHaveLength(1));
    send(0, lines(A, "app", ["old"]));
    fireEvent.change(screen.getByLabelText(LOG_SINCE), { target: { value: "900" } });
    await vi.waitFor(() => expect(emit).toHaveLength(2));
    expect(m.unwatch).toHaveBeenCalledWith(1);
    expect(lastOptions()).toMatchObject({ sinceSeconds: 900 });
    expect(logText()).toBe("");
    fireEvent.change(screen.getByLabelText(LOG_SINCE), { target: { value: "" } });
    await vi.waitFor(() => expect(emit).toHaveLength(3));
    expect(lastOptions()).toMatchObject({ sinceSeconds: null });
    expect(Array.from(screen.getByLabelText(LOG_SINCE).querySelectorAll("option")).map((o) => [o.textContent, o.value])).toEqual([
      ["전체", ""], ["최근 5분", "300"], ["최근 15분", "900"], ["최근 1시간", "3600"], ["최근 6시간", "21600"], ["최근 24시간", "86400"],
    ]);
  });

  test("the time toggle shows the server time as local MM-DD HH:mm:ss.SSS without reopening the stream", async () => {
    workload();
    await vi.waitFor(() => expect(emit).toHaveLength(1));
    send(0, lines(A, "app", ["hello"], "2026-11-02T06:40:58.776123456Z"));
    expect(logText()).toBe("hello\n");
    fireEvent.click(screen.getByLabelText(LOG_TIME));
    expect(logText()).toMatch(/^\d\d-\d\d \d\d:\d\d:\d\d\.776 hello\n$/);
    // 새 줄도 같은 모양, 끄면 시각이 사라진다
    send(0, lines(A, "app", ["next"], "2026-11-02T06:40:59.001Z"));
    expect(logText()).toMatch(/\.001 next\n$/);
    fireEvent.click(screen.getByLabelText(LOG_TIME));
    expect(logText()).toBe("hello\nnext\n");
    expect(emit).toHaveLength(1);
    expect(m.unwatch).not.toHaveBeenCalled();
  });

  test("the time sits after the source prefix and before json rows' own fields", async () => {
    await twoPods();
    send(0, lines(A, "app", [JSON.stringify({ level: "info", msg: "hi" })], "2026-11-02T06:40:58.776Z"));
    fireEvent.click(screen.getByLabelText(LOG_TIME));
    const row = logBox().querySelector(".lj-row") as HTMLElement;
    expect(row.textContent).toMatch(/^abcde \d\d-\d\d \d\d:\d\d:\d\d\.776 /);
  });

  test("the wrap toggle only changes the view: on by default, off scrolls sideways, the stream is not reopened", async () => {
    workload();
    await vi.waitFor(() => expect(emit).toHaveLength(1));
    send(0, lines(A, "app", ["a very long line"]));
    expect(logBox()).not.toHaveClass("nowrap");
    fireEvent.click(screen.getByLabelText(LOG_WRAP));
    expect(logBox()).toHaveClass("nowrap");
    expect(logText()).toBe("a very long line\n");
    fireEvent.click(screen.getByLabelText(LOG_WRAP));
    expect(logBox()).not.toHaveClass("nowrap");
    expect(emit).toHaveLength(1);
  });

  test("the container picker lists the template's containers after 모든 컨테이너; picking one reopens with it", async () => {
    workload([c("app"), c("sidecar")]);
    await vi.waitFor(() => expect(emit).toHaveLength(1));
    const picker = screen.getByLabelText(LOG_CONTAINER);
    expect(Array.from(picker.querySelectorAll("option")).map((o) => o.textContent)).toEqual([LOG_ALL_CONTAINERS, "app", "sidecar"]);
    expect(picker).toHaveValue("");
    fireEvent.change(picker, { target: { value: "sidecar" } });
    await vi.waitFor(() => expect(emit).toHaveLength(2));
    expect(lastOptions()).toMatchObject({ container: "sidecar" });
    fireEvent.change(picker, { target: { value: "" } });
    await vi.waitFor(() => expect(emit).toHaveLength(3));
    expect(lastOptions()).toMatchObject({ container: null });
  });

  test("without template containers (a Service) there is no container picker", async () => {
    workload([]);
    await vi.waitFor(() => expect(emit).toHaveLength(1));
    expect(screen.queryByLabelText(LOG_CONTAINER)).toBeNull();
  });
});

describe("save", () => {
  beforeEach(() => {
    m.logsSave.mockResolvedValue("/Users/me/Downloads/web-20261103-141500.log");
  });

  test("sends the lines as shown (prefix and time included) under <name>-<YYYYMMDD-HHMMSS>.log and offers Finder", async () => {
    await twoPods();
    send(0, lines(A, "app", ["timed"], "2026-11-02T06:40:58.776Z"));
    fireEvent.click(screen.getByLabelText(LOG_TIME));
    fireEvent.click(chip(/^fghij/));
    fireEvent.click(screen.getByRole("button", { name: LOG_SAVE }));
    await screen.findByText(new RegExp(logSaved("/Users/me/Downloads/web-20261103-141500.log")));
    const [fileName, text] = m.logsSave.mock.calls[0];
    expect(fileName).toMatch(/^web-\d{8}-\d{6}\.log$/);
    // 감춘 출처는 빠지고, 시각이 없는 줄은 시각 없이
    expect(text).toMatch(/^abcde a one\nabcde a two\nabcde \d\d-\d\d \d\d:\d\d:\d\d\.776 timed\n$/);
    const reveal = vi.spyOn(desktop, "reveal").mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole("button", { name: LOG_REVEAL }));
    expect(reveal).toHaveBeenCalledWith("/Users/me/Downloads/web-20261103-141500.log");
  });

  test("a single pod saves the raw text", async () => {
    render(wrap(<PodLogs target={T} ssoProfile="p" live namespace="prod" pod="web-1" containers={[c("app")]} />));
    await vi.waitFor(() => expect(emit).toHaveLength(1));
    expect(screen.getByRole("button", { name: LOG_SAVE })).toBeDisabled();
    send(0, lines("web-1", "app", ["one", "two"]));
    fireEvent.click(screen.getByRole("button", { name: LOG_SAVE }));
    await screen.findByText(new RegExp(logSaved("/Users/me/Downloads/web-20261103-141500.log")));
    expect(m.logsSave).toHaveBeenCalledTimes(1);
    expect(m.logsSave.mock.calls[0][0]).toMatch(/^web-1-\d{8}-\d{6}\.log$/);
    expect(m.logsSave.mock.calls[0][1]).toBe("one\ntwo\n");
  });

  test("a failed save says why", async () => {
    m.logsSave.mockRejectedValue({ kind: "other", message: "디스크가 가득 찼어요" });
    await twoPods();
    fireEvent.click(screen.getByRole("button", { name: LOG_SAVE }));
    expect(await screen.findByText(new RegExp(logSaveFailed("디스크가 가득 찼어요")))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: LOG_REVEAL })).toBeNull();
  });
});

describe("pod logs with all containers", () => {
  const setup = () => render(wrap(<PodLogs target={T} ssoProfile="p" live namespace="prod" pod="web-1" containers={[c("init-db", true), c("app"), c("sidecar")]} />));
  const podBox = () => screen.getByLabelText("web-1") as HTMLElement;

  test("the picker offers 모든 컨테이너; choosing it reopens with container null and the lines carry the container name", async () => {
    setup();
    await vi.waitFor(() => expect(m.logs).toHaveBeenCalledTimes(1));
    expect(m.logs.mock.lastCall![3]).toMatchObject({ container: "app", sinceSeconds: null });
    fireEvent.change(screen.getByLabelText(LOG_CONTAINER), { target: { value: "" } });
    await vi.waitFor(() => expect(emit).toHaveLength(2));
    expect(m.logs.mock.lastCall![3]).toMatchObject({ container: null });
    send(1, lines("web-1", "app", ["from app"]));
    send(1, lines("web-1", "sidecar", ["from sidecar"]));
    expect(podBox().textContent).toBe("app from app\nsidecar from sidecar\n");
    expect(chip(/^app 1$/)).toBeInTheDocument();
    expect(chip(/^sidecar 1$/)).toBeInTheDocument();
  });
});
