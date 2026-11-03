import { fireEvent, render, screen, within } from "@testing-library/react";
import { ago, cron, HOUR, NOW, runs, tpl, wf } from "./catalogFixtures";
import { FIND_NO_PROBLEMS } from "./catalogText";
import { Findings } from "./FindingsView";

const handlers = () => ({ onOpenWorkflow: vi.fn(), onOpenCron: vi.fn(), onOpenTemplate: vi.fn() });
const card = (title: RegExp | string) => screen.getByRole("button", { name: title });

// 연속 실패 Cron 하나, 놓친 Cron 하나, 오래 실행 중 Workflow 하나, 제한 시간 없는 클러스터 템플릿 하나
const PROBLEMS = {
  workflows: [
    ...runs("bad", ["Failed", "Failed", "Failed"]),
    wf({ name: "stuck", uid: "stuck", phase: "Running", startedAt: ago(3 * HOUR), finishedAt: null }),
  ],
  crons: [cron({ name: "bad" }), cron({ name: "late", missed: true })],
  templates: [tpl({ kind: "ClusterWorkflowTemplate", namespace: null, name: "shared", hasDeadline: false })],
};

describe("Findings", () => {
  test("카드는 건수와 심각도를 보이고, 문제 없는 카드는 흐리게 꺼진다. 처음엔 문제가 있는 첫 카드가 열려 있다", () => {
    render(<Findings {...PROBLEMS} now={NOW} {...handlers()} />);
    const failing = card(/연속 실패 Cron/);
    expect(failing).toHaveAttribute("aria-pressed", "true");
    expect(failing).toHaveClass("danger");
    expect(failing).toHaveTextContent("1건");
    expect(failing).toHaveTextContent("위험");
    expect(card(/놓친 실행/)).toHaveClass("warn");
    expect(card(/오래 실행 중/)).toHaveTextContent("주의");
    expect(card(/제한 시간 없는/)).toHaveTextContent("참고");
    const pending = card(/오래 대기 중/);
    expect(pending).toBeDisabled();
    expect(pending).toHaveClass("empty");
    expect(pending).toHaveTextContent("문제 없음");
    // 열린 카드의 항목
    const items = screen.getByRole("table", { name: "점검 대상" });
    expect(within(items).getByRole("button", { name: "bad" })).toBeInTheDocument();
    expect(within(items).getByText("최근 3회 연속 실패 · 마지막 실행 1시간 전")).toBeInTheDocument();
  });

  test("카드를 누르면 그 목록으로 바뀌고, 항목을 누르면 종류에 맞는 상세를 연다", () => {
    const h = handlers();
    render(<Findings {...PROBLEMS} now={NOW} {...h} />);
    fireEvent.click(within(screen.getByRole("table", { name: "점검 대상" })).getByRole("button", { name: "bad" }));
    expect(h.onOpenCron).toHaveBeenCalledWith("batch", "bad");

    fireEvent.click(card(/오래 실행 중/));
    expect(card(/오래 실행 중/)).toHaveAttribute("aria-pressed", "true");
    expect(card(/연속 실패 Cron/)).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "stuck" }));
    expect(h.onOpenWorkflow).toHaveBeenCalledWith({ kind: "live", namespace: "batch", name: "stuck" });

    fireEvent.click(card(/제한 시간 없는/));
    fireEvent.click(screen.getByRole("button", { name: "shared" }));
    expect(h.onOpenTemplate).toHaveBeenCalledWith("ClusterWorkflowTemplate", null, "shared");
  });

  test("문제 없는 카드는 눌러도 선택되지 않는다", () => {
    render(<Findings {...PROBLEMS} now={NOW} {...handlers()} />);
    fireEvent.click(card(/오래 대기 중/));
    expect(card(/오래 대기 중/)).toHaveAttribute("aria-pressed", "false");
    expect(card(/연속 실패 Cron/)).toHaveAttribute("aria-pressed", "true");
  });

  test("문제가 하나도 없으면 안내만 보인다", () => {
    render(<Findings workflows={[]} crons={[cron({ hasDeadline: true })]} templates={[]} now={NOW} {...handlers()} />);
    expect(screen.getByText(FIND_NO_PROBLEMS)).toBeInTheDocument();
    expect(screen.getAllByText("문제 없음").length).toBeGreaterThan(0);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
