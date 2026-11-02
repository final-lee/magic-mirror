import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { k8sApi } from "./api";
import { ShellTab } from "./ShellTab";
import {
  ATTACH_WARNING, SHELL_CANCEL, SHELL_CLOSE, SHELL_CONFIRM, SHELL_MODE_ATTACH, SHELL_OPEN, SHELL_PERMISSION_CHECKING, SHELL_TYPED_LABEL, noStreamPermission,
} from "./text";
import type { K8sContainer, K8sRules } from "./types";

// 터미널 자체는 PodTerminal.test에서 본다. 여기서는 열 때의 값만 기록하는 대역으로 바꾼다
const { opened } = vi.hoisted(() => ({ opened: [] as { container: string; mode: string; confirmText: string | null; visible: boolean }[] }));
vi.mock("./PodTerminal", () => ({
  PodTerminal: (p: { container: string; mode: string; confirmText: string | null; visible: boolean }) => {
    opened.push({ container: p.container, mode: p.mode, confirmText: p.confirmText, visible: p.visible });
    return <div data-testid="terminal" />;
  },
}));
vi.mock("./api", () => ({ k8sApi: { shellConfirmName: vi.fn() } }));
const m = vi.mocked(k8sApi);
const T = { profile: "app", region: "r", cluster: "c" };

const c = (name: string): K8sContainer => ({ name, image: "x", init: false, state: "running", ready: true, restarts: 0, reason: null, message: null, lastTermination: null });
const grant = (...resources: string[]): K8sRules => ({
  namespace: "dev", resourceRules: [{ verbs: ["create"], apiGroups: [""], resources, resourceNames: [] }], nonResourceRules: [], incomplete: false,
});

function setup(props: Partial<Parameters<typeof ShellTab>[0]> = {}) {
  render(<ShellTab target={T} ssoProfile="p" namespace="dev" pod="web-1" containers={[c("app"), c("side")]} rules={grant("pods/exec", "pods/attach")} visible {...props} />);
}

beforeEach(() => {
  opened.length = 0;
  // 입력해야 하는 이름은 백엔드가 정한다(위험하지 않으면 null)
  m.shellConfirmName.mockResolvedValue(null);
});

/** 확인 창이 이름을 물어본 뒤의 확인 버튼 */
const confirmButton = () => screen.getByRole("button", { name: SHELL_CONFIRM });
async function opened_dialog() {
  fireEvent.click(screen.getByRole("button", { name: SHELL_OPEN }));
  await waitFor(() => expect(m.shellConfirmName).toHaveBeenCalled());
}

test("a safe target opens after one confirmation, on the chosen container", async () => {
  setup();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "side" } });
  await opened_dialog();
  expect(m.shellConfirmName).toHaveBeenCalledWith("dev", "web-1");
  await waitFor(() => expect(confirmButton()).toBeEnabled());
  expect(screen.queryByLabelText(SHELL_TYPED_LABEL)).not.toBeInTheDocument();
  expect(screen.queryByTestId("terminal")).not.toBeInTheDocument();
  fireEvent.click(confirmButton());
  expect(screen.getByTestId("terminal")).toBeInTheDocument();
  expect(opened[opened.length - 1]).toEqual({ container: "side", mode: "exec", confirmText: null, visible: true });
});

test("cancelling the confirmation opens nothing", async () => {
  setup();
  await opened_dialog();
  fireEvent.click(screen.getByRole("button", { name: SHELL_CANCEL }));
  expect(screen.queryByTestId("terminal")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: SHELL_OPEN })).toBeInTheDocument();
});

test("a dangerous target: the confirm button stays off until the name the backend asked for is typed, and the name goes along", async () => {
  m.shellConfirmName.mockResolvedValue("web-1");
  setup({ namespace: "kube-system" });
  await opened_dialog();
  const field = await screen.findByLabelText(SHELL_TYPED_LABEL);
  expect(confirmButton()).toBeDisabled();
  fireEvent.change(field, { target: { value: "web" } });
  expect(confirmButton()).toBeDisabled();
  fireEvent.change(field, { target: { value: "web-1" } });
  expect(confirmButton()).toBeEnabled();
  fireEvent.click(confirmButton());
  expect(opened[opened.length - 1].confirmText).toBe("web-1");
});

test("the confirm button waits until the backend has said whether a name is needed", async () => {
  let answer: (v: string | null) => void = () => {};
  m.shellConfirmName.mockImplementation(() => new Promise((r) => (answer = r)));
  setup();
  await opened_dialog();
  expect(confirmButton()).toBeDisabled();
  answer(null);
  await waitFor(() => expect(confirmButton()).toBeEnabled());
});

test("attach warns before opening and while the session runs", async () => {
  setup();
  fireEvent.click(screen.getByLabelText(SHELL_MODE_ATTACH));
  await opened_dialog();
  expect(screen.getByText(ATTACH_WARNING)).toBeInTheDocument();
  await waitFor(() => expect(confirmButton()).toBeEnabled());
  fireEvent.click(confirmButton());
  expect(opened[opened.length - 1]?.mode).toBe("attach");
  expect(screen.getByText(ATTACH_WARNING)).toBeInTheDocument();
});

test("without pods/exec permission the button is off and says why; attach has its own permission", () => {
  setup({ rules: grant("pods/attach") });
  expect(screen.getByRole("button", { name: SHELL_OPEN })).toBeDisabled();
  expect(screen.getByText(noStreamPermission("pods/exec"))).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText(SHELL_MODE_ATTACH));
  expect(screen.getByRole("button", { name: SHELL_OPEN })).toBeEnabled();
});

test("while the rules are unknown the button waits", () => {
  setup({ rules: undefined });
  expect(screen.getByRole("button", { name: SHELL_OPEN })).toBeDisabled();
  expect(screen.getByText(SHELL_PERMISSION_CHECKING)).toBeInTheDocument();
});

test("closing the session goes back to the form and ends the terminal", async () => {
  setup();
  await opened_dialog();
  await waitFor(() => expect(confirmButton()).toBeEnabled());
  fireEvent.click(confirmButton());
  fireEvent.click(screen.getByRole("button", { name: SHELL_CLOSE }));
  expect(screen.queryByTestId("terminal")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: SHELL_OPEN })).toBeInTheDocument();
});
