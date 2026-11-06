import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { ApiPeersView } from "./ApiPeersView";
import { devicesApi } from "./api";
import type { TsNode } from "./types";

vi.mock("./api", () => ({
  devicesApi: { list: vi.fn(), changes: vi.fn(), preview: vi.fn(), apply: vi.fn(), undo: vi.fn(), extraList: vi.fn() },
}));
const device = { id: "d1", name: "host.example.ts.net", findings: ["unauthorized"], tags: [] };
const node: TsNode = { cli: null, version: null, backendState: null, health: [], tailnet: null, magicDnsSuffix: null, user: null, self: null, prefs: null, peers: [] };
const plan = { items: [{ device, action: "authorize", method: "POST", path: "/device/d1/authorized", body: { authorized: true } }] };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(devicesApi.list).mockResolvedValue([device]);
  vi.mocked(devicesApi.changes).mockResolvedValue([{ id: "c1", at: "now", action: "tags", target: { deviceId: "d1", name: device.name }, summary: "tags", before: ["tag:old"], after: [], undone: false }]);
  vi.mocked(devicesApi.preview).mockResolvedValue(plan);
  vi.mocked(devicesApi.apply).mockResolvedValue([{ id: "d1", name: device.name, ok: true, error: null }]);
  vi.mocked(devicesApi.undo).mockResolvedValue(undefined);
  vi.mocked(devicesApi.extraList).mockImplementation(async (_tailnet, _id, invites) => invites ? [] : { attributes: {}, expiries: {} });
});
test("shows the API call before applying and confirms undo", async () => {
  renderWithClient(<ApiPeersView node={node} tailnet="example.com" />);
  fireEvent.click(await screen.findByLabelText(`${device.name} 선택`));
  fireEvent.click(screen.getByRole("button", { name: "미리보기" }));
  expect(await screen.findByText("POST /device/d1/authorized")).toBeInTheDocument();
  expect(devicesApi.apply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "적용" }));
  expect(await screen.findByText("완료")).toBeInTheDocument();
  fireEvent.click(screen.getByText("변경 기록"));
  fireEvent.click(await screen.findByRole("button", { name: "되돌리기" }));
  expect(devicesApi.undo).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "되돌림 적용" }));
  await waitFor(() => expect(devicesApi.undo).toHaveBeenCalledWith("example.com", "c1"));
});

test("the change preview closes on a click outside the sheet or Esc without sending anything", async () => {
  renderWithClient(<ApiPeersView node={node} tailnet="example.com" />);
  fireEvent.click(await screen.findByLabelText(`${device.name} 선택`));
  fireEvent.click(screen.getByRole("button", { name: "미리보기" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(dialog);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  fireEvent.click(dialog.parentElement!);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "미리보기" }));
  await screen.findByRole("dialog");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(devicesApi.apply).not.toHaveBeenCalled();
});

test("passes a single IPv4 address to the preview before applying", async () => {
  renderWithClient(<ApiPeersView node={node} tailnet="example.com" />);
  fireEvent.click(await screen.findByLabelText(`${device.name} 선택`));
  fireEvent.change(screen.getByRole("combobox", { name: "기기 작업" }), { target: { value: "ip" } });
  fireEvent.change(screen.getByLabelText("새 IPv4 (100.64.0.0/10)"), { target: { value: "100.64.0.1" } });
  fireEvent.click(screen.getByRole("button", { name: "미리보기" }));
  await waitFor(() => expect(devicesApi.preview).toHaveBeenCalledWith("example.com", ["d1"], "ip", "100.64.0.1"));
  expect(devicesApi.apply).not.toHaveBeenCalled();
});

test("the extras button toggles the device panel", async () => {
  renderWithClient(<ApiPeersView node={node} tailnet="example.com" />);
  fireEvent.click(await screen.findByLabelText(`${device.name} 선택`));
  const toggle = screen.getByRole("button", { name: "포스처 · 공유" });
  fireEvent.click(toggle);
  expect(await screen.findByText("기기 포스처와 공유")).toBeInTheDocument();
  fireEvent.click(toggle);
  expect(screen.queryByText("기기 포스처와 공유")).not.toBeInTheDocument();
});

test("share history previews the exact reconstructed commands before undo", async () => {
  vi.mocked(devicesApi.changes).mockResolvedValue([{
    id: "share1", at: "now", action: "shareConfig", target: {}, summary: "공유",
    before: { commands: [["serve", "reset"], ["serve", "--bg", "--https=443", "--set-path=/", "3000"]] },
    after: {}, undone: false,
  }]);
  renderWithClient(<ApiPeersView node={node} tailnet="example.com" />);
  fireEvent.click(await screen.findByRole("button", { name: "변경 기록" }));
  fireEvent.click(await screen.findByRole("button", { name: "되돌리기" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("'tailscale' 'serve' 'reset'");
  expect(screen.getByRole("dialog")).toHaveTextContent("'--https=443' '--set-path=/' '3000'");
  expect(devicesApi.undo).not.toHaveBeenCalled();
});
