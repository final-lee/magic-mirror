import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api } from "../api/client";
import type { Settings } from "../api/types";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../test/utils";
import { k8sApi } from "./api";
import { K8sTab } from "./K8sTab";
import {
  ALL_NAMESPACES,
  ALL_NAMESPACES_NOTE,
  COPIED,
  COPY,
  CORE_GROUP,
  IDENTITY_FALLBACK,
  NO_CONTEXT,
  NO_KUBECONFIG,
  BAR_LABEL,
  RECHECK,
  RECONNECT,
  RULES_INCOMPLETE,
  SEVERAL_CONTEXTS,
  STATE_CONNECTED,
  STATE_CONNECTING,
  WILDCARD,
  profileMismatch,
  savedMissing,
} from "./text";
import type { K8sContextCandidate, K8sContextInfo, K8sRow, K8sRules, K8sSession, K8sTarget, K8sWatchMessage } from "./types";

vi.mock("./api", () => ({ k8sApi: { context: vi.fn(), open: vi.fn(), close: vi.fn(), rules: vi.fn(), watch: vi.fn(), unwatch: vi.fn() } }));
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
const ns = (name: string): K8sRow => ({ uid: name, name, namespace: null, resourceVersion: "1", createdAt: null, labels: {}, values: {} });

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
