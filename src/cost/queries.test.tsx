import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { costApi } from "./api";
import { sampleBreakdown, sampleOverview } from "./fixtures";
import { refreshCost, useCostBreakdown, useCostOverview, useCostTagKeys, useCostUsage, type OverviewQuery } from "./queries";
import type { CostOverview } from "./types";

vi.mock("./api", () => ({ costApi: { overview: vi.fn(), breakdown: vi.fn(), tagKeys: vi.fn(), usage: vi.fn() } }));

const m = vi.mocked(costApi);
const Q: OverviewQuery = { period: "thisMonth", metric: "UnblendedCost", excludeCredits: true, filters: [] };

function makeClient() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return { qc, wrapper };
}

function screenHooks() {
  return {
    overview: useCostOverview("prod", Q),
    byService: useCostBreakdown("prod", { ...Q, groupBy: { kind: "service" } }, true),
    byRegion: useCostBreakdown("prod", { ...Q, groupBy: { kind: "region" } }, true),
    tags: useCostTagKeys("prod", true),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.overview.mockResolvedValue(sampleOverview({ requests: 0 }));
  m.breakdown.mockResolvedValue(sampleBreakdown());
  m.tagKeys.mockResolvedValue(["team"]);
  m.usage.mockResolvedValue({ yearMonth: "2026-11", requests: 3 });
});

test("plain loads never skip the backend cache", async () => {
  const { wrapper } = makeClient();
  const { result } = renderHook(screenHooks, { wrapper });
  await waitFor(() => expect(result.current.tags.isSuccess && result.current.byRegion.isSuccess && result.current.byService.isSuccess).toBe(true));
  expect(m.overview).toHaveBeenCalledWith("prod", { ...Q, groupBy: { kind: "service" } }, false);
  expect(m.breakdown.mock.calls.map((c) => c[2])).toEqual([false, false]);
  expect(m.tagKeys).toHaveBeenCalledWith("prod", false);
});

test("refresh re-reads the overview with refresh=true first, then the service breakdown from that fresh cache and the rest with refresh=true", async () => {
  const { qc, wrapper } = makeClient();
  const { result } = renderHook(screenHooks, { wrapper });
  await waitFor(() => expect(result.current.tags.isSuccess && result.current.byRegion.isSuccess && result.current.byService.isSuccess).toBe(true));
  vi.clearAllMocks();

  let finish!: (o: CostOverview) => void;
  m.overview.mockReturnValueOnce(new Promise((r) => (finish = r)));
  let done = false;
  act(() => void refreshCost(qc, "prod").then(() => (done = true)));
  await waitFor(() => expect(m.overview).toHaveBeenCalledWith("prod", expect.anything(), true));
  // 개요가 끝나기 전에는 분해를 부르지 않는다(서비스별은 개요가 새로 쓴 캐시를 읽어야 한다)
  expect(m.breakdown).not.toHaveBeenCalled();

  await act(async () => finish(sampleOverview()));
  await waitFor(() => expect(done).toBe(true));
  const refreshOf = (kind: string) => m.breakdown.mock.calls.find((c) => c[1].groupBy.kind === kind)?.[2];
  expect(refreshOf("service")).toBe(false);
  expect(refreshOf("region")).toBe(true);
  expect(m.tagKeys).toHaveBeenCalledWith("prod", true);

  // 새로고침 표시는 한 번만 쓴다
  vi.clearAllMocks();
  await act(() => result.current.overview.refetch());
  expect(m.overview).toHaveBeenCalledWith("prod", expect.anything(), false);
});

test("a view that is not on screen during a refresh comes back from the cache, not with refresh=true", async () => {
  const { qc, wrapper } = makeClient();
  const last = { ...Q, period: "lastMonth" as const };
  const hidden = renderHook(() => useCostOverview("prod", last), { wrapper });
  await waitFor(() => expect(hidden.result.current.isSuccess).toBe(true));
  hidden.unmount();
  await act(() => refreshCost(qc, "prod"));
  expect(m.overview).toHaveBeenCalledTimes(1);

  renderHook(() => useCostOverview("prod", last), { wrapper });
  await waitFor(() => expect(m.overview).toHaveBeenCalledTimes(2));
  expect(m.overview).toHaveBeenLastCalledWith("prod", { ...last, groupBy: { kind: "service" } }, false);
});

test("the request counter is read again only after an answer that actually sent requests", async () => {
  const { wrapper } = makeClient();
  m.overview.mockResolvedValueOnce(sampleOverview({ requests: 0 }));
  const { result, rerender } = renderHook(({ period }) => ({ usage: useCostUsage("prod"), overview: useCostOverview("prod", { ...Q, period }) }), {
    wrapper,
    initialProps: { period: "thisMonth" as OverviewQuery["period"] },
  });
  await waitFor(() => expect(result.current.overview.isSuccess && result.current.usage.isSuccess).toBe(true));
  expect(m.usage).toHaveBeenCalledTimes(1);

  m.overview.mockResolvedValueOnce(sampleOverview({ requests: 2 }));
  rerender({ period: "lastMonth" });
  await waitFor(() => expect(m.usage).toHaveBeenCalledTimes(2));
});
