import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../../test/utils";
import { k8sApi } from "../api";
import type { K8sChange } from "../types";
import { securityApi } from "./api";
import { ALLOWED, READ_ONLY, TARGET, finding, report } from "./fixtures";
import { SecurityView } from "./SecurityView";
import * as t from "./text";
import type { SecurityChecksSetting, SecurityReport } from "./types";

vi.mock("./api", () => ({ securityApi: { findings: vi.fn() } }));
vi.mock("../api", () => ({ k8sApi: { rules: vi.fn() } }));
vi.mock("../../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
const s = vi.mocked(securityApi);
const k = vi.mocked(k8sApi);
const lanes = { width: () => undefined, resize: vi.fn(), commit: vi.fn() };

interface Opts {
  setting?: SecurityChecksSetting;
  applied?: K8sChange | null;
  withIam?: boolean;
}

function setup(data: SecurityReport = report(), opts: Opts = {}) {
  s.findings.mockResolvedValue(data);
  const handlers = { onSetting: vi.fn(), onChange: vi.fn(), onOpenObject: vi.fn(), onOpenIam: vi.fn(), onOpenAccess: vi.fn() };
  const qc = newQueryClient();
  const ui = (applied: K8sChange | null, setting: SecurityChecksSetting | undefined) =>
    withClientAndSso(
      <SecurityView
        target={TARGET}
        context="ctx"
        ssoProfile="exec"
        live
        setting={setting}
        onSetting={handlers.onSetting}
        appliedChange={applied}
        onChange={handlers.onChange}
        onOpenObject={handlers.onOpenObject}
        onOpenIam={opts.withIam === false ? undefined : handlers.onOpenIam}
        onOpenAccess={handlers.onOpenAccess}
        lanes={lanes}
      />,
      qc,
      ssoLoginStub(),
    );
  const view = render(ui(opts.applied ?? null, opts.setting));
  return { ...handlers, rerender: (applied: K8sChange | null, setting?: SecurityChecksSetting) => view.rerender(ui(applied, setting ?? opts.setting)) };
}

const summary = () => screen.getByRole("region", { name: t.SUMMARY_LABEL });
const card = (group: string, label: string) => within(within(summary()).getByRole("group", { name: group })).getByRole("button", { name: new RegExp(label) });
const table = () => screen.getByRole("table", { name: t.FINDINGS_TABLE_LABEL });
const detail = () => screen.getByRole("complementary", { name: t.DETAIL_LABEL });
const open = async (text: string | RegExp) => {
  fireEvent.click((await screen.findAllByText(text))[0].closest("tr")!);
  return detail();
};

beforeEach(() => {
  vi.resetAllMocks();
  k.rules.mockResolvedValue(ALLOWED);
});

test("the summary counts findings by severity and by category and leaves out system namespaces by default", async () => {
  setup();
  await screen.findByRole("table", { name: t.FINDINGS_TABLE_LABEL });
  expect(card(t.BY_SEVERITY_LABEL, "높음")).toHaveTextContent("5");
  expect(card(t.BY_SEVERITY_LABEL, "중간")).toHaveTextContent("1");
  expect(card(t.BY_SEVERITY_LABEL, "낮음")).toHaveTextContent("1");
  expect(card(t.BY_CATEGORY_LABEL, "클러스터")).toHaveTextContent("1");
  expect(card(t.BY_CATEGORY_LABEL, "권한")).toHaveTextContent("3");
  expect(card(t.BY_CATEGORY_LABEL, "워크로드")).toHaveTextContent("3");
  expect(summary()).toHaveTextContent("7건");
  expect(summary()).toHaveTextContent(t.HIDDEN_SYSTEM(1));
  expect(within(table()).queryByText("DaemonSet kube-system/agent")).not.toBeInTheDocument();
});

test("the system namespace switch saves the setting and the saved setting shows those findings", async () => {
  const { onSetting, rerender } = setup();
  fireEvent.click(await screen.findByRole("checkbox", { name: t.INCLUDE_SYSTEM }));
  expect(onSetting).toHaveBeenCalledWith({ disabled: [], includeSystem: true });
  rerender(null, { disabled: [], includeSystem: true });
  expect(await within(table()).findByText("DaemonSet kube-system/agent")).toBeInTheDocument();
  expect(summary()).toHaveTextContent("8건");
  expect(summary()).not.toHaveTextContent("숨겼어요");
});

test("turning a check off in the panel saves it, and a saved off check is gone from the list and the counts", async () => {
  const { onSetting, rerender } = setup();
  fireEvent.click(await screen.findByRole("button", { name: t.CHECKS_PANEL }));
  const panel = screen.getByRole("region", { name: t.CHECKS_PANEL });
  const privileged = within(panel).getByRole("checkbox", { name: new RegExp(t.CHECK_BY_ID.privileged.title) });
  expect(privileged).toBeChecked();
  fireEvent.click(privileged);
  expect(onSetting).toHaveBeenCalledWith({ disabled: ["privileged"], includeSystem: false });

  rerender(null, { disabled: ["privileged"], includeSystem: false });
  await waitFor(() => expect(within(table()).queryByText("Deployment dev/web")).toBeInTheDocument());
  expect(within(table()).queryByText(t.CHECK_BY_ID.privileged.title)).not.toBeInTheDocument();
  expect(card(t.BY_SEVERITY_LABEL, "높음")).toHaveTextContent("4");
  expect(within(screen.getByRole("region", { name: t.CHECKS_PANEL })).getByRole("checkbox", { name: new RegExp(t.CHECK_BY_ID.privileged.title) })).not.toBeChecked();
});

test("the panel switches a whole category off and shows how many findings each check has", async () => {
  const { onSetting } = setup();
  fireEvent.click(await screen.findByRole("button", { name: t.CHECKS_PANEL }));
  const panel = screen.getByRole("region", { name: t.CHECKS_PANEL });
  expect(within(panel).getByRole("checkbox", { name: new RegExp(t.CHECK_BY_ID.privileged.title) }).closest("label")).toHaveTextContent("1건");
  fireEvent.click(within(panel).getAllByRole("button", { name: t.CHECKS_DISABLE_ALL })[0]);
  const next = onSetting.mock.calls[0][0] as SecurityChecksSetting;
  expect(next.disabled).toHaveLength(6);
  expect(next.disabled).toContain("clusterPublicEndpoint");
});

test("a check that could not be read is marked in the panel and named in the banner, unless it is off", async () => {
  setup(report({ skipped: ["imdsHopLimit"] }));
  await screen.findByRole("table", { name: t.FINDINGS_TABLE_LABEL });
  expect(screen.getByRole("group", { name: t.GAPS_LABEL })).toHaveTextContent(t.skippedLine([t.CHECK_BY_ID.imdsHopLimit.title]));
  fireEvent.click(screen.getByRole("button", { name: t.CHECKS_PANEL }));
  expect(within(screen.getByRole("region", { name: t.CHECKS_PANEL })).getByText(t.CHECK_SKIPPED)).toBeInTheDocument();
});

test("a severity card filters the list and clicking it again clears the filter", async () => {
  setup();
  await screen.findByRole("table", { name: t.FINDINGS_TABLE_LABEL });
  fireEvent.click(card(t.BY_SEVERITY_LABEL, "중간"));
  expect(card(t.BY_SEVERITY_LABEL, "중간")).toHaveAttribute("aria-pressed", "true");
  const rows = within(table()).getAllByRole("row").slice(1);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toHaveTextContent(t.CHECK_BY_ID.privilegeEscalation.title);
  fireEvent.click(card(t.BY_SEVERITY_LABEL, "중간"));
  expect(within(table()).getAllByRole("row").slice(1)).toHaveLength(7);
});

test("the search box filters by target and message", async () => {
  setup();
  await screen.findByRole("table", { name: t.FINDINGS_TABLE_LABEL });
  fireEvent.change(screen.getByRole("searchbox", { name: t.FILTER_PLACEHOLDER }), { target: { value: "runner" } });
  const rows = within(table()).getAllByRole("row").slice(1);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toHaveTextContent("ServiceAccount ci/runner");
  fireEvent.change(screen.getByRole("searchbox", { name: t.FILTER_PLACEHOLDER }), { target: { value: "no-such" } });
  expect(screen.getByText(t.NO_MATCH)).toBeInTheDocument();
});

test("the list can be grouped by check with a count per group, and a group collapses", async () => {
  setup(report({ findings: [finding({ id: "a" }), finding({ id: "b", namespace: "ops" }), finding({ id: "c", check: "hostPath", severity: "medium", message: "hostPath 볼륨" })] }));
  await screen.findByRole("table", { name: t.FINDINGS_TABLE_LABEL });
  fireEvent.click(screen.getByRole("checkbox", { name: t.GROUP_BY_CHECK }));
  const group = screen.getByRole("region", { name: t.CHECK_BY_ID.privileged.title });
  expect(within(group).getByText("2건")).toBeInTheDocument();
  expect(within(group).getAllByRole("row")).toHaveLength(3);
  expect(screen.getByRole("region", { name: t.CHECK_BY_ID.hostPath.title })).toBeInTheDocument();
  // 묶으면 점검 항목 열은 머리글에 없다
  expect(within(group).queryByRole("columnheader", { name: new RegExp(t.H_CHECK) })).not.toBeInTheDocument();
  fireEvent.click(within(group).getByRole("button", { name: t.GROUP_COLLAPSE(t.CHECK_BY_ID.privileged.title, true) }));
  expect(within(group).queryByRole("table")).not.toBeInTheDocument();
});

test("clicking a finding opens the 70% detail with evidence, why it matters and how to fix it by hand; clicking it again closes it", async () => {
  setup();
  const d = await open(t.CHECK_BY_ID.privileged.title);
  expect(d).toHaveStyle({ width: "70%" });
  expect(within(d).getByText("컨테이너 app: privileged: true")).toBeInTheDocument();
  expect(within(d).getByText(t.CHECK_BY_ID.privileged.why)).toBeInTheDocument();
  expect(within(d).getByText(t.CHECK_BY_ID.privileged.remedy)).toBeInTheDocument();
  expect(within(d).getByText(t.NO_FIX)).toBeInTheDocument();
  expect(within(d).queryByRole("button", { name: t.FIX_BUTTON })).not.toBeInTheDocument();
  fireEvent.click(within(table()).getByText(t.CHECK_BY_ID.privileged.title).closest("tr")!);
  await waitFor(() => expect(screen.queryByRole("complementary", { name: t.DETAIL_LABEL })).not.toBeInTheDocument());
});

test("a fixable finding has a top-right fix button that starts the change preview with the partial object", async () => {
  const { onChange } = setup();
  const d = await open(t.CHECK_BY_ID.privilegeEscalation.title);
  const toolbar = d.querySelector(".k8s-toolbar") as HTMLElement;
  const fix = within(toolbar).getByRole("button", { name: t.FIX_BUTTON });
  expect(fix).toHaveClass("tone-primary");
  expect(within(d).getByText("컨테이너 app에 allowPrivilegeEscalation: false를 더해요")).toBeInTheDocument();
  expect(within(d).getByText("Pod 템플릿이 바뀌어 Pod가 새로 만들어져요(롤아웃)")).toBeInTheDocument();
  await waitFor(() => expect(k.rules).toHaveBeenCalled());
  fireEvent.click(fix);
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange.mock.calls[0][0]).toMatchObject({
    type: "apply", force: false, namespace: "dev", name: "web", kind: { kind: "Deployment" },
    object: { spec: { template: { spec: { containers: [{ name: "app", securityContext: { allowPrivilegeEscalation: false } }] } } } },
  });
});

test("the fix button is disabled with the reason when the identity cannot patch, and enabled while the rules are unknown", async () => {
  k.rules.mockResolvedValue(READ_ONLY);
  setup();
  const d = await open(t.CHECK_BY_ID.saTokenAutomount.title);
  const fix = within(d).getByRole("button", { name: t.FIX_BUTTON });
  await waitFor(() => expect(fix).toBeDisabled());
  expect(fix).toHaveAttribute("title", "serviceaccounts에 patch 권한이 없어요");
  expect(fix).toHaveAttribute("aria-description", "serviceaccounts에 patch 권한이 없어요");
});

test("an incomplete rule list leaves the fix enabled for the server to decide", async () => {
  k.rules.mockResolvedValue({ ...READ_ONLY, incomplete: true });
  setup();
  const d = await open(t.CHECK_BY_ID.saTokenAutomount.title);
  await waitFor(() => expect(k.rules).toHaveBeenCalled());
  expect(within(d).getByRole("button", { name: t.FIX_BUTTON })).toBeEnabled();
});

test("the target buttons open the object in the workloads view, the IAM principal in IAM, and the access screen", async () => {
  const { onOpenObject, onOpenIam, onOpenAccess } = setup();
  let d = await open(t.CHECK_BY_ID.privileged.title);
  fireEvent.click(within(d).getByRole("button", { name: t.OPEN_OBJECT }));
  expect(onOpenObject).toHaveBeenCalledWith({ kind: expect.objectContaining({ kind: "Deployment" }), namespace: "dev", name: "web" });

  d = await open(t.CHECK_BY_ID.adminSubject.title);
  fireEvent.click(within(d).getByRole("button", { name: t.OPEN_IAM }));
  expect(onOpenIam).toHaveBeenCalledWith("arn:aws:iam::1:role/ops");
  fireEvent.click(within(d).getByRole("button", { name: t.OPEN_ACCESS }));
  expect(onOpenAccess).toHaveBeenCalled();

  d = await open(t.CHECK_BY_ID.secretsReadAll.title);
  fireEvent.click(within(d).getByRole("button", { name: t.OPEN_SERVICE_ACCOUNT }));
  expect(onOpenObject).toHaveBeenLastCalledWith({ kind: expect.objectContaining({ kind: "ServiceAccount" }), namespace: "ci", name: "runner" });
});

test("an AWS resource has no open button and says it must be fixed in AWS; without an IAM handler the IAM button is not drawn", async () => {
  setup(report(), { withIam: false });
  let d = await open(t.CHECK_BY_ID.clusterPublicEndpoint.title);
  expect(within(d).queryByRole("button", { name: t.OPEN_OBJECT })).not.toBeInTheDocument();
  expect(within(d).getByText(t.AWS_TARGET_NOTE)).toBeInTheDocument();
  d = await open(t.CHECK_BY_ID.adminSubject.title);
  expect(within(d).queryByRole("button", { name: t.OPEN_IAM })).not.toBeInTheDocument();
  expect(within(d).getByRole("button", { name: t.OPEN_ACCESS })).toBeInTheDocument();
});

test("read failures are gaps next to the findings, not a failure of the screen", async () => {
  setup(report({ gaps: [{ section: "cluster", subject: null, error: { kind: "accessDenied", action: "eks:DescribeCluster" }, partial: false }, { section: "pods", subject: null, error: { kind: "other", message: "잘림" }, partial: true }] }));
  await screen.findByRole("table", { name: t.FINDINGS_TABLE_LABEL });
  const gaps = screen.getByRole("group", { name: t.GAPS_LABEL });
  expect(gaps).toHaveTextContent(t.gapLine([t.SECTION_LABELS.cluster]));
  expect(gaps).toHaveTextContent(t.PARTIAL_LINE([t.SECTION_LABELS.pods]));
  expect(within(table()).getAllByRole("row").length).toBeGreaterThan(1);
});

test("a clean cluster says nothing was found", async () => {
  setup(report({ findings: [] }));
  expect(await screen.findByText(t.ALL_CLEAR)).toBeInTheDocument();
});

test("a finding that disappears after a refresh closes its detail", async () => {
  const { rerender } = setup();
  await open(t.CHECK_BY_ID.privileged.title);
  rerender(null, { disabled: ["privileged"], includeSystem: false });
  await waitFor(() => expect(screen.queryByRole("complementary", { name: t.DETAIL_LABEL })).not.toBeInTheDocument());
});

test("applying a fix reads the findings again, but other changes do not", async () => {
  const { rerender } = setup();
  await screen.findByRole("table", { name: t.FINDINGS_TABLE_LABEL });
  expect(s.findings).toHaveBeenCalledTimes(1);
  rerender({ type: "scale", replicas: 2, kind: { group: "apps", version: "v1", kind: "Deployment", plural: "deployments", namespaced: true }, namespace: "dev", name: "web" });
  expect(s.findings).toHaveBeenCalledTimes(1);
  rerender({ type: "apply", force: false, object: {}, kind: { group: "", version: "v1", kind: "ServiceAccount", plural: "serviceaccounts", namespaced: true }, namespace: "dev", name: "default" });
  await waitFor(() => expect(s.findings).toHaveBeenCalledTimes(2));
});

test("a connection failure is shown as an error", async () => {
  s.findings.mockRejectedValue({ kind: "other", message: "연결할 수 없어요" });
  const qc = newQueryClient();
  render(
    withClientAndSso(
      <SecurityView target={TARGET} context="ctx" ssoProfile="exec" live setting={undefined} onSetting={vi.fn()} appliedChange={null} onChange={vi.fn()} onOpenObject={vi.fn()} onOpenAccess={vi.fn()} lanes={lanes} />,
      qc,
      ssoLoginStub(),
    ),
  );
  expect(await screen.findByText(/연결할 수 없어요/)).toBeInTheDocument();
});
