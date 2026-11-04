import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { desktop } from "../api/desktop";
import { dispatchKey } from "../keymap/registry";
import { newQueryClient, renderWithClient } from "../test/utils";
import { argowfApi } from "./api";
import { CONN, wf } from "./catalogFixtures";
import { EventFlow } from "./EventFlow";
import { EventSources } from "./EventSources";
import { Sensors } from "./Sensors";
import { UserInfoView } from "./UserInfoView";

vi.mock("./api", () => ({
  argowfApi: { eventSources: vi.fn(), sensors: vi.fn(), resourceLogs: vi.fn(), logsStop: vi.fn(), userInfo: vi.fn(), copyToken: vi.fn() },
}));
vi.mock("../api/desktop", () => ({ desktop: { copy: vi.fn(), openUrl: vi.fn() } }));
const api = vi.mocked(argowfApi);
beforeEach(() => vi.resetAllMocks());

test("이벤트 의존성과 트리거를 Workflow에 잇는다", async () => {
  api.eventSources.mockResolvedValue([{ namespace: "batch", name: "source", types: ["webhook"], eventNames: ["push"], status: null, message: null, yaml: "" }]);
  api.sensors.mockResolvedValue([
    {
      namespace: "batch",
      name: "sensor",
      dependencies: [{ name: "dep", eventSourceName: "source", eventName: "push" }],
      triggers: [{ name: "run", type: "argoWorkflow", target: null }],
      status: null,
      message: null,
      yaml: "",
    },
  ]);
  const onOpenWorkflow = vi.fn();
  renderWithClient(
    <EventFlow
      conn={CONN}
      live
      namespace="batch"
      workflows={[wf({ name: "job", labels: { "events.argoproj.io/sensor": "sensor", "events.argoproj.io/trigger": "run" } })]}
      onOpenWorkflow={onOpenWorkflow}
      onTokenError={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "job" }));
  expect(screen.getByText(/sensor: dep/)).toBeInTheDocument();
  expect(onOpenWorkflow).toHaveBeenCalledWith({ kind: "live", namespace: "batch", name: "job" });
});

test("Argo Events가 없으면 안내한다", async () => {
  api.eventSources.mockRejectedValue("이 클러스터에 Argo Events가 없어요");
  renderWithClient(<EventSources conn={CONN} live namespace={null} links={[]} onTokenError={vi.fn()} />);
  expect(await screen.findByText("이 클러스터에 Argo Events가 없어요")).toBeInTheDocument();
});

test.each([
  ["EventSource", EventSources],
  ["Sensor", Sensors],
] as const)("%s 목록에서 ⌘F와 Esc로 항목을 거른다", async (_kind, View) => {
  api.eventSources.mockResolvedValue(["alpha", "beta"].map((name) => ({ namespace: "batch", name, types: [], eventNames: [], status: null, message: null, yaml: "" })));
  api.sensors.mockResolvedValue(["alpha", "beta"].map((name) => ({ namespace: "batch", name, dependencies: [], triggers: [], status: null, message: null, yaml: "" })));
  renderWithClient(<View conn={CONN} live namespace={null} links={[]} onTokenError={vi.fn()} />);
  await screen.findByRole("button", { name: "alpha" });
  act(() => { dispatchKey(new KeyboardEvent("keydown", { key: "f", metaKey: true })); });
  const input = screen.getByRole("textbox", { name: "목록에서 찾기" });
  fireEvent.change(input, { target: { value: "alpha" } });
  expect(screen.queryByRole("button", { name: "beta" })).toBeNull();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.getByRole("button", { name: "beta" })).toBeInTheDocument();
});

test.each([
  ["EventSource", EventSources],
  ["Sensor", Sensors],
] as const)("%s 로그는 숨기면 멈추고 네임스페이스가 바뀌면 선택을 지운다", async (kind, View) => {
  api.eventSources.mockResolvedValue([{ namespace: "batch", name: "source", types: [], eventNames: [], status: null, message: null, yaml: "" }]);
  api.sensors.mockResolvedValue([{ namespace: "batch", name: "source", dependencies: [], triggers: [], status: null, message: null, yaml: "" }]);
  api.resourceLogs.mockResolvedValueOnce(10).mockResolvedValueOnce(11);
  api.logsStop.mockResolvedValue();
  const qc = newQueryClient();
  const view = (live: boolean, namespace: string | null) => (
    <QueryClientProvider client={qc}>
      <View conn={CONN} live={live} namespace={namespace} links={[]} onTokenError={vi.fn()} />
    </QueryClientProvider>
  );
  const { rerender } = render(view(true, "batch"));
  fireEvent.click(await screen.findByRole("button", { name: "source" }));
  fireEvent.click(screen.getByRole("button", { name: "로그" }));
  await waitFor(() => expect(api.resourceLogs).toHaveBeenCalledWith(CONN, kind, "batch", "source", expect.any(Function)));
  rerender(view(false, "batch"));
  await waitFor(() => expect(api.logsStop).toHaveBeenCalledWith(10));
  rerender(view(true, "batch"));
  await waitFor(() => expect(api.resourceLogs).toHaveBeenCalledTimes(2));
  rerender(view(true, "ops"));
  await waitFor(() => expect(api.logsStop).toHaveBeenCalledWith(11));
  expect(screen.queryByRole("button", { name: "로그" })).not.toBeInTheDocument();
  expect(api.resourceLogs).toHaveBeenCalledTimes(2);
});

test("늦게 열린 로그도 네임스페이스가 바뀌면 중지한다", async () => {
  api.eventSources.mockResolvedValue([{ namespace: "batch", name: "source", types: [], eventNames: [], status: null, message: null, yaml: "" }]);
  let resolveStream!: (id: number) => void;
  api.resourceLogs.mockReturnValue(
    new Promise((resolve) => {
      resolveStream = resolve;
    }),
  );
  api.logsStop.mockResolvedValue();
  const qc = newQueryClient();
  const view = (namespace: string) => (
    <QueryClientProvider client={qc}>
      <EventSources conn={CONN} live namespace={namespace} links={[]} onTokenError={vi.fn()} />
    </QueryClientProvider>
  );
  const { rerender } = render(view("batch"));
  fireEvent.click(await screen.findByRole("button", { name: "source" }));
  fireEvent.click(screen.getByRole("button", { name: "로그" }));
  rerender(view("ops"));
  await act(async () => resolveStream(12));
  expect(api.logsStop).toHaveBeenCalledWith(12);
});

test("토큰은 화면에 표시하지 않고 클립보드로만 보낸다", async () => {
  api.userInfo.mockResolvedValue({
    issuer: null,
    subject: null,
    groups: [],
    email: null,
    emailVerified: null,
    serviceAccountName: null,
    serviceAccountNamespace: null,
  });
  api.copyToken.mockResolvedValue("Bearer secret");
  renderWithClient(
    <UserInfoView
      conn={CONN}
      session={{ url: CONN.url, identity: "ctx-a", version: "v4", auth: "context", kube: true, ssoProfile: null }}
      onTokenError={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "토큰 복사" }));
  await waitFor(() => expect(desktop.copy).toHaveBeenCalledWith("Bearer secret"));
  expect(screen.queryByText(/Bearer secret/)).not.toBeInTheDocument();
});
