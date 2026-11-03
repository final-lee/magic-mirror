import { fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { renderWithClient } from "../test/utils";
import type { Settings } from "../api/types";
import { argowfApi } from "./api";
import { ArgoWfTab } from "./ArgoWfTab";
import { ARGOWF_FORBIDDEN, ARGOWF_TOKEN_INVALID } from "./text";
import { conn, info, page, row } from "./shellFixtures";
import { cron } from "./catalogFixtures";

vi.mock("./api", () => ({
  argowfApi: {
    contexts: vi.fn(),
    session: vi.fn(),
    setToken: vi.fn(),
    forgetToken: vi.fn(),
    info: vi.fn(),
    workflows: vi.fn(),
    watch: vi.fn(),
    watchStop: vi.fn(),
    crons: vi.fn(),
    templates: vi.fn(),
    eventBindings: vi.fn(),
  },
}));
vi.mock("../api/queries", () => ({ useSettings: vi.fn() }));
import { useSettings } from "../api/queries";

const session = { url: conn.url, version: "v4.1.6", identity: "me@example.test", auth: "token" as const, kube: false, ssoProfile: null };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(argowfApi.contexts).mockResolvedValue([{ name: "dev", cluster: "cluster", server: null, ssoProfile: "dev-profile" }]);
  vi.mocked(argowfApi.session).mockResolvedValue(null);
  vi.mocked(argowfApi.info).mockResolvedValue(info);
  vi.mocked(argowfApi.workflows).mockResolvedValue(page([]));
  vi.mocked(argowfApi.watch).mockResolvedValue(1);
  vi.mocked(argowfApi.watchStop).mockResolvedValue(undefined);
  vi.mocked(argowfApi.crons).mockResolvedValue([]);
  vi.mocked(argowfApi.templates).mockResolvedValue([]);
  vi.mocked(argowfApi.eventBindings).mockResolvedValue([]);
});

function setup(initial: Settings) {
  vi.mocked(useSettings).mockImplementation(() => {
    const [settings, setSettings] = useState(initial);
    return { settings, update: (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })), isError: false, error: null, refetch: vi.fn() };
  });
  return renderWithClient(<ArgoWfTab active />);
}
const base: Settings = { enabledServices: [], favorites: [], lastProfile: null, lastRegion: null };
const server = { name: "test", url: conn.url, context: null };

test("서버를 추가한 뒤 context를 고르며 HTTP 경고를 보인다", async () => {
  setup(base);
  fireEvent.change(screen.getByLabelText("서버 주소"), { target: { value: "http://example.test" } });
  fireEvent.click(screen.getByRole("button", { name: "다음" }));
  expect(await screen.findByText(/평문/)).toBeInTheDocument();
  const context = await screen.findByRole("option", { name: "dev · cluster" });
  fireEvent.change(context.parentElement!, { target: { value: "dev" } });
  fireEvent.click(screen.getByRole("button", { name: "연결" }));
  await waitFor(() => expect(argowfApi.session).toHaveBeenCalledWith({ url: "http://example.test", context: "dev" }, "dev-profile"));
});

test("토큰 오류가 나면 토큰 폼으로 돌아간다", async () => {
  vi.mocked(argowfApi.session).mockRejectedValue({ kind: "other", message: ARGOWF_TOKEN_INVALID });
  setup({ ...base, argoWorkflowsServers: [server] });
  expect(await screen.findByText(ARGOWF_TOKEN_INVALID)).toBeInTheDocument();
  expect(screen.getByLabelText(/토큰/)).toHaveAttribute("type", "password");
});

test("왼쪽 메뉴에 Argo UI의 모든 화면과 바깥 링크가 있다", async () => {
  vi.mocked(argowfApi.session).mockResolvedValue(session);
  setup({ ...base, argoWorkflowsServers: [server] });
  await screen.findByRole("button", { name: "Workflows" });
  const names = screen.getAllByRole("navigation")[0].textContent;
  for (const label of [
    "Workflows",
    "CronWorkflows",
    "템플릿",
    "보관함",
    "Reports",
    "Event Flow",
    "Event Sources",
    "Sensors",
    "Event Bindings",
    "점검",
    "User Info",
    "Plugins",
    "API Docs ↗",
    "Help ↗",
  ]) {
    expect(names).toContain(label);
  }
});

test("서버의 managedNamespace는 모든 호출에 쓰이고 네임스페이스 칸을 잠근다", async () => {
  vi.mocked(argowfApi.session).mockResolvedValue(session);
  vi.mocked(argowfApi.info).mockResolvedValue({ ...info, managedNamespace: "managed" });
  setup({ ...base, argoWorkflowsServers: [{ ...server, namespace: "other" }] });
  const box = await screen.findByLabelText("네임스페이스");
  expect(box).toBeDisabled();
  expect(box).toHaveValue("managed");
  await waitFor(() => expect(argowfApi.workflows).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ namespace: "managed" })));
  expect(argowfApi.workflows).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ namespace: "other" }));
});

test("네임스페이스는 Argo 자원이 있는 곳 중에서 고르고, 바꾸면 그 네임스페이스로 다시 읽는다", async () => {
  vi.mocked(argowfApi.session).mockResolvedValue(session);
  vi.mocked(argowfApi.crons).mockImplementation(async (_c, ns) =>
    ns === null ? [cron({ name: "b", namespace: "team-b" }), cron({ name: "c", namespace: "team-c" })] : [],
  );
  setup({ ...base, argoWorkflowsServers: [{ ...server, namespace: "team-a" }] });
  const box = await screen.findByRole("combobox", { name: "네임스페이스" });
  await waitFor(() => expect(box.querySelector('option[value="team-b"]')).not.toBeNull());
  // 설정에 저장된 것은 지금 자원이 없어도 그대로 보인다
  expect([...box.querySelectorAll("option")].map((o) => o.value)).toEqual(["", "team-a", "team-b", "team-c"]);
  expect(box).toHaveValue("team-a");
  await waitFor(() => expect(argowfApi.workflows).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ namespace: "team-a" })));
  fireEvent.change(box, { target: { value: "team-b" } });
  await waitFor(() => expect(argowfApi.workflows).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ namespace: "team-b" })));
});

test("모든 네임스페이스 목록이 403이면 고르라고 하고, 다른 Argo 목록이 보여 준 네임스페이스로 채운다", async () => {
  vi.mocked(argowfApi.session).mockResolvedValue(session);
  vi.mocked(argowfApi.workflows).mockImplementation(async (_c, q) => {
    if (q.namespace === null) throw { kind: "other", message: ARGOWF_FORBIDDEN };
    return page([row("mine", "Succeeded")]);
  });
  vi.mocked(argowfApi.crons).mockImplementation(async (_c, ns) => (ns === null ? [cron({ namespace: "test" })] : []));
  setup({ ...base, argoWorkflowsServers: [server] });
  expect(await screen.findByText("네임스페이스를 골라 주세요")).toBeInTheDocument();
  const box = screen.getAllByRole("combobox", { name: "네임스페이스" })[1];
  await waitFor(() => expect(box.querySelector('option[value="test"]')).not.toBeNull());
  fireEvent.change(box, { target: { value: "test" } });
  expect(await screen.findByText("mine")).toBeInTheDocument();
});

test("어디서도 네임스페이스를 알 수 없는 신원만 이름을 직접 넣는다", async () => {
  vi.mocked(argowfApi.session).mockResolvedValue(session);
  vi.mocked(argowfApi.workflows).mockImplementation(async (_c, q) => {
    if (q.namespace === null) throw { kind: "other", message: ARGOWF_FORBIDDEN };
    return page([row("mine", "Succeeded")]);
  });
  vi.mocked(argowfApi.crons).mockRejectedValue({ kind: "other", message: ARGOWF_FORBIDDEN });
  vi.mocked(argowfApi.templates).mockRejectedValue({ kind: "other", message: ARGOWF_FORBIDDEN });
  vi.mocked(argowfApi.eventBindings).mockRejectedValue({ kind: "other", message: ARGOWF_FORBIDDEN });
  setup({ ...base, argoWorkflowsServers: [server] });
  await screen.findByText("네임스페이스를 골라 주세요");
  const box = screen.getAllByRole("combobox", { name: "네임스페이스" })[1];
  await waitFor(() => expect(box).not.toBeDisabled());
  fireEvent.change(box, { target: { value: "\u0000type" } });
  const input = await screen.findByLabelText("네임스페이스 이름");
  fireEvent.change(input, { target: { value: "test" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(await screen.findByText("mine")).toBeInTheDocument();
});
