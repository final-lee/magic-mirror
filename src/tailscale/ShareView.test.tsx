import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { tailscaleApi } from "./api";
import { ShareView } from "./ShareView";

vi.mock("./api", () => ({ tailscaleApi: { shareRead: vi.fn(), sharePreview: vi.fn(), shareApply: vi.fn() } }));

const serveConfig = JSON.stringify({
  TCP: { "443": { HTTPS: true }, "2222": { TCPForward: "127.0.0.1:22" } },
  Web: { "mac.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:5476" } } } },
  AllowFunnel: { "mac.example.ts.net:443": true },
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(tailscaleApi.shareRead).mockImplementation(async (kind) => kind === "downloads" ? "/Users/me/Downloads" : kind === "cert-domains" ? '["node.example.ts.net"]' : "{}");
  vi.mocked(tailscaleApi.sharePreview).mockResolvedValue(["funnel", "reset"]);
  vi.mocked(tailscaleApi.shareApply).mockResolvedValue("");
});

test("reset previews the command and requires typed confirmation before applying", async () => {
  renderWithClient(<ShareView />);
  fireEvent.click(screen.getByRole("button", { name: "Funnel 초기화…" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("tailscale funnel reset");
  expect(tailscaleApi.shareApply).not.toHaveBeenCalled();
  const apply = within(dialog).getByRole("button", { name: "실행" });
  expect(apply).toBeDisabled();
  fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Funnel" } });
  fireEvent.click(apply);
  await waitFor(() => expect(tailscaleApi.shareApply).toHaveBeenCalledWith({ action: "funnel-reset" }));
});

test("serve status becomes a table with per-row removal and a Funnel column", async () => {
  vi.mocked(tailscaleApi.shareRead).mockImplementation(async (kind) => kind === "serve-status" ? serveConfig
    : kind === "funnel-status" ? "{}" : kind === "downloads" ? "/Users/me/Downloads" : kind === "cert-domains" ? "[]" : kind === "services" ? "[]" : "");
  vi.mocked(tailscaleApi.sharePreview).mockResolvedValue(["serve", "--bg", "--https=443", "off"]);
  renderWithClient(<ShareView />);
  const web = (await screen.findByText("mac.example.ts.net:443")).closest("tr")!;
  expect(within(web).getByText("http://127.0.0.1:5476")).toBeInTheDocument();
  expect(within(web).getByText("켜짐")).toBeInTheDocument();
  const tcp = screen.getByText("mac.example.ts.net:2222").closest("tr")!;
  expect(within(tcp).getByText("127.0.0.1:22")).toBeInTheDocument();
  expect(within(tcp).getByText("꺼짐")).toBeInTheDocument();
  fireEvent.click(within(web).getByRole("button", { name: /^제거/ }));
  await waitFor(() => expect(tailscaleApi.sharePreview).toHaveBeenCalledWith(
    { action: "mapping-off", target: "", port: "443", mode: "https", path: "", service: "" }));
  expect(await screen.findByRole("dialog")).toHaveTextContent("tailscale serve --bg --https=443 off");
});

test("shows empty states instead of blank sections", async () => {
  vi.mocked(tailscaleApi.shareRead).mockImplementation(async (kind) => kind === "services" ? "[]" : kind === "cert-domains" ? "[]" : "{}");
  renderWithClient(<ShareView />);
  expect(await screen.findByText("공유 중인 경로가 없어요")).toBeInTheDocument();
  expect(await screen.findByText("접근할 수 있는 Services가 없어요")).toBeInTheDocument();
});
