import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { argowfApi } from "./api";
import { CONN, cron, tpl, wf } from "./catalogFixtures";
import { CAT_CONFIRM, SEC_TPL_CRONS, SEC_TPL_PARAMS, SUBMIT_NEED_NAMESPACE, TAB_TPL_RUNS, TAB_YAML, TPL_RUN } from "./catalogText";
import { TemplateDetail } from "./TemplateDetail";
import type { CronRow, TemplateRow, WfRow } from "./types";

vi.mock("./api", () => ({ argowfApi: { template: vi.fn(), submitTemplate: vi.fn(), remove: vi.fn() } }));
const m = vi.mocked(argowfApi);

const REPORT = tpl({
  name: "report",
  description: "일일 리포트를 만든다",
  parameters: [
    { name: "region", value: "ap-northeast-2", enum: [], description: "배포 리전" },
    { name: "env", value: null, enum: ["dev", "stg"], description: null },
  ],
  templates: ["main", "notify"],
});
const SHARED = tpl({
  kind: "ClusterWorkflowTemplate",
  namespace: null,
  name: "shared",
  parameters: [{ name: "mode", value: "fast", enum: ["fast", "slow"], description: null }],
});

interface SetupOver {
  row?: TemplateRow;
  workflows?: WfRow[];
  crons?: CronRow[];
}
function setup({ row = REPORT, workflows = [], crons = [] }: SetupOver = {}) {
  m.template.mockResolvedValue({ row, yaml: `kind: ${row.kind}\n` });
  const handlers = { onClose: vi.fn(), onOpenWorkflow: vi.fn(), onOpenCron: vi.fn(), onTokenError: vi.fn() };
  renderWithClient(<TemplateDetail conn={CONN} kind={row.kind} namespace={row.namespace} name={row.name} workflows={workflows} crons={crons} {...handlers} />);
  return handlers;
}
const openForm = async () => {
  const run = await screen.findByRole("button", { name: TPL_RUN });
  await waitFor(() => expect(run).toBeEnabled());
  fireEvent.click(run);
  return screen.getByRole("dialog");
};

beforeEach(() => {
  vi.resetAllMocks();
  m.submitTemplate.mockResolvedValue("report-abcde");
});

describe("개요", () => {
  test("설명, 파라미터(이름·기본값·선택지·설명), 템플릿 이름, 쓰는 Cron", async () => {
    const { onOpenCron } = setup({ crons: [cron({ name: "nightly", template: "report" }), cron({ name: "other", template: "x" })] });
    expect(await screen.findByText("일일 리포트를 만든다")).toBeInTheDocument();
    const params = screen.getByRole("region", { name: SEC_TPL_PARAMS });
    const region = within(params).getByRole("row", { name: /region/ });
    expect(within(region).getByText("ap-northeast-2")).toBeInTheDocument();
    expect(within(region).getByText("배포 리전")).toBeInTheDocument();
    expect(within(within(params).getByRole("row", { name: /env/ })).getByText("dev, stg")).toBeInTheDocument();
    expect(screen.getByText("notify")).toBeInTheDocument();
    const users = screen.getByRole("region", { name: SEC_TPL_CRONS });
    expect(within(users).queryByText("batch/other")).not.toBeInTheDocument();
    fireEvent.click(within(users).getByRole("button", { name: "batch/nightly" }));
    expect(onOpenCron).toHaveBeenCalledWith("batch", "nightly");
  });

  test("최근 실행을 누르면 그 Workflow를 열고, YAML 탭이 있다", async () => {
    const { onOpenWorkflow } = setup({
      workflows: [wf({ name: "report-run", uid: "u1", template: "report" }), wf({ name: "unrelated", uid: "u2", template: "x" })],
    });
    await screen.findByText("일일 리포트를 만든다");
    fireEvent.click(screen.getByRole("tab", { name: TAB_TPL_RUNS }));
    expect(screen.queryByText("unrelated")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("report-run"));
    expect(onOpenWorkflow).toHaveBeenCalledWith({ kind: "live", namespace: "batch", name: "report-run" });
    fireEvent.click(screen.getByRole("tab", { name: TAB_YAML }));
    expect(screen.getByText(/kind: WorkflowTemplate/)).toBeInTheDocument();
  });
});

test("운영 템플릿 삭제는 이름 확인이 필요하다", async () => {
  const row = tpl({ name: "prod-report" });
  m.remove.mockResolvedValue();
  const { onClose } = setup({ row });
  await screen.findByRole("button", { name: TPL_RUN });
  fireEvent.click(screen.getByRole("button", { name: "삭제" }));
  const dialog = screen.getByRole("dialog");
  const confirm = within(dialog).getByRole("button", { name: "삭제" });
  expect(confirm).toBeDisabled();
  fireEvent.change(within(dialog).getByPlaceholderText(/prod-report/), { target: { value: "prod-report" } });
  fireEvent.click(confirm);
  await waitFor(() => expect(m.remove).toHaveBeenCalledWith(CONN, "WorkflowTemplate", "batch", "prod-report"));
  expect(onClose).toHaveBeenCalled();
});
describe("실행 폼", () => {
  test("추가 실행 옵션을 검사만 요청에 보낸다", async () => {
    const { onOpenWorkflow } = setup();
    const dialog = await openForm();
    fireEvent.change(within(dialog).getByLabelText("env"), { target: { value: "dev" } });
    fireEvent.change(within(dialog).getByLabelText("Entrypoint"), { target: { value: "notify" } });
    fireEvent.change(within(dialog).getByLabelText("레이블"), { target: { value: "team=ops" } });
    fireEvent.change(within(dialog).getByLabelText("generateName"), { target: { value: "job-" } });
    fireEvent.change(within(dialog).getByLabelText("ServiceAccount"), { target: { value: "runner" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "검사만" }));
    await waitFor(() =>
      expect(m.submitTemplate).toHaveBeenCalledWith(CONN, "WorkflowTemplate", "batch", "batch", "report", {
        parameters: ["region=ap-northeast-2", "env=dev"],
        entryPoint: "notify",
        labels: "team=ops",
        generateName: "job-",
        serviceAccount: "runner",
        serverDryRun: true,
      }),
    );
    expect(onOpenWorkflow).not.toHaveBeenCalled();
  });
  test("기본값이 채워지고 enum은 선택 상자다. 고르지 않으면 보내지 않는다", async () => {
    setup();
    const dialog = await openForm();
    expect(within(dialog).getByLabelText("region")).toHaveValue("ap-northeast-2");
    const env = within(dialog).getByLabelText("env");
    expect(env.tagName).toBe("SELECT");
    expect(
      within(env)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["선택하세요", "dev", "stg"]);
    expect(env).toHaveValue("");
    // 네임스페이스 템플릿은 네임스페이스를 묻지 않는다
    expect(within(dialog).queryByLabelText("네임스페이스")).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: CAT_CONFIRM }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("env 값을 골라 주세요");
    expect(m.submitTemplate).not.toHaveBeenCalled();
  });

  test("값을 바꿔 보내면 모든 파라미터가 이름=값으로 가고, 만든 Workflow를 연다", async () => {
    const { onOpenWorkflow } = setup();
    const dialog = await openForm();
    fireEvent.change(within(dialog).getByLabelText("region"), { target: { value: "us-east-1" } });
    fireEvent.change(within(dialog).getByLabelText("env"), { target: { value: "stg" } });
    fireEvent.click(within(dialog).getByRole("button", { name: CAT_CONFIRM }));
    await waitFor(() => expect(onOpenWorkflow).toHaveBeenCalledWith({ kind: "live", namespace: "batch", name: "report-abcde" }));
    expect(m.submitTemplate).toHaveBeenCalledWith(CONN, "WorkflowTemplate", "batch", "batch", "report", {
      parameters: ["region=us-east-1", "env=stg"],
      entryPoint: REPORT.entrypoint,
      labels: null,
      generateName: null,
      serviceAccount: null,
      serverDryRun: false,
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("기본값이 선택지 안에 있으면 미리 골라 둔다", async () => {
    setup({ row: SHARED, workflows: [] });
    const dialog = await openForm();
    expect(within(dialog).getByLabelText("mode")).toHaveValue("fast");
  });

  test("ClusterWorkflowTemplate은 네임스페이스를 고른다: 처음엔 최근 실행의 것, 후보는 보이는 네임스페이스", async () => {
    const { onOpenWorkflow } = setup({
      row: SHARED,
      workflows: [
        wf({ name: "old", uid: "o", namespace: "batch", template: "shared", clusterTemplate: true, startedAt: "2026-11-01T00:00:00Z" }),
        wf({ name: "new", uid: "n", namespace: "ops", template: "shared", clusterTemplate: true, startedAt: "2026-11-02T00:00:00Z" }),
      ],
      crons: [cron({ namespace: "data" })],
    });
    m.submitTemplate.mockResolvedValue("shared-xyz");
    const dialog = await openForm();
    const ns = within(dialog).getByLabelText("네임스페이스");
    expect(ns).toHaveValue("ops");
    expect([...dialog.querySelectorAll("datalist option")].map((o) => o.getAttribute("value"))).toEqual(["batch", "data", "ops"]);

    fireEvent.change(ns, { target: { value: "data" } });
    fireEvent.click(within(dialog).getByRole("button", { name: CAT_CONFIRM }));
    await waitFor(() => expect(onOpenWorkflow).toHaveBeenCalledWith({ kind: "live", namespace: "data", name: "shared-xyz" }));
    expect(m.submitTemplate).toHaveBeenCalledWith(CONN, "ClusterWorkflowTemplate", null, "data", "shared", {
      parameters: ["mode=fast"],
      entryPoint: SHARED.entrypoint,
      labels: null,
      generateName: null,
      serviceAccount: null,
      serverDryRun: false,
    });
  });

  test("클러스터 템플릿에서 네임스페이스가 비면 보내지 않는다", async () => {
    setup({ row: SHARED });
    const dialog = await openForm();
    fireEvent.click(within(dialog).getByRole("button", { name: CAT_CONFIRM }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(SUBMIT_NEED_NAMESPACE);
    expect(m.submitTemplate).not.toHaveBeenCalled();
  });

  test("서버가 거절하면 메시지를 보이고 창을 유지한다", async () => {
    m.submitTemplate.mockRejectedValue(new Error("parameter env is required"));
    const { onOpenWorkflow } = setup({ row: tpl({ name: "report" }) });
    const dialog = await openForm();
    fireEvent.click(within(dialog).getByRole("button", { name: CAT_CONFIRM }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("parameter env is required");
    expect(onOpenWorkflow).not.toHaveBeenCalled();
  });
});
