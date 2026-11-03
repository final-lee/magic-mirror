import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { argowfApi } from "./api";
import { ACTION_RETRY, typeNameHint } from "./ActionDialog";
import { CONN, cron, runs } from "./catalogFixtures";
import { CAT_CONFIRM, CRON_DELETE, CRON_RESUME, CRON_RUN, CRON_SUSPEND, SEC_CRON_NEXT, TAB_CRON_RUNS, TAB_YAML } from "./catalogText";
import { CronDetail } from "./CronDetail";
import type { CronDetail as CronDetailData, CronRow } from "./types";

vi.mock("./api", () => ({ argowfApi: { cron: vi.fn(), cronAction: vi.fn() } }));
const m = vi.mocked(argowfApi);

const detail = (row: CronRow): CronDetailData => ({
  row,
  entrypoint: "main",
  template: row.template,
  parameters: [{ name: "region", value: "ap-northeast-2" }],
  yaml: "kind: CronWorkflow\n",
});

function setup(over: { row?: CronRow; name?: string } = {}) {
  const row = over.row ?? cron();
  m.cron.mockResolvedValue(detail(row));
  const handlers = { onClose: vi.fn(), onOpenWorkflow: vi.fn(), onOpenTemplate: vi.fn(), onTokenError: vi.fn() };
  renderWithClient(
    <CronDetail conn={CONN} namespace={row.namespace} name={row.name} workflows={runs(row.name, ["Failed", "Succeeded"], row.namespace)} live {...handlers} />,
  );
  return handlers;
}
/** 상세를 읽기 전에는 동작 버튼이 꺼져 있다 */
const header = async (name: string) => {
  const button = await screen.findByRole("button", { name });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
};
const dialog = () => screen.getByRole("dialog");

beforeEach(() => {
  vi.resetAllMocks();
  m.cronAction.mockResolvedValue(null);
});

describe("개요", () => {
  test("스케줄과 다음 실행, 상태, Workflow 설정(템플릿 링크·파라미터)을 보인다", async () => {
    const { onOpenTemplate } = setup({ row: cron({ template: "report", active: ["nightly-active"], missed: true }) });
    expect(await screen.findByText("매일 19:30 (Asia/Seoul)")).toBeInTheDocument();
    expect(screen.getByText("30 19 * * *")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: SEC_CRON_NEXT })).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("nightly-active")).toBeInTheDocument();
    expect(screen.getByText("4 / 1")).toBeInTheDocument();
    expect(screen.getByText("region=ap-northeast-2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "report" }));
    expect(onOpenTemplate).toHaveBeenCalledWith("WorkflowTemplate", "batch", "report");
  });

  test("ClusterWorkflowTemplate을 쓰면 네임스페이스 없이 연다", async () => {
    const { onOpenTemplate } = setup({ row: cron({ template: "shared", clusterTemplate: true }) });
    fireEvent.click(await screen.findByRole("button", { name: "shared" }));
    expect(onOpenTemplate).toHaveBeenCalledWith("ClusterWorkflowTemplate", null, "shared");
  });

  test("정지된 Cron은 다음 실행이 돌지 않는다고 알린다", async () => {
    setup({ row: cron({ suspended: true }) });
    expect(await screen.findByText(/정지돼 있어서/)).toBeInTheDocument();
  });
});

describe("실행 이력·YAML", () => {
  test("이력의 Workflow를 누르면 상세로 연다", async () => {
    const { onOpenWorkflow } = setup();
    await screen.findByText("매일 19:30 (Asia/Seoul)");
    fireEvent.click(screen.getByRole("tab", { name: TAB_CRON_RUNS }));
    fireEvent.click(screen.getByText("nightly-0"));
    expect(onOpenWorkflow).toHaveBeenCalledWith({ kind: "live", namespace: "batch", name: "nightly-0" });
  });

  test("YAML 탭", async () => {
    setup();
    await screen.findByText("매일 19:30 (Asia/Seoul)");
    fireEvent.click(screen.getByRole("tab", { name: TAB_YAML }));
    expect(screen.getByText(/kind: CronWorkflow/)).toBeInTheDocument();
  });
});

describe("동작", () => {
  test("지금 실행: 확인 창을 거쳐 보내고, 만들어진 Workflow를 연다", async () => {
    m.cronAction.mockResolvedValue("nightly-manual-x1");
    const { onOpenWorkflow } = setup();
    fireEvent.click(await header(CRON_RUN));
    expect(m.cronAction).not.toHaveBeenCalled();
    fireEvent.click(within(dialog()).getByRole("button", { name: CAT_CONFIRM }));
    await waitFor(() => expect(onOpenWorkflow).toHaveBeenCalledWith({ kind: "live", namespace: "batch", name: "nightly-manual-x1" }));
    expect(m.cronAction).toHaveBeenCalledWith(CONN, "batch", "nightly", { kind: "submit" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("정지와 재개는 지금 상태에 따라 바뀐다", async () => {
    setup();
    fireEvent.click(await header(CRON_SUSPEND));
    fireEvent.click(within(dialog()).getByRole("button", { name: CAT_CONFIRM }));
    await waitFor(() => expect(m.cronAction).toHaveBeenCalledWith(CONN, "batch", "nightly", { kind: "suspend" }));
    expect(await screen.findByRole("status")).toHaveTextContent("정지했어요");
  });

  test("정지된 Cron에는 재개가 뜬다", async () => {
    setup({ row: cron({ suspended: true }) });
    const resume = await header(CRON_RESUME);
    expect(screen.queryByRole("button", { name: CRON_SUSPEND })).not.toBeInTheDocument();
    fireEvent.click(resume);
    fireEvent.click(within(dialog()).getByRole("button", { name: CAT_CONFIRM }));
    await waitFor(() => expect(m.cronAction).toHaveBeenCalledWith(CONN, "batch", "nightly", { kind: "resume" }));
  });

  test("삭제: prod가 들어간 이름은 이름을 쳐야 켜지고, 지우면 상세를 닫는다", async () => {
    const { onClose } = setup({ row: cron({ name: "prod-nightly" }) });
    fireEvent.click(await header(CRON_DELETE));
    const apply = within(dialog()).getByRole("button", { name: CAT_CONFIRM });
    expect(apply).toBeDisabled();
    const input = within(dialog()).getByPlaceholderText(typeNameHint("prod-nightly"));
    fireEvent.change(input, { target: { value: "prod-nightl" } });
    expect(apply).toBeDisabled();
    fireEvent.change(input, { target: { value: "prod-nightly" } });
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(m.cronAction).toHaveBeenCalledWith(CONN, "batch", "prod-nightly", { kind: "delete" });
  });

  test("prod가 아니면 이름을 치지 않아도 지운다(그래도 확인 창은 거친다)", async () => {
    setup();
    fireEvent.click(await header(CRON_DELETE));
    expect(within(dialog()).queryByRole("textbox")).not.toBeInTheDocument();
    expect(m.cronAction).not.toHaveBeenCalled();
    fireEvent.click(within(dialog()).getByRole("button", { name: CAT_CONFIRM }));
    await waitFor(() => expect(m.cronAction).toHaveBeenCalledWith(CONN, "batch", "nightly", { kind: "delete" }));
  });

  test("실패하면 서버 메시지를 보이고 창을 닫지 않는다. 열린 상세도 그대로", async () => {
    m.cronAction.mockRejectedValue(new Error("forbidden: cronworkflows is forbidden"));
    const { onClose, onOpenWorkflow } = setup();
    fireEvent.click(await header(CRON_RUN));
    fireEvent.click(within(dialog()).getByRole("button", { name: CAT_CONFIRM }));
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent("forbidden: cronworkflows is forbidden");
    expect(within(dialog()).getByRole("button", { name: ACTION_RETRY })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(onOpenWorkflow).not.toHaveBeenCalled();
  });
});
