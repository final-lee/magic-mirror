import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChangeActions } from "./ChangeActions";
import { ChangeDialog, useK8sChange } from "./ChangeFlow";
import { k8sApi } from "./api";
import { CRONJOBS, DEPLOYMENTS, NODES } from "./kinds";
import * as t from "./text";
import type { K8sChange, K8sObjectView, K8sRules } from "./types";

vi.mock("./api", () => ({ k8sApi: { preview: vi.fn(), apply: vi.fn(), revisions: vi.fn() } }));
const api = vi.mocked(k8sApi);
const target = { profile: "p", region: "r", cluster: "c" };
const objectRef = { kind: DEPLOYMENTS, namespace: "prod", name: "web" };
const change: K8sChange = { ...objectRef, type: "restart" };
const view: K8sObjectView = { kind: DEPLOYMENTS, row: { uid: "u", name: "web", namespace: "prod", resourceVersion: "1", createdAt: null, labels: {}, values: { desired: "3" }, problems: [] }, annotations: {}, owners: [], children: [], childrenTruncated: false, childrenError: null, containers: [], conditions: [], events: [], eventsError: null, yaml: "", editYaml: "", secretKeys: null };
const rules: K8sRules = { namespace: "prod", incomplete: false, resourceRules: [], nonResourceRules: [] };
const preview = { calls: [{ verb: "PATCH", path: "/web", body: { x: 1 } }], diff: [{ path: "spec.x", before: 1, after: 2 }], impact: ["impact"], warnings: ["warning"], confirmName: "web", reversible: true, conflicts: [] };
beforeEach(() => { vi.resetAllMocks(); });

test("permissions explain disabled actions and scale validates the input", () => {
  const start = vi.fn();
  const { rerender } = render(<ChangeActions target={target} ssoProfile="p" objectRef={objectRef} view={view} rules={rules} onStart={start} />);
  expect(screen.getByRole("button", { name: t.CHANGE_SCALE })).toBeDisabled();
  expect(screen.getByRole("button", { name: t.CHANGE_DELETE })).toHaveAttribute("title", t.CHANGE_DENIED("delete", "deployments"));
  rerender(<ChangeActions target={target} ssoProfile="p" objectRef={objectRef} view={view} rules={{ ...rules, incomplete: true }} onStart={start} />);
  const input = screen.getByLabelText(t.CHANGE_REPLICAS);
  expect(input).toHaveValue(3);
  fireEvent.change(input, { target: { value: "-1" } });
  expect(screen.getByRole("button", { name: t.CHANGE_SCALE })).toBeDisabled();
  fireEvent.change(input, { target: { value: "4" } });
  fireEvent.click(screen.getByRole("button", { name: t.CHANGE_SCALE }));
  expect(start).toHaveBeenCalledWith({ ...objectRef, type: "scale", replicas: 4 });
});

test("rollout undo requires get and revision list as well as patch", () => {
  const start = vi.fn();
  const patchOnly = {
    ...rules,
    resourceRules: [{ verbs: ["patch"], apiGroups: ["apps"], resources: ["deployments"], resourceNames: [] }],
  };
  const renderActions = (current: K8sRules) => (
    <ChangeActions target={target} ssoProfile="p" objectRef={objectRef} view={view} rules={current} onStart={start} />
  );
  const { rerender } = render(renderActions(patchOnly));
  const undo = screen.getByRole("button", { name: t.CHANGE_ROLLOUT_UNDO });
  expect(undo).toBeDisabled();
  expect(undo).toHaveAttribute("title", t.CHANGE_DENIED("get", "deployments"));
  rerender(renderActions({
    ...patchOnly,
    resourceRules: [{ verbs: ["patch", "get"], apiGroups: ["apps"], resources: ["deployments"], resourceNames: [] }],
  }));
  expect(undo).toHaveAttribute("title", t.CHANGE_DENIED("list", "replicasets"));
  expect(api.revisions).not.toHaveBeenCalled();
});

test("rollout undo loads revisions and previews the selected revision", async () => {
  api.revisions.mockResolvedValue([{ revision: "2", name: "rev2" }, { revision: "1", name: "rev1" }]);
  const start = vi.fn();
  render(<ChangeActions target={target} ssoProfile="p" objectRef={objectRef} view={view} rules={{ ...rules, incomplete: true }} onStart={start} />);
  fireEvent.click(screen.getByRole("button", { name: t.CHANGE_ROLLOUT_UNDO }));
  await screen.findByRole("option", { name: "1 — rev1" });
  fireEvent.change(screen.getByLabelText(t.CHANGE_REVISION), { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: t.CHANGE_PREVIEW }));
  expect(start).toHaveBeenCalledWith({ ...objectRef, type: "rolloutUndo", revision: "1" });
});

test("CronJob run name is editable and suspend action follows its status", () => {
  const start = vi.fn();
  const cronRef = { ...objectRef, kind: CRONJOBS };
  const cronView = { ...view, kind: CRONJOBS, row: { ...view.row, values: { suspend: "false" } } };
  const allowed = { ...rules, incomplete: true };
  const renderActions = (current: K8sObjectView) => (
    <ChangeActions target={target} ssoProfile="p" objectRef={cronRef} view={current} rules={allowed} onStart={start} />
  );
  const { rerender } = render(renderActions(cronView));
  const name = screen.getByLabelText(t.CHANGE_JOB_NAME);
  expect((name as HTMLInputElement).value).toMatch(/^web-manual-\d+$/);
  fireEvent.change(name, { target: { value: "custom-job" } });
  fireEvent.click(screen.getByRole("button", { name: t.CHANGE_RUN_NOW }));
  expect(start).toHaveBeenCalledWith({ ...cronRef, type: "rerun", jobName: "custom-job" });
  fireEvent.click(screen.getByRole("button", { name: t.CHANGE_SUSPEND }));
  expect(start).toHaveBeenCalledWith({ ...cronRef, type: "suspend", suspend: true });
  rerender(renderActions({ ...cronView, row: { ...cronView.row, values: { suspend: "true" } } }));
  fireEvent.click(screen.getByRole("button", { name: t.CHANGE_RESUME }));
  expect(start).toHaveBeenCalledWith({ ...cronRef, type: "suspend", suspend: false });
});

test("node scheduling actions reflect permissions and the current state", () => {
  const start = vi.fn();
  const nodeRef = { kind: NODES, namespace: null, name: "node" };
  const nodeView = { ...view, kind: NODES, row: { ...view.row, name: "node", namespace: null, values: { status: "Ready" } } };
  const renderActions = (current: K8sObjectView, permissions: K8sRules) => (
    <ChangeActions target={target} ssoProfile="p" objectRef={nodeRef} view={current} rules={permissions} onStart={start} />
  );
  const { rerender } = render(renderActions(nodeView, rules));
  expect(screen.getByRole("button", { name: t.CHANGE_CORDON })).toBeDisabled();
  rerender(renderActions(nodeView, { ...rules, incomplete: true }));
  fireEvent.click(screen.getByRole("button", { name: t.CHANGE_CORDON }));
  expect(start).toHaveBeenCalledWith({ ...nodeRef, type: "cordon", unschedulable: true });
  rerender(renderActions({ ...nodeView, row: { ...nodeView.row, values: { status: "Ready,SchedulingDisabled" } } }, { ...rules, incomplete: true }));
  fireEvent.click(screen.getByRole("button", { name: t.CHANGE_UNCORDON }));
  expect(start).toHaveBeenCalledWith({ ...nodeRef, type: "cordon", unschedulable: false });
});

/** 작업 버튼에서 고른 변경을 실제 미리보기 흐름으로 넘긴다. */
function ActionFlow() {
  const flow = useK8sChange(target, "p", () => {});
  return (
    <>
      <ChangeActions target={target} ssoProfile="p" objectRef={objectRef} view={view}
        rules={{ ...rules, incomplete: true }} onStart={flow.start} />
      {flow.pending && <ChangeDialog pending={flow.pending} apply={flow.apply} retry={flow.retry} cancel={flow.cancel} />}
    </>
  );
}

test("the selected rollout revision is sent to preview", async () => {
  api.revisions.mockResolvedValue([{ revision: "7", name: "old" }]);
  api.preview.mockResolvedValue(preview);
  render(<ActionFlow />);
  fireEvent.click(screen.getByRole("button", { name: t.CHANGE_ROLLOUT_UNDO }));
  await screen.findByRole("option", { name: "7 — old" });
  fireEvent.click(screen.getByRole("button", { name: t.CHANGE_PREVIEW }));
  await waitFor(() => expect(api.preview).toHaveBeenCalledWith(target, { ...objectRef, type: "rolloutUndo", revision: "7" }, "p"));
});

function Harness() {
  const flow = useK8sChange(target, "p", () => {});
  return <><button onClick={() => flow.start(change, "log")}>start</button>{flow.pending && <ChangeDialog pending={flow.pending} apply={flow.apply} retry={flow.retry} cancel={flow.cancel} />}</>;
}
test("preview renders calls, diff and warnings, gates confirmation and blocks retry after apply error", async () => {
  api.preview.mockResolvedValue(preview);
  api.apply.mockRejectedValue(new Error("conflict"));
  render(<Harness />);
  fireEvent.click(screen.getByText("start"));
  expect(await screen.findByText("PATCH /web")).toBeInTheDocument();
  expect(screen.getByText("spec.x")).toBeInTheDocument();
  expect(screen.getByText("warning")).toBeInTheDocument();
  expect(screen.getByText("impact")).toBeInTheDocument();
  expect(screen.getAllByText("warning")).toHaveLength(1);
  fireEvent.click(screen.getByText(t.CHANGE_BODY));
  expect(screen.getByText(/"x": 1/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: t.CHANGE_APPLY })).toBeDisabled();
  fireEvent.change(screen.getByLabelText(t.CHANGE_CONFIRM), { target: { value: "web" } });
  fireEvent.click(screen.getByRole("button", { name: t.CHANGE_APPLY }));
  await waitFor(() => expect(api.apply).toHaveBeenCalledWith(target, change, "web", "log", "p"));
  expect(await screen.findByText(/conflict/)).toBeInTheDocument();
  expect(screen.getByText(/상태가 바뀌었을 수 있어서/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: t.CHANGE_APPLY })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: t.CHANGE_RETRY }));
  await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(2));
});
