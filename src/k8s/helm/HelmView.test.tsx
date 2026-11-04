import type { QueryClient } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { typeYaml } from "../../test/codemirror";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../../test/utils";
import { k8sApi } from "../api";
import type { K8sChange } from "../types";
import { helmApi } from "./api";
import { HelmView } from "./HelmView";
import * as t from "./text";
import { ALLOWED, detail, KINDS, READ_ONLY, release, revision, TARGET } from "./testData";
import type { HelmTool } from "./types";
import { findFor, findInput, findInputs } from "../testFind";

vi.mock("./api", () => ({ helmApi: { tool: vi.fn(), releases: vi.fn(), release: vi.fn(), showValues: vi.fn() } }));
vi.mock("../api", () => ({ k8sApi: { rules: vi.fn() } }));
vi.mock("../../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
const h = vi.mocked(helmApi);
const k = vi.mocked(k8sApi);

const TOOL: HelmTool = { available: true, path: "/opt/homebrew/bin/helm", version: "v4.3.1", reason: null };
const lanes = { width: () => undefined, resize: vi.fn(), commit: vi.fn() };
const RELEASES = [
  release(),
  release({ name: "api", namespace: "zeta", status: "failed", problem: true, chart: "api-0.1.0", description: "Upgrade failed" }),
  release({ name: "db", namespace: "apps", status: "pending-upgrade", problem: true, chart: "pg-2.0.0" }),
  release({ name: "old", namespace: "apps", status: "uninstalled", chart: "old-1.0.0" }),
];

function setup(props: { namespace?: string | null; applied?: K8sChange | null; qc?: QueryClient } = {}) {
  const onChange = vi.fn();
  const onOpenObject = vi.fn();
  const qc = props.qc ?? newQueryClient();
  const ui = (applied: K8sChange | null) => withClientAndSso(
    <HelmView target={TARGET} context="ctx" ssoProfile="p" live visible namespace={props.namespace === undefined ? null : props.namespace} kinds={KINDS}
      appliedChange={applied} onChange={onChange} onOpenObject={onOpenObject} lanes={lanes} now={Date.parse("2026-01-02T01:00:00Z")} />,
    qc, ssoLoginStub(),
  );
  const view = render(ui(props.applied ?? null));
  return { onChange, onOpenObject, rerender: (applied: K8sChange | null) => view.rerender(ui(applied)) };
}

const row = (name: string) => screen.getByRole("row", { name: new RegExp(`^${name}\\b`) });
const open = async (name: string) => {
  fireEvent.click(await screen.findByText(name));
  return await screen.findByRole("complementary", { name: t.DETAIL_LABEL });
};

/** helm 확인이 끝나 단추가 켜진 뒤에 누른다 */
const clickInstall = async () => {
  const install = await screen.findByRole("button", { name: t.ACT_INSTALL });
  await waitFor(() => expect(install).toBeEnabled());
  fireEvent.click(install);
};

beforeEach(() => {
  vi.resetAllMocks();
  h.tool.mockResolvedValue(TOOL);
  h.releases.mockResolvedValue(RELEASES);
  h.release.mockImplementation(async (_t, _ns, name, rev) => detail({ name, revision: rev ?? 3 }));
  k.rules.mockResolvedValue(ALLOWED);
});

test("lists each release with its chart, app version, revision and a status badge, and shows problem releases", async () => {
  setup();
  await screen.findByText("web");
  const web = row("web");
  expect(within(web).getByText("web-1.0.0")).toBeInTheDocument();
  expect(within(web).getByText("deployed")).toHaveClass("ok");
  expect(within(row("api")).getByText("failed")).toHaveClass("bad");
  expect(within(row("db")).getByText("pending-upgrade")).toHaveClass("warn");
  expect(within(row("old")).getByText("uninstalled")).toHaveClass("muted");
  expect(screen.getByText(t.PROBLEM_COUNT(2))).toBeInTheDocument();
});

test("the namespace column is shown only when all namespaces are listed and the list asks the backend for the chosen namespace", async () => {
  setup({ namespace: "apps" });
  await screen.findByText("web");
  expect(screen.queryByRole("columnheader", { name: new RegExp(t.COL_NAMESPACE) })).not.toBeInTheDocument();
  expect(h.releases).toHaveBeenCalledWith(TARGET, "apps", "p");
});

test("all namespaces shows the namespace column", async () => {
  setup({ namespace: null });
  await screen.findByText("web");
  expect(screen.getByRole("columnheader", { name: new RegExp(t.COL_NAMESPACE) })).toBeInTheDocument();
  expect(h.releases).toHaveBeenCalledWith(TARGET, null, "p");
});

test("⌘F finds by name, chart, namespace and status, and only-problems keeps failed and pending releases", async () => {
  setup();
  await screen.findByText("web");
  expect(findInputs()).toHaveLength(0);
  findFor("pg-2");
  expect(screen.getByText("db")).toBeInTheDocument();
  expect(screen.queryByText("web")).not.toBeInTheDocument();
  findFor("zeta");
  expect(screen.getByText("api")).toBeInTheDocument();
  expect(screen.queryByText("db")).not.toBeInTheDocument();
  findFor("nothing-matches");
  expect(screen.getByText(t.LIST_NO_MATCH)).toBeInTheDocument();
  fireEvent.keyDown(findInput(), { key: "Escape" });
  fireEvent.click(screen.getByLabelText(t.ONLY_PROBLEMS));
  expect(screen.getByText("api")).toBeInTheDocument();
  expect(screen.getByText("db")).toBeInTheDocument();
  expect(screen.queryByText("web")).not.toBeInTheDocument();
  expect(screen.queryByText("old")).not.toBeInTheDocument();
});

test("an empty namespace says there are no releases", async () => {
  h.releases.mockResolvedValue([]);
  setup();
  expect(await screen.findByText(t.LIST_EMPTY)).toBeInTheDocument();
});

test("a release whose data could not be read is marked instead of hiding the row", async () => {
  h.releases.mockResolvedValue([release({ unreadable: true, chart: "" })]);
  setup();
  expect(await screen.findByText(t.UNREADABLE_ROW)).toBeInTheDocument();
});

test("opening a row shows the detail overlay and closing it returns to the list", async () => {
  setup();
  const panel = await open("web");
  expect(await within(panel).findByText("apps/web")).toBeInTheDocument();
  fireEvent.click(within(panel).getByRole("button", { name: t.CLOSE }));
  expect(screen.queryByRole("complementary", { name: t.DETAIL_LABEL })).not.toBeInTheDocument();
});

test("the detail closes by itself when the release disappears from the list after an uninstall", async () => {
  const qc = newQueryClient();
  setup({ qc });
  await open("web");
  h.releases.mockResolvedValue(RELEASES.filter((r) => r.name !== "web"));
  await qc.invalidateQueries();
  await waitFor(() => expect(screen.queryByRole("complementary", { name: t.DETAIL_LABEL })).not.toBeInTheDocument());
});

test("a helm change that was just applied re-reads the list and a different kind of change does not", async () => {
  const { rerender } = setup();
  await screen.findByText("web");
  const calls = () => h.releases.mock.calls.length;
  const before = calls();
  rerender({ kind: { group: "apps", version: "v1", kind: "Deployment", plural: "deployments", namespaced: true }, namespace: "apps", name: "x", type: "restart" });
  // 다시 읽지 않았음을 보이려면 잠깐 기다려 봐야 한다(TS lib에 Promise.withResolvers가 없다)
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(calls()).toBe(before);
  h.releases.mockResolvedValue([release({ revision: 4 })]);
  rerender({ kind: { group: "helm.sh", version: "v1", kind: "Release", plural: "releases", namespaced: true }, namespace: "apps", name: "web", type: "helmRollback", revision: 2 });
  await waitFor(() => expect(calls()).toBeGreaterThan(before));
  expect(await screen.findByText("4")).toBeInTheDocument();
});

test("without helm the install button is disabled with the reason", async () => {
  h.tool.mockResolvedValue({ available: false, path: null, version: null, reason: "helm을 찾지 못했어요. helm을 설치(brew install helm)한 뒤 앱을 다시 열어 주세요" });
  setup();
  const install = await screen.findByRole("button", { name: t.ACT_INSTALL });
  await waitFor(() => expect(install).toHaveAttribute("title", expect.stringContaining("brew install helm")));
  expect(install).toBeDisabled();
});

test("the install button opens the install dialog with the chosen namespace and previews through the change flow", async () => {
  const { onChange } = setup({ namespace: "apps" });
  await clickInstall();
  const dialog = await screen.findByRole("dialog", { name: t.INSTALL_TITLE });
  expect(within(dialog).getByLabelText(t.INSTALL_NAMESPACE)).toHaveValue("apps");
  fireEvent.change(within(dialog).getByLabelText(t.INSTALL_NAME), { target: { value: "cache" } });
  fireEvent.change(within(dialog).getByLabelText(t.SRC_PATH_LABEL), { target: { value: "/charts/cache" } });
  typeYaml("replicas: 2\n");
  fireEvent.click(within(dialog).getByRole("button", { name: t.ACT_PREVIEW }));
  expect(onChange).toHaveBeenCalledWith({
    kind: { group: "helm.sh", version: "v1", kind: "Release", plural: "releases", namespaced: true },
    namespace: "apps", name: "cache", type: "helmInstall", chart: { reference: "/charts/cache", repo: null, version: null }, values: "replicas: 2\n", createNamespace: false,
  });
  expect(screen.queryByRole("dialog", { name: t.INSTALL_TITLE })).not.toBeInTheDocument();
});

test("all namespaces installs into default unless another namespace is typed", async () => {
  setup({ namespace: null });
  await clickInstall();
  expect(await screen.findByLabelText(t.INSTALL_NAMESPACE)).toHaveValue("default");
});

test("detail toolbar: upgrade, rollback and uninstall are enabled for the latest revision with permission", async () => {
  setup();
  const panel = await open("web");
  await within(panel).findByText("apps/web");
  for (const name of [t.ACT_UPGRADE, t.ACT_ROLLBACK, t.ACT_UNINSTALL]) {
    await waitFor(() => expect(within(panel).getByRole("button", { name })).toBeEnabled());
  }
});

test("without secret create permission the change buttons are disabled with the missing permission as the reason", async () => {
  k.rules.mockResolvedValue(READ_ONLY);
  setup();
  const panel = await open("web");
  const upgrade = await within(panel).findByRole("button", { name: t.ACT_UPGRADE });
  await waitFor(() => expect(upgrade).toHaveAttribute("title", t.DENIED("create", "secrets")));
  expect(upgrade).toBeDisabled();
  expect(within(panel).getByRole("button", { name: t.ACT_UNINSTALL })).toHaveAttribute("title", t.DENIED("delete", "secrets"));
});

test("an incomplete rule list leaves the buttons on for the server to decide", async () => {
  k.rules.mockResolvedValue({ ...READ_ONLY, incomplete: true });
  setup();
  const panel = await open("web");
  await waitFor(() => expect(within(panel).getByRole("button", { name: t.ACT_UPGRADE })).toBeEnabled());
});

test("a configmap-driver release checks configmap permission instead of secrets", async () => {
  h.release.mockImplementation(async (_t, _ns, name) => detail({ name, driver: "configMap" }));
  k.rules.mockResolvedValue(READ_ONLY);
  setup();
  const panel = await open("web");
  await waitFor(() => expect(within(panel).getByRole("button", { name: t.ACT_UPGRADE })).toBeEnabled());
  expect(within(panel).getByText(t.STORE_CONFIGMAP, { selector: "dd" })).toBeInTheDocument();
});

test("uninstall starts the change with the keep-history choice", async () => {
  const { onChange } = setup();
  const panel = await open("web");
  const remove = await within(panel).findByRole("button", { name: t.ACT_UNINSTALL });
  await waitFor(() => expect(remove).toBeEnabled());
  fireEvent.click(remove);
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ type: "helmUninstall", keepHistory: false, namespace: "apps", name: "web" }));
  fireEvent.click(within(panel).getByLabelText(t.ACT_KEEP_HISTORY));
  fireEvent.click(remove);
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ type: "helmUninstall", keepHistory: true }));
});

test("rollback offers the other revisions, starting from the previous one", async () => {
  const { onChange } = setup();
  const panel = await open("web");
  const rollback = await within(panel).findByRole("button", { name: t.ACT_ROLLBACK });
  await waitFor(() => expect(rollback).toBeEnabled());
  fireEvent.click(rollback);
  const select = within(panel).getByLabelText(t.ACT_REVISION);
  await waitFor(() => expect(select).toHaveValue("2"));
  expect(within(select).queryByRole("option", { name: /^3/ })).not.toBeInTheDocument();
  fireEvent.change(select, { target: { value: "1" } });
  fireEvent.click(within(panel).getByRole("button", { name: t.ACT_PREVIEW }));
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ type: "helmRollback", revision: 1, name: "web" }));
});

test("a release with a single revision has nothing to roll back to", async () => {
  h.release.mockImplementation(async (_t, _ns, name) => detail({ name, history: [revision(3)] }));
  setup();
  const panel = await open("web");
  const rollback = await within(panel).findByRole("button", { name: t.ACT_ROLLBACK });
  await waitFor(() => expect(rollback).toHaveAttribute("title", t.ACT_NO_OTHER_REVISION));
  expect(rollback).toBeDisabled();
});

test("editing values: the editor starts from the user values, syntax errors block the preview and the typed text is sent", async () => {
  const { onChange } = setup();
  const panel = await open("web");
  const upgrade = await within(panel).findByRole("button", { name: t.ACT_UPGRADE });
  await waitFor(() => expect(upgrade).toBeEnabled());
  fireEvent.click(upgrade);
  const dialog = await screen.findByRole("dialog", { name: t.UPGRADE_TITLE("web") });
  expect(dialog.querySelector(".cm-content")?.textContent).toContain("replicas: 2");
  typeYaml("a: [unclosed\n");
  await waitFor(() => expect(within(dialog).getByRole("button", { name: t.ACT_PREVIEW })).toBeDisabled());
  typeYaml("replicas: 5\nimage:\n  tag: v2\n");
  await waitFor(() => expect(within(dialog).getByRole("button", { name: t.ACT_PREVIEW })).toBeEnabled());
  fireEvent.click(within(dialog).getByRole("button", { name: t.ACT_PREVIEW }));
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ type: "helmUpgrade", namespace: "apps", name: "web", values: "replicas: 5\nimage:\n  tag: v2\n", chart: null }));
});

test("upgrading to another chart needs a chart location and sends it with the version", async () => {
  const { onChange } = setup();
  const panel = await open("web");
  const upgrade = await within(panel).findByRole("button", { name: t.ACT_UPGRADE });
  await waitFor(() => expect(upgrade).toBeEnabled());
  fireEvent.click(upgrade);
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByLabelText(t.UPGRADE_CHART_OTHER));
  const preview = within(dialog).getByRole("button", { name: t.ACT_PREVIEW });
  expect(preview).toBeDisabled();
  fireEvent.click(within(dialog).getByLabelText(t.SRC_REPO));
  fireEvent.change(within(dialog).getByLabelText(t.SRC_REPO_URL), { target: { value: "https://charts.example.com" } });
  expect(preview).toBeDisabled();
  fireEvent.change(within(dialog).getByLabelText(t.SRC_CHART_NAME), { target: { value: "web" } });
  fireEvent.change(within(dialog).getByLabelText(t.SRC_VERSION), { target: { value: "2.0.0" } });
  expect(preview).toBeEnabled();
  fireEvent.click(preview);
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ type: "helmUpgrade", chart: { reference: "web", repo: "https://charts.example.com", version: "2.0.0" } }));
});

test("a stored-chart upgrade says no repository is contacted", async () => {
  setup();
  const panel = await open("web");
  const upgrade = await within(panel).findByRole("button", { name: t.ACT_UPGRADE });
  await waitFor(() => expect(upgrade).toBeEnabled());
  fireEvent.click(upgrade);
  expect(await screen.findByText(t.UPGRADE_STORED_NOTE("web-1.0.0"))).toBeInTheDocument();
});

test("without helm every change button in the detail is disabled with the reason", async () => {
  const reason = "helm을 찾지 못했어요";
  h.tool.mockResolvedValue({ available: false, path: null, version: null, reason });
  setup();
  const panel = await open("web");
  for (const name of [t.ACT_UPGRADE, t.ACT_UNINSTALL]) {
    const button = await within(panel).findByRole("button", { name });
    await waitFor(() => expect(button).toHaveAttribute("title", reason));
    expect(button).toBeDisabled();
  }
});

test("summary lists resources, opens known kinds in the workloads view with the release namespace as the default and leaves unknown kinds as text", async () => {
  const { onOpenObject } = setup();
  const panel = await open("web");
  fireEvent.click(await within(panel).findByRole("button", { name: `${t.OPEN_OBJECT}: Deployment/web` }));
  expect(onOpenObject).toHaveBeenCalledWith({ kind: expect.objectContaining({ kind: "Deployment", group: "apps", plural: "deployments" }), namespace: "apps", name: "web" });
  fireEvent.click(within(panel).getByRole("button", { name: `${t.OPEN_OBJECT}: ConfigMap/web-config` }));
  expect(onOpenObject).toHaveBeenLastCalledWith({ kind: expect.objectContaining({ kind: "ConfigMap" }), namespace: "apps", name: "web-config" });
  expect(within(panel).getByText("w1")).toHaveAttribute("title", t.NOT_OPENABLE);
  expect(within(panel).queryByRole("button", { name: /Widget/ })).not.toBeInTheDocument();
});

test("a failed release explains why and a pending one warns about the stuck operation", async () => {
  h.release.mockImplementation(async (_t, _ns, name) => detail({ name, status: "pending-upgrade", problem: true, description: "Upgrade in progress" }));
  setup();
  const panel = await open("web");
  expect(await within(panel).findByText(t.PENDING_NOTE)).toBeInTheDocument();
  expect(within(panel).getAllByText("Upgrade in progress").length).toBeGreaterThan(0);
});

test("values tab shows the given values and the computed values", async () => {
  setup();
  const panel = await open("web");
  fireEvent.click(await within(panel).findByRole("tab", { name: t.TAB_VALUES }));
  expect(await within(panel).findByText(t.VALUES_USER)).toBeInTheDocument();
  expect(panel.textContent).toContain("replicas");
  expect(panel.textContent).toContain("image");
  expect(within(panel).getByText(t.VALUES_COMPUTED)).toBeInTheDocument();
});

test("a release without user values says the chart defaults are used", async () => {
  h.release.mockImplementation(async (_t, _ns, name) => detail({ name, userValues: "" }));
  setup();
  const panel = await open("web");
  fireEvent.click(await within(panel).findByRole("tab", { name: t.TAB_VALUES }));
  expect(await within(panel).findByText(t.VALUES_USER_EMPTY)).toBeInTheDocument();
});

test("manifest tab notes that secret values are hidden, and the notes tab shows the chart notes or says there are none", async () => {
  setup();
  const panel = await open("web");
  fireEvent.click(await within(panel).findByRole("tab", { name: t.TAB_MANIFEST }));
  expect(await within(panel).findByText(t.MANIFEST_NOTE)).toBeInTheDocument();
  fireEvent.click(within(panel).getByRole("tab", { name: t.TAB_NOTES }));
  expect(within(panel).getByText(/Visit http:\/\/web/)).toBeInTheDocument();
});

test("no notes says so", async () => {
  h.release.mockImplementation(async (_t, _ns, name) => detail({ name, notes: "  \n" }));
  setup();
  const panel = await open("web");
  fireEvent.click(await within(panel).findByRole("tab", { name: t.TAB_NOTES }));
  expect(await within(panel).findByText(t.NOTES_EMPTY)).toBeInTheDocument();
});

test("history lists every revision, views an older one read-only and rolls back from a row", async () => {
  const { onChange } = setup();
  const panel = await open("web");
  fireEvent.click(await within(panel).findByRole("tab", { name: t.TAB_HISTORY }));
  const table = await within(panel).findByRole("table", { name: t.TAB_HISTORY });
  expect(within(table).getAllByRole("row")).toHaveLength(4);
  expect(within(table).getByText("3 (최신)")).toBeInTheDocument();
  // 최신 행에는 롤백 단추가 없다
  expect(within(table).getAllByRole("button", { name: t.HISTORY_ROLLBACK })).toHaveLength(2);
  fireEvent.click(within(table).getAllByRole("button", { name: t.HISTORY_ROLLBACK })[1]);
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ type: "helmRollback", revision: 1 }));
  fireEvent.click(within(table).getAllByRole("button", { name: t.HISTORY_VIEW })[0]);
  await waitFor(() => expect(h.release).toHaveBeenCalledWith(TARGET, "apps", "web", 2, "p"));
  expect(await within(panel).findByText(t.VIEWING_OLD(2, 3))).toBeInTheDocument();
  // 옛 리비전을 보는 동안은 변경 단추가 이유와 함께 꺼진다
  expect(within(panel).getByRole("button", { name: t.ACT_UPGRADE })).toHaveAttribute("title", t.NEED_LATEST);
  expect(within(panel).getByRole("button", { name: t.ACT_UNINSTALL })).toBeDisabled();
  fireEvent.click(within(panel).getByRole("button", { name: t.VIEW_LATEST }));
  await waitFor(() => expect(within(panel).queryByText(t.VIEWING_OLD(2, 3))).not.toBeInTheDocument());
});

test("a revision whose data could not be read cannot be viewed", async () => {
  h.release.mockImplementation(async (_t, _ns, name) => detail({ name, history: [revision(3), revision(2, { unreadable: true })] }));
  setup();
  const panel = await open("web");
  fireEvent.click(await within(panel).findByRole("tab", { name: t.TAB_HISTORY }));
  const table = await within(panel).findByRole("table", { name: t.TAB_HISTORY });
  expect(within(table).getByText(t.HISTORY_UNREADABLE)).toBeInTheDocument();
  expect(within(table).getByRole("button", { name: t.HISTORY_VIEW })).toBeDisabled();
});

test("a backend error in the detail is shown with a retry", async () => {
  h.release.mockRejectedValue({ kind: "other", message: "릴리스를 찾지 못했어요" });
  setup();
  const panel = await open("web");
  expect(await within(panel).findByText(/릴리스를 찾지 못했어요/)).toBeInTheDocument();
});

test("a list error is shown without hiding the toolbar", async () => {
  h.releases.mockRejectedValue({ kind: "accessDenied", action: "list secrets" });
  setup();
  await waitFor(() => expect(screen.getByRole("button", { name: t.ACT_INSTALL })).toBeInTheDocument());
  expect(await screen.findByText(/list secrets/)).toBeInTheDocument();
});
