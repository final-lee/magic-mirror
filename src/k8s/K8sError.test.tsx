import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../test/utils";
import { K8sError } from "./K8sError";
import { refreshK8s } from "./queries";

vi.mock("./queries", () => ({ refreshK8s: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));

const T = { profile: "app", region: "r", cluster: "c" };

beforeEach(() => vi.mocked(refreshK8s).mockClear());

test("retry refreshes the target with the sso profile", () => {
  const qc = newQueryClient();
  render(
    <QueryClientProvider client={qc}>
      <K8sError error={{ kind: "other", message: "boom" }} target={T} ssoProfile="exec-p" />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  expect(refreshK8s).toHaveBeenCalledWith(qc, T, "exec-p");
});

test("a login success for the exec profile after the error appeared refreshes once", () => {
  const qc = newQueryClient();
  const ui = (at: number | null) =>
    withClientAndSso(<K8sError error={{ kind: "ssoExpired" }} target={T} ssoProfile="exec-p" />, qc, ssoLoginStub({ lastSuccessAt: (p) => (p === "exec-p" ? at : null) }));
  const at = Date.now() + 1000;
  const { rerender } = render(ui(null));
  expect(refreshK8s).not.toHaveBeenCalled();
  rerender(ui(at));
  rerender(ui(at));
  expect(refreshK8s).toHaveBeenCalledTimes(1);
  expect(refreshK8s).toHaveBeenCalledWith(qc, T, "exec-p");
});
