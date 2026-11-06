import { fireEvent, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { api } from "../api/client";
import type { Settings } from "../api/types";
import { newQueryClient, renderWithClient } from "../test/utils";
import { tailscaleApi } from "./api";
import { ApiRequired } from "./ApiRequired";
import { TailscaleTabsProvider } from "./TabContext";
import * as t from "./text";
import { useTailscaleApi } from "./useTailscaleApi";

vi.mock("../api/client", () => ({ api: { getSettings: vi.fn(), saveSettings: vi.fn() } }));
vi.mock("./api", () => ({ tailscaleApi: { apiStatus: vi.fn() } }));

const EMPTY: Settings = { enabledServices: [], favorites: [], lastProfile: null, lastRegion: null };
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={newQueryClient()}>{children}</QueryClientProvider>;

beforeEach(() => vi.resetAllMocks());

describe("useTailscaleApi", () => {
  test("등록한 테일넷이 없으면 키체인을 묻지 않고 연결 안 됨이에요", async () => {
    vi.mocked(api.getSettings).mockResolvedValue(EMPTY);
    const { result } = renderHook(() => useTailscaleApi(), { wrapper });
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current).toEqual({ tailnet: null, connected: false, isLoading: false });
    expect(tailscaleApi.apiStatus).not.toHaveBeenCalled();
  });

  test("키체인에 자격 증명이 있는 테일넷이면 연결됨이에요", async () => {
    vi.mocked(api.getSettings).mockResolvedValue({ ...EMPTY, tailscaleTailnet: "example.com" });
    vi.mocked(tailscaleApi.apiStatus).mockResolvedValue({ tailnet: "example.com", kind: "token" });
    const { result } = renderHook(() => useTailscaleApi(), { wrapper });
    await waitFor(() => expect(result.current.connected).toBe(true));
    expect(result.current).toEqual({ tailnet: "example.com", connected: true, isLoading: false });
    expect(tailscaleApi.apiStatus).toHaveBeenCalledWith("example.com");
  });

  test("설정에는 있는데 키체인에 없으면 연결 안 됨이에요", async () => {
    vi.mocked(api.getSettings).mockResolvedValue({ ...EMPTY, tailscaleTailnet: "example.com" });
    vi.mocked(tailscaleApi.apiStatus).mockResolvedValue({ tailnet: "example.com", kind: null });
    const { result } = renderHook(() => useTailscaleApi(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current).toEqual({ tailnet: "example.com", connected: false, isLoading: false });
  });
});

test("ApiRequired의 버튼은 연결 탭으로 옮기자고 요청해요", () => {
  const select = vi.fn();
  renderWithClient(
    <TailscaleTabsProvider value={{ select, deviceView: "table", setDeviceView: vi.fn() }}>
      <ApiRequired title={t.TAB_POLICY} />
    </TailscaleTabsProvider>,
  );
  expect(screen.getByText(t.API_REQUIRED)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: t.API_REQUIRED_BUTTON }));
  expect(select).toHaveBeenCalledWith("connect");
});
