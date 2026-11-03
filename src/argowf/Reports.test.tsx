import { fireEvent, screen } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { argowfApi } from "./api";
import { CONN, wf } from "./catalogFixtures";
import { Reports } from "./Reports";
import { detailOf } from "./shellFixtures";

vi.mock("./api", () => ({ argowfApi: { workflows: vi.fn(), archived: vi.fn(), workflow: vi.fn(), archivedWorkflow: vi.fn() } }));

test("상세 자원 사용량을 막대로 그리고 막대를 누르면 Workflow를 연다", async () => {
  const row = wf({ name: "job", labels: { "workflows.argoproj.io/cron-workflow": "nightly" } });
  const page = { rows: [row], continueToken: null, resourceVersion: null };
  vi.mocked(argowfApi.workflows).mockResolvedValue(page);
  vi.mocked(argowfApi.archived).mockResolvedValue({ ...page, rows: [] });
  vi.mocked(argowfApi.workflow).mockResolvedValue(detailOf({ row, resourcesDuration: { cpu: 3, memory: 8 } }));
  const open = vi.fn();
  renderWithClient(<Reports conn={CONN} live namespace="batch" onOpenWorkflow={open} onTokenError={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("레이블 선택자"), { target: { value: "workflows.argoproj.io/cron-workflow=nightly" } });
  const cpu = await screen.findByRole("button", { name: "job: 3 CPU·초" });
  fireEvent.click(cpu);
  expect(open).toHaveBeenCalledWith({ kind: "live", namespace: "batch", name: "job" });
  expect(screen.getByRole("button", { name: "job: 8 메모리·초" })).toBeInTheDocument();
  expect(screen.getByText(/실행 1개 · 성공률 100%/)).toBeInTheDocument();
  expect(argowfApi.workflows).toHaveBeenCalledWith(CONN, expect.objectContaining({ labelSelector: "workflows.argoproj.io/cron-workflow=nightly", namespace: "batch" }));
});
