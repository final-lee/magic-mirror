import { act, fireEvent, render, screen } from "@testing-library/react";
import { desktop } from "../api/desktop";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../test/utils";
import { k8sApi } from "./api";
import { ForwardPanel } from "./ForwardPanel";
import { FORWARD_BAD_PORT, FORWARD_CUSTOM, FORWARD_LOCAL, FORWARD_OPEN, FORWARD_OPEN_BROWSER, FORWARD_PORT, FORWARD_START, forwardOpened, noStreamPermission } from "./text";
import type { K8sForward, K8sPort, K8sRules } from "./types";

vi.mock("./api", () => ({ k8sApi: { forwardOpen: vi.fn() } }));
vi.mock("../api/desktop", () => ({ desktop: { openUrl: vi.fn(), copy: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
const m = vi.mocked(k8sApi);
const T = { profile: "app", region: "r", cluster: "c" };

const rules: K8sRules = { namespace: "dev", resourceRules: [{ verbs: ["create"], apiGroups: [""], resources: ["pods/portforward"], resourceNames: [] }], nonResourceRules: [], incomplete: false };
const ports: K8sPort[] = [
  { name: "http", port: 8080, container: "app", target: null },
  { name: null, port: 9090, container: "side", target: null },
];
const forward = (over: Partial<K8sForward> = {}): K8sForward => ({ id: 1, localPort: 18080, target: T, namespace: "dev", kind: "pod", name: "web-1", remotePort: 8080, pod: "web-1", error: null, ...over });

function setup(props: Partial<Parameters<typeof ForwardPanel>[0]> = {}) {
  render(
    withClientAndSso(
      <ForwardPanel target={T} ssoProfile="p" namespace="dev" kind="pod" name="web-1" ports={ports} rules={rules} {...props} />,
      newQueryClient(),
      ssoLoginStub(),
    ),
  );
}

beforeEach(() => vi.clearAllMocks());

test("the first declared port is preselected and the local port is automatic by default", async () => {
  m.forwardOpen.mockResolvedValue(forward());
  setup();
  fireEvent.click(screen.getByRole("button", { name: FORWARD_START }));
  fireEvent.click(screen.getByRole("button", { name: FORWARD_OPEN }));
  await act(async () => {});
  expect(m.forwardOpen).toHaveBeenCalledWith(T, { namespace: "dev", kind: "pod", name: "web-1", remotePort: 8080, localPort: null }, "p");
  expect(screen.getByText(forwardOpened("127.0.0.1:18080"))).toBeInTheDocument();
});

test("picks another declared port and a chosen local port", async () => {
  m.forwardOpen.mockResolvedValue(forward({ localPort: 5000, remotePort: 9090 }));
  setup();
  fireEvent.click(screen.getByRole("button", { name: FORWARD_START }));
  fireEvent.change(screen.getByLabelText(FORWARD_PORT), { target: { value: "9090" } });
  fireEvent.change(screen.getByLabelText(FORWARD_LOCAL), { target: { value: "5000" } });
  fireEvent.click(screen.getByRole("button", { name: FORWARD_OPEN }));
  await act(async () => {});
  expect(m.forwardOpen).toHaveBeenCalledWith(T, expect.objectContaining({ remotePort: 9090, localPort: 5000 }), "p");
});

test("a service forward sends the service kind and a typed port when none is declared", async () => {
  m.forwardOpen.mockResolvedValue(forward({ kind: "service", name: "web", remotePort: 80 }));
  setup({ kind: "service", name: "web", ports: [] });
  fireEvent.click(screen.getByRole("button", { name: FORWARD_START }));
  fireEvent.change(screen.getByLabelText(FORWARD_CUSTOM), { target: { value: "80" } });
  fireEvent.click(screen.getByRole("button", { name: FORWARD_OPEN }));
  await act(async () => {});
  expect(m.forwardOpen).toHaveBeenCalledWith(T, { namespace: "dev", kind: "service", name: "web", remotePort: 80, localPort: null }, "p");
});

test("a bad port is refused before anything is sent", async () => {
  setup({ ports: [] });
  fireEvent.click(screen.getByRole("button", { name: FORWARD_START }));
  fireEvent.change(screen.getByLabelText(FORWARD_CUSTOM), { target: { value: "99999" } });
  fireEvent.click(screen.getByRole("button", { name: FORWARD_OPEN }));
  expect(screen.getByText(FORWARD_BAD_PORT)).toBeInTheDocument();
  expect(m.forwardOpen).not.toHaveBeenCalled();
});

test("the opened forward can be opened in the browser", async () => {
  m.forwardOpen.mockResolvedValue(forward());
  setup();
  fireEvent.click(screen.getByRole("button", { name: FORWARD_START }));
  fireEvent.click(screen.getByRole("button", { name: FORWARD_OPEN }));
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: FORWARD_OPEN_BROWSER }));
  expect(desktop.openUrl).toHaveBeenCalledWith("http://127.0.0.1:18080");
});

test("a failed open shows the error", async () => {
  m.forwardOpen.mockRejectedValue({ kind: "other", message: "로컬 포트 80를 쓸 수 없어요" });
  setup();
  fireEvent.click(screen.getByRole("button", { name: FORWARD_START }));
  fireEvent.click(screen.getByRole("button", { name: FORWARD_OPEN }));
  await act(async () => {});
  expect(screen.getByText(/로컬 포트 80/)).toBeInTheDocument();
});

test("without pods/portforward permission the button is off and its reason is the tooltip", () => {
  setup({ rules: { ...rules, resourceRules: [] } });
  const b = screen.getByRole("button", { name: FORWARD_START });
  expect(b).toBeDisabled();
  expect(b).toHaveAttribute("title", noStreamPermission("pods/portforward"));
});
