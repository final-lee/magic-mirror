import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../test/utils";
import { k8sApi } from "./api";
import { DEPLOYMENTS, NODES, PODS } from "./kinds";
import { BACK, CAT_CUSTOM, KIND_TREE_LABEL, TAB_SUMMARY, TAB_YAML } from "./text";
import type { K8sKind, K8sObjectView, K8sRow, K8sWatchMessage } from "./types";
import { WorkloadsView, type WorkloadsFocus } from "./WorkloadsView";

vi.mock("./api", () => ({ k8sApi: { watch: vi.fn(), unwatch: vi.fn(), get: vi.fn(), rules: vi.fn(), secretValue: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
const m = vi.mocked(k8sApi);
let n = 0;
let T = { profile: "app", region: "r", cluster: "c" };

const row = (name: string): K8sRow => ({ uid: `u-${name}`, name, namespace: "prod", resourceVersion: "7", createdAt: null, labels: {}, values: {}, problems: [] });
const view = (name: string, over: Partial<K8sObjectView> = {}): K8sObjectView => ({
  kind: PODS, row: row(name), annotations: {}, owners: [], children: [], childrenTruncated: false, childrenError: null,
  containers: [], conditions: [], events: [], eventsError: null, yaml: "", secretKeys: null, ...over,
});
const emits = new Map<string, (msg: K8sWatchMessage) => void>();

beforeEach(() => {
  vi.clearAllMocks();
  T = { ...T, cluster: `c${n++}` };
  m.unwatch.mockResolvedValue(null);
  m.watch.mockImplementation(async (_t, kind, _ns, _p, onMessage) => {
    emits.set(kind.plural, onMessage);
    return 1;
  });
});

const LANES = { width: () => undefined, resize: vi.fn(), commit: vi.fn() };

function setup(props: Partial<Parameters<typeof WorkloadsView>[0]> = {}) {
  const ui = (p: Partial<Parameters<typeof WorkloadsView>[0]>) =>
    withClientAndSso(
      <WorkloadsView target={T} context="ctx" sessionEpoch={1} ssoProfile="p" live namespace="prod" kinds={[]} focus={null} bookmarked={new Set()} onToggleBookmark={vi.fn()} lanes={LANES} {...props} {...p} />,
      qc,
      ssoLoginStub(),
    );
  const qc = newQueryClient();
  const r = render(ui({}));
  return { rerender: (p: Partial<Parameters<typeof WorkloadsView>[0]>) => r.rerender(ui(p)) };
}
const send = (plural: string, msg: K8sWatchMessage) => act(() => emits.get(plural)!(msg));

test("starts on pods, opens a row, follows an owner, and goes back", async () => {
  m.get.mockImplementation(async (_t, kind, _ns, name) =>
    kind.plural === "pods" ? view(name, { owners: [{ group: "apps", version: "v1", kind: "ReplicaSet", name: "rs1", namespace: "prod", uid: "r", controller: true, problems: [] }] }) : view(name, { kind }),
  );
  setup();
  await vi.waitFor(() => expect(m.watch).toHaveBeenCalledWith(T, PODS, "prod", "p", expect.any(Function)));
  send("pods", { type: "reset", rows: [row("web-1")] });
  fireEvent.click(screen.getByText("web-1"));
  await vi.waitFor(() => expect(m.get).toHaveBeenCalledWith(T, PODS, "prod", "web-1", "p"));
  fireEvent.click(await screen.findByRole("button", { name: "ReplicaSet/rs1" }));
  await vi.waitFor(() => expect(m.get).toHaveBeenLastCalledWith(T, expect.objectContaining({ plural: "replicasets" }), "prod", "rs1", "p"));
  fireEvent.click(screen.getByRole("button", { name: BACK }));
  expect(await screen.findByRole("button", { name: "ReplicaSet/rs1" })).toBeInTheDocument();
});

test("changing kind watches that kind and closes the detail", async () => {
  m.get.mockResolvedValue(view("web-1"));
  setup({ namespace: null });
  await vi.waitFor(() => expect(m.watch).toHaveBeenCalled());
  send("pods", { type: "reset", rows: [row("web-1")] });
  fireEvent.click(screen.getByText("web-1"));
  await vi.waitFor(() => expect(m.get).toHaveBeenCalled());
  fireEvent.click(within(screen.getByRole("navigation", { name: KIND_TREE_LABEL })).getByRole("button", { name: "Deployment" }));
  await vi.waitFor(() => expect(m.watch).toHaveBeenCalledWith(T, DEPLOYMENTS, null, "p", expect.any(Function)));
  expect(screen.queryByRole("tab")).toBeNull();
});

test("a bookmark view shows only its kind, without the kind tree", async () => {
  setup({ fixedKind: DEPLOYMENTS });
  await vi.waitFor(() => expect(m.watch).toHaveBeenCalledWith(T, DEPLOYMENTS, "prod", "p", expect.any(Function)));
  expect(screen.queryByRole("navigation", { name: KIND_TREE_LABEL })).toBeNull();
  expect(m.watch).not.toHaveBeenCalledWith(T, PODS, expect.anything(), expect.anything(), expect.anything());
});

test("cluster-scoped kinds watch all namespaces", async () => {
  setup({ focus: { ref: { kind: NODES, namespace: null, name: "ip-1" }, nonce: 1 } });
  await vi.waitFor(() => expect(m.watch).toHaveBeenCalledWith(T, NODES, null, "p", expect.any(Function)));
});

test("a new focus opens that object", async () => {
  m.get.mockResolvedValue(view("ip-1", { kind: NODES }));
  const { rerender } = setup();
  const focus: WorkloadsFocus = { ref: { kind: NODES, namespace: null, name: "ip-1" }, nonce: 1 };
  rerender({ focus });
  await vi.waitFor(() => expect(m.get).toHaveBeenCalledWith(T, NODES, null, "ip-1", "p"));
});

test("custom kinds appear in the tree", async () => {
  const widget: K8sKind = { group: "mm.example.com", version: "v1", kind: "Widget", plural: "widgets", namespaced: true, verbs: ["list", "watch"], custom: true };
  setup({ kinds: [widget] });
  expect(screen.getByText("mm.example.com")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Widget" }));
  await vi.waitFor(() => expect(m.watch).toHaveBeenCalledWith(T, { group: "mm.example.com", version: "v1", kind: "Widget", plural: "widgets", namespaced: true }, "prod", "p", expect.any(Function)));
  expect(screen.getByText(CAT_CUSTOM)).toBeInTheDocument();
});

test("watched updates refetch the selected detail and switching objects resets its tab", async () => {
  m.get.mockImplementation(async (_t, _kind, _ns, name) => view(name));
  setup();
  await vi.waitFor(() => expect(m.watch).toHaveBeenCalled());
  send("pods", { type: "reset", rows: [row("first"), row("second")] });
  fireEvent.click(screen.getByText("first"));
  await vi.waitFor(() => expect(m.get).toHaveBeenCalledTimes(1));
  send("pods", { type: "reset", rows: [{ ...row("first"), resourceVersion: "8" }, row("second")] });
  await vi.waitFor(() => expect(m.get).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("tab", { name: TAB_YAML }));
  fireEvent.click(screen.getByText("second"));
  expect(screen.getByRole("tab", { name: TAB_SUMMARY })).toHaveAttribute("aria-selected", "true");
  await vi.waitFor(() => expect(m.get).toHaveBeenLastCalledWith(T, PODS, "prod", "second", "p"));
});
