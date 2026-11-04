import { act, fireEvent, screen, within } from "@testing-library/react";
import { dispatchKey } from "../keymap/registry";
import { renderWithClient } from "../test/utils";
import { argowfApi } from "./api";
import { CONN, cron, tpl, wf } from "./catalogFixtures";
import { CAT_NO_TEMPLATE_MATCH, CAT_NO_TEMPLATES, TPL_CLUSTER } from "./catalogText";
import { TemplateList } from "./TemplateList";
import type { WfRow } from "./types";

vi.mock("./api", () => ({ argowfApi: { templates: vi.fn() } }));
const m = vi.mocked(argowfApi);

const TEMPLATES = [
  tpl({
    name: "report",
    parameters: [
      { name: "a", value: null, enum: [], description: null },
      { name: "b", value: "x", enum: [], description: null },
    ],
  }),
  tpl({ kind: "ClusterWorkflowTemplate", namespace: null, name: "shared" }),
  tpl({ name: "backup", namespace: "ops" }),
];
const runFor = (name: string, i: number, phase: WfRow["phase"], extra: Partial<WfRow> = {}) =>
  wf({ name: `${name}-${i}`, uid: `${name}-${i}`, template: name, phase, startedAt: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(), ...extra });
const WORKFLOWS = [
  runFor("report", 0, "Succeeded"),
  runFor("report", 1, "Succeeded"),
  runFor("report", 2, "Succeeded"),
  runFor("report", 3, "Failed"),
  runFor("report", 4, "Running"),
];
const CRONS = [
  cron({ name: "a", template: "report" }),
  cron({ name: "b", template: "report" }),
  cron({ name: "c", template: "shared", clusterTemplate: true, namespace: "ops" }),
  cron({ name: "d", template: "report", namespace: "ops" }),
];

function setup(over: Partial<Parameters<typeof TemplateList>[0]> = {}) {
  const handlers = { onOpen: vi.fn(), onTokenError: vi.fn() };
  renderWithClient(<TemplateList conn={CONN} live workflows={WORKFLOWS} crons={CRONS} selected={null} {...handlers} {...over} />);
  return handlers;
}
const rowOf = (name: string) => screen.getByRole("row", { name: new RegExp(name) });

beforeEach(() => {
  vi.resetAllMocks();
  m.templates.mockResolvedValue(TEMPLATES);
});

describe("TemplateList", () => {
  test("두 종류를 한 목록에: 클러스터 배지, 파라미터 수, 쓰는 Cron 수, 최근 성공률(끝난 실행만)", async () => {
    setup();
    const report = await screen.findByRole("row", { name: /report/ });
    const cells = within(report).getAllByRole("cell");
    expect(cells.map((c) => c.textContent)).toEqual(["report", "batch", "2", "2", "75% (3/4)"]);

    const shared = rowOf("shared");
    expect(within(shared).getByText(TPL_CLUSTER)).toBeInTheDocument();
    // 클러스터 템플릿을 쓰는 Cron은 네임스페이스와 상관없이 센다. 네임스페이스 템플릿은 같은 네임스페이스만
    expect(
      within(shared)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["shared", TPL_CLUSTER, "0", "1", "실행 없음"]);
    expect(within(rowOf("backup")).getAllByRole("cell")[3]).toHaveTextContent("0");
  });

  test("클러스터 템플릿은 네임스페이스 템플릿 뒤에 온다", async () => {
    setup();
    await screen.findByRole("row", { name: /report/ });
    const names = screen
      .getAllByRole("row")
      .slice(1)
      .map((r) => within(r).getAllByRole("cell")[0].textContent);
    expect(names).toEqual(["report", "backup", "shared"]);
  });

  test("검색과 선택", async () => {
    const { onOpen } = setup({ selected: { kind: "ClusterWorkflowTemplate", namespace: null, name: "shared" } });
    await screen.findByRole("row", { name: /report/ });
    expect(rowOf("shared")).toHaveAttribute("aria-selected", "true");
    fireEvent.click(rowOf("shared"));
    expect(onOpen).toHaveBeenCalledWith("ClusterWorkflowTemplate", null, "shared");
    fireEvent.click(rowOf("backup"));
    expect(onOpen).toHaveBeenLastCalledWith("WorkflowTemplate", "ops", "backup");

    expect(screen.queryByRole("textbox", { name: "목록에서 찾기" })).toBeNull();
    act(() => { dispatchKey(new KeyboardEvent("keydown", { key: "f", metaKey: true })); });
    const input = screen.getByRole("textbox", { name: "목록에서 찾기" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "bkp" } });
    expect(
      screen
        .getAllByRole("row")
        .slice(1)
        .map((r) => within(r).getAllByRole("cell")[0].textContent),
    ).toEqual(["backup"]);
    fireEvent.change(input, { target: { value: "zzzzqq" } });
    expect(screen.getByText(CAT_NO_TEMPLATE_MATCH)).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(rowOf("report")).toBeInTheDocument();
  });

  test("템플릿이 없으면 안내한다", async () => {
    m.templates.mockResolvedValue([]);
    setup();
    expect(await screen.findByText(CAT_NO_TEMPLATES)).toBeInTheDocument();
  });
});
