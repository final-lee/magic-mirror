import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChangeActions } from "./ChangeActions";
import { ChangeDialog, useK8sChange } from "./ChangeFlow";
import { k8sApi } from "./api";
import { DEPLOYMENTS } from "./kinds";
import * as t from "./text";
import type { K8sChange, K8sObjectView, K8sRules } from "./types";

vi.mock("./api", () => ({ k8sApi: { preview: vi.fn(), apply: vi.fn(), revisions: vi.fn() } }));
const api = vi.mocked(k8sApi);
const target = { profile: "p", region: "r", cluster: "c" };
const objectRef = { kind: DEPLOYMENTS, namespace: "prod", name: "web" };
const change: K8sChange = { ...objectRef, type: "restart" };
const view: K8sObjectView = { kind: DEPLOYMENTS, row: { uid: "u", name: "web", namespace: "prod", resourceVersion: "1", createdAt: null, labels: {}, values: { desired: "3" }, problems: [] }, annotations: {}, owners: [], children: [], childrenTruncated: false, childrenError: null, containers: [], conditions: [], events: [], eventsError: null, yaml: "", secretKeys: null };
const rules: K8sRules = { namespace: "prod", incomplete: false, resourceRules: [], nonResourceRules: [] };
const preview = { calls: [{ verb: "PATCH", path: "/web", body: { x: 1 } }], diff: [{ path: "spec.x", before: 1, after: 2 }], impact: ["impact"], warnings: ["warning"], confirmName: "web", reversible: true };
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
  expect(screen.getByRole("button", { name: t.CHANGE_APPLY })).toBeDisabled();
  fireEvent.change(screen.getByLabelText(t.CHANGE_CONFIRM), { target: { value: "web" } });
  fireEvent.click(screen.getByRole("button", { name: t.CHANGE_APPLY }));
  await waitFor(() => expect(api.apply).toHaveBeenCalledWith(target, change, "web", "log", "p"));
  expect(await screen.findByText(/conflict/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: t.CHANGE_APPLY })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: t.CHANGE_RETRY }));
  await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(2));
});
