import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { desktop } from "../api/desktop";
import { renderWithClient } from "../test/utils";
import { tailscaleApi } from "./api";
import { LockControls } from "./LockControls";
import type { TsLock } from "./keyTypes";

vi.mock("./api", () => ({ tailscaleApi: { lockChange: vi.fn(), lockHistory: vi.fn(), lockInit: vi.fn() } }));
vi.mock("../api/desktop", () => ({ desktop: { copy: vi.fn() } }));
const lock: TsLock = { enabled: true, publicKey: "tlpub:abc", nodeKeySigned: true, thisKeyTrusted: true, trustedKeys: 1, needsSignature: [] };

test("signing requires a trusted node and an explicit command confirmation", async () => {
  vi.mocked(tailscaleApi.lockChange).mockResolvedValue("");
  const view = renderWithClient(<LockControls lock={{ ...lock, thisKeyTrusted: false }} />);
  fireEvent.change(screen.getByLabelText("서명할 노드 키"), { target: { value: "nodekey:abc" } });
  expect(screen.getByRole("button", { name: "노드 서명" })).toBeDisabled();
  view.rerender(<QueryClientProvider client={view.qc}><LockControls lock={lock} /></QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: "노드 서명" }));
  const dialog = screen.getByRole("dialog");
  expect(dialog).toHaveTextContent("tailscale lock sign 'nodekey:abc'");
  expect(tailscaleApi.lockChange).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "실행" }));
  await waitFor(() => expect(tailscaleApi.lockChange).toHaveBeenCalledWith("sign-node", "nodekey:abc"));
});

test("initialization previews the self key and shows generated secrets only in the result sheet", async () => {
  const own = `tlpub:${"a".repeat(64)}`;
  const extra = `tlpub:${"b".repeat(64)}`;
  const secret = `disablement-secret:${"A".repeat(64)}`;
  vi.mocked(tailscaleApi.lockInit).mockResolvedValue(`Initialization complete.\n${secret}\n`);
  vi.mocked(desktop.copy).mockResolvedValue(undefined);
  renderWithClient(<LockControls lock={{ ...lock, enabled: false, publicKey: own }} />);
  expect(screen.getByRole("button", { name: "변경 이력" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("추가로 신뢰할 공개 키 (한 줄에 하나)"), { target: { value: extra } });
  fireEvent.change(screen.getByLabelText("생성할 비활성화 비밀값 개수"), { target: { value: "2" } });
  fireEvent.click(screen.getByRole("button", { name: "Tailnet Lock 켜기" }));
  const dialog = screen.getByRole("dialog");
  expect(dialog).toHaveTextContent(`tailscale lock init --confirm --gen-disablements=2 '${own}' '${extra}'`);
  expect(tailscaleApi.lockInit).not.toHaveBeenCalled();
  fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "init" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "실행" }));
  expect(await within(dialog).findByText(secret)).toBeInTheDocument();
  expect(tailscaleApi.lockInit).toHaveBeenCalledWith([own, extra], 2);
  fireEvent.click(within(dialog).getByRole("button", { name: "복사" }));
  await waitFor(() => expect(desktop.copy).toHaveBeenCalledWith(secret));
  fireEvent.click(within(dialog).getByRole("button", { name: "닫기" }));
  expect(screen.queryByText(secret)).not.toBeInTheDocument();
});

test("a filtered peer signs its node key rather than its name", async () => {
  renderWithClient(<LockControls lock={{ ...lock, needsSignature: [{ name: "build-1", nodeKey: "nodekey:123" }] }} />);
  fireEvent.click(screen.getByRole("button", { name: "build-1 서명" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("tailscale lock sign 'nodekey:123'");
});
