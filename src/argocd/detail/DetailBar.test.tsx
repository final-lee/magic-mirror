import { fireEvent, screen, within } from "@testing-library/react";
import { renderWithClient } from "../../test/utils";
import { desktop } from "../../api/desktop";
import { readApi } from "./api";
import { DetailBar } from "./DetailBar";
import { ARGO_OPEN_UI, SW_ALLOWED, SW_BLOCKED, SW_PANEL_LABEL } from "./text";

vi.mock("./api", () => ({ readApi: { appLinks: vi.fn(), syncWindows: vi.fn() } }));
vi.mock("../../api/desktop", () => ({ desktop: { openUrl: vi.fn(), copy: vi.fn(), reveal: vi.fn() } }));
const m = vi.mocked(readApi);
const URL = "https://argocd.example";

const open = (onTokenError = vi.fn()) => renderWithClient(<DetailBar url={URL} namespace="argocd" name="web" version="1" live onTokenError={onTokenError} />);
const deny = { kind: "deny", schedule: "0 22 * * *", duration: "8h", manualSync: false };
const allow = { kind: "allow", schedule: "0 9 * * 1-5", duration: "2h", manualSync: true };

beforeEach(() => {
  vi.resetAllMocks();
  m.appLinks.mockResolvedValue([]);
  m.syncWindows.mockResolvedValue({ canSync: true, active: [], assigned: [] });
});

test("the ArgoCD web UI opens at the application page", () => {
  open();
  fireEvent.click(screen.getByRole("button", { name: ARGO_OPEN_UI }));
  expect(desktop.openUrl).toHaveBeenCalledWith("https://argocd.example/applications/argocd/web");
});

test("deep links from the server open in the browser", async () => {
  m.appLinks.mockResolvedValue([{ title: "Grafana", url: "https://grafana.example/d/web", description: "dashboards", iconClass: null }]);
  open();
  fireEvent.click(await screen.findByRole("button", { name: "Grafana" }));
  expect(desktop.openUrl).toHaveBeenCalledWith("https://grafana.example/d/web");
  expect(m.appLinks).toHaveBeenCalledWith(URL, "argocd", "web");
});

describe("sync window badge", () => {
  test("an app with no windows shows nothing", async () => {
    open();
    await screen.findByRole("button", { name: ARGO_OPEN_UI });
    expect(m.syncWindows).toHaveBeenCalledWith(URL, "argocd", "web");
    expect(screen.queryByRole("button", { name: SW_BLOCKED })).toBeNull();
    expect(screen.queryByRole("button", { name: SW_ALLOWED })).toBeNull();
  });

  test("a deny window that is active blocks sync and says so; the list explains each window", async () => {
    m.syncWindows.mockResolvedValue({ canSync: false, active: [deny], assigned: [deny, allow] });
    open();
    const badge = await screen.findByRole("button", { name: SW_BLOCKED });
    expect(badge).toHaveClass("argo-bad");
    expect(screen.queryByRole("list", { name: SW_PANEL_LABEL })).toBeNull();
    fireEvent.click(badge);
    const list = screen.getByRole("list", { name: SW_PANEL_LABEL });
    const [first, second] = within(list).getAllByRole("listitem");
    expect(first).toHaveTextContent("막는 시간(deny)");
    expect(first).toHaveTextContent("0 22 * * * 부터 8h");
    expect(first).toHaveTextContent("지금 켜져 있어요");
    expect(second).toHaveTextContent("허용하는 시간(allow)");
    expect(second).toHaveTextContent("수동 동기화는 허용돼요");
    expect(second).not.toHaveTextContent("지금 켜져 있어요");
  });

  test("windows that do not block right now are shown as a notice, not a block", async () => {
    m.syncWindows.mockResolvedValue({ canSync: true, active: [], assigned: [deny] });
    open();
    expect(await screen.findByRole("button", { name: SW_ALLOWED })).toHaveClass("argo-warn");
  });
});

test("a token error from either read is reported", async () => {
  const onTokenError = vi.fn();
  m.syncWindows.mockRejectedValue({ kind: "other", message: "ArgoCD 토큰이 만료됐거나 맞지 않아요. 새 토큰을 넣어 주세요" });
  open(onTokenError);
  await screen.findByRole("button", { name: ARGO_OPEN_UI });
  await vi.waitFor(() => expect(onTokenError).toHaveBeenCalledWith("ArgoCD 토큰이 만료됐거나 맞지 않아요. 새 토큰을 넣어 주세요"));
});
