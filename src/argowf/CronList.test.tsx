import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { dispatchKey } from "../keymap/registry";
import { renderWithClient } from "../test/utils";
import { argowfApi } from "./api";
import { CAT_NO_CRON_MATCH, CAT_NO_CRONS, CRON_MISSED, CRON_SUSPENDED } from "./catalogText";
import { CONN, cron, runs } from "./catalogFixtures";
import { CronList } from "./CronList";
import { ARGOWF_TOKEN_INVALID } from "./text";

vi.mock("./api", () => ({ argowfApi: { crons: vi.fn() } }));
const m = vi.mocked(argowfApi);

const CRONS = [
  cron({ name: "nightly", missed: true }),
  cron({ name: "weekly-report", namespace: "ops", schedules: ["0 9 * * 1"], timezone: null, suspended: true, concurrencyPolicy: "Allow", nextRuns: [] }),
  cron({ name: "odd", schedules: ["0 9,18 * * *"], timezone: "UTC", lastScheduledTime: null }),
];
const WORKFLOWS = [...runs("nightly", ["Failed", "Failed", "Succeeded"]), ...runs("weekly-report", ["Running"], "ops")];

function setup(over: Partial<Parameters<typeof CronList>[0]> = {}) {
  const handlers = { onOpen: vi.fn(), onTokenError: vi.fn() };
  renderWithClient(<CronList conn={CONN} live workflows={WORKFLOWS} selected={null} {...handlers} {...over} />);
  return handlers;
}
const rowOf = (name: string) => screen.getByRole("row", { name: new RegExp(name) });

beforeEach(() => {
  vi.resetAllMocks();
  m.crons.mockResolvedValue(CRONS);
});

describe("CronList", () => {
  test("스케줄은 사람 말과 원문·시간대를 함께, 모르는 모양은 원문만 보인다", async () => {
    setup();
    const nightly = await screen.findByRole("row", { name: /nightly/ });
    expect(within(nightly).getByText("매일 19:30 (Asia/Seoul)")).toBeInTheDocument();
    expect(within(nightly).getByText("30 19 * * * · Asia/Seoul")).toBeInTheDocument();
    expect(within(rowOf("weekly-report")).getByText("매주 월요일 09:00")).toBeInTheDocument();
    // 원문과 같은 글이면 한 번만(시간대는 붙는다)
    expect(within(rowOf("odd")).getAllByText(/0 9,18 \* \* \*/)).toHaveLength(2);
  });

  test("최근 실행 막대는 Cron의 Workflow로 채우고, 놓침·정지됨 배지와 마지막 결과를 보인다", async () => {
    setup();
    const nightly = await screen.findByRole("row", { name: /nightly/ });
    expect(within(nightly).getByRole("img", { name: "최근 3회: 성공 1 · 실패 2" })).toBeInTheDocument();
    // 막대는 오래된 것이 왼쪽: 빈 칸 7 + 성공 + 실패 + 실패
    const cells = [...nightly.querySelectorAll(".awc-run")].map((c) => c.className.replace("awc-run ", ""));
    expect(cells).toEqual([...Array<string>(7).fill("none"), "ok", "fail", "fail"]);
    expect(within(nightly).getByText(CRON_MISSED)).toBeInTheDocument();
    expect(within(nightly).getByText("Failed")).toBeInTheDocument();

    const weekly = rowOf("weekly-report");
    expect(within(weekly).getByText(CRON_SUSPENDED)).toBeInTheDocument();
    expect(within(weekly).getByRole("img", { name: "최근 1회: 실행 중 1" })).toBeInTheDocument();
    expect(within(weekly).getByText("Allow")).toBeInTheDocument();
    // 실행 기록이 없으면 마지막 예약 시각을, 그것도 없으면 안내를
    expect(within(rowOf("odd")).getByText("아직 안 돌았어요")).toBeInTheDocument();
  });

  test("검색은 퍼지로 걸러 목록을 줄이고, 맞는 게 없으면 안내한다", async () => {
    setup();
    await screen.findByRole("row", { name: /nightly/ });
    expect(screen.queryByRole("textbox", { name: "목록에서 찾기" })).toBeNull();
    act(() => { dispatchKey(new KeyboardEvent("keydown", { key: "f", metaKey: true })); });
    const input = screen.getByRole("textbox", { name: "목록에서 찾기" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "wkrp" } });
    expect(
      screen
        .getAllByRole("row")
        .slice(1)
        .map((r) => within(r).getAllByRole("cell")[0].textContent),
    ).toEqual(["weekly-report"]);
    fireEvent.change(input, { target: { value: "zzzzqq" } });
    expect(screen.getByText(CAT_NO_CRON_MATCH)).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByRole("row", { name: /nightly/ })).toBeInTheDocument();
  });

  test("행을 누르면(Enter도) 연다. 고른 행은 표시된다", async () => {
    const { onOpen } = setup({ selected: { namespace: "ops", name: "weekly-report" } });
    await screen.findByRole("row", { name: /nightly/ });
    expect(rowOf("weekly-report")).toHaveAttribute("aria-selected", "true");
    expect(rowOf("nightly")).toHaveAttribute("aria-selected", "false");
    fireEvent.click(rowOf("nightly"));
    expect(onOpen).toHaveBeenCalledWith("batch", "nightly");
    fireEvent.keyDown(rowOf("weekly-report"), { key: "Enter" });
    expect(onOpen).toHaveBeenLastCalledWith("ops", "weekly-report");
  });

  test("Cron이 하나도 없으면 안내한다", async () => {
    m.crons.mockResolvedValue([]);
    setup();
    expect(await screen.findByText(CAT_NO_CRONS)).toBeInTheDocument();
  });

  test("토큰 오류는 토큰 폼으로 돌려보낸다", async () => {
    m.crons.mockRejectedValue(new Error(ARGOWF_TOKEN_INVALID));
    const { onTokenError } = setup();
    await waitFor(() => expect(onTokenError).toHaveBeenCalledWith(ARGOWF_TOKEN_INVALID));
  });
});
