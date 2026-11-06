import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { tailscaleApi } from "./api";
import { DnsView } from "./DnsView";
import { useTailscaleApi } from "./useTailscaleApi";

vi.mock("./api", () => ({ tailscaleApi: { dns: vi.fn(), dnsSave: vi.fn(), dnsSplitSave: vi.fn() } }));
vi.mock("./useTailscaleApi", () => ({ useTailscaleApi: vi.fn() }));

test("previews the full DNS request and can restore the previous configuration", async () => {
  vi.mocked(useTailscaleApi).mockReturnValue({ tailnet: "example.com", connected: true, isLoading: false });
  let current: Record<string, unknown> = { nameservers: [], searchPaths: [], splitDNS: {}, preferences: { magicDNS: false } };
  vi.mocked(tailscaleApi.dns).mockImplementation(async () => current);
  vi.mocked(tailscaleApi.dnsSave).mockImplementation(async (_tailnet, _before, after) => {
    current = after as Record<string, unknown>;
    return null;
  });
  renderWithClient(<DnsView />);
  const magic = await screen.findByText("MagicDNS: 꺼짐");
  fireEvent.click(within(magic.parentElement!).getByRole("button", { name: "켜기" }));
  expect(screen.getByText("POST /tailnet/-/dns/configuration")).toBeInTheDocument();
  expect(tailscaleApi.dnsSave).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "적용" }));
  await screen.findByRole("button", { name: "이전 구성으로 되돌리기" });
  expect(current.preferences).toEqual({ magicDNS: true, overrideLocalDNS: false });
  fireEvent.click(screen.getByRole("button", { name: "이전 구성으로 되돌리기" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "적용" }));
  await waitFor(() => expect(current.preferences).toEqual({ magicDNS: false }));
});

test("split resolver edits preview PATCH and restore resolver options through undo", async () => {
  vi.mocked(useTailscaleApi).mockReturnValue({ tailnet: "example.com", connected: true, isLoading: false });
  let current: Record<string, unknown> = {
    nameservers: [], searchPaths: [], preferences: {},
    splitDNS: { "corp.test": [{ address: "10.0.0.1", useWithExitNode: false }] },
  };
  vi.mocked(tailscaleApi.dns).mockImplementation(async () => current);
  vi.mocked(tailscaleApi.dnsSplitSave).mockImplementation(async (_tailnet, _before, after) => {
    current = after as Record<string, unknown>;
    return null;
  });
  renderWithClient(<DnsView />);
  const domain = await screen.findByText("corp.test");
  const row = domain.closest("tr")!;
  fireEvent.change(within(row).getByLabelText("네임서버 주소"), { target: { value: "10.0.0.2" } });
  fireEvent.click(within(row).getByLabelText("Exit node에서도 사용"));
  fireEvent.click(within(row.closest("section")!).getByRole("button", { name: "변경 미리보기" }));
  let dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("PATCH /tailnet/-/dns/split-dns")).toBeInTheDocument();
  expect(within(dialog).getByText("POST /tailnet/-/dns/configuration")).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "적용" }));
  await screen.findByRole("button", { name: "이전 구성으로 되돌리기" });
  expect(tailscaleApi.dnsSplitSave).toHaveBeenCalledWith("example.com", expect.anything(), expect.anything(), {
    "corp.test": ["10.0.0.2"],
  });
  fireEvent.click(screen.getByRole("button", { name: "이전 구성으로 되돌리기" }));
  dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("PATCH /tailnet/-/dns/split-dns")).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "적용" }));
  await waitFor(() => expect(current.splitDNS).toEqual({
    "corp.test": [{ address: "10.0.0.1", useWithExitNode: false }],
  }));
});
