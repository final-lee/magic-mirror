import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ChangeActions } from "./ChangeActions";
import { ChangeDialog, useK8sChange } from "./ChangeFlow";
import { DrainProgress } from "./DrainProgress";
import { k8sApi } from "./api";
import { reduceDrain, startRun } from "./drain";
import { NODES } from "./kinds";
import * as t from "./text";
import type { K8sChange, K8sDrainCounts, K8sDrainMessage, K8sDrainPod, K8sObjectView, K8sPreview, K8sRules } from "./types";

vi.mock("./api", () => ({ k8sApi: { preview: vi.fn(), apply: vi.fn(), revisions: vi.fn(), drain: vi.fn(), unwatch: vi.fn() } }));
const api = vi.mocked(k8sApi);
const target = { profile: "p", region: "r", cluster: "c" };
const nodeRef = { kind: NODES, namespace: null, name: "worker-1" };
const drainChange: K8sChange = { ...nodeRef, type: "drain" };
const view: K8sObjectView = { kind: NODES, row: { uid: "u", name: "worker-1", namespace: null, resourceVersion: "1", createdAt: null, labels: {}, values: { status: "Ready" }, problems: [] }, annotations: {}, owners: [], children: [], childrenTruncated: false, childrenError: null, containers: [], conditions: [], events: [], eventsError: null, yaml: "", editYaml: "", secretKeys: null };
const rule = (verbs: string[], resources: string[], apiGroups = [""]) => ({ verbs, apiGroups, resources, resourceNames: [] });
const rules = (...resourceRules: K8sRules["resourceRules"]): K8sRules => ({ namespace: "default", incomplete: false, resourceRules, nonResourceRules: [] });

const pod = (name: string, extra: Partial<K8sDrainPod> = {}): K8sDrainPod => ({ namespace: "app", name, uid: `uid-${name}`, emptyDir: false, unmanaged: false, blockedBy: null, ...extra });
const counts = (extra: Partial<K8sDrainCounts>): K8sDrainCounts => ({ total: 0, pending: 0, evicting: 0, evicted: 0, blocked: 0, failed: 0, ...extra });
const preview: K8sPreview = {
  calls: [{ verb: "PATCH", path: "/api/v1/nodes/worker-1", body: { spec: { unschedulable: true } } }],
  diff: [{ path: "spec.unschedulable", before: false, after: true }],
  impact: ["노드를 스케줄 중지하고 Pod를 하나씩 다른 노드로 옮깁니다"],
  warnings: ["emptyDir 데이터가 사라지는 Pod 1개: app/cache"],
  confirmName: "worker-1",
  reversible: true,
  conflicts: [],
  drain: {
    nodeCordoned: false,
    evict: [pod("cache", { emptyDir: true, unmanaged: true }), pod("web"), pod("held", { blockedBy: "held-pdb" })],
    skipped: [{ namespace: "kube-system", name: "proxy", reason: "daemonSet" }],
    budgetsUnknown: false,
  },
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("drain button", () => {
  const renderActions = (permissions: K8sRules | undefined, start = vi.fn()) => {
    render(<ChangeActions target={target} ssoProfile="p" objectRef={nodeRef} view={view} rules={permissions} onStart={start} />);
    return start;
  };
  const allowed = rules(rule(["patch"], ["nodes"]), rule(["create"], ["pods/eviction"]));

  test("starts a drain preview when both nodes patch and pods/eviction create are allowed", () => {
    const start = renderActions(allowed);
    fireEvent.click(screen.getByRole("button", { name: t.CHANGE_DRAIN }));
    expect(start).toHaveBeenCalledWith(drainChange);
  });

  test("is off with the reason when eviction is not allowed", () => {
    renderActions(rules(rule(["patch"], ["nodes"])));
    const button = screen.getByRole("button", { name: t.CHANGE_DRAIN });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", t.CHANGE_DENIED("create", "pods/eviction"));
  });

  test("is off with the reason when the node cannot be patched", () => {
    renderActions(rules(rule(["create"], ["pods/eviction"])));
    const button = screen.getByRole("button", { name: t.CHANGE_DRAIN });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", t.CHANGE_DENIED("patch", "nodes"));
  });

  test("a wildcard pods/* rule allows eviction, and unknown rules leave the decision to the server", () => {
    const { unmount } = render(
      <ChangeActions target={target} ssoProfile="p" objectRef={nodeRef} view={view} rules={rules(rule(["*"], ["nodes", "pods/*"]))} onStart={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: t.CHANGE_DRAIN })).toBeEnabled();
    unmount();
    render(<ChangeActions target={target} ssoProfile="p" objectRef={nodeRef} view={view} rules={{ ...rules(), incomplete: true }} onStart={vi.fn()} />);
    expect(screen.getByRole("button", { name: t.CHANGE_DRAIN })).toBeEnabled();
  });

  test("only Nodes get a drain button", () => {
    const podRef = { kind: { ...NODES, kind: "Pod", plural: "pods", namespaced: true }, namespace: "app", name: "web" };
    render(<ChangeActions target={target} ssoProfile="p" objectRef={podRef} view={view} rules={allowed} onStart={vi.fn()} />);
    expect(screen.queryByRole("button", { name: t.CHANGE_DRAIN })).not.toBeInTheDocument();
  });
});

/** 상세에서 drain을 시작해 미리보기, 적용, 진행 창까지 이어 주는 화면 */
function Harness({ onDrained = () => {} }: { onDrained?: () => void }) {
  const flow = useK8sChange(target, "p", () => {}, onDrained);
  return (
    <>
      <button onClick={() => flow.start(drainChange)}>start</button>
      {flow.pending && <ChangeDialog pending={flow.pending} apply={flow.apply} retry={flow.retry} cancel={flow.cancel} />}
      {flow.drain && <DrainProgress run={flow.drain} onStop={flow.stopDrain} onClose={flow.closeDrain} />}
    </>
  );
}

/** `k8s_drain`의 채널을 흉내 낸다: 받은 콜백으로 메시지를 보낸다 */
function fakeChannel(id = 7) {
  const channel: { emit: (m: K8sDrainMessage) => void } = { emit: () => {} };
  api.drain.mockImplementation(async (_target, _node, _confirm, _profile, onMessage) => {
    channel.emit = (message) => act(() => onMessage(message));
    return id;
  });
  return channel;
}

async function openPlan() {
  api.preview.mockResolvedValue(preview);
  render(<Harness />);
  fireEvent.click(screen.getByText("start"));
  await screen.findByRole("dialog", { name: t.CHANGE_PREVIEW });
}

describe("drain preview", () => {
  test("shows the plan: pods to evict with their warnings, skipped pods and the call list", async () => {
    await openPlan();
    expect(api.preview).toHaveBeenCalledWith(target, drainChange, "p");
    const evict = within(screen.getByRole("table", { name: t.DRAIN_PLAN_EVICT }));
    expect(evict.getByText("app/cache").closest("tr")).toHaveTextContent(t.DRAIN_FLAG_EMPTY_DIR);
    expect(evict.getByText("app/cache").closest("tr")).toHaveTextContent(t.DRAIN_FLAG_UNMANAGED);
    expect(evict.getByText("app/held").closest("tr")).toHaveTextContent(t.DRAIN_FLAG_BLOCKED("held-pdb"));
    expect(evict.getByText("app/web").closest("tr")).not.toHaveTextContent(t.DRAIN_FLAG_EMPTY_DIR);
    expect(within(screen.getByRole("table", { name: t.DRAIN_PLAN_SKIPPED })).getByText(t.DRAIN_SKIP_REASON.daemonSet)).toBeInTheDocument();
    expect(screen.getByText(/emptyDir 데이터가 사라지는 Pod 1개/)).toBeInTheDocument();
  });

  test("always needs the typed node name before applying", async () => {
    await openPlan();
    const apply = screen.getByRole("button", { name: t.CHANGE_APPLY });
    expect(apply).toBeDisabled();
    fireEvent.change(screen.getByLabelText(t.CHANGE_CONFIRM), { target: { value: "worker-2" } });
    expect(apply).toBeDisabled();
    fireEvent.change(screen.getByLabelText(t.CHANGE_CONFIRM), { target: { value: "worker-1" } });
    expect(apply).toBeEnabled();
    expect(api.drain).not.toHaveBeenCalled();
  });

  test("a refused drain (stale plan) stays in the preview with the error and starts no progress", async () => {
    api.drain.mockRejectedValue(new Error("미리보기 이후 바뀌었어요"));
    await openPlan();
    fireEvent.change(screen.getByLabelText(t.CHANGE_CONFIRM), { target: { value: "worker-1" } });
    fireEvent.click(screen.getByRole("button", { name: t.CHANGE_APPLY }));
    expect(await screen.findByText(/미리보기 이후 바뀌었어요/)).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: t.CHANGE_PREVIEW })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: t.DRAIN_TITLE("worker-1") })).not.toBeInTheDocument();
    expect(api.apply).not.toHaveBeenCalled();
  });
});

describe("drain progress", () => {
  const start = async (id = 7) => {
    const channel = fakeChannel(id);
    await openPlan();
    fireEvent.change(screen.getByLabelText(t.CHANGE_CONFIRM), { target: { value: "worker-1" } });
    fireEvent.click(screen.getByRole("button", { name: t.CHANGE_APPLY }));
    await screen.findByRole("dialog", { name: t.DRAIN_TITLE("worker-1") });
    return channel;
  };
  const rowOf = (name: string) => screen.getByText(`app/${name}`).closest("tr")!;

  test("applies through k8s_drain (not apply) with the typed name and replaces the preview with the progress window", async () => {
    await start();
    expect(api.drain).toHaveBeenCalledWith(target, "worker-1", "worker-1", "p", expect.any(Function));
    expect(api.apply).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: t.CHANGE_PREVIEW })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(t.DRAIN_PHASE_CORDON);
  });

  test("renders per-pod states and totals from the channel", async () => {
    const channel = await start();
    channel.emit({ type: "started", pods: preview.drain!.evict, counts: counts({ total: 3, pending: 3 }) });
    for (const name of ["cache", "web", "held"]) {
      expect(rowOf(name)).toHaveTextContent(t.DRAIN_POD_STATE.pending);
    }
    expect(screen.getByText(t.DRAIN_COUNTS(counts({ total: 3, pending: 3 })))).toBeInTheDocument();

    channel.emit({ type: "cordoned" });
    expect(screen.getByRole("status")).toHaveTextContent(t.DRAIN_PHASE_EVICT);

    channel.emit({ type: "pod", namespace: "app", name: "cache", state: "evicting", error: null, counts: counts({ total: 3, pending: 2, evicting: 1 }) });
    expect(rowOf("cache")).toHaveTextContent(t.DRAIN_POD_STATE.evicting);
    channel.emit({ type: "pod", namespace: "app", name: "cache", state: "evicted", error: null, counts: counts({ total: 3, pending: 2, evicted: 1 }) });
    channel.emit({ type: "pod", namespace: "app", name: "web", state: "failed", error: "클러스터에 변경을 보내지 못했어요", counts: counts({ total: 3, pending: 1, evicted: 1, failed: 1 }) });
    channel.emit({ type: "pod", namespace: "app", name: "held", state: "blocked", error: null, counts: counts({ total: 3, evicted: 1, failed: 1, blocked: 1 }) });
    expect(rowOf("cache")).toHaveTextContent(t.DRAIN_POD_STATE.evicted);
    expect(rowOf("web")).toHaveTextContent(t.DRAIN_POD_STATE.failed);
    expect(rowOf("web")).toHaveTextContent("클러스터에 변경을 보내지 못했어요");
    expect(rowOf("held")).toHaveTextContent(t.DRAIN_POD_STATE.blocked);
    expect(rowOf("held")).toHaveTextContent(t.DRAIN_FLAG_BLOCKED("held-pdb"));
    expect(screen.getByText(t.DRAIN_COUNTS(counts({ total: 3, evicted: 1, failed: 1, blocked: 1 })))).toBeInTheDocument();
  });

  test("messages that arrive before the call returns are kept", async () => {
    api.preview.mockResolvedValue(preview);
    api.drain.mockImplementation(async (_target, _node, _confirm, _profile, onMessage) => {
      onMessage({ type: "started", pods: preview.drain!.evict, counts: counts({ total: 3, pending: 3 }) });
      return 7;
    });
    render(<Harness />);
    fireEvent.click(screen.getByText("start"));
    fireEvent.change(await screen.findByLabelText(t.CHANGE_CONFIRM), { target: { value: "worker-1" } });
    fireEvent.click(screen.getByRole("button", { name: t.CHANGE_APPLY }));
    await screen.findByRole("dialog", { name: t.DRAIN_TITLE("worker-1") });
    expect(rowOf("web")).toHaveTextContent(t.DRAIN_POD_STATE.pending);
  });

  test("stop sends the cancel for this drain, waits for the last message and cannot be pressed twice", async () => {
    const channel = await start(42);
    channel.emit({ type: "started", pods: preview.drain!.evict, counts: counts({ total: 3, pending: 3 }) });
    channel.emit({ type: "cordoned" });
    const stop = screen.getByRole("button", { name: t.DRAIN_STOP });
    fireEvent.click(stop);
    expect(api.unwatch).toHaveBeenCalledTimes(1);
    expect(api.unwatch).toHaveBeenCalledWith(42);
    expect(screen.getByRole("status")).toHaveTextContent(t.DRAIN_PHASE_STOPPING);
    expect(stop).toBeDisabled();
    fireEvent.click(stop);
    expect(api.unwatch).toHaveBeenCalledTimes(1);
    channel.emit({ type: "finished", outcome: "stopped", counts: counts({ total: 3, pending: 3 }), error: null });
    expect(screen.getByRole("status")).toHaveTextContent(t.DRAIN_OUTCOME.stopped);
    expect(screen.queryByRole("button", { name: t.DRAIN_STOP })).not.toBeInTheDocument();
  });

  test("the final summary names the outcome and counts, offers close, and notifies the owner once", async () => {
    const onDrained = vi.fn();
    const channel = fakeChannel();
    api.preview.mockResolvedValue(preview);
    render(<Harness onDrained={onDrained} />);
    fireEvent.click(screen.getByText("start"));
    fireEvent.change(await screen.findByLabelText(t.CHANGE_CONFIRM), { target: { value: "worker-1" } });
    fireEvent.click(screen.getByRole("button", { name: t.CHANGE_APPLY }));
    await screen.findByRole("dialog", { name: t.DRAIN_TITLE("worker-1") });
    channel.emit({ type: "started", pods: preview.drain!.evict, counts: counts({ total: 3, pending: 3 }) });
    channel.emit({ type: "cordoned" });
    expect(onDrained).not.toHaveBeenCalled();
    channel.emit({ type: "finished", outcome: "timedOut", counts: counts({ total: 3, evicted: 2, blocked: 1 }), error: null });
    expect(screen.getByRole("status")).toHaveTextContent(t.DRAIN_OUTCOME.timedOut);
    expect(screen.getByText(t.DRAIN_COUNTS(counts({ total: 3, evicted: 2, blocked: 1 })))).toBeInTheDocument();
    expect(screen.getByText(t.DRAIN_UNDO_HINT)).toBeInTheDocument();
    expect(onDrained).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: t.DRAIN_CLOSE }));
    expect(screen.queryByRole("dialog", { name: t.DRAIN_TITLE("worker-1") })).not.toBeInTheDocument();
  });

  test("a fatal error is shown with the summary", async () => {
    const channel = await start();
    channel.emit({ type: "finished", outcome: "failed", counts: counts({ total: 3, failed: 1, pending: 2 }), error: { kind: "accessDenied", action: "create pods/eviction" } });
    expect(screen.getByRole("status")).toHaveTextContent(t.DRAIN_OUTCOME.failed);
    expect(screen.getByText(/권한 없음 \(create pods\/eviction\)/)).toBeInTheDocument();
  });

  test("leaving the screen mid-drain cancels it, but not once it has finished", async () => {
    fakeChannel(9);
    api.preview.mockResolvedValue(preview);
    const { unmount } = render(<Harness />);
    fireEvent.click(screen.getByText("start"));
    fireEvent.change(await screen.findByLabelText(t.CHANGE_CONFIRM), { target: { value: "worker-1" } });
    fireEvent.click(screen.getByRole("button", { name: t.CHANGE_APPLY }));
    await screen.findByRole("dialog", { name: t.DRAIN_TITLE("worker-1") });
    unmount();
    await waitFor(() => expect(api.unwatch).toHaveBeenCalledWith(9));

    api.unwatch.mockClear();
    const second = fakeChannel(10);
    const view2 = render(<Harness />);
    fireEvent.click(screen.getByText("start"));
    fireEvent.change(await screen.findByLabelText(t.CHANGE_CONFIRM), { target: { value: "worker-1" } });
    fireEvent.click(screen.getByRole("button", { name: t.CHANGE_APPLY }));
    await screen.findByRole("dialog", { name: t.DRAIN_TITLE("worker-1") });
    second.emit({ type: "finished", outcome: "completed", counts: counts({ total: 0 }), error: null });
    view2.unmount();
    expect(api.unwatch).not.toHaveBeenCalled();
  });
});

describe("drain state", () => {
  test("pod messages change only known pods and finished clears stopping", () => {
    let run = startRun("n");
    run = reduceDrain(run, { type: "started", pods: [pod("a")], counts: counts({ total: 1, pending: 1 }) });
    run = reduceDrain(run, { type: "pod", namespace: "app", name: "ghost", state: "evicted", error: null, counts: counts({ total: 1 }) });
    expect(run.rows.map((row) => [row.pod.name, row.state])).toEqual([["a", "pending"]]);
    run = { ...run, stopping: true };
    run = reduceDrain(run, { type: "finished", outcome: "stopped", counts: counts({ total: 1, pending: 1 }), error: null });
    expect(run.stopping).toBe(false);
    expect(run.finished?.outcome).toBe("stopped");
  });
});
