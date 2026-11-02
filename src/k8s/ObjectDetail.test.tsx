import { fireEvent, render, screen, within } from "@testing-library/react";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../test/utils";
import { k8sApi } from "./api";
import { DEPLOYMENTS, NODES, PODS, SECRETS, SERVICE_ACCOUNTS } from "./kinds";
import { ObjectDetail } from "./ObjectDetail";
import {
  BACK, CHILDREN_TRUNCATED, CLOSE, NO_RECENT_EVENTS, NO_SECRET_PERMISSION, OPEN_IN_IAM, SEC_CHILDREN, SEC_OWNERS, SHOW_VALUE,
  TAB_LOGS, TAB_YAML, YAML_SECRET_NOTE, openNode,
} from "./text";
import type { K8sKind, K8sObjectView, K8sRow } from "./types";

vi.mock("./api", () => ({ k8sApi: { get: vi.fn(), rules: vi.fn(), secretValue: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
const m = vi.mocked(k8sApi);
const T = { profile: "app", region: "r", cluster: "c" };

const row = (over: Partial<K8sRow> = {}): K8sRow => ({ uid: "u1", name: "web-1", namespace: "prod", resourceVersion: "1", createdAt: "2026-10-30T11:00:00Z", labels: { app: "web" }, values: {}, problems: [], ...over });
const view = (over: Partial<K8sObjectView> = {}): K8sObjectView => ({
  kind: PODS, row: row(), annotations: {}, owners: [], children: [], childrenTruncated: false, childrenError: null,
  containers: [], conditions: [], events: [], eventsError: null, yaml: "apiVersion: v1\nkind: Pod\n", secretKeys: null, ...over,
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

beforeEach(() => vi.clearAllMocks());

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
  const h = setup();
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

test("YAML tab is colored and keeps the text as is; only pods get a logs tab", async () => {
  m.get.mockResolvedValue(view());
  setup();
  expect(await screen.findByRole("tab", { name: TAB_LOGS })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: TAB_YAML }));
  const pre = document.querySelector(".k8s-yaml") as HTMLElement;
  expect(pre.textContent).toBe("apiVersion: v1\nkind: Pod\n");
  expect(Array.from(pre.querySelectorAll(".y-key")).map((e) => e.textContent)).toEqual(["apiVersion", "kind"]);
});

test("no logs tab for other kinds", async () => {
  m.get.mockResolvedValue(view({ kind: DEPLOYMENTS }));
  setup({ objectRef: { kind: DEPLOYMENTS, namespace: "prod", name: "web" } });
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
