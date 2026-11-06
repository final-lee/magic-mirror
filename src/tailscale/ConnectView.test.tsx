import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { api } from "../api/client";
import type { Settings } from "../api/types";
import { renderWithClient } from "../test/utils";
import { tailscaleApi } from "./api";
import { TailscaleTab } from "./TailscaleTab";
import * as t from "./text";
import type { TsApiStatus, TsNode } from "./types";

vi.mock("../api/client", () => ({ api: { getSettings: vi.fn(), saveSettings: vi.fn() } }));
vi.mock("./api", () => ({
  tailscaleApi: { node: vi.fn(), diagnose: vi.fn(), acceptRoutes: vi.fn(), apiStatus: vi.fn(), apiConnect: vi.fn(), apiForget: vi.fn() },
}));
vi.mock("../api/desktop", () => ({ desktop: { copy: vi.fn() } }));

const a = vi.mocked(tailscaleApi);
const EMPTY: Settings = { enabledServices: [], favorites: [], lastProfile: null, lastRegion: null };
const node: TsNode = {
  cli: "/cli", version: "1.104.1", backendState: "Running", health: [], tailnet: "example.com", magicDnsSuffix: "example.ts.net",
  user: "me@example.com", self: null, prefs: null, peers: [],
};

/** 키체인에 자격 증명이 있는 테일넷(apiStatus가 이 값을 돌려준다) */
let stored: TsApiStatus;

beforeEach(() => {
  vi.resetAllMocks();
  stored = { tailnet: "example.com", kind: null };
  vi.mocked(api.getSettings).mockResolvedValue(EMPTY);
  vi.mocked(api.saveSettings).mockResolvedValue(undefined);
  a.node.mockResolvedValue(node);
  a.apiStatus.mockImplementation(async (tailnet) => ({ tailnet, kind: tailnet === stored.tailnet ? stored.kind : null }));
});

async function openConnectTab() {
  renderWithClient(<TailscaleTab active />);
  fireEvent.click(await screen.findByRole("button", { name: t.TAB_CONNECT }));
}

const typeOauth = (id: string, secret: string) => {
  fireEvent.change(screen.getByLabelText(t.CLIENT_ID), { target: { value: id } });
  fireEvent.change(screen.getByLabelText(t.CLIENT_SECRET), { target: { value: secret } });
};

test("연결 다음에 조직 탭이 있고 이 Mac과 기기가 먼저예요", async () => {
  renderWithClient(<TailscaleTab active />);
  const tabs = within(await screen.findByRole("navigation", { name: t.TABS_LABEL })).getAllByRole("button");
  expect(tabs[tabs.length - 2]?.textContent).toBe(t.TAB_CONNECT);
  expect(tabs[tabs.length - 1]?.textContent).toBe("조직");
  expect(tabs.map((tab) => tab.textContent).slice(0, 2)).toEqual([t.TAB_MAC, t.TAB_PEERS]);
});

test("OAuth 값을 넣어 연결하면 기기 수를 보이고 테일넷을 설정에 저장해요", async () => {
  a.apiConnect.mockImplementation(async (tailnet) => {
    stored = { tailnet, kind: "oauth" };
    return { devices: 3, magicDnsSuffix: "example.ts.net" };
  });
  await openConnectTab();
  expect(await screen.findByLabelText(t.TAILNET_LABEL)).toHaveValue("example.com");
  expect(screen.getByLabelText(t.CLIENT_SECRET)).toHaveAttribute("type", "password");
  expect(within(screen.getByRole("main")).getByRole("button", { name: t.CONNECT })).toBeDisabled();
  typeOauth(" client-id ", "secret");
  fireEvent.click(within(screen.getByRole("main")).getByRole("button", { name: t.CONNECT }));

  expect(await screen.findByText(t.connectResult(3))).toBeInTheDocument();
  expect(a.apiConnect).toHaveBeenCalledWith("example.com", { kind: "oauth", clientId: "client-id", clientSecret: "secret" });
  await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ tailscaleTailnet: "example.com" })));
  expect(screen.getByText(t.connected("example.com", t.KIND_OAUTH))).toBeInTheDocument();
  expect(screen.getByText(`${t.MAGIC_DNS_RESULT}: example.ts.net`)).toBeInTheDocument();
  expect(screen.queryByText(t.TAILNET_MISMATCH, { exact: false })).toBeNull();
  expect(screen.queryByLabelText(t.CLIENT_SECRET)).toBeNull();
});

test("이 Mac의 테일넷과 MagicDNS 접미사가 다르면 경고해요", async () => {
  a.apiConnect.mockImplementation(async (tailnet) => {
    stored = { tailnet, kind: "token" };
    return { devices: 1, magicDnsSuffix: "other.ts.net" };
  });
  await openConnectTab();
  fireEvent.change(await screen.findByLabelText(t.TAILNET_LABEL), { target: { value: "other.org" } });
  fireEvent.click(screen.getByRole("radio", { name: new RegExp(t.KIND_TOKEN) }));
  expect(screen.queryByLabelText(t.CLIENT_ID)).toBeNull();
  fireEvent.change(screen.getByLabelText(t.API_TOKEN), { target: { value: "tskey-api-secret" } });
  fireEvent.click(within(screen.getByRole("main")).getByRole("button", { name: t.CONNECT }));

  expect(await screen.findByText(t.tailnetMismatch("example.ts.net"))).toBeInTheDocument();
  expect(a.apiConnect).toHaveBeenCalledWith("other.org", { kind: "token", token: "tskey-api-secret" });
  expect(screen.getByText(t.connected("other.org", t.KIND_TOKEN))).toBeInTheDocument();
});

test("연결에 실패하면 오류를 보이고 설정은 그대로예요", async () => {
  a.apiConnect.mockRejectedValue({ kind: "other", message: "자격 증명이 만료됐거나 맞지 않아요" });
  await openConnectTab();
  await screen.findByLabelText(t.TAILNET_LABEL);
  typeOauth("client-id", "wrong");
  fireEvent.click(within(screen.getByRole("main")).getByRole("button", { name: t.CONNECT }));
  expect(await screen.findByRole("alert")).toHaveTextContent("자격 증명이 만료됐거나 맞지 않아요");
  expect(api.saveSettings).not.toHaveBeenCalled();
  expect(screen.getByLabelText(t.CLIENT_ID)).toHaveValue("client-id");
});

describe("이미 연결돼 있을 때", () => {
  beforeEach(() => {
    stored = { tailnet: "example.com", kind: "oauth" };
    vi.mocked(api.getSettings).mockResolvedValue({ ...EMPTY, tailscaleTailnet: "example.com" });
  });

  test("테일넷과 종류를 보이고 지우기는 키체인 항목과 설정을 지워요", async () => {
    a.apiForget.mockImplementation(async () => {
      stored = { tailnet: "example.com", kind: null };
    });
    await openConnectTab();
    expect(await screen.findByText(t.connected("example.com", t.KIND_OAUTH))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t.FORGET }));
    expect(await screen.findByLabelText(t.CLIENT_ID)).toBeInTheDocument();
    expect(a.apiForget).toHaveBeenCalledWith("example.com");
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ tailscaleTailnet: null })));
    expect(screen.queryByText(t.connected("example.com", t.KIND_OAUTH))).toBeNull();
  });

  test("바꾸기는 폼을 다시 열고 취소하면 상태 줄로 돌아가요", async () => {
    await openConnectTab();
    fireEvent.click(await screen.findByRole("button", { name: t.CHANGE }));
    expect(screen.getByLabelText(t.TAILNET_LABEL)).toHaveValue("example.com");
    expect(screen.getByLabelText(t.CLIENT_SECRET)).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: t.CANCEL_CHANGE }));
    expect(screen.getByText(t.connected("example.com", t.KIND_OAUTH))).toBeInTheDocument();
    expect(a.apiConnect).not.toHaveBeenCalled();
  });

  test("다른 테일넷으로 바꾸면 이전 테일넷의 키체인 항목을 지워요", async () => {
    a.apiConnect.mockImplementation(async (tailnet) => {
      stored = { tailnet, kind: "oauth" };
      return { devices: 2, magicDnsSuffix: null };
    });
    await openConnectTab();
    fireEvent.click(await screen.findByRole("button", { name: t.CHANGE }));
    fireEvent.change(screen.getByLabelText(t.TAILNET_LABEL), { target: { value: "other.org" } });
    typeOauth("id", "secret");
    fireEvent.click(within(screen.getByRole("main")).getByRole("button", { name: t.CONNECT }));
    expect(await screen.findByText(t.connected("other.org", t.KIND_OAUTH))).toBeInTheDocument();
    expect(a.apiForget).toHaveBeenCalledWith("example.com");
    expect(screen.getByText(`${t.MAGIC_DNS_RESULT}: ${t.UNKNOWN}`)).toBeInTheDocument();
  });
});
