import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { dispatchKey } from "../keymap/registry";
import { argowfApi } from "./api";
import { WfLogs } from "./WfLogs";
import { conn } from "./shellFixtures";
import type { WfLogMessage } from "./types";

vi.mock("./api", () => ({ argowfApi: { logs: vi.fn(), logsStop: vi.fn(), saveText: vi.fn(), artifactPreview: vi.fn() } }));

let send: (m: WfLogMessage) => void = () => {};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(argowfApi.logsStop).mockResolvedValue(undefined);
  vi.mocked(argowfApi.logs).mockImplementation(async (_c, _ns, _n, _pod, _o, cb) => {
    send = cb;
    return 3;
  });
  Element.prototype.scrollIntoView = vi.fn();
});

const logs = (extra: Partial<Parameters<typeof WfLogs>[0]> = {}) => (
  <WfLogs conn={conn} namespace="ns" name="job" pod="job-1" running={false} live onTokenError={vi.fn()} {...extra} />
);
const defaults = { container: "main", follow: false, tailLines: 1000, previous: false, sinceSeconds: null, timestamps: false };

test("⌘F는 로그 찾기를 열고 Esc는 강조를 지우고 닫는다", async () => {
  render(logs());
  await waitFor(() => expect(argowfApi.logs).toHaveBeenCalled());
  act(() => send({ type: "lines", lines: [{ pod: "job-1", text: "error occurred" }] }));
  expect(screen.queryByRole("textbox", { name: "목록에서 찾기" })).toBeNull();
  act(() => { dispatchKey(new KeyboardEvent("keydown", { key: "f", metaKey: true })); });
  const input = screen.getByRole("textbox", { name: "목록에서 찾기" });
  expect(input).toHaveFocus();
  fireEvent.change(input, { target: { value: "error" } });
  expect(document.querySelector("mark")).toHaveTextContent("error");
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("textbox", { name: "목록에서 찾기" })).toBeNull();
  expect(document.querySelector("mark")).toBeNull();
});

test("직전 컨테이너·최근 N초·시각 표시 옵션을 로그 호출에 넘긴다", async () => {
  render(logs());
  await waitFor(() => expect(argowfApi.logs).toHaveBeenCalledWith(conn, "ns", "job", "job-1", defaults, expect.any(Function)));
  fireEvent.click(screen.getByLabelText("직전 컨테이너"));
  await waitFor(() => expect(argowfApi.logs).toHaveBeenLastCalledWith(conn, "ns", "job", "job-1", { ...defaults, previous: true }, expect.any(Function)));
  fireEvent.click(screen.getByLabelText("시각 표시"));
  fireEvent.change(screen.getByLabelText("최근 N초"), { target: { value: "300" } });
  await waitFor(() =>
    expect(argowfApi.logs).toHaveBeenLastCalledWith(
      conn,
      "ns",
      "job",
      "job-1",
      { ...defaults, previous: true, timestamps: true, sinceSeconds: 300 },
      expect.any(Function),
    ),
  );
  expect(argowfApi.logsStop).toHaveBeenCalled();
});

test("[파일로 저장]은 지금 버퍼의 글을 저장 창으로 넘긴다", async () => {
  vi.mocked(argowfApi.saveText).mockResolvedValue("/tmp/job-job-1.log");
  const notice = vi.fn();
  render(logs({ onNotice: notice }));
  await waitFor(() => expect(argowfApi.logs).toHaveBeenCalled());
  expect(screen.getByRole("button", { name: "파일로 저장" })).toBeDisabled();
  act(() =>
    send({
      type: "lines",
      lines: [
        { pod: "job-1", text: "첫 줄" },
        { pod: "job-1", text: "둘째 줄" },
      ],
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "파일로 저장" }));
  await waitFor(() => expect(argowfApi.saveText).toHaveBeenCalledWith("job-job-1.log", "첫 줄\n둘째 줄"));
  expect(notice).toHaveBeenCalledWith("로그를 저장했어요: /tmp/job-job-1.log");
});

test("전체 Workflow 로그를 저장하면 줄마다 Pod 이름이 앞에 붙는다", async () => {
  vi.mocked(argowfApi.saveText).mockResolvedValue(null);
  render(logs({ pod: null }));
  await waitFor(() => expect(argowfApi.logs).toHaveBeenCalled());
  act(() => send({ type: "lines", lines: [{ pod: "p-a", text: "x" }] }));
  fireEvent.click(await screen.findByRole("button", { name: "파일로 저장" }));
  await waitFor(() => expect(argowfApi.saveText).toHaveBeenCalledWith("job-workflow.log", "p-a x"));
});

test("Pod가 지워져 로그가 비면 main-logs 아티팩트를 읽어 로그 줄로 보인다", async () => {
  vi.mocked(argowfApi.artifactPreview).mockResolvedValue({ contentType: "text/plain", size: 10, text: "보관 1\n보관 2", imageBase64: null });
  const ref = { target: { kind: "live" as const, namespace: "ns", name: "job" }, nodeId: "n1", name: "main-logs", direction: "output" as const };
  render(logs({ archivedLogs: ref }));
  await waitFor(() => expect(argowfApi.logs).toHaveBeenCalled());
  act(() => send({ type: "end" }));
  expect(await screen.findByText(/보관 1/)).toBeInTheDocument();
  expect(screen.getByText(/보관 2/)).toBeInTheDocument();
  expect(argowfApi.artifactPreview).toHaveBeenCalledWith(conn, ref);
  expect(screen.getByText(/보관된 로그/)).toBeInTheDocument();
});

test("아티팩트도 없으면 Pod가 지워졌다고 안내한다", async () => {
  render(logs());
  await waitFor(() => expect(argowfApi.logs).toHaveBeenCalled());
  act(() => send({ type: "end" }));
  expect(await screen.findByText("Pod가 지워져 로그가 없어요")).toBeInTheDocument();
  expect(argowfApi.artifactPreview).not.toHaveBeenCalled();
});
