import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { tailscaleApi } from "./api";
import { DiagnoseView } from "./DiagnoseView";

vi.mock("./api", () => ({ tailscaleApi: { diagnosticTool: vi.fn() } }));

test("DNS and identity tools show their own results and errors", async () => {
  vi.mocked(tailscaleApi.diagnosticTool).mockReset();
  vi.mocked(tailscaleApi.diagnosticTool).mockResolvedValueOnce("resolver: 100.100.100.100").mockRejectedValueOnce(new Error("조회 실패"));
  renderWithClient(<DiagnoseView />);
  fireEvent.change(screen.getByLabelText("도메인 이름"), { target: { value: "host.example" } });
  fireEvent.change(screen.getByLabelText("레코드 유형 (선택)"), { target: { value: "AAAA" } });
  fireEvent.click(screen.getByRole("button", { name: "DNS 질의" }));
  expect(await screen.findByText("resolver: 100.100.100.100")).toBeInTheDocument();
  expect(tailscaleApi.diagnosticTool).toHaveBeenCalledWith("dns-query", "host.example", "AAAA");
  fireEvent.click(screen.getByRole("button", { name: "내 신원" }));
  await waitFor(() => expect(screen.getByText("조회 실패")).toBeInTheDocument());
  expect(screen.getByText("resolver: 100.100.100.100")).toBeInTheDocument();
});

test("whoami JSON is shown as labelled rows with the raw text behind a toggle", async () => {
  vi.mocked(tailscaleApi.diagnosticTool).mockReset();
  vi.mocked(tailscaleApi.diagnosticTool).mockResolvedValueOnce(JSON.stringify({
    Node: { ComputedName: "mac", Name: "mac.example.ts.net.", Addresses: ["100.1.2.3/32"], MachineAuthorized: true, KeyExpiry: "2027-03-21T00:19:09Z" },
    UserProfile: { DisplayName: "Me", LoginName: "me@example.com" },
  }));
  renderWithClient(<DiagnoseView />);
  fireEvent.click(screen.getByRole("button", { name: "내 신원" }));
  expect(await screen.findByText("기기 이름")).toBeInTheDocument();
  expect(screen.getByText("mac.example.ts.net")).toBeInTheDocument();
  expect(screen.getByText("100.1.2.3")).toBeInTheDocument();
  expect(screen.getByText("승인됨")).toBeInTheDocument();
  expect(screen.getByText("원문 보기")).toBeInTheDocument();
});
