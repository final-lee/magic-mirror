import { act, fireEvent, render, screen } from "@testing-library/react";
import { dispatchKey, resetKeymap } from "../../keymap/registry";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../../test/utils";
import { k8sApi } from "../api";
import { CONFIGMAPS, DEPLOYMENTS, NODES, PODS, SERVICES } from "../kinds";
import { CHANGE_CORDON, CHANGE_DELETE, CHANGE_RESTART, CHANGE_SCALE, CHANGE_UNCORDON, SHELL_MODE_ATTACH, SHELL_MODE_EXEC, TAB_LOGS, TAB_SHELL, TAB_YAML, YAML_EDIT } from "../text";
import type { K8sChange, K8sKindRef, K8sObjectView, K8sRow, K8sRules, K8sWatchMessage } from "../types";
import { WorkloadsView } from "../WorkloadsView";
import {
  KEY_ALREADY_ALL, KEY_ALREADY_CORDONED, KEY_CLUSTER_SCOPED, KEY_NO_DESCRIBE, KEY_NO_SELECTION, KEY_NOT_CORDONED, KEY_ONLY,
} from "./text";

// 터미널·로그 본문은 따로 시험한다. 여기서는 키가 상세의 어느 단추·탭에 닿는지만 본다
vi.mock("../PodTerminal", () => ({ PodTerminal: () => null }));
vi.mock("../PodLogs", () => ({ PodLogs: () => <div>pod logs</div>, WorkloadLogs: () => <div>workload logs</div> }));
vi.mock("../api", () => ({ k8sApi: { metrics: vi.fn(), watch: vi.fn(), unwatch: vi.fn(), get: vi.fn(), rules: vi.fn(), secretValue: vi.fn(), shellConfirmName: vi.fn() } }));
vi.mock("../../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
const m = vi.mocked(k8sApi);
// 감시는 대상(클러스터)별로 모아 두므로 시험마다 다른 클러스터로 시작한다
let T = { profile: "app", region: "r", cluster: "keys-0" };
let runs = 0;
const LANES = { width: () => undefined, resize: vi.fn(), commit: vi.fn() };

const row = (name: string, namespace: string | null = "prod", values: Record<string, string> = {}): K8sRow => ({
  uid: `u-${name}`, name, namespace, resourceVersion: "7", createdAt: null, labels: {}, values, problems: [],
});
const rowValues = new Map<string, Record<string, string>>();
const view = (kind: K8sKindRef, r: K8sRow): K8sObjectView => ({
  kind, row: r, annotations: {}, owners: [], children: [], childrenTruncated: false, childrenError: null,
  containers: kind.kind === "Pod" ? [{ name: "app", image: "x", init: false, state: "running", ready: true, restarts: 0, reason: null, message: null, lastTermination: null }] : [],
  conditions: [], events: [], eventsError: null, yaml: "kind: x", editYaml: "kind: x", secretKeys: null, ports: [],
});
/** denyAll: 규칙을 모두 읽었는데 허용이 하나도 없다(patch·delete가 막힌다). 아니면 불완전한 규칙이라 서버 판단에 맡긴다 */
const rules = (denyAll: boolean): K8sRules => ({ namespace: "prod", resourceRules: [], nonResourceRules: [], incomplete: !denyAll });
const emits = new Map<string, (msg: K8sWatchMessage) => void>();
const send = (plural: string, rows: K8sRow[]) => act(() => emits.get(plural)!({ type: "reset", rows }));

beforeEach(() => {
  vi.clearAllMocks();
  resetKeymap();
  emits.clear();
  rowValues.clear();
  T = { ...T, cluster: `keys-${runs++}` };
  m.metrics.mockResolvedValue({ podsUnavailable: null, nodesUnavailable: null, pods: [], nodes: [] });
  m.unwatch.mockResolvedValue(null);
  m.rules.mockResolvedValue(rules(false));
  m.shellConfirmName.mockResolvedValue(null);
  m.watch.mockImplementation(async (_t, kind, _ns, _p, onMessage) => {
    emits.set(kind.plural, onMessage);
    return 1;
  });
});

interface Setup {
  kind?: K8sKindRef;
  namespace?: string | null;
  hidden?: boolean;
}

function setup({ kind = PODS, namespace = "prod", hidden = false }: Setup = {}) {
  const onChange = vi.fn<(c: K8sChange) => void>();
  const onAllNamespaces = vi.fn();
  m.get.mockImplementation(async (_t, k, _ns, name) => view(k, row(name, k.namespaced ? "prod" : null, rowValues.get(name))));
  render(
    withClientAndSso(
      <div hidden={hidden} className="k8s-body">
        <WorkloadsView target={T} context="ctx" sessionEpoch={1} ssoProfile="p" live namespace={namespace} kinds={[]} focus={null}
          fixedKind={kind} bookmarked={new Set()} onToggleBookmark={vi.fn()} lanes={LANES} onChange={onChange} onAllNamespaces={onAllNamespaces} />
      </div>,
      newQueryClient(),
      ssoLoginStub(),
    ),
  );
  return { onChange, onAllNamespaces };
}

const list = () => screen.getByTestId("iam-list");
/** 키를 디스패처에 보낸다(창 리스너 없이). 처리했으면 true */
function press(init: KeyboardEventInit & { key: string }): boolean {
  let handled = false;
  act(() => {
    handled = dispatchKey(new KeyboardEvent("keydown", { cancelable: true, bubbles: true, ...init }));
  });
  return handled;
}

/** 목록을 읽고 행을 골라(상세가 뜬다) 커서를 목록에 둔다 */
async function open(plural: string, rows: K8sRow[], pick: string) {
  await vi.waitFor(() => expect(emits.has(plural)).toBe(true));
  send(plural, rows);
  fireEvent.click(screen.getByText(pick));
  await screen.findByRole("complementary");
  await vi.waitFor(() => expect(screen.getByRole("tab", { name: TAB_YAML })).toBeInTheDocument());
  // 상세가 권한·객체 읽기를 마칠 때까지(마치기 전에 시험이 끝나면 act 경고가 난다)
  await act(async () => {});
  list().focus();
}
/** 상태 줄에 보이는 안내(없으면 빈 글) */
const note = () => screen.getByRole("status").querySelector(".k8s-key-note span")?.textContent ?? "";
const tab = (name: string) => screen.getByRole("tab", { name });
const forwardLine = () => document.querySelector('[data-k8s-action="forward"]');

describe("moving", () => {
  test("j and k step through the rows, g and G jump to the ends, and the ends stay put", async () => {
    setup();
    await vi.waitFor(() => expect(emits.has("pods")).toBe(true));
    send("pods", [row("a"), row("b"), row("c")]);
    list().focus();
    const selected = () => screen.queryAllByRole("row").filter((r) => r.getAttribute("aria-selected") === "true").map((r) => r.textContent);
    fireEvent.keyDown(list(), { key: "j" });
    expect(selected()[0]).toContain("a");
    fireEvent.keyDown(list(), { key: "j" });
    expect(selected()[0]).toContain("b");
    fireEvent.keyDown(list(), { key: "G" });
    expect(selected()[0]).toContain("c");
    fireEvent.keyDown(list(), { key: "j" });
    expect(selected()[0]).toContain("c");
    fireEvent.keyDown(list(), { key: "k" });
    expect(selected()[0]).toContain("b");
    fireEvent.keyDown(list(), { key: "g" });
    expect(selected()[0]).toContain("a");
    fireEvent.keyDown(list(), { key: "k" });
    expect(selected()[0]).toContain("a");
  });

  test("with a modifier the letters are left alone", async () => {
    setup();
    await vi.waitFor(() => expect(emits.has("pods")).toBe(true));
    send("pods", [row("a"), row("b")]);
    fireEvent.keyDown(list(), { key: "j", metaKey: true });
    fireEvent.keyDown(list(), { key: "j", ctrlKey: true });
    expect(screen.queryAllByRole("row").some((r) => r.getAttribute("aria-selected") === "true")).toBe(false);
  });
});

describe("tabs", () => {
  test("y opens the YAML tab, l the logs, and the list keeps the cursor", async () => {
    setup();
    await open("pods", [row("web-1")], "web-1");
    expect(press({ key: "y" })).toBe(true);
    expect(tab(TAB_YAML)).toHaveAttribute("aria-selected", "true");
    expect(press({ key: "l" })).toBe(true);
    expect(tab(TAB_LOGS)).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("pod logs")).toBeInTheDocument();
    expect(document.activeElement).toBe(list());
  });

  test("l on a Deployment opens the workload logs", async () => {
    setup({ kind: DEPLOYMENTS });
    await open("deployments", [row("web", "prod", { ready: "3/3" })], "web");
    press({ key: "l" });
    expect(screen.getByText("workload logs")).toBeInTheDocument();
  });

  test("a opens the shell tab in attach mode and s in shell mode, without opening a session", async () => {
    setup();
    await open("pods", [row("web-1")], "web-1");
    press({ key: "a" });
    expect(tab(TAB_SHELL)).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("radio", { name: SHELL_MODE_ATTACH })).toBeChecked();
    press({ key: "s" });
    expect(screen.getByRole("radio", { name: SHELL_MODE_EXEC })).toBeChecked();
    expect(m.shellConfirmName).not.toHaveBeenCalled();
  });

  test("d selects the describe tab when the detail offers it, otherwise says so", async () => {
    setup();
    await open("pods", [row("web-1")], "web-1");
    press({ key: "d" });
    expect(note()).toBe(KEY_NO_DESCRIBE);
    // describe 탭을 가진 상세(다른 화면이 더한다)에서는 그 탭 단추를 누른다
    const describe = document.createElement("button");
    describe.setAttribute("role", "tab");
    describe.dataset.tab = "describe";
    const clicked = vi.fn();
    describe.addEventListener("click", clicked);
    document.querySelector('[role="tablist"]')!.appendChild(describe);
    press({ key: "d" });
    expect(clicked).toHaveBeenCalled();
  });

  test.each<[string, K8sKindRef, string]>([
    ["l", CONFIGMAPS, "k8s.logs"],
    ["a", DEPLOYMENTS, "k8s.attach"],
    ["s", CONFIGMAPS, "k8s.shell"],
    ["r", PODS, "k8s.restart"],
    ["c", PODS, "k8s.cordon"],
    ["u", PODS, "k8s.uncordon"],
    ["F", DEPLOYMENTS, "k8s.forward"],
  ])("%s on %j that does not apply explains why and changes nothing", async (key, kind, command) => {
    const { onChange } = setup({ kind });
    await open(kind.plural, [row("x")], "x");
    press(key === "F" ? { key, shiftKey: true } : { key });
    expect(note()).toBe(KEY_ONLY[command]);
    expect(onChange).not.toHaveBeenCalled();
    expect(tab(TAB_YAML)).toHaveAttribute("aria-selected", "false");
  });
});

describe("changes only open the preview", () => {
  test("r on a Deployment starts the restart preview and ctrl+d the delete preview", async () => {
    const { onChange } = setup({ kind: DEPLOYMENTS });
    await open("deployments", [row("web", "prod", { ready: "3/3" })], "web");
    await screen.findByRole("button", { name: CHANGE_RESTART });
    press({ key: "r" });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ type: "restart", name: "web", namespace: "prod" }));
    press({ key: "d", ctrlKey: true });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ type: "delete", name: "web" }));
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  test("ctrl+d works on any kind", async () => {
    const { onChange } = setup({ kind: CONFIGMAPS });
    await open("configmaps", [row("cfg")], "cfg");
    await screen.findByRole("button", { name: CHANGE_DELETE });
    press({ key: "d", ctrlKey: true });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ type: "delete", name: "cfg" }));
  });

  test("s on a Deployment moves to the replicas box, and Enter there opens the scale preview", async () => {
    const { onChange } = setup({ kind: DEPLOYMENTS });
    await open("deployments", [row("web", "prod", { ready: "3/3" })], "web");
    await screen.findByRole("button", { name: CHANGE_SCALE });
    press({ key: "s" });
    const replicas = screen.getByRole("spinbutton");
    expect(document.activeElement).toBe(replicas);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(replicas, { target: { value: "5" } });
    fireEvent.keyDown(replicas, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ type: "scale", replicas: 5, name: "web" }));
  });

  test("a bad replica count is not previewed with Enter", async () => {
    const { onChange } = setup({ kind: DEPLOYMENTS });
    await open("deployments", [row("web", "prod", { ready: "3/3" })], "web");
    await screen.findByRole("button", { name: CHANGE_SCALE });
    press({ key: "s" });
    const replicas = screen.getByRole("spinbutton");
    fireEvent.change(replicas, { target: { value: "-1" } });
    fireEvent.keyDown(replicas, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
  });

  test("e opens the YAML editor instead of the viewer, and pressing it again stays quiet", async () => {
    setup();
    await open("pods", [row("web-1")], "web-1");
    await screen.findByRole("button", { name: YAML_EDIT });
    press({ key: "e" });
    expect(screen.queryByRole("button", { name: YAML_EDIT })).toBeNull();
    expect(tab(TAB_YAML)).toHaveAttribute("aria-selected", "true");
    press({ key: "e" });
    expect(note()).toBe("");
  });

  test("a denied change explains with the permission reason instead of opening", async () => {
    m.rules.mockResolvedValue(rules(true));
    const { onChange } = setup({ kind: DEPLOYMENTS });
    await open("deployments", [row("web", "prod", { ready: "3/3" })], "web");
    await screen.findByRole("button", { name: CHANGE_RESTART });
    press({ key: "r" });
    expect(note()).toMatch(/patch/);
    press({ key: "d", ctrlKey: true });
    expect(onChange).not.toHaveBeenCalled();
    press({ key: "s" });
    expect(note()).toMatch(/patch/);
    expect(document.activeElement).toBe(list());
  });
});

describe("nodes", () => {
  test("c cordons a schedulable node and u only explains; on a cordoned node it is the other way round", async () => {
    rowValues.set("n1", { status: "Ready" });
    rowValues.set("n2", { status: "Ready,SchedulingDisabled" });
    const { onChange } = setup({ kind: NODES, namespace: null });
    await open("nodes", [row("n1", null, { status: "Ready" }), row("n2", null, { status: "Ready,SchedulingDisabled" })], "n1");
    await screen.findByRole("button", { name: CHANGE_CORDON });
    press({ key: "u" });
    expect(note()).toBe(KEY_NOT_CORDONED);
    expect(onChange).not.toHaveBeenCalled();
    press({ key: "c" });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ type: "cordon", unschedulable: true, name: "n1" }));
    fireEvent.click(screen.getByText("n2"));
    await screen.findByRole("button", { name: CHANGE_UNCORDON });
    list().focus();
    press({ key: "c" });
    expect(note()).toBe(KEY_ALREADY_CORDONED);
    press({ key: "u" });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ type: "cordon", unschedulable: false, name: "n2" }));
  });
});

describe("port-forward and namespaces", () => {
  test("shift+F puts the cursor on the port-forward line of a Pod", async () => {
    setup();
    await open("pods", [row("web-1")], "web-1");
    await vi.waitFor(() => expect(forwardLine()).not.toBeNull());
    press({ key: "F", shiftKey: true });
    expect(document.activeElement).toBe(forwardLine());
  });

  test("shift+F on a Service", async () => {
    setup({ kind: SERVICES });
    await open("services", [row("svc")], "svc");
    await vi.waitFor(() => expect(forwardLine()).not.toBeNull());
    press({ key: "F", shiftKey: true });
    expect(document.activeElement).toBe(forwardLine());
  });

  test("0 asks for all namespaces", async () => {
    const { onAllNamespaces } = setup();
    await vi.waitFor(() => expect(emits.has("pods")).toBe(true));
    send("pods", [row("a")]);
    list().focus();
    press({ key: "0" });
    expect(onAllNamespaces).toHaveBeenCalledTimes(1);
  });

  test("0 when all namespaces are already shown only says so", async () => {
    const { onAllNamespaces } = setup({ namespace: null });
    await vi.waitFor(() => expect(emits.has("pods")).toBe(true));
    send("pods", [row("a")]);
    list().focus();
    press({ key: "0" });
    expect(note()).toBe(KEY_ALREADY_ALL);
    expect(onAllNamespaces).not.toHaveBeenCalled();
  });

  test("0 on a cluster-scoped kind explains that it has no namespace", async () => {
    const { onAllNamespaces } = setup({ kind: NODES, namespace: "prod" });
    await vi.waitFor(() => expect(emits.has("nodes")).toBe(true));
    send("nodes", [row("n1", null)]);
    list().focus();
    press({ key: "0" });
    expect(note()).toBe(KEY_CLUSTER_SCOPED("Node"));
    expect(onAllNamespaces).not.toHaveBeenCalled();
  });
});

describe("when the keys must stay out of the way", () => {
  test("with no row selected the keys explain what to do first", async () => {
    const { onChange } = setup();
    await vi.waitFor(() => expect(emits.has("pods")).toBe(true));
    send("pods", [row("a")]);
    list().focus();
    press({ key: "y" });
    expect(note()).toBe(KEY_NO_SELECTION);
    press({ key: "d", ctrlKey: true });
    expect(onChange).not.toHaveBeenCalled();
  });

  test("typing in an input is not intercepted: neither the replicas box nor the find line", async () => {
    const { onChange } = setup({ kind: DEPLOYMENTS });
    await open("deployments", [row("web", "prod", { ready: "3/3" })], "web");
    await screen.findByRole("button", { name: CHANGE_SCALE });
    screen.getByRole("spinbutton").focus();
    for (const key of ["y", "l", "r", "e", "d", "0", "/"]) expect(press({ key }), key).toBe(false);
    expect(press({ key: "d", ctrlKey: true })).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    // ⌘F 줄의 입력칸
    list().focus();
    press({ key: "f", metaKey: true });
    const find = screen.getByRole("textbox", { name: "목록에서 찾기" });
    expect(document.activeElement).toBe(find);
    expect(press({ key: "/" })).toBe(false);
    expect(press({ key: "y" })).toBe(false);
  });

  test("the cursor must be in the list: elsewhere on the page the letters do nothing", async () => {
    setup();
    await open("pods", [row("web-1")], "web-1");
    (document.activeElement as HTMLElement).blur();
    expect(press({ key: "y" })).toBe(false);
    expect(tab(TAB_YAML)).toHaveAttribute("aria-selected", "false");
  });

  test("a dialog on top blocks the keys", async () => {
    const { onChange } = setup({ kind: DEPLOYMENTS });
    await open("deployments", [row("web", "prod", { ready: "3/3" })], "web");
    await screen.findByRole("button", { name: CHANGE_RESTART });
    const modal = document.createElement("div");
    modal.className = "modal";
    document.body.appendChild(modal);
    expect(press({ key: "r" })).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    modal.remove();
  });

  test("a hidden tab never reacts", async () => {
    const { onChange, onAllNamespaces } = setup({ hidden: true });
    await vi.waitFor(() => expect(emits.has("pods")).toBe(true));
    send("pods", [row("a")]);
    list().focus();
    for (const key of ["y", "l", "0", "e", "/"]) expect(press({ key }), key).toBe(false);
    expect(press({ key: "d", ctrlKey: true })).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(onAllNamespaces).not.toHaveBeenCalled();
  });

  test("the note goes away by itself and can be dismissed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      setup();
      await open("pods", [row("web-1")], "web-1");
      press({ key: "r" });
      expect(note()).toBe(KEY_ONLY["k8s.restart"]);
      act(() => vi.advanceTimersByTime(5000));
      expect(note()).toBe("");
      press({ key: "r" });
      fireEvent.click(screen.getByRole("button", { name: "안내 닫기" }));
      expect(note()).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });
});

test("/ opens the find line of the list like ⌘F", async () => {
  setup();
  await vi.waitFor(() => expect(emits.has("pods")).toBe(true));
  send("pods", [row("a")]);
  list().focus();
  expect(press({ key: "/" })).toBe(true);
  expect(screen.getByRole("textbox", { name: "목록에서 찾기" })).toHaveFocus();
});
