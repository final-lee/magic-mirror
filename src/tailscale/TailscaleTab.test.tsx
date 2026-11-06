import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { tailscaleApi } from "./api";
import { TailscaleTab } from "./TailscaleTab";
import type { TsNode, TsPeer } from "./types";

vi.mock("./api", () => ({ tailscaleApi: { node: vi.fn(), diagnose: vi.fn(), acceptRoutes: vi.fn(), localRead: vi.fn(), lockStatus: vi.fn() } }));
vi.mock("../api/desktop", () => ({ desktop: { copy: vi.fn() } }));
vi.mock("./useTailscaleApi", () => ({ useTailscaleApi: () => ({ tailnet: null, connected: false, isLoading: false }) }));

const peer = (hostName: string, data: Partial<TsPeer> = {}): TsPeer => ({
  hostName, dnsName: `${hostName}.example.net`, os: "linux", ips: ["100.1.1.1"], online: false,
  routes: [], exitNodeOption: false, exitNode: false, tags: [], relay: "tok", curAddr: "", lastSeen: null, keyExpiry: null, owner: null, ...data,
});
const node: TsNode = {
  cli: "/Applications/Tailscale.app/Contents/MacOS/Tailscale", version: "1.104.1", backendState: "Running", health: ["주의"],
  tailnet: "example.com", magicDnsSuffix: "example.net", user: "me@example.com", self: peer("mac", { ips: ["100.1.2.3"] }),
  prefs: { acceptRoutes: true, acceptDns: false, exitNode: "", shieldsUp: false, ssh: false, autoUpdate: true, advertiseRoutes: "", advertiseExitNode: false },
  peers: [peer("router", { online: true, routes: ["10.0.0.0/16"], tags: ["tag:server"] }), peer("exit", { online: true, exitNodeOption: true }), peer("laptop", { lastSeen: "2026-01-01T00:00:00Z" })],
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(tailscaleApi.node).mockResolvedValue(node);
  vi.mocked(tailscaleApi.localRead).mockImplementation(async (kind) => kind === "prefs" ? "{}" : "[]");
  vi.mocked(tailscaleApi.lockStatus).mockResolvedValue(null);
});

test("CLI가 없어도 탭을 열고 CLI 보기에 설치 안내를 보여줘요", async () => {
  vi.mocked(tailscaleApi.node).mockResolvedValue({ ...node, cli: null });
  renderWithClient(<TailscaleTab active />);
  expect(await screen.findByText(/Tailscale 앱을 설치/)).toBeInTheDocument();
  expect(screen.getByRole("navigation", { name: "Tailscale 보기" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "기기" }));
  expect(screen.getByRole("button", { name: "기기" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "연결 탭 열기" })).toBeInTheDocument();
});

test("이 Mac의 상태와 설정을 보여줘요", async () => {
  vi.mocked(tailscaleApi.localRead).mockImplementation(async (kind) =>
    kind === "prefs" ? '{"accept-routes":true,"exit-node":""}' : kind === "accounts" ? "[]" : "");
  renderWithClient(<TailscaleTab active />);
  expect(await screen.findByText("주의")).toBeInTheDocument();
  expect(screen.getByText("100.1.2.3")).toBeInTheDocument();
  expect(await screen.findByText("서브넷 경로 받기")).toBeInTheDocument();
  expect(screen.getAllByText("안 씀").length).toBeGreaterThan(0);
});

test("기기 필터와 퍼지 검색은 개수를 좁혀요", async () => {
  renderWithClient(<TailscaleTab active />);
  fireEvent.click(await screen.findByRole("button", { name: "기기" }));
  expect(screen.getByRole("button", { name: "모두 3" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "온라인 2" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "서브넷 라우터 1" }));
  expect(screen.getByText("router")).toBeInTheDocument();
  expect(screen.queryByText("exit")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "모두 3" }));
  fireEvent.change(screen.getByRole("textbox", { name: "기기 검색" }), { target: { value: "lpt" } });
  expect(screen.getByText("laptop")).toBeInTheDocument();
  expect(screen.queryByText("router")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "모두 1" })).toBeInTheDocument();
  expect(within(screen.getByRole("table")).getByText(/마지막 접속/)).toBeInTheDocument();
});

test("입력한 주소를 진단하고 같은 주소를 다시 제출하면 다시 진단해요", async () => {
  vi.mocked(tailscaleApi.diagnose).mockResolvedValue({ host: "host", port: 443, address: null, tailnet: null, checks: [], verdict: "확인했어요", fix: null });
  renderWithClient(<TailscaleTab active />);
  fireEvent.click(await screen.findByRole("button", { name: "진단" }));
  fireEvent.change(screen.getByLabelText("URL 또는 호스트[:포트]"), { target: { value: "host:443" } });
  fireEvent.click(within(screen.getByRole("main")).getByRole("button", { name: "진단" }));
  expect(await screen.findByText("확인했어요")).toBeInTheDocument();
  expect(tailscaleApi.diagnose).toHaveBeenCalledWith("host:443");
  fireEvent.click(within(screen.getByRole("main")).getByRole("button", { name: "진단" }));
  await waitFor(() => expect(tailscaleApi.diagnose).toHaveBeenCalledTimes(2));
});
