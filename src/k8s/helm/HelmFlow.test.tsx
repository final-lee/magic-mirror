import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { typeYaml } from "../../test/codemirror";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../../test/utils";
import { k8sApi } from "../api";
import { ChangeDialog, useK8sChange } from "../ChangeFlow";
import { ChangeLog } from "../ChangeLog";
import * as k from "../text";
import type { K8sChangeLogEntry, K8sPreview } from "../types";
import { helmApi } from "./api";
import { HelmView } from "./HelmView";
import * as t from "./text";
import { ALLOWED, detail, KINDS, release, TARGET } from "./testData";
import { HELM_RELEASE_KIND } from "./types";

vi.mock("./api", () => ({ helmApi: { tool: vi.fn(), releases: vi.fn(), release: vi.fn(), showValues: vi.fn() } }));
vi.mock("../api", () => ({ k8sApi: { rules: vi.fn(), preview: vi.fn(), apply: vi.fn(), changeLog: vi.fn(), undo: vi.fn() } }));
vi.mock("../../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
const h = vi.mocked(helmApi);
const api = vi.mocked(k8sApi);

const lanes = { width: () => undefined, resize: vi.fn(), commit: vi.fn() };
const preview = (over: Partial<K8sPreview> = {}): K8sPreview => ({
  calls: [{ verb: "helm", path: "uninstall web --namespace apps --kube-context ctx", body: null }],
  diff: [{ path: "Deployment web", before: { kind: "Deployment" }, after: null }],
  impact: ["helm uninstall web: 릴리스의 객체 1개를 삭제해요"], warnings: ["이 삭제는 되돌릴 수 없어요"], confirmName: "web", reversible: false, conflicts: [], ...over,
});

/** 실제 변경 틀(useK8sChange·ChangeDialog)에 Helm 화면을 이어 붙인다 */
function Harness({ onDone }: { onDone: () => void }) {
  const flow = useK8sChange(TARGET, "p", onDone);
  return (
    <>
      <HelmView target={TARGET} context="ctx" ssoProfile="p" live visible namespace="apps" kinds={KINDS} appliedChange={null} onChange={flow.start} onOpenObject={vi.fn()} lanes={lanes} />
      {flow.pending && <ChangeDialog pending={flow.pending} apply={flow.apply} retry={flow.retry} cancel={flow.cancel} />}
    </>
  );
}

const mount = (ui: React.ReactElement) => render(withClientAndSso(ui, newQueryClient(), ssoLoginStub()));

beforeEach(() => {
  vi.resetAllMocks();
  h.tool.mockResolvedValue({ available: true, path: "/h", version: "v4.3.1", reason: null });
  h.releases.mockResolvedValue([release()]);
  h.release.mockImplementation(async (_t, _ns, name) => detail({ name }));
  api.rules.mockResolvedValue(ALLOWED);
});

const openUninstall = async () => {
  fireEvent.click(await screen.findByText("web"));
  const panel = await screen.findByRole("complementary", { name: t.DETAIL_LABEL });
  const remove = await within(panel).findByRole("button", { name: t.ACT_UNINSTALL });
  await waitFor(() => expect(remove).toBeEnabled());
  fireEvent.click(remove);
};

test("uninstall goes through the shared preview: the helm command is shown, applying needs the release name, then the typed name is sent", async () => {
  api.preview.mockResolvedValue(preview());
  api.apply.mockResolvedValue({ logId: "l1" });
  const done = vi.fn();
  mount(<Harness onDone={done} />);
  await openUninstall();
  expect(api.preview).toHaveBeenCalledWith(TARGET, { kind: HELM_RELEASE_KIND, namespace: "apps", name: "web", type: "helmUninstall", keepHistory: false }, "p");
  expect(await screen.findByText("helm uninstall web --namespace apps --kube-context ctx")).toBeInTheDocument();
  expect(screen.getByText("이 삭제는 되돌릴 수 없어요")).toBeInTheDocument();
  expect(screen.getByText("Deployment web")).toBeInTheDocument();
  const apply = screen.getByRole("button", { name: k.CHANGE_APPLY });
  expect(apply).toBeDisabled();
  fireEvent.change(screen.getByLabelText(k.CHANGE_CONFIRM), { target: { value: "wrong" } });
  expect(apply).toBeDisabled();
  fireEvent.change(screen.getByLabelText(k.CHANGE_CONFIRM), { target: { value: "web" } });
  fireEvent.click(apply);
  await waitFor(() => expect(api.apply).toHaveBeenCalledWith(TARGET, expect.objectContaining({ type: "helmUninstall", name: "web" }), "web", null, "p"));
  await waitFor(() => expect(done).toHaveBeenCalledWith(expect.objectContaining({ type: "helmUninstall" })));
});

test("a rejected preview (for example helm refusing the values) is shown and nothing can be applied", async () => {
  api.preview.mockRejectedValue({ kind: "other", message: "helm이 실패했어요: Error: values don't meet the specifications" });
  mount(<Harness onDone={vi.fn()} />);
  await openUninstall();
  expect(await screen.findByText(/values don't meet the specifications/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: k.CHANGE_APPLY })).toBeDisabled();
  expect(api.apply).not.toHaveBeenCalled();
});

test("an apply that fails after the preview asks for a new preview before trying again", async () => {
  api.preview.mockResolvedValue(preview({ confirmName: null }));
  api.apply.mockRejectedValue({ kind: "other", message: "미리보기 이후 바뀌었어요. 다시 미리보기 해 주세요" });
  mount(<Harness onDone={vi.fn()} />);
  await openUninstall();
  fireEvent.click(await screen.findByRole("button", { name: k.CHANGE_APPLY }));
  expect(await screen.findByText(/미리보기 이후 바뀌었어요/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: k.CHANGE_APPLY })).toBeDisabled();
});

test("an uninstall that keeps history is previewed with that choice", async () => {
  api.preview.mockResolvedValue(preview({ warnings: [], confirmName: "web", reversible: true }));
  mount(<Harness onDone={vi.fn()} />);
  fireEvent.click(await screen.findByText("web"));
  const panel = await screen.findByRole("complementary", { name: t.DETAIL_LABEL });
  fireEvent.click(await within(panel).findByLabelText(t.ACT_KEEP_HISTORY));
  const remove = within(panel).getByRole("button", { name: t.ACT_UNINSTALL });
  await waitFor(() => expect(remove).toBeEnabled());
  fireEvent.click(remove);
  await waitFor(() => expect(api.preview).toHaveBeenCalledWith(TARGET, expect.objectContaining({ type: "helmUninstall", keepHistory: true }), "p"));
});

test("an upgrade from the values editor is previewed with the edited values", async () => {
  api.preview.mockResolvedValue(preview({ calls: [{ verb: "helm", path: "upgrade web (리비전 3의 차트) --namespace apps", body: null }], confirmName: null, reversible: true, warnings: [] }));
  mount(<Harness onDone={vi.fn()} />);
  fireEvent.click(await screen.findByText("web"));
  const panel = await screen.findByRole("complementary", { name: t.DETAIL_LABEL });
  const upgrade = await within(panel).findByRole("button", { name: t.ACT_UPGRADE });
  await waitFor(() => expect(upgrade).toBeEnabled());
  fireEvent.click(upgrade);
  typeYaml("replicas: 4\n");
  fireEvent.click(await screen.findByRole("button", { name: t.ACT_PREVIEW }));
  await waitFor(() => expect(api.preview).toHaveBeenCalledWith(TARGET, expect.objectContaining({ type: "helmUpgrade", values: "replicas: 4\n", chart: null }), "p"));
  expect(await screen.findByText("helm upgrade web (리비전 3의 차트) --namespace apps")).toBeInTheDocument();
});

const entry = (over: Partial<K8sChangeLogEntry> = {}): K8sChangeLogEntry => ({
  id: "log1", at: "2026-01-02T00:00:00Z", target: TARGET,
  change: { kind: HELM_RELEASE_KIND, namespace: "apps", name: "web", type: "helmUpgrade", values: "", chart: null },
  summary: "helm upgrade web: 리비전 3 → 4", ok: true, error: null,
  inverse: { kind: HELM_RELEASE_KIND, namespace: "apps", name: "web", type: "helmRollback", revision: 3 }, undoOf: null, undone: false, ...over,
});

function LogHarness() {
  const flow = useK8sChange(TARGET, "p", () => {});
  return (
    <>
      <ChangeLog target={TARGET} onStart={flow.start} />
      {flow.pending && <ChangeDialog pending={flow.pending} apply={flow.apply} retry={flow.retry} cancel={flow.cancel} />}
    </>
  );
}

test("the change log undoes a helm upgrade with a rollback preview and applies it with the log id", async () => {
  api.changeLog.mockResolvedValue([entry()]);
  api.undo.mockResolvedValue({ target: TARGET, change: entry().inverse! });
  api.preview.mockResolvedValue(preview({ confirmName: null, warnings: [], calls: [{ verb: "helm", path: "rollback web 3 --namespace apps", body: null }] }));
  api.apply.mockResolvedValue({ logId: "l2" });
  mount(<LogHarness />);
  expect(await screen.findByText("helm upgrade web: 리비전 3 → 4")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: k.CHANGE_UNDO }));
  expect(await screen.findByText("helm rollback web 3 --namespace apps")).toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: k.CHANGE_UNDO_PREVIEW })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: k.CHANGE_APPLY }));
  await waitFor(() => expect(api.apply).toHaveBeenCalledWith(TARGET, expect.objectContaining({ type: "helmRollback", revision: 3 }), null, "log1", "p"));
});

test("an uninstall without kept history has no undo in the log", async () => {
  api.changeLog.mockResolvedValue([entry({ summary: "helm uninstall web", change: { kind: HELM_RELEASE_KIND, namespace: "apps", name: "web", type: "helmUninstall", keepHistory: false }, inverse: null })]);
  mount(<LogHarness />);
  expect(await screen.findByText("helm uninstall web")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: k.CHANGE_UNDO })).not.toBeInTheDocument();
});
