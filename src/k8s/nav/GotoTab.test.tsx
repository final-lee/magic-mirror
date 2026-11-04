import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api } from "../../api/client";
import type { Settings } from "../../api/types";
import { dispatchKey, resetKeymap } from "../../keymap/registry";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../../test/utils";
import { k8sApi } from "../api";
import { K8sTab } from "../K8sTab";
import { KIND_TREE_LABEL, NAV_ALL } from "../text";
import { NAV_HELM } from "../helm/text";
import type { K8sContextInfo, K8sKind, K8sRow, K8sSession, K8sTarget, K8sWatchMessage } from "../types";
import { TEST_KINDS } from "./testKinds";

vi.mock("../PodTerminal", () => ({ PodTerminal: () => null }));
vi.mock("../api", () => ({
  k8sApi: { context: vi.fn(), open: vi.fn(), close: vi.fn(), rules: vi.fn(), watch: vi.fn(), unwatch: vi.fn(), kinds: vi.fn(), get: vi.fn(), secretValue: vi.fn(), overview: vi.fn(), metrics: vi.fn(), preview: vi.fn(), apply: vi.fn() },
}));
vi.mock("../../api/client", () => ({ api: { getSettings: vi.fn(), saveSettings: vi.fn(), ssoLogin: vi.fn() } }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const m = vi.mocked(k8sApi);
let n = 0;
let target: K8sTarget;
const ARN = "arn:aws:eks:ap-northeast-2:1:cluster/prod";
const row = (name: string): K8sRow => ({ uid: name, name, namespace: null, resourceVersion: "1", createdAt: null, labels: {}, values: {}, problems: [] });
const info = (): K8sContextInfo => ({
  arn: ARN, endpoint: "https://x", version: "1.30", endpointPublic: true, endpointPrivate: false, publicCidrs: [], kubeconfigMissing: false, kubeconfigPaths: [],
  candidates: [{ name: "ctx", cluster: "ctx", user: "u", namespace: "default", execProfile: null }], chosen: null, savedMissing: null, updateCommand: "x",
});
const session = (): K8sSession => ({ context: "ctx", execProfile: null, serverVersion: "1.30", identity: { username: "alice", groups: [], arn: null, source: "selfSubjectReview" } });
const emptyOverview = { cluster: null, nodes: [], requestsPartial: false, metrics: false, nodegroups: [], fargateProfiles: [], nodePools: null, addons: [], insights: [], removedApis: null, nextVersion: null, skew: [], gaps: [] };

let emitNamespaces: (m: K8sWatchMessage) => void = () => {};
const emits = new Map<string, (m: K8sWatchMessage) => void>();
function setup({ hidden = false, kinds = TEST_KINDS }: { hidden?: boolean; kinds?: K8sKind[] | Error } = {}) {
  const seeded: Settings = { enabledServices: [], favorites: [], lastProfile: "app", lastRegion: null };
  vi.mocked(api.getSettings).mockResolvedValue(seeded);
  vi.mocked(api.saveSettings).mockResolvedValue(undefined as never);
  if (kinds instanceof Error) m.kinds.mockRejectedValue(kinds);
  else m.kinds.mockResolvedValue(kinds);
  const qc = newQueryClient();
  qc.setQueryData(["settings"], seeded);
  return render(withClientAndSso(<div hidden={hidden}><K8sTab target={target} active={!hidden} /></div>, qc, ssoLoginStub()));
}

beforeEach(() => {
  target = { profile: "app", region: "ap-northeast-2", cluster: `goto${n++}` };
  vi.clearAllMocks();
  resetKeymap();
  localStorage.clear();
  m.context.mockResolvedValue(info());
  m.open.mockResolvedValue(session());
  m.close.mockResolvedValue(null);
  m.rules.mockResolvedValue({ namespace: "default", incomplete: true, nonResourceRules: [], resourceRules: [] });
  m.overview.mockResolvedValue(emptyOverview);
  m.metrics.mockResolvedValue({ podsUnavailable: null, nodesUnavailable: null, pods: [], nodes: [] });
  m.unwatch.mockResolvedValue(null);
  m.watch.mockImplementation(async (_t, k, _n, _p, onMessage) => {
    emits.set(k.plural, onMessage);
    if (k.plural === "namespaces") emitNamespaces = onMessage;
    return m.watch.mock.calls.length;
  });
});

/** 키를 디스패처에 보낸다. 처리했으면 true */
function press(key: string, init: KeyboardEventInit = {}): boolean {
  let handled = false;
  act(() => {
    handled = dispatchKey(new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true, ...init }));
  });
  return handled;
}
const prompt = () => screen.queryByRole("textbox", { name: "이동 명령" }) as HTMLInputElement | null;
async function connected() {
  await screen.findByText("연결됨");
  await vi.waitFor(() => expect(m.watch).toHaveBeenCalled());
  act(() => emitNamespaces({ type: "reset", rows: [row("default"), row("kube-system"), row("prod")] }));
}
const submit = (text: string) => {
  press(":", { shiftKey: true });
  fireEvent.change(prompt()!, { target: { value: text } });
  fireEvent.keyDown(prompt()!, { key: "Enter" });
};
const nsSelect = () => screen.getByRole("combobox", { name: "네임스페이스" }) as HTMLSelectElement;

test(": opens the prompt at the top of the tab and Esc closes it, handing the cursor back", async () => {
  setup();
  await connected();
  const nav = screen.getByRole("button", { name: NAV_ALL });
  nav.focus();
  expect(press(":", { shiftKey: true })).toBe(true);
  expect(prompt()).toHaveFocus();
  fireEvent.keyDown(prompt()!, { key: "Escape" });
  expect(prompt()).toBeNull();
  await waitFor(() => expect(nav).toHaveFocus());
});

test(":deploy opens the workloads view on Deployments, :po goes back to Pods, and the cursor lands on the list", async () => {
  setup();
  await connected();
  submit("deploy");
  await vi.waitFor(() => expect(m.watch).toHaveBeenCalledWith(target, expect.objectContaining({ plural: "deployments" }), "default", expect.anything(), expect.any(Function)));
  const tree = within(screen.getByRole("navigation", { name: KIND_TREE_LABEL }));
  expect(tree.getByRole("button", { name: "Deployment" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("button", { name: NAV_ALL })).toHaveAttribute("aria-current", "page");
  expect(prompt()).toBeNull();
  act(() => emits.get("deployments")!({ type: "reset", rows: [row("web")] }));
  await waitFor(() => expect(screen.getByTestId("iam-list")).toHaveFocus());
  submit("po");
  expect(tree.getByRole("button", { name: "Pod" })).toHaveAttribute("aria-current", "page");
});

test("a kind name works from any menu, and goes to the workloads view", async () => {
  setup();
  await connected();
  submit("helm");
  expect(screen.getByRole("button", { name: NAV_HELM })).toHaveAttribute("aria-current", "page");
  submit("svc");
  expect(screen.getByRole("button", { name: NAV_ALL })).toHaveAttribute("aria-current", "page");
  await vi.waitFor(() => expect(m.watch).toHaveBeenCalledWith(target, expect.objectContaining({ plural: "services" }), "default", expect.anything(), expect.any(Function)));
});

test("choosing the same kind again from another menu brings it back", async () => {
  setup();
  await connected();
  submit("deploy");
  fireEvent.click(screen.getByRole("button", { name: "개요" }));
  // 메뉴로 직접 옮기면 All은 기본 종류(Pod)부터
  fireEvent.click(screen.getByRole("button", { name: NAV_ALL }));
  expect(within(screen.getByRole("navigation", { name: KIND_TREE_LABEL })).getByRole("button", { name: "Pod" })).toHaveAttribute("aria-current", "page");
  submit("deploy");
  expect(within(screen.getByRole("navigation", { name: KIND_TREE_LABEL })).getByRole("button", { name: "Deployment" })).toHaveAttribute("aria-current", "page");
});

test("a node link after a kind goto wins over the stale kind request", async () => {
  m.overview.mockResolvedValue({ ...emptyOverview, nodes: [{
    name: "ip-1", ready: true, unschedulable: false, pressures: [], instanceType: "m6i.large", zone: "a", groupKind: "managed", group: "ng",
    kubeletVersion: "v1.31.4", capacity: { cpuMilli: 2000, memoryBytes: 1000, pods: 29 }, allocatable: { cpuMilli: 2000, memoryBytes: 1000, pods: 29 },
    requested: { cpuMilli: 500, memoryBytes: 200, pods: 5 }, limits: { cpuMilli: 1000, memoryBytes: 400, pods: 5 }, usage: null,
  }] });
  setup();
  await connected();
  submit("deploy");
  submit("overview");
  fireEvent.click(await screen.findByRole("button", { name: "ip-1" }));
  expect(within(screen.getByRole("navigation", { name: KIND_TREE_LABEL })).getByRole("button", { name: "Node" })).toHaveAttribute("aria-current", "page");
  await vi.waitFor(() => expect(m.get).toHaveBeenCalledWith(target, expect.objectContaining({ plural: "nodes" }), null, "ip-1", expect.anything()));
});

test(":ns switches the namespace from the watched list, :ns all shows every namespace, an unknown one is refused", async () => {
  setup();
  await connected();
  expect(nsSelect().value).toBe("default");
  submit("ns kube-system");
  expect(nsSelect().value).toBe("kube-system");
  submit("ns all");
  expect(nsSelect().value).toBe("");
  press(":", { shiftKey: true });
  fireEvent.change(prompt()!, { target: { value: "ns nope" } });
  fireEvent.keyDown(prompt()!, { key: "Enter" });
  expect(screen.getByRole("alert")).toHaveTextContent("네임스페이스 'nope'");
  expect(prompt()).toBeInTheDocument();
  expect(nsSelect().value).toBe("");
});

test("an unknown kind is refused inline with the closest names, and nothing moves", async () => {
  setup();
  await connected();
  press(":", { shiftKey: true });
  fireEvent.change(prompt()!, { target: { value: "depoy" } });
  fireEvent.keyDown(prompt()!, { key: "Enter" });
  expect(screen.getByRole("alert")).toHaveTextContent("deploy");
  expect(screen.getByRole("button", { name: "개요" })).toHaveAttribute("aria-current", "page");
});

test("recent commands come back in the next prompt", async () => {
  setup();
  await connected();
  submit("ns prod");
  press(":", { shiftKey: true });
  expect(within(screen.getByRole("list", { name: "최근 명령" })).getByText("ns prod")).toBeInTheDocument();
  fireEvent.keyDown(prompt()!, { key: "ArrowUp" });
  expect(prompt()!.value).toBe("ns prod");
});

test("a typed colon stays out of inputs, and a hidden tab never opens the prompt", async () => {
  const first = setup();
  await connected();
  nsSelect().focus();
  expect(press(":", { shiftKey: true })).toBe(false);
  expect(prompt()).toBeNull();
  first.unmount();
  target = { ...target, cluster: `goto${n++}` };
  setup({ hidden: true });
  await vi.waitFor(() => expect(m.context).toHaveBeenCalled());
  expect(press(":", { shiftKey: true })).toBe(false);
  expect(prompt()).toBeNull();
});

test("no prompt before a context is chosen", async () => {
  m.context.mockResolvedValue({ ...info(), candidates: [{ name: "a", cluster: "a", user: "u", namespace: null, execProfile: null }, { name: "b", cluster: "b", user: "u", namespace: null, execProfile: null }] });
  setup();
  await screen.findByText(/context/i);
  expect(press(":", { shiftKey: true })).toBe(false);
});

test("while the kinds are not known yet, built-in aliases still work", async () => {
  setup({ kinds: new Error("no discovery") });
  await connected();
  submit("sts");
  await vi.waitFor(() => expect(m.watch).toHaveBeenCalledWith(target, expect.objectContaining({ plural: "statefulsets" }), "default", expect.anything(), expect.any(Function)));
});
