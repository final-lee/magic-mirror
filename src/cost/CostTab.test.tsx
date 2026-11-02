import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { costApi } from "./api";
import { CostTab } from "./CostTab";
import { ACCOUNT, row, sampleBreakdown, sampleOverview } from "./fixtures";
import {
  BREADCRUMB_LABEL,
  BREAKDOWN_LABEL,
  CARD_COMPARE,
  CARD_FORECAST,
  CARD_TOTAL,
  COL,
  CRUMB_ROOT,
  DRILL_HINT,
  ESTIMATED,
  EXCLUDE_CREDITS,
  GROUP_SELECT,
  MEMBER_BLOCKED_HINT,
  METRIC_SELECT,
  NO_ACTIVE_TAGS,
  NO_DATA_YET,
  PERIOD_LABEL,
  PERMISSIONS_HINT,
  REFRESH,
  SHOW_LAST_MONTH,
  smallRows,
  TAG_KEY_SELECT,
  usageLine,
} from "./text";
import type { CostQuery } from "./types";

vi.mock("./api", () => ({ costApi: { overview: vi.fn(), breakdown: vi.fn(), tagKeys: vi.fn(), usage: vi.fn() } }));

const m = vi.mocked(costApi);
const RDS = "Amazon Relational Database Service";
const FIRST: CostQuery = { period: "thisMonth", metric: "UnblendedCost", excludeCredits: true, filters: [], groupBy: { kind: "service" } };

beforeEach(() => {
  vi.clearAllMocks();
  m.overview.mockResolvedValue(sampleOverview());
  m.breakdown.mockResolvedValue(sampleBreakdown());
  m.tagKeys.mockResolvedValue(["env", "team"]);
  m.usage.mockResolvedValue({ yearMonth: "2026-10", requests: 12 });
});

const setup = () => renderWithClient(<CostTab profile="prod" />);
const table = () => screen.findByRole("table", { name: BREAKDOWN_LABEL });
const bodyRows = (t: HTMLElement) => within(t).getAllByRole("row").slice(1);
const firstCells = (t: HTMLElement) => bodyRows(t).map((r) => within(r).getAllByRole("cell")[0].textContent);
const card = (name: string) => screen.getByRole("region", { name });
const lastQuery = (fn: typeof m.overview | typeof m.breakdown) => fn.mock.lastCall![1];

test("the first screen reads this month's billed cost without credits, grouped by service, from the cache", async () => {
  setup();
  await table();
  expect(m.overview).toHaveBeenCalledWith("prod", FIRST, false);
  expect(m.breakdown).toHaveBeenCalledWith("prod", FIRST, false);
  expect(m.tagKeys).not.toHaveBeenCalled();
  expect(screen.getByText(ACCOUNT)).toBeInTheDocument();
  expect(screen.getByText("3시간 전 데이터")).toBeInTheDocument();

  expect(within(card(CARD_TOTAL)).getByText("$60.50")).toBeInTheDocument();
  expect(within(card(CARD_TOTAL)).getByText(ESTIMATED)).toBeInTheDocument();
  expect(within(card(CARD_TOTAL)).getByText(/10월 1일 ~ 10월 3일/)).toBeInTheDocument();
  expect(within(card(CARD_FORECAST)).getByText("$749.67")).toBeInTheDocument();
  expect(card(CARD_COMPARE)).toHaveTextContent("+$10.50 +21.0%");
});

test("the counter shows this month's Cost Explorer requests and their price", async () => {
  setup();
  expect(await screen.findByText(usageLine(12, "$0.12"))).toBeInTheDocument();
});

test("period, metric and the credit toggle change the query; the forecast is only for this month", async () => {
  setup();
  await table();
  fireEvent.click(screen.getByRole("button", { name: PERIOD_LABEL.lastMonth }));
  await waitFor(() => expect(lastQuery(m.overview)).toMatchObject({ period: "lastMonth" }));
  m.overview.mockResolvedValue(sampleOverview({ forecast: null }));
  expect(screen.getByRole("button", { name: PERIOD_LABEL.lastMonth })).toHaveAttribute("aria-pressed", "true");

  fireEvent.change(screen.getByRole("combobox", { name: METRIC_SELECT }), { target: { value: "AmortizedCost" } });
  await waitFor(() => expect(lastQuery(m.overview)).toMatchObject({ period: "lastMonth", metric: "AmortizedCost" }));
  fireEvent.click(screen.getByRole("checkbox", { name: EXCLUDE_CREDITS }));
  await waitFor(() => expect(lastQuery(m.overview)).toMatchObject({ metric: "AmortizedCost", excludeCredits: false }));
  await waitFor(() => expect(lastQuery(m.breakdown)).toMatchObject({ metric: "AmortizedCost", excludeCredits: false }));
  expect(screen.queryByRole("region", { name: CARD_FORECAST })).not.toBeInTheDocument();
});

test("without a compare range (last 6 months) the table drops the compare columns and there is no compare card", async () => {
  m.overview.mockResolvedValue(sampleOverview({ granularity: "monthly", compareRange: null, compareTotal: null, delta: null, deltaPct: null, forecast: null }));
  m.breakdown.mockResolvedValue(sampleBreakdown({ rows: [row(RDS, "36", null, 100)], small: null }));
  setup();
  fireEvent.click(await screen.findByRole("button", { name: PERIOD_LABEL.last6Months }));
  const t = await table();
  expect(within(t).getAllByRole("columnheader").map((h) => h.textContent?.trim())).toEqual([COL.label, `${COL.current} ▼`, COL.share]);
  expect(screen.queryByRole("region", { name: CARD_COMPARE })).not.toBeInTheDocument();
});

test("a forecast that could not be made shows why", async () => {
  m.overview.mockResolvedValue(sampleOverview({ forecast: null, forecastNote: "예상하기엔 데이터가 부족해요" }));
  setup();
  expect(await screen.findByText("예상하기엔 데이터가 부족해요")).toBeInTheDocument();
});

describe("breakdown table", () => {
  test("rows start by this period descending, headers re-sort, and the small rows stay last", async () => {
    setup();
    const t = await table();
    expect(firstCells(t)).toEqual([RDS, "EC2 - Other", "Tax", smallRows(2)]);
    fireEvent.click(within(t).getByRole("columnheader", { name: new RegExp(COL.deltaPct) }));
    // Tax +131%, RDS +20%, EC2 - Other -4.7%
    expect(firstCells(t)).toEqual(["Tax", RDS, "EC2 - Other", smallRows(2)]);
    fireEvent.click(within(t).getByRole("columnheader", { name: new RegExp(COL.deltaPct) }));
    expect(firstCells(t)).toEqual(["EC2 - Other", RDS, "Tax", smallRows(2)]);
    fireEvent.click(within(t).getByRole("columnheader", { name: new RegExp(COL.label) }));
    expect(firstCells(t)).toEqual([RDS, "EC2 - Other", "Tax", smallRows(2)]);
  });

  test("clicking a service drills the whole screen into its usage types, and the breadcrumb goes back up", async () => {
    setup();
    const t = await table();
    fireEvent.click(within(t).getByRole("cell", { name: RDS }));
    const drilled = { ...FIRST, filters: [{ dimension: "SERVICE", value: RDS }] };
    await waitFor(() => expect(m.breakdown).toHaveBeenLastCalledWith("prod", { ...drilled, groupBy: { kind: "usageType" } }, false));
    expect(m.overview).toHaveBeenLastCalledWith("prod", { ...drilled, groupBy: { kind: "service" } }, false);
    const crumbs = screen.getByRole("navigation", { name: BREADCRUMB_LABEL });
    expect(crumbs).toHaveTextContent(`${CRUMB_ROOT}›${RDS}`);
    expect(screen.getByRole("combobox", { name: GROUP_SELECT })).toHaveValue("usageType");
    // 사용 유형에서는 더 내려가지 않는다
    await waitFor(() => expect(bodyRows(screen.getByRole("table", { name: BREAKDOWN_LABEL }))[0]).not.toHaveAttribute("title", DRILL_HINT));

    const calls = m.breakdown.mock.calls.length;
    fireEvent.click(within(crumbs).getByRole("button", { name: CRUMB_ROOT }));
    expect(screen.getByRole("combobox", { name: GROUP_SELECT })).toHaveValue("service");
    expect(screen.getByRole("navigation", { name: BREADCRUMB_LABEL })).toHaveTextContent(CRUMB_ROOT);
    // 올라가면 이미 받은 답을 다시 쓴다(다시 묻지 않는다)
    expect(firstCells(await table())).toEqual([RDS, "EC2 - Other", "Tax", smallRows(2)]);
    expect(m.breakdown).toHaveBeenCalledTimes(calls);
  });

  test("grouping by tag reads the active tag keys and groups by the first one", async () => {
    setup();
    await table();
    fireEvent.change(screen.getByRole("combobox", { name: GROUP_SELECT }), { target: { value: "tag" } });
    await waitFor(() => expect(m.breakdown).toHaveBeenLastCalledWith("prod", { ...FIRST, groupBy: { kind: "tag", key: "env" } }, false));
    expect(m.tagKeys).toHaveBeenCalledWith("prod", false);
    fireEvent.change(screen.getByRole("combobox", { name: TAG_KEY_SELECT }), { target: { value: "team" } });
    await waitFor(() => expect(m.breakdown).toHaveBeenLastCalledWith("prod", { ...FIRST, groupBy: { kind: "tag", key: "team" } }, false));
  });

  test("with no active cost allocation tag the tag grouping explains how to turn them on and asks for nothing", async () => {
    m.tagKeys.mockResolvedValue([]);
    setup();
    await table();
    const calls = m.breakdown.mock.calls.length;
    fireEvent.change(screen.getByRole("combobox", { name: GROUP_SELECT }), { target: { value: "tag" } });
    expect(await screen.findByText(NO_ACTIVE_TAGS)).toBeInTheDocument();
    expect(m.breakdown).toHaveBeenCalledTimes(calls);
  });
});

test("on the 1st of the month there is no data yet, and the button switches to last month", async () => {
  m.overview.mockResolvedValue(sampleOverview({ range: null, compareRange: null, total: "0", compareTotal: null, delta: null, deltaPct: null, buckets: [], series: [] }));
  setup();
  expect(await screen.findByText(NO_DATA_YET)).toBeInTheDocument();
  expect(m.breakdown).not.toHaveBeenCalled();
  expect(screen.getByRole("region", { name: CARD_FORECAST })).toBeInTheDocument();
  m.overview.mockResolvedValue(sampleOverview());
  fireEvent.click(screen.getByRole("button", { name: SHOW_LAST_MONTH }));
  await waitFor(() => expect(lastQuery(m.overview)).toMatchObject({ period: "lastMonth" }));
  expect(await table()).toBeInTheDocument();
});

test("access denied names the permissions and the organization block, and the breakdown is not asked", async () => {
  m.overview.mockRejectedValue({ kind: "accessDenied", action: "ce:GetCostAndUsage" });
  setup();
  expect(await screen.findByText("권한 없음 (ce:GetCostAndUsage)")).toBeInTheDocument();
  expect(screen.getByText(PERMISSIONS_HINT)).toBeInTheDocument();
  expect(screen.getByText(MEMBER_BLOCKED_HINT)).toBeInTheDocument();
  expect(m.breakdown).not.toHaveBeenCalled();
});

test("other errors show the backend's message as is", async () => {
  m.overview.mockRejectedValue({ kind: "other", message: "Billing 콘솔에서 Cost Explorer를 처음 열면 켜져요(최대 24시간)" });
  setup();
  expect(await screen.findByText("Billing 콘솔에서 Cost Explorer를 처음 열면 켜져요(최대 24시간)")).toBeInTheDocument();
  expect(screen.queryByText(PERMISSIONS_HINT)).not.toBeInTheDocument();
});

test("hovering a bar shows that day's amounts per service", async () => {
  setup();
  await table();
  fireEvent.mouseEnter(screen.getByLabelText("10월 2일 $20.25"));
  const tip = screen.getByRole("tooltip");
  expect(within(tip).getByText(RDS).closest("tr")).toHaveTextContent("$12.00");
  expect(within(tip).getByText("EC2 - Other").closest("tr")).toHaveTextContent("$5.25");
  expect(within(tip).getByText("기타").closest("tr")).toHaveTextContent("$3.00");
  expect(within(tip).getByText("합계").closest("tr")).toHaveTextContent("$20.25");
});

test("the refresh button reads the screen again skipping the cache", async () => {
  setup();
  await table();
  fireEvent.click(screen.getByRole("button", { name: REFRESH }));
  await waitFor(() => expect(m.overview).toHaveBeenLastCalledWith("prod", FIRST, true));
});
