import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../test/utils";
import { k8sApi } from "./api";
import { CONFIGMAPS, CRONJOBS, DAEMONSETS, DEPLOYMENTS, JOBS, NODES, PODS, PVCS, REPLICASETS, SECRETS, SERVICES, SERVICE_ACCOUNTS, STATEFULSETS } from "./kinds";
import { ObjectDetail } from "./ObjectDetail";
import {
  ANNOTATION_FOLD_LABEL, BACK, CHILDREN_TRUNCATED, CLOSE, LOG_ALL_CONTAINERS, LOG_CONTAINER, NO_RECENT_EVENTS, NO_SECRET_PERMISSION, OPEN_IN_IAM, SEC_CHILDREN, SEC_OWNERS, SEC_USAGE, SHOW_VALUE,
  CHANGE_NODE_SHELL, CHANGE_NODE_SHELL_IMAGE, FORWARD_OPEN, FORWARD_PORT, SHELL_OPEN, TAB_LOGS, TAB_SHELL, TAB_YAML, YAML_SECRET_NOTE, H_CPU_USAGE, H_MEMORY_USAGE, USAGE_LIMIT, USAGE_REQUEST, forwardPortLabel, noStreamPermission, openNode,
} from "./text";
import type { K8sContainer, K8sKind, K8sObjectView, K8sRow } from "./types";
import { buildUsageIndex } from "./usage";

vi.mock("./api", () => ({ k8sApi: { get: vi.fn(), rules: vi.fn(), secretValue: vi.fn(), logs: vi.fn(), workloadLogs: vi.fn(), unwatch: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
// 터미널(xterm)은 PodTerminal.test에서 본다
const terminalProps: Record<string, unknown>[] = [];
vi.mock("./PodTerminal", () => ({ PodTerminal: (p: Record<string, unknown>) => (terminalProps.push(p), null) }));
const m = vi.mocked(k8sApi);
const T = { profile: "app", region: "r", cluster: "c" };

const row = (over: Partial<K8sRow> = {}): K8sRow => ({ uid: "u1", name: "web-1", namespace: "prod", resourceVersion: "1", createdAt: "2026-10-30T11:00:00Z", labels: { app: "web" }, values: {}, problems: [], ...over });
const view = (over: Partial<K8sObjectView> = {}): K8sObjectView => ({
  kind: PODS, row: row(), annotations: {}, owners: [], children: [], childrenTruncated: false, childrenError: null,
  containers: [], conditions: [], events: [], eventsError: null, yaml: "apiVersion: v1\nkind: Pod\n", editYaml: "apiVersion: v1\nkind: Pod\n", secretKeys: null, ...over,
});
const widgetKind: K8sKind = { group: "mm.example.com", version: "v1", kind: "Widget", plural: "widgets", namespaced: true, verbs: ["list", "watch"], custom: true };

function setup(props: Partial<Parameters<typeof ObjectDetail>[0]> = {}) {
  const handlers = { onOpen: vi.fn(), onBack: vi.fn(), onClose: vi.fn(), onOpenIam: vi.fn() };
  render(
    withClientAndSso(
      <ObjectDetail target={T} context="ctx" ssoProfile="p" live objectRef={{ kind: PODS, namespace: "prod", name: "web-1" }} resourceVersion="1" kinds={[widgetKind]} now={Date.parse("2026-10-30T12:00:00Z")} {...handlers} {...props} />,
      newQueryClient(),
      ssoLoginStub(),
    ),
  );
  return handlers;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Pod·Service 상세가 셸·port-forward 버튼의 권한을 읽는다. 시험이 따로 정하지 않으면 아무 권한도 없다
  m.rules.mockResolvedValue({ namespace: "prod", resourceRules: [], nonResourceRules: [], incomplete: false });
});

test("change actions are there without any switch when the detail can start changes", async () => {
  m.get.mockResolvedValue(view());
  m.rules.mockResolvedValue({ namespace: "prod", resourceRules: [], nonResourceRules: [], incomplete: true });
  const qc = newQueryClient();
  const renderDetail = (onChange?: () => void) => withClientAndSso(
    <ObjectDetail target={T} context="ctx" ssoProfile="p" live objectRef={{ kind: PODS, namespace: "prod", name: "web-1" }} resourceVersion="1" kinds={[]} onOpen={vi.fn()} onBack={null} onClose={vi.fn()} onChange={onChange} />,
    qc, ssoLoginStub(),
  );
  const result = render(renderDetail(vi.fn()));
  expect(await screen.findByRole("button", { name: "삭제" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: TAB_SHELL })).toBeInTheDocument();
  result.rerender(renderDetail());
  expect(screen.queryByRole("button", { name: "삭제" })).not.toBeInTheDocument();
});

test("long annotations and last-applied-configuration start folded; expanding shows indented, colored JSON", async () => {
  const applied = JSON.stringify({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "web" } });
  const long = "x".repeat(400);
  m.get.mockResolvedValue(view({ annotations: { "kubectl.kubernetes.io/last-applied-configuration": applied, "note/long": long, "note/short": "hi" } }));
  setup();
  expect(await screen.findByText("hi")).toBeInTheDocument();
  expect(screen.queryByText(long)).toBeNull();
  const toggles = screen.getAllByRole("button", { name: /^펼치기/ });
  expect(toggles).toHaveLength(2);
  fireEvent.click(toggles[0]);
  const pre = document.querySelector(".k8s-annotation-open pre") as HTMLElement;
  expect(pre.textContent).toBe(JSON.stringify(JSON.parse(applied), null, 2));
  expect(within(pre).getByText('"apiVersion"')).toHaveClass("y-key");
  expect(within(pre).getByText('"apps/v1"')).toHaveClass("y-str");
  fireEvent.click(screen.getByRole("button", { name: ANNOTATION_FOLD_LABEL }));
  expect(screen.getAllByRole("button", { name: /^펼치기/ })).toHaveLength(2);
});

test("summary: values, owners, children, containers, conditions, events", async () => {
  m.get.mockResolvedValue(
    view({
      row: row({ values: { status: "CrashLoopBackOff", node: "ip-1" }, problems: ["crashLoopBackOff"] }),
      owners: [
        { group: "apps", version: "v1", kind: "ReplicaSet", name: "web-5d", namespace: "prod", uid: "rs1", controller: true, problems: [] },
        { group: "x.io", version: "v1", kind: "Thing", name: "t", namespace: "prod", uid: "t1", controller: false, problems: [] },
      ],
      children: [{ group: "mm.example.com", version: "v1", kind: "Widget", name: "w1", namespace: "prod", uid: "w", controller: false, problems: ["notReady"] }],
      childrenTruncated: true,
      containers: [{ name: "app", image: "nginx", init: false, state: "waiting", ready: false, restarts: 4, reason: "CrashLoopBackOff", message: null, lastTermination: { reason: "OOMKilled", exitCode: 137, finishedAt: null } }],
      conditions: [{ type: "Ready", status: "False", reason: "ContainersNotReady", message: null, lastTransition: null }],
      events: [{ type: "Warning", reason: "BackOff", message: "Back-off restarting", count: 3, lastSeen: "2026-10-30T11:59:00Z", source: "kubelet", object: "Pod/web-1" }],
    }),
  );
  const h = setup({ kinds: [widgetKind, { ...REPLICASETS, verbs: ["list", "watch"], custom: false }] });
  expect(await screen.findByText("CrashLoopBackOff", { selector: "dd" })).toBeInTheDocument();
  expect(m.get).toHaveBeenCalledWith(T, PODS, "prod", "web-1", "p");
  const owners = screen.getByRole("region", { name: SEC_OWNERS });
  fireEvent.click(within(owners).getByRole("button", { name: "ReplicaSet/web-5d" }));
  expect(h.onOpen).toHaveBeenCalledWith({ kind: expect.objectContaining({ kind: "ReplicaSet", plural: "replicasets" }), namespace: "prod", name: "web-5d" });
  expect(within(owners).getByText("Thing/t").tagName).not.toBe("BUTTON");
  const children = screen.getByRole("region", { name: SEC_CHILDREN });
  fireEvent.click(within(children).getByRole("button", { name: "Widget/w1" }));
  expect(h.onOpen).toHaveBeenLastCalledWith({ kind: { group: "mm.example.com", version: "v1", kind: "Widget", plural: "widgets", namespaced: true }, namespace: "prod", name: "w1" });
  expect(screen.getByText(CHILDREN_TRUNCATED)).toBeInTheDocument();
  expect(screen.getByText("OOMKilled (137)")).toBeInTheDocument();
  expect(screen.getByText("ContainersNotReady")).toBeInTheDocument();
  expect(screen.getByText("Back-off restarting")).toBeInTheDocument();
});

test("a pod shows usage graphs in the summary right below the basics, not in a tab", async () => {
  const rs = { group: "apps", version: "v1", kind: "ReplicaSet", name: "web-5d", namespace: "prod", uid: "rs1", controller: true, problems: [] };
  m.get.mockResolvedValue(view({ owners: [rs] }));
  setup();
  const usage = await screen.findByRole("region", { name: SEC_USAGE });
  const owners = screen.getByRole("region", { name: SEC_OWNERS });
  expect(usage.compareDocumentPosition(owners) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByRole("tab", { name: SEC_USAGE })).not.toBeInTheDocument();
});

test("a deployment summary has the usage graphs and a service summary does not", async () => {
  m.get.mockResolvedValue(view({ kind: DEPLOYMENTS }));
  setup({ objectRef: { kind: DEPLOYMENTS, namespace: "prod", name: "web" } });
  expect(await screen.findByRole("region", { name: SEC_USAGE })).toBeInTheDocument();
});

test("a service summary has no usage graphs", async () => {
  m.get.mockResolvedValue(view({ kind: SERVICES }));
  setup({ objectRef: { kind: SERVICES, namespace: "prod", name: "web" } });
  expect(await screen.findByText(NO_RECENT_EVENTS)).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: SEC_USAGE })).not.toBeInTheDocument();
});

test("pod node link and back/close", async () => {
  m.get.mockResolvedValue(view({ row: row({ values: { node: "ip-1" } }) }));
  const h = setup();
  fireEvent.click(await screen.findByRole("button", { name: openNode("ip-1") }));
  expect(h.onOpen).toHaveBeenCalledWith({ kind: NODES, namespace: null, name: "ip-1" });
  fireEvent.click(screen.getByRole("button", { name: BACK }));
  expect(h.onBack).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: CLOSE }));
  expect(h.onClose).toHaveBeenCalled();
});

test("no back button at the bottom of the stack; no events message", async () => {
  m.get.mockResolvedValue(view());
  setup({ onBack: null });
  expect(await screen.findByText(NO_RECENT_EVENTS)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: BACK })).toBeNull();
});

test("service account role opens IAM", async () => {
  m.get.mockResolvedValue(view({ kind: SERVICE_ACCOUNTS, row: row({ name: "web", values: { roleArn: "arn:aws:iam::1:role/web" } }) }));
  const h = setup({ objectRef: { kind: SERVICE_ACCOUNTS, namespace: "prod", name: "web" } });
  fireEvent.click(await screen.findByRole("button", { name: OPEN_IN_IAM }));
  expect(h.onOpenIam).toHaveBeenCalledWith("arn:aws:iam::1:role/web");
});

test("YAML tab is colored and keeps the text as is; pods get a logs tab", async () => {
  m.get.mockResolvedValue(view());
  setup();
  expect(await screen.findByRole("tab", { name: TAB_LOGS })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: TAB_YAML }));
  const pre = document.querySelector(".k8s-yaml") as HTMLElement;
  expect(pre.textContent).toBe("apiVersion: v1\nkind: Pod\n");
  expect(Array.from(pre.querySelectorAll(".y-key")).map((e) => e.textContent)).toEqual(["apiVersion", "kind"]);
});

describe.each([DEPLOYMENTS, STATEFULSETS, DAEMONSETS, REPLICASETS, JOBS, SERVICES])("workload logs tab on $kind", (kind) => {
  test("opens the merged logs of the selector's pods, with the pod template's containers to pick from", async () => {
    const template = { name: "app", image: "x", init: false, state: "template" as const, ready: false, restarts: 0, reason: null, message: null, lastTermination: null };
    m.get.mockResolvedValue(view({ kind, containers: [template, { ...template, name: "sidecar" }] }));
    m.workloadLogs.mockResolvedValue(1);
    m.unwatch.mockResolvedValue(null);
    setup({ objectRef: { kind, namespace: "prod", name: "web" } });
    fireEvent.click(await screen.findByRole("tab", { name: TAB_LOGS }));
    await vi.waitFor(() => expect(m.workloadLogs).toHaveBeenCalledWith(T, kind, "prod", "web", { container: null, follow: true, tailLines: 500, previous: false, sinceSeconds: null }, "p", expect.any(Function)));
    expect(m.logs).not.toHaveBeenCalled();
    expect(screen.getByLabelText("web")).toBeInTheDocument();
    expect(within(await screen.findByLabelText(LOG_CONTAINER)).getAllByRole("option").map((o) => o.textContent)).toEqual([LOG_ALL_CONTAINERS, "app", "sidecar"]);
  });
});

test.each([CRONJOBS, CONFIGMAPS, SECRETS, PVCS, NODES])("no logs tab for $kind", async (kind) => {
  m.get.mockResolvedValue(view({ kind }));
  setup({ objectRef: { kind, namespace: kind.namespaced ? "prod" : null, name: "web" } });
  await screen.findByRole("tab", { name: TAB_YAML });
  expect(screen.queryByRole("tab", { name: TAB_LOGS })).toBeNull();
});

test("secret: keys with a permission pre-check and a masked YAML note", async () => {
  m.get.mockResolvedValue(view({ kind: SECRETS, row: row({ name: "db" }), secretKeys: [{ key: "password", size: 7 }], yaml: "data:\n  password: ••••\n" }));
  m.rules.mockResolvedValue({ namespace: "prod", incomplete: false, nonResourceRules: [], resourceRules: [{ verbs: ["list"], apiGroups: [""], resources: ["secrets"], resourceNames: [] }] });
  setup({ objectRef: { kind: SECRETS, namespace: "prod", name: "db" } });
  const button = await screen.findByRole("button", { name: SHOW_VALUE });
  await vi.waitFor(() => expect(button).toBeDisabled());
  expect(button).toHaveAttribute("title", NO_SECRET_PERMISSION);
  expect(m.rules).toHaveBeenCalledWith(T, "prod", "p");
  fireEvent.click(screen.getByRole("tab", { name: TAB_YAML }));
  expect(screen.getByText(YAML_SECRET_NOTE)).toBeInTheDocument();
});

test("a failed read shows the error", async () => {
  m.get.mockRejectedValue({ kind: "other", message: "pods \"web-1\" not found" });
  setup({ objectRef: { kind: DEPLOYMENTS, namespace: "prod", name: "x" } });
  expect(await screen.findByText(/not found/)).toBeInTheDocument();
});

test("managed SSO success retries the failed detail request", async () => {
  m.get.mockRejectedValueOnce({ kind: "ssoExpired" }).mockResolvedValueOnce(view());
  const qc = newQueryClient();
  const manager = ssoLoginStub();
  const ui = (at: number | null) => withClientAndSso(
    <ObjectDetail target={T} context="ctx" ssoProfile="p" live objectRef={{ kind: PODS, namespace: "prod", name: "web-1" }} resourceVersion="1" kinds={[]} onOpen={vi.fn()} onBack={null} onClose={vi.fn()} />,
    qc, { ...manager, lastSuccessAt: () => at },
  );
  const rendered = render(ui(null));
  await screen.findByText(/SSO 세션이 만료됐어요/);
  rendered.rerender(ui(Date.now() + 1000));
  expect(await screen.findByText(NO_RECENT_EVENTS)).toBeInTheDocument();
  expect(m.get).toHaveBeenCalledTimes(2);
});

test("the logs tab keeps its stream while the pod's detail is read again for a new resourceVersion", async () => {
  const app = { name: "app", image: "x", init: false, state: "running" as const, ready: true, restarts: 0, reason: null, message: null, lastTermination: null };
  m.get.mockImplementation((_t, _k, _ns, _n) => (m.get.mock.calls.length === 1 ? Promise.resolve(view({ containers: [app] })) : new Promise(() => {})));
  m.logs.mockResolvedValue(1);
  m.unwatch.mockResolvedValue(null);
  const qc = newQueryClient();
  const ui = (rv: string) =>
    withClientAndSso(
      <ObjectDetail target={T} context="ctx" ssoProfile="p" live objectRef={{ kind: PODS, namespace: "prod", name: "web-1" }} resourceVersion={rv} kinds={[]} onOpen={vi.fn()} onBack={null} onClose={vi.fn()} />,
      qc,
      ssoLoginStub(),
    );
  const rendered = render(ui("1"));
  fireEvent.click(await screen.findByRole("tab", { name: TAB_LOGS }));
  await vi.waitFor(() => expect(m.logs).toHaveBeenCalledTimes(1));
  rendered.rerender(ui("2"));
  await vi.waitFor(() => expect(m.get).toHaveBeenCalledTimes(2));
  expect(screen.getByLabelText("web-1")).toBeInTheDocument();
  expect(m.logs).toHaveBeenCalledTimes(1);
  expect(m.unwatch).not.toHaveBeenCalled();
});

const grant = (...resources: string[]) => ({
  namespace: "prod", resourceRules: [{ verbs: ["create"], apiGroups: [""], resources, resourceNames: [] }], nonResourceRules: [], incomplete: false,
});
const running = { name: "app", image: "x", init: false, state: "running" as const, ready: true, restarts: 0, reason: null, message: null, lastTermination: null };

test("a pod gets a shell tab with the container picker, gated by pods/exec", async () => {
  m.get.mockResolvedValue(view({ containers: [running] }));
  m.rules.mockResolvedValue(grant("pods/exec"));
  setup({ onChange: vi.fn() });
  await screen.findByRole("tab", { name: TAB_SHELL });
  fireEvent.click(screen.getByRole("tab", { name: TAB_SHELL }));
  expect(await screen.findByRole("button", { name: SHELL_OPEN })).toBeEnabled();
  expect(screen.getByRole("option", { name: "app" })).toBeInTheDocument();
});

test("without pods/exec the shell button is off with the reason", async () => {
  m.get.mockResolvedValue(view({ containers: [running] }));
  m.rules.mockResolvedValue(grant("pods/log"));
  setup({ onChange: vi.fn() });
  fireEvent.click(await screen.findByRole("tab", { name: TAB_SHELL }));
  expect(await screen.findByText(noStreamPermission("pods/exec"))).toBeInTheDocument();
  expect(screen.getByRole("button", { name: SHELL_OPEN })).toBeDisabled();
});

test("a service has no shell tab but a port-forward picker over its service ports", async () => {
  const ports = [{ name: "web", port: 80, container: null, target: "8080" }];
  m.get.mockResolvedValue(view({ kind: SERVICES, row: row({ name: "web" }), ports }));
  m.rules.mockResolvedValue(grant("pods/portforward"));
  setup({ objectRef: { kind: SERVICES, namespace: "prod", name: "web" }, onChange: vi.fn() });
  const open = await screen.findByRole("button", { name: FORWARD_OPEN });
  expect(screen.queryByRole("tab", { name: TAB_SHELL })).not.toBeInTheDocument();
  await waitFor(() => expect(open).toBeEnabled());
  expect(within(screen.getByLabelText(FORWARD_PORT)).getByRole("option", { name: forwardPortLabel(ports[0]) })).toBeInTheDocument();
});

test("port-forward is off on a pod when pods/portforward is missing", async () => {
  m.get.mockResolvedValue(view());
  m.rules.mockResolvedValue(grant("pods/exec"));
  setup({ onChange: vi.fn() });
  const open = await screen.findByRole("button", { name: FORWARD_OPEN });
  await waitFor(() => expect(open).toHaveAttribute("title", noStreamPermission("pods/portforward")));
  expect(open).toBeDisabled();
});

test("a detail that cannot start changes shows neither the shell tab nor the port-forward line", async () => {
  m.get.mockResolvedValue(view({ containers: [running] }));
  m.rules.mockResolvedValue(grant("pods/exec", "pods/portforward"));
  setup();
  await screen.findByRole("tab", { name: TAB_LOGS });
  expect(screen.queryByRole("tab", { name: TAB_SHELL })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: FORWARD_OPEN })).not.toBeInTheDocument();
});

const nodeView = () => view({ kind: NODES, row: row({ name: "node-1", namespace: null, values: { status: "Ready" } }) });

test("a node offers a node shell that previews a debug pod in the chosen namespace, with the image editable", async () => {
  m.get.mockResolvedValue(nodeView());
  m.rules.mockResolvedValue({ namespace: "dev", resourceRules: [{ verbs: ["create"], apiGroups: [""], resources: ["pods", "pods/exec"], resourceNames: [] }], nonResourceRules: [], incomplete: false });
  const onChange = vi.fn();
  setup({ objectRef: { kind: NODES, namespace: null, name: "node-1" }, shellNamespace: "dev", onChange });
  const button = await screen.findByRole("button", { name: CHANGE_NODE_SHELL });
  await waitFor(() => expect(button).toBeEnabled());
  expect(m.rules).toHaveBeenCalledWith(T, "dev", "p");
  fireEvent.change(screen.getByLabelText(CHANGE_NODE_SHELL_IMAGE), { target: { value: "alpine:3.20" } });
  fireEvent.click(button);
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ type: "nodeShell", node: "node-1", image: "alpine:3.20", namespace: "dev", kind: PODS, name: expect.stringMatching(/^mm-node-shell-[a-z0-9]+$/) }));
});

test("a node shell needs pods create and pods/exec; without them the button is off with the reason", async () => {
  m.get.mockResolvedValue(nodeView());
  m.rules.mockResolvedValue(grant("pods/exec"));
  setup({ objectRef: { kind: NODES, namespace: null, name: "node-1" }, onChange: vi.fn() });
  const button = await screen.findByRole("button", { name: CHANGE_NODE_SHELL });
  await waitFor(() => expect(button).toBeDisabled());
});

test("after the node shell change is applied the node detail opens the terminal on that pod; a stale change does not", async () => {
  m.get.mockResolvedValue(nodeView());
  const applied = { kind: PODS, namespace: "dev", name: "mm-node-shell-x", type: "nodeShell" as const, node: "node-1", image: "busybox:1.36" };
  const props = { objectRef: { kind: NODES, namespace: null, name: "node-1" }, onChange: vi.fn() };
  const view1 = (change: typeof applied | null) => withClientAndSso(
    <ObjectDetail target={T} context="ctx" ssoProfile="p" live resourceVersion="1" kinds={[]} onOpen={vi.fn()} onBack={null} onClose={vi.fn()} appliedChange={change} {...props} />,
    qc, ssoLoginStub());
  const qc = newQueryClient();
  const r = render(view1(applied));
  await screen.findByRole("tab", { name: TAB_YAML });
  // 마운트 전에 이미 적용돼 있던 변경으로는 열지 않는다
  expect(screen.queryByRole("tab", { name: TAB_SHELL })).not.toBeInTheDocument();
  r.rerender(view1({ ...applied }));
  expect(await screen.findByRole("tab", { name: TAB_SHELL })).toHaveAttribute("aria-selected", "true");
  expect(terminalProps[terminalProps.length - 1]).toMatchObject({ mode: "node", namespace: "dev", pod: "mm-node-shell-x" });
});

test("pod containers show usage against their request and limit, hot ones highlighted", async () => {
  const container = (name: string, over: Partial<K8sContainer> = {}): K8sContainer => ({ name, image: "i", init: false, state: "running", ready: true, restarts: 0, reason: null, message: null, lastTermination: null, ...over });
  m.get.mockResolvedValue(view({ containers: [
    container("init", { init: true, cpuRequest: 100 }),
    container("app", { cpuRequest: 500, cpuLimit: 1000, memoryRequest: 100 * 1024 * 1024, memoryLimit: 200 * 1024 * 1024 }),
    container("side"),
  ] }));
  const usage = buildUsageIndex({ podsUnavailable: null, nodesUnavailable: null, nodes: [], pods: [{
    namespace: "prod", name: "web-1", cpuMilli: 960, memoryBytes: 110 * 1024 * 1024, owners: [],
    containers: [{ name: "app", cpuMilli: 450, memoryBytes: 190 * 1024 * 1024 }, { name: "side", cpuMilli: 10, memoryBytes: 1024 * 1024 }],
  }] });
  setup({ usageIndex: usage });
  expect(await screen.findByRole("columnheader", { name: H_CPU_USAGE })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: H_MEMORY_USAGE })).toBeInTheDocument();
  const rows = screen.getAllByRole("row");
  const app = rows.find((r) => r.textContent?.startsWith("app"))!;
  expect(app).toHaveTextContent("450m");
  expect(app).toHaveTextContent(`${USAGE_REQUEST} 500m (90%)`);
  expect(app).toHaveTextContent(`${USAGE_LIMIT} 1 (45%)`);
  expect(app).toHaveTextContent("190 MiB");
  expect(app).toHaveTextContent(`${USAGE_LIMIT} 200 MiB (95%)`);
  expect(app).toHaveTextContent(`${USAGE_REQUEST} 100 MiB (190%)`);
  // 90%는 넘지 않았고, 메모리의 190%(요청)와 95%(제한)만 눈에 띈다
  expect([...app.querySelectorAll(".k8s-hot")].map((e) => e.textContent)).toEqual(["190%", "95%"]);
  // 요청·제한이 없는 컨테이너는 사용량만, init 컨테이너는 비움
  const side = rows.find((r) => r.textContent?.startsWith("side"))!;
  expect(side).toHaveTextContent("10m");
  expect(side).not.toHaveTextContent(USAGE_REQUEST);
  const init = screen.getAllByRole("row").find((r) => r.textContent?.startsWith("init"))!;
  expect(init).not.toHaveTextContent("100m");
});

test("no usage columns without metrics for the pod", async () => {
  m.get.mockResolvedValue(view({ containers: [{ name: "app", image: "i", init: false, state: "running", ready: true, restarts: 0, reason: null, message: null, lastTermination: null }] }));
  setup({ usageIndex: buildUsageIndex({ podsUnavailable: null, nodesUnavailable: null, pods: [], nodes: [] }) });
  expect(await screen.findByText("app")).toBeInTheDocument();
  expect(screen.queryByRole("columnheader", { name: H_CPU_USAGE })).toBeNull();
});
