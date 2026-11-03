import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api } from "../api/client";
import { onSsoExpired } from "../api/invoke";
import type { Settings } from "../api/types";
import { typeYaml } from "../test/codemirror";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../test/utils";
import { k8sApi } from "./api";
import { K8sTab } from "./K8sTab";
import {
  ALL_NAMESPACES,
  NAV_EVENTS,
  NAV_MY_PERMISSIONS,
  NAV_ALL,
  NAV_OVERVIEW,
  BOOKMARK_MISSING,
  RESIZE_LANE,
  bookmarkAdd,
  SEC_NODES,
  ALL_NAMESPACES_NOTE,
  COPIED,
  COPY,
  CORE_GROUP,
  IDENTITY_FALLBACK,
  NO_CONTEXT,
  NO_KUBECONFIG,
  BAR_LABEL,
  KIND_TREE_LABEL,
  RECHECK,
  RECONNECT,
  RULES_INCOMPLETE,
  SEVERAL_CONTEXTS,
  STATE_CONNECTED,
  STATE_CONNECTING,
  WILDCARD,
  BATCH_APPLY,
  BATCH_DONE,
  CHANGE_DONE,
  YAML_CREATE,
  YAML_PREVIEW,
  profileMismatch,
  savedMissing,
} from "./text";
import { DEPLOYMENTS, EVENTS, NODES, PODS } from "./kinds";
import type { K8sContextCandidate, K8sContextInfo, K8sRow, K8sRules, K8sSession, K8sTarget, K8sWatchMessage } from "./types";

// 터미널(xterm)은 PodTerminal.test에서 본다
vi.mock("./PodTerminal", () => ({ PodTerminal: () => null }));
vi.mock("./api", () => ({
  k8sApi: { context: vi.fn(), open: vi.fn(), close: vi.fn(), rules: vi.fn(), watch: vi.fn(), unwatch: vi.fn(), kinds: vi.fn(), get: vi.fn(), secretValue: vi.fn(), overview: vi.fn(), preview: vi.fn(), apply: vi.fn() },
}));
vi.mock("../api/client", () => ({ api: { getSettings: vi.fn(), saveSettings: vi.fn(), ssoLogin: vi.fn() } }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const m = vi.mocked(k8sApi);
let n = 0;
let target: K8sTarget;
const ARN = "arn:aws:eks:ap-northeast-2:1:cluster/prod";

const cand = (name: string, over: Partial<K8sContextCandidate> = {}): K8sContextCandidate => ({ name, cluster: name, user: `${name}-user`, namespace: null, execProfile: null, ...over });
const info = (candidates: K8sContextCandidate[], over: Partial<K8sContextInfo> = {}): K8sContextInfo => ({
  arn: ARN, endpoint: "https://x", version: "1.30", endpointPublic: true, endpointPrivate: false, publicCidrs: [],
  kubeconfigMissing: false, kubeconfigPaths: [], candidates, chosen: null, savedMissing: null, updateCommand: "aws eks update-kubeconfig --name prod", ...over,
});
const session = (over: Partial<K8sSession> = {}): K8sSession => ({
  context: "ctx", execProfile: null, serverVersion: "1.30",
  identity: { username: "alice", groups: ["g1", "g2", "g3", "g4", "g5", "g6"], arn: null, source: "selfSubjectReview" }, ...over,
});
const rules = (over: Partial<K8sRules> = {}): K8sRules => ({
  namespace: "default", incomplete: false, nonResourceRules: [],
  resourceRules: [{ verbs: ["get", "list"], apiGroups: ["", "apps"], resources: ["pods"], resourceNames: [] }, { verbs: ["*"], apiGroups: ["*"], resources: ["*"], resourceNames: ["x"] }], ...over,
});
const ns = (name: string): K8sRow => ({ uid: name, name, namespace: null, resourceVersion: "1", createdAt: null, labels: {}, values: {}, problems: [] });
const emptyOverview = {
  cluster: null, nodes: [], requestsPartial: false, metrics: false, nodegroups: [], fargateProfiles: [], nodePools: null,
  addons: [], insights: [], removedApis: null, nextVersion: null, skew: [], gaps: [],
};
const openMyRules = () => fireEvent.click(screen.getByRole("button", { name: NAV_MY_PERMISSIONS }));

let emit: (m: K8sWatchMessage) => void = () => {};
let seeded: Settings;
function setup(settings: Partial<Settings> = {}, sso = ssoLoginStub()) {
  seeded = { enabledServices: [], favorites: [], lastProfile: "app", lastRegion: null, ...settings };
  vi.mocked(api.getSettings).mockResolvedValue(seeded);
  vi.mocked(api.saveSettings).mockResolvedValue(undefined as never);
  const qc = newQueryClient();
  qc.setQueryData(["settings"], seeded);
  const tree = () => withClientAndSso(<K8sTab target={target} active />, qc, sso);
  return { qc, ...render(tree()) };
}
const watchCalls = () => m.watch.mock.calls;
const sendNamespaces = (rows: K8sRow[]) => act(() => emit({ type: "reset", rows }));

beforeEach(() => {
  target = { profile: "app", region: "ap-northeast-2", cluster: `prod${n++}` };
  vi.clearAllMocks();
  m.open.mockResolvedValue(session());
  m.close.mockResolvedValue(null);
  m.rules.mockResolvedValue(rules());
  m.kinds.mockResolvedValue([]);
  m.overview.mockResolvedValue(emptyOverview);
  m.unwatch.mockResolvedValue(null);
  m.watch.mockImplementation(async (_t, _k, _n, _p, onMessage) => {
    emit = onMessage;
    return 1;
  });
});

test("no candidates shows the guide, copies the command, and rechecks", async () => {
  m.context.mockResolvedValue(info([]));
  setup();
  expect(await screen.findByText(NO_CONTEXT)).toBeInTheDocument();
  expect(screen.getByText("aws eks update-kubeconfig --name prod").tagName).toBe("CODE");
  fireEvent.click(screen.getByRole("button", { name: COPY }));
  expect(await screen.findByRole("button", { name: COPIED })).toBeInTheDocument();
  expect(writeText).toHaveBeenCalledWith("aws eks update-kubeconfig --name prod");
  fireEvent.click(screen.getByRole("button", { name: RECHECK }));
  await waitFor(() => expect(m.context).toHaveBeenCalledTimes(2));
});

test("no kubeconfig: empty candidates with tried paths shows the paths and the update command", async () => {
  m.context.mockResolvedValue(info([], { kubeconfigMissing: true, kubeconfigPaths: ["/a/config", "/b/config"] }));
  setup();
  expect(await screen.findByText(NO_KUBECONFIG(["/a/config", "/b/config"]))).toBeInTheDocument();
  expect(screen.getByText("aws eks update-kubeconfig --name prod").tagName).toBe("CODE");
});

test("files exist but none points at this cluster: no-context message, not the missing-file one", async () => {
  m.context.mockResolvedValue(info([], { kubeconfigPaths: ["/a/config"] }));
  setup();
  expect(await screen.findByText(NO_CONTEXT)).toBeInTheDocument();
  expect(screen.getByText("aws eks update-kubeconfig --name prod").tagName).toBe("CODE");
});

test("a single candidate auto-opens and still shows the saved-missing notice", async () => {
  m.context.mockResolvedValue(info([cand("ctx")]));
  setup({ k8sContexts: { [ARN]: "gone" } });
  expect(await screen.findByText(savedMissing("gone"))).toBeInTheDocument();
  await screen.findByText(STATE_CONNECTED);
});

test("several candidates: picking one saves it and opens with that context", async () => {
  m.context.mockResolvedValue(info([cand("a", { execProfile: "pa" }), cand("b")]));
  setup();
  expect(await screen.findByText(SEVERAL_CONTEXTS)).toBeInTheDocument();
  expect(screen.getByText("a-user")).toBeInTheDocument();
  expect(screen.getByText("pa")).toBeInTheDocument();
  fireEvent.click(screen.getByText("b").closest("button")!);
  await waitFor(() => expect(m.open).toHaveBeenCalledWith(target, null, "b", target.profile));
  expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ k8sContexts: { [ARN]: "b" } }));
});

test("a saved context that is gone shows the notice above the picker", async () => {
  m.context.mockResolvedValue(info([cand("a"), cand("b")]));
  setup({ k8sContexts: { [ARN]: "gone" } });
  expect(await screen.findByText(savedMissing("gone"))).toBeInTheDocument();
  expect(screen.getByText(SEVERAL_CONTEXTS)).toBeInTheDocument();
  expect(m.open).not.toHaveBeenCalled();
});

test("one candidate opens directly and the top bar shows context, identity, groups and state", async () => {
  m.context.mockResolvedValue(info([cand("ctx")]));
  let resolve!: (s: K8sSession) => void;
  m.open.mockReturnValue(new Promise((r) => (resolve = r)));
  setup();
  const bar = async () => within(await screen.findByRole("group", { name: BAR_LABEL }));
  expect(await (await bar()).findByText(STATE_CONNECTING)).toBeInTheDocument();
  await act(async () => resolve(session()));
  const b = await bar();
  expect(await b.findByText(STATE_CONNECTED)).toBeInTheDocument();
  expect(b.getByText("ctx")).toBeInTheDocument();
  const user = b.getByText("alice");
  expect(user.closest("[title]")).toHaveAttribute("title", "g1\ng2\ng3\ng4\ng5\ng6");
  expect(b.getByText("g4")).toBeInTheDocument();
  expect(b.queryByText("g5")).toBeNull();
  expect(b.getByText("+2")).toBeInTheDocument();
});

test("profile mismatch is noted only when the exec profile differs", async () => {
  m.context.mockResolvedValue(info([cand("ctx", { execProfile: "other" })]));
  m.open.mockResolvedValue(session({ execProfile: "other" }));
  const first = setup();
  expect(await screen.findByText(profileMismatch("other", "app"))).toBeInTheDocument();
  first.unmount();
  target = { ...target, cluster: `prod${n++}` };
  m.open.mockResolvedValue(session({ execProfile: "app" }));
  m.context.mockResolvedValue(info([cand("ctx", { execProfile: "app" })]));
  setup();
  await screen.findByText(STATE_CONNECTED);
  expect(screen.queryByText(/kubeconfig는 프로필/)).toBeNull();
});

test("kubeconfig identity shows the fallback note", async () => {
  m.context.mockResolvedValue(info([cand("ctx")]));
  m.open.mockResolvedValue(session({ identity: { username: "u", groups: [], arn: null, source: "kubeconfig" } }));
  setup();
  expect(await screen.findByText(IDENTITY_FALLBACK)).toBeInTheDocument();
});

test("sso expiry on open shows the login for the exec profile and retry refreshes", async () => {
  m.context.mockResolvedValue(info([cand("ctx", { execProfile: "exec-p" })]));
  m.open.mockRejectedValue({ kind: "ssoExpired" });
  const sso = ssoLoginStub();
  setup({}, sso);
  fireEvent.click(await screen.findByRole("button", { name: "로그인" }));
  expect(sso.start).toHaveBeenCalledWith("exec-p", { manual: true });
  expect(m.open).toHaveBeenCalledTimes(1);
  m.open.mockResolvedValue(session());
  fireEvent.click(screen.getByRole("button", { name: RECONNECT }));
  await waitFor(() => expect(m.close).toHaveBeenCalled());
  await waitFor(() => expect(m.open).toHaveBeenCalledTimes(2));
});

test("namespace selector lists namespaces and defaults to the context namespace, else default, else all", async () => {
  m.context.mockResolvedValue(info([cand("ctx", { namespace: "team" })]));
  const first = setup();
  await screen.findByText(STATE_CONNECTED);
  await waitFor(() => expect(watchCalls()).toHaveLength(1));
  await sendNamespaces([ns("default"), ns("team"), ns("kube-system")]);
  const select = screen.getByRole("combobox") as HTMLSelectElement;
  expect(select.value).toBe("team");
  expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([ALL_NAMESPACES, "default", "kube-system", "team"]);
  openMyRules();
  await waitFor(() => expect(m.rules).toHaveBeenCalledWith(target, "team", target.profile));
  first.unmount();

  target = { ...target, cluster: `prod${n++}` };
  m.context.mockResolvedValue(info([cand("ctx")]));
  const second = setup();
  await screen.findByText(STATE_CONNECTED);
  await waitFor(() => expect(watchCalls().length).toBeGreaterThan(1));
  await sendNamespaces([ns("default"), ns("x")]);
  await waitFor(() => expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("default"));
  second.unmount();

  target = { ...target, cluster: `prod${n++}` };
  setup();
  await screen.findByText(STATE_CONNECTED);
  await waitFor(() => expect(watchCalls().length).toBeGreaterThan(2));
  await sendNamespaces([ns("x")]);
  expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("");
});

test("my rules: one row per group and resource, core and wildcard words, all-namespaces note, incomplete notice", async () => {
  m.context.mockResolvedValue(info([cand("ctx")]));
  m.rules.mockResolvedValue(rules({ incomplete: true }));
  setup();
  await screen.findByText(STATE_CONNECTED);
  openMyRules();
  expect(await screen.findByText(RULES_INCOMPLETE)).toBeInTheDocument();
  expect(screen.getByText(ALL_NAMESPACES_NOTE)).toBeInTheDocument();
  expect(m.rules).toHaveBeenCalledWith(target, "default", target.profile);
  const rows = screen.getAllByRole("row").slice(1);
  expect(rows).toHaveLength(3);
  expect(within(rows[0]).getByText("get, list")).toBeInTheDocument();
  expect(within(rows[0]).getByText(CORE_GROUP)).toBeInTheDocument();
  expect(within(rows[1]).getByText("apps")).toBeInTheDocument();
  expect(within(rows[2]).getAllByText(WILDCARD)).toHaveLength(3);
  expect(within(rows[2]).getByText("x")).toBeInTheDocument();
  await sendNamespaces([ns("default")]);
  await waitFor(() => expect(screen.queryByText(ALL_NAMESPACES_NOTE)).toBeNull());
});

test("reconnect closes, reopens once, and lists the namespaces again", async () => {
  m.context.mockResolvedValue(info([cand("ctx")]));
  setup();
  await screen.findByText(STATE_CONNECTED);
  await waitFor(() => expect(watchCalls()).toHaveLength(1));
  await sendNamespaces([ns("default"), ns("one")]);
  expect(screen.getByRole("option", { name: "one" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: RECONNECT }));
  await waitFor(() => expect(m.close).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(m.open).toHaveBeenCalledTimes(2));
  expect(m.close.mock.invocationCallOrder[0]).toBeLessThan(m.open.mock.invocationCallOrder[1]);
  await waitFor(() => expect(watchCalls()).toHaveLength(2));
  await act(async () => {});
  expect(watchCalls()).toHaveLength(2);
  expect(screen.queryByRole("option", { name: "one" })).toBeNull();
  await sendNamespaces([ns("default"), ns("two")]);
  expect(screen.getByRole("option", { name: "two" })).toBeInTheDocument();
});

test("a fatal watch error shows a compact error above the selector", async () => {
  m.context.mockResolvedValue(info([cand("ctx")]));
  setup();
  await screen.findByText(STATE_CONNECTED);
  await waitFor(() => expect(watchCalls()).toHaveLength(1));
  act(() => emit({ type: "error", error: { kind: "other", message: "watch broke" }, fatal: true }));
  expect(await screen.findByText("watch broke")).toBeInTheDocument();
});

test("a non-fatal stall error shows as a banner and goes away after the next changes", async () => {
  m.context.mockResolvedValue(info([cand("ctx")]));
  setup();
  await screen.findByText(STATE_CONNECTED);
  await waitFor(() => expect(watchCalls()).toHaveLength(1));
  await sendNamespaces([ns("default")]);
  act(() => emit({ type: "error", error: { kind: "network", message: "stalled list" }, fatal: false } as K8sWatchMessage));
  expect(await screen.findByText(/stalled list/)).toBeInTheDocument();
  expect(screen.getByText(STATE_CONNECTED)).toBeInTheDocument();
  act(() => emit({ type: "changes", upserts: [ns("two")], deletes: [] }));
  await waitFor(() => expect(screen.queryByText(/stalled list/)).not.toBeInTheDocument());
});

test("ssoExpired over the watch channel reports the exec profile", async () => {
  const seen: string[] = [];
  const off = onSsoExpired((p) => seen.push(p));
  m.context.mockResolvedValue(info([cand("ctx", { execProfile: "exec-p" })]));
  setup();
  await screen.findByText(STATE_CONNECTED);
  await waitFor(() => expect(watchCalls()).toHaveLength(1));
  act(() => emit({ type: "error", error: { kind: "ssoExpired" }, fatal: false } as K8sWatchMessage));
  act(() => emit({ type: "error", error: { kind: "ssoExpired" }, fatal: false } as K8sWatchMessage));
  expect(seen).toEqual(["exec-p"]);
  off();
});

test("reconnecting does not ask the rules before the session is open again", async () => {
  m.context.mockResolvedValue(info([cand("ctx")]));
  setup();
  await screen.findByText(STATE_CONNECTED);
  openMyRules();
  await waitFor(() => expect(m.rules).toHaveBeenCalledTimes(1));
  let release!: (s: K8sSession) => void;
  m.open.mockImplementationOnce(() => new Promise((r) => (release = r)));
  m.rules.mockRejectedValue({ kind: "other", message: "먼저 연결해 주세요" });
  fireEvent.click(screen.getByRole("button", { name: RECONNECT }));
  await waitFor(() => expect(m.close).toHaveBeenCalled());
  await waitFor(() => expect(m.open).toHaveBeenCalledTimes(2));
  expect(m.rules).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("먼저 연결해 주세요")).not.toBeInTheDocument();
  m.rules.mockResolvedValue(rules());
  release(session());
  await waitFor(() => expect(m.rules).toHaveBeenCalledTimes(2));
});

test("the context is not read until the settings have loaded", async () => {
  m.context.mockResolvedValue(info([cand("ctx")]));
  let release!: (s: Settings) => void;
  vi.mocked(api.getSettings).mockImplementation(() => new Promise((r) => (release = r)));
  const qc = newQueryClient();
  render(withClientAndSso(<K8sTab target={target} active />, qc, ssoLoginStub()));
  await new Promise((r) => setTimeout(r, 20));
  expect(m.context).not.toHaveBeenCalled();
  release({ enabledServices: [], favorites: [], lastProfile: "app", lastRegion: null, kubeconfigPath: "/kc" });
  await waitFor(() => expect(m.context).toHaveBeenCalledWith(target, "/kc", null));
});

test("opens on the overview once connected", async () => {
  m.context.mockResolvedValue(info([cand("ctx")]));
  setup();
  await screen.findByText(STATE_CONNECTED);
  await waitFor(() => expect(m.overview).toHaveBeenCalledWith(target));
  expect(await screen.findByText(SEC_NODES)).toBeInTheDocument();
  expect(m.rules).not.toHaveBeenCalled();
  await waitFor(() => expect(m.kinds).toHaveBeenCalledWith(target, target.profile));
});

test("the nav switches to All (pods) and events", async () => {
  m.context.mockResolvedValue(info([cand("ctx")]));
  setup();
  await screen.findByText(STATE_CONNECTED);
  fireEvent.click(screen.getByRole("button", { name: NAV_ALL }));
  await waitFor(() => expect(watchCalls().some((c) => c[1].plural === PODS.plural)).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: NAV_EVENTS }));
  await waitFor(() => expect(watchCalls().some((c) => c[1].plural === EVENTS.plural)).toBe(true));
});

test("a node name in the overview opens its detail in workloads", async () => {
  m.context.mockResolvedValue(info([cand("ctx")]));
  m.overview.mockResolvedValue({ ...emptyOverview, nodes: [{
    name: "ip-1", ready: true, unschedulable: false, pressures: [], instanceType: null, zone: null, groupKind: "self", group: null, kubeletVersion: "v1.31.0",
    allocatable: { cpuMilli: 1000, memoryBytes: 1, pods: 1 }, requested: { cpuMilli: 0, memoryBytes: 0, pods: 0 }, usage: null,
  }] });
  m.get.mockResolvedValue({ kind: NODES, row: ns("ip-1"), annotations: {}, owners: [], children: [], childrenTruncated: false, childrenError: null, containers: [], conditions: [], events: [], eventsError: null, yaml: "", editYaml: "", secretKeys: null });
  setup();
  fireEvent.click(await screen.findByRole("button", { name: "ip-1" }));
  await waitFor(() => expect(m.get).toHaveBeenCalledWith(target, NODES, null, "ip-1", target.profile));
  expect(screen.getByRole("button", { name: NAV_ALL })).toHaveAttribute("aria-current", "page");
});

test("a failed kinds discovery shows next to the workloads tree, and retry refetches only the kinds", async () => {
  m.context.mockResolvedValue(info([cand("ctx", { execProfile: "pa" })]));
  m.open.mockResolvedValue(session({ execProfile: "pa" }));
  m.kinds.mockRejectedValueOnce({ kind: "other", message: "discovery broke" }).mockResolvedValue([]);
  setup();
  await screen.findByText(STATE_CONNECTED);
  fireEvent.click(screen.getByRole("button", { name: NAV_ALL }));
  expect(await screen.findByText("discovery broke")).toBeInTheDocument();
  expect(screen.getByRole("navigation", { name: KIND_TREE_LABEL })).toBeInTheDocument();
  await waitFor(() => expect(watchCalls().some((c) => c[1].plural === PODS.plural)).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  await waitFor(() => expect(m.kinds).toHaveBeenCalledTimes(2));
  expect(m.kinds).toHaveBeenLastCalledWith(target, "pa");
  await waitFor(() => expect(screen.queryByText("discovery broke")).toBeNull());
  expect(m.open).toHaveBeenCalledTimes(1);
  expect(m.close).not.toHaveBeenCalled();
});

test("after the exec profile logs in again, the failed kinds discovery is refetched", async () => {
  m.context.mockResolvedValue(info([cand("ctx", { execProfile: "pa" })]));
  m.open.mockResolvedValue(session({ execProfile: "pa" }));
  m.kinds.mockRejectedValueOnce({ kind: "ssoExpired" }).mockResolvedValue([]);
  seeded = { enabledServices: [], favorites: [], lastProfile: "app", lastRegion: null };
  vi.mocked(api.getSettings).mockResolvedValue(seeded);
  const qc = newQueryClient();
  qc.setQueryData(["settings"], seeded);
  const manager = ssoLoginStub();
  const at = Date.now() + 1000;
  const ui = (successProfile: string | null) => withClientAndSso(<K8sTab target={target} active />, qc, { ...manager, lastSuccessAt: (p) => (p === successProfile ? at : null) });
  const rendered = render(ui(null));
  await screen.findByText(STATE_CONNECTED);
  fireEvent.click(screen.getByRole("button", { name: NAV_ALL }));
  expect(await screen.findByText("SSO 세션이 만료됐어요 (pa)")).toBeInTheDocument();
  rendered.rerender(ui("app"));
  expect(m.kinds).toHaveBeenCalledTimes(1);
  rendered.rerender(ui("pa"));
  await waitFor(() => expect(m.kinds).toHaveBeenCalledTimes(2));
  expect(m.kinds).toHaveBeenLastCalledWith(target, "pa");
});

const navLabels = () => Array.from(screen.getByRole("navigation", { name: "클러스터 메뉴" }).querySelectorAll("button .iam-nav-label")).map((l) => l.textContent);

test("a star in All saves a bookmark after the earlier ones; the bookmark opens its kind without the tree", async () => {
  m.context.mockResolvedValue(info([cand("ctx")]));
  m.kinds.mockResolvedValue([{ ...PODS, verbs: ["list", "watch"], custom: false }, { ...DEPLOYMENTS, verbs: ["list", "watch"], custom: false }]);
  setup({ k8sBookmarks: [PODS] });
  await screen.findByText(STATE_CONNECTED);
  expect(navLabels().slice(0, 2)).toEqual(["Pod", NAV_OVERVIEW]);
  fireEvent.click(screen.getByRole("button", { name: NAV_ALL }));
  fireEvent.click(await screen.findByRole("button", { name: bookmarkAdd("Deployment") }));
  expect(api.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ k8sBookmarks: [PODS, DEPLOYMENTS] }));
  await waitFor(() => expect(navLabels().slice(0, 3)).toEqual(["Pod", "Deployment", NAV_OVERVIEW]));
  fireEvent.click(within(screen.getByRole("navigation", { name: "클러스터 메뉴" })).getByRole("button", { name: "Deployment" }));
  await waitFor(() => expect(watchCalls().some((c) => c[1].plural === DEPLOYMENTS.plural)).toBe(true));
  expect(screen.queryByRole("navigation", { name: KIND_TREE_LABEL })).toBeNull();
  expect(within(screen.getByRole("navigation", { name: "클러스터 메뉴" })).getByRole("button", { name: "Deployment" })).toHaveAttribute("aria-current", "page");
});

test("a bookmarked kind this cluster does not serve is disabled once the kinds are known", async () => {
  const widget = { group: "mm.example.com", version: "v1", kind: "Widget", plural: "widgets", namespaced: true };
  m.context.mockResolvedValue(info([cand("ctx")]));
  setup({ k8sBookmarks: [widget, PODS] });
  await screen.findByText(STATE_CONNECTED);
  await waitFor(() => expect(screen.getByRole("button", { name: "Widget" })).toBeDisabled());
  expect(screen.getByRole("button", { name: "Widget" })).toHaveAttribute("title", BOOKMARK_MISSING);
});

test("dragging the handle beside the menu resizes it and saves the width when released", async () => {
  m.context.mockResolvedValue(info([cand("ctx")]));
  setup();
  await screen.findByText(STATE_CONNECTED);
  const nav = screen.getByRole("navigation", { name: "클러스터 메뉴" });
  vi.spyOn(nav, "getBoundingClientRect").mockReturnValue({ width: 196 } as DOMRect);
  const [handle] = screen.getAllByRole("separator", { name: RESIZE_LANE });
  fireEvent.mouseDown(handle, { button: 0, clientX: 196 });
  fireEvent.mouseMove(window, { clientX: 250 });
  expect(nav.style.width).toBe("250px");
  expect(api.saveSettings).not.toHaveBeenCalled();
  fireEvent.mouseUp(window, { clientX: 250 });
  expect(api.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ k8sLaneWidths: { nav: 250 } }));
  expect(nav.style.width).toBe("250px");
});

test("create from YAML: the selected namespace fills in, and the document is previewed then applied", async () => {
  m.context.mockResolvedValue(info([cand("ctx", { namespace: "team" })]));
  m.preview.mockResolvedValue({ calls: [], diff: [], impact: ["ConfigMap c: 새 객체를 만듭니다"], warnings: [], confirmName: null, reversible: true, conflicts: [] });
  m.apply.mockResolvedValue({ logId: "log-1" });
  setup();
  await screen.findByText(STATE_CONNECTED);
  fireEvent.click(screen.getByRole("button", { name: YAML_CREATE }));
  typeYaml("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n");
  fireEvent.click(screen.getByRole("button", { name: YAML_PREVIEW }));
  await screen.findByText("ConfigMap c: 새 객체를 만듭니다");
  expect(m.preview).toHaveBeenCalledWith(target, expect.objectContaining({ type: "apply", name: "c", namespace: "team", force: false }), target.profile);
  fireEvent.click(screen.getByRole("button", { name: BATCH_APPLY(1) }));
  await screen.findByText(BATCH_DONE);
  expect(m.apply).toHaveBeenCalledWith(target, expect.objectContaining({ name: "c", namespace: "team" }), null, null, target.profile);
  expect(await screen.findByText(CHANGE_DONE)).toBeInTheDocument();
});
