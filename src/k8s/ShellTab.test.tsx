import { fireEvent, render, screen } from "@testing-library/react";
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
});

test("a normal namespace opens after one confirmation, on the chosen container", () => {
  setup();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "side" } });
  fireEvent.click(screen.getByRole("button", { name: SHELL_OPEN }));
  expect(screen.queryByLabelText(SHELL_TYPED_LABEL)).not.toBeInTheDocument();
  expect(screen.queryByTestId("terminal")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: SHELL_CONFIRM }));
  expect(screen.getByTestId("terminal")).toBeInTheDocument();
  expect(opened[opened.length - 1]).toEqual({ container: "side", mode: "exec", confirmText: null, visible: true });
});

test("cancelling the confirmation opens nothing", () => {
  setup();
  fireEvent.click(screen.getByRole("button", { name: SHELL_OPEN }));
  fireEvent.click(screen.getByRole("button", { name: SHELL_CANCEL }));
  expect(screen.queryByTestId("terminal")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: SHELL_OPEN })).toBeInTheDocument();
});

test.each(["kube-system", "shop-prod"])("%s: the confirm button stays off until the exact pod name is typed, and the name goes along", (namespace) => {
  setup({ namespace });
  fireEvent.click(screen.getByRole("button", { name: SHELL_OPEN }));
  const confirm = screen.getByRole("button", { name: SHELL_CONFIRM });
  expect(confirm).toBeDisabled();
  fireEvent.change(screen.getByLabelText(SHELL_TYPED_LABEL), { target: { value: "web" } });
  expect(confirm).toBeDisabled();
  fireEvent.change(screen.getByLabelText(SHELL_TYPED_LABEL), { target: { value: "web-1" } });
  expect(confirm).toBeEnabled();
  fireEvent.click(confirm);
  expect(opened[opened.length - 1]?.confirmText).toBe("web-1");
});

test("attach warns before opening and while the session runs", () => {
  setup();
  fireEvent.click(screen.getByLabelText(SHELL_MODE_ATTACH));
  fireEvent.click(screen.getByRole("button", { name: SHELL_OPEN }));
  expect(screen.getByText(ATTACH_WARNING)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: SHELL_CONFIRM }));
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

test("closing the session goes back to the form and ends the terminal", () => {
  setup();
  fireEvent.click(screen.getByRole("button", { name: SHELL_OPEN }));
  fireEvent.click(screen.getByRole("button", { name: SHELL_CONFIRM }));
  fireEvent.click(screen.getByRole("button", { name: SHELL_CLOSE }));
  expect(screen.queryByTestId("terminal")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: SHELL_OPEN })).toBeInTheDocument();
});
