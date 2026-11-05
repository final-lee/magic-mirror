import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ErrorState } from "../components/ErrorState";
import { renderWithClient } from "../test/utils";
import { tailscaleApi } from "./api";
import { DiagnoseTargetProvider } from "./DiagnoseContext";
import type { TsDiagnosis } from "./types";

vi.mock("./api", () => ({ tailscaleApi: { diagnose: vi.fn(), acceptRoutes: vi.fn() } }));

const url = "https://example.test";
const result: TsDiagnosis = {
  host: "example.test", port: 443, address: "10.0.0.1", tailnet: "example.net",
  verdict: "경로 받기가 꺼져 있어요", fix: "acceptRoutes",
  checks: ["cli", "backend", "dns", "route", "acceptRoutes", "peer", "ping", "tcp", "udp"].map((id, i) => ({
    id: id as TsDiagnosis["checks"][number]["id"], status: i === 4 ? "fail" : "ok", summary: `점검 ${id}`, detail: i === 4 ? "경로를 받아야 해요" : null,
  })),
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(tailscaleApi.diagnose).mockResolvedValue(result);
  vi.mocked(tailscaleApi.acceptRoutes).mockResolvedValue(null);
});

function box(error: unknown, target: string | null = url, compact = false) {
  return <DiagnoseTargetProvider value={target}><ErrorState error={error} profile="p" onRetry={() => {}} compact={compact} /></DiagnoseTargetProvider>;
}

const network = { kind: "network", message: "timeout" };

test("only network errors with a target offer diagnosis", () => {
  const view = renderWithClient(box(network, null));
  expect(screen.queryByRole("button", { name: "Tailscale 진단" })).not.toBeInTheDocument();
  view.rerender(box({ kind: "accessDenied", action: "read" }));
  expect(screen.queryByRole("button", { name: "Tailscale 진단" })).not.toBeInTheDocument();
  view.rerender(box({ kind: "other", message: "실패" }));
  expect(screen.queryByRole("button", { name: "Tailscale 진단" })).not.toBeInTheDocument();
  view.rerender(<ErrorState error={network} profile="p" onRetry={() => {}} />);
  expect(screen.queryByRole("button", { name: "Tailscale 진단" })).not.toBeInTheDocument();
  view.rerender(box(network));
  expect(screen.getByRole("button", { name: "Tailscale 진단" })).toBeInTheDocument();
  expect(tailscaleApi.diagnose).not.toHaveBeenCalled();
});

test.each([false, true])("expanding a network error shows verdict and checks (compact=%s)", async (compact) => {
  renderWithClient(box(network, url, compact));
  fireEvent.click(screen.getByRole("button", { name: "Tailscale 진단" }));
  expect(await screen.findByText(result.verdict)).toBeInTheDocument();
  expect(tailscaleApi.diagnose).toHaveBeenCalledWith(url);
  expect(screen.getByText(/example.test:443 → 10.0.0.1/)).toBeInTheDocument();
  expect(screen.getByText(/example.net/)).toBeInTheDocument();
  expect(screen.getAllByRole("listitem")).toHaveLength(9);
  expect(screen.getByText("경로를 받아야 해요")).toBeInTheDocument();
  expect(screen.getByLabelText("실패")).toHaveTextContent("✗");
});

test("route changes require confirmation, can be cancelled and undone", async () => {
  renderWithClient(box(network));
  fireEvent.click(screen.getByRole("button", { name: "Tailscale 진단" }));
  fireEvent.click(await screen.findByRole("button", { name: "경로 받기 켜기" }));
  expect(screen.getByText("tailscale set --accept-routes=true")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "취소" }));
  expect(tailscaleApi.acceptRoutes).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "경로 받기 켜기" }));
  fireEvent.click(screen.getByRole("button", { name: "적용" }));
  await waitFor(() => expect(tailscaleApi.acceptRoutes).toHaveBeenCalledWith(true));
  await waitFor(() => expect(tailscaleApi.diagnose).toHaveBeenCalledTimes(2));
  fireEvent.click(await screen.findByRole("button", { name: "되돌리기" }));
  expect(screen.getByText("tailscale set --accept-routes=false")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "적용" }));
  await waitFor(() => expect(tailscaleApi.acceptRoutes).toHaveBeenCalledWith(false));
  await waitFor(() => expect(tailscaleApi.diagnose).toHaveBeenCalledTimes(3));
});

test("command and apply errors remain visible", async () => {
  vi.mocked(tailscaleApi.diagnose).mockRejectedValueOnce({ kind: "other", message: "진단 실패" });
  renderWithClient(box(network));
  fireEvent.click(screen.getByRole("button", { name: "Tailscale 진단" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("진단 실패");
  fireEvent.click(screen.getByRole("button", { name: "다시 진단" }));
  fireEvent.click(await screen.findByRole("button", { name: "경로 받기 켜기" }));
  vi.mocked(tailscaleApi.acceptRoutes).mockRejectedValueOnce({ kind: "other", message: "적용 실패" });
  fireEvent.click(screen.getByRole("button", { name: "적용" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("적용 실패");
  expect(within(screen.getByLabelText("Tailscale 진단")).getByText("tailscale set --accept-routes=true")).toBeInTheDocument();
});
