import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { api } from "../api/client";
import type { ResourceMetrics as Metrics, ServiceInfo } from "../api/types";
import { makeResource, renderWithClient, sampleServices } from "../test/utils";
import { formatMetric } from "./MetricChart";
import { ResourceArea } from "./ResourceArea";

vi.mock("../api/client", () => ({ api: { listResources: vi.fn(), resourceMetrics: vi.fn(), ssoLogin: vi.fn() } }));
vi.mock("../api/desktop", () => ({ desktop: { copy: vi.fn(), openUrl: vi.fn() } }));

const ec2: ServiceInfo = { ...sampleServices[0], metricTypes: ["instances"] };
const props = { profile: "prod", region: "ap-northeast-2", account: "123456789012", filter: "", onOpenBucket: vi.fn(), onRefresh: vi.fn(), active: true };
const END = 1_800_000_000_000;

function metrics(over: Partial<Metrics> = {}): Metrics {
  return {
    namespace: "AWS/EC2",
    region: "ap-northeast-2",
    period: 60,
    start: END - 3 * 3_600_000,
    end: END,
    daily: false,
    note: null,
    charts: [
      { metric: "CPUUtilization", stat: "Average", unit: "percent", series: [{ label: "", times: [END - 120_000, END - 60_000], values: [12, 37.5] }] },
      { metric: "NetworkIn", stat: "Sum", unit: "bytes", series: [{ label: "", times: [], values: [] }] },
    ],
    ...over,
  };
}

async function openDetail(service: ServiceInfo = ec2, typeIndex = 0) {
  vi.mocked(api.listResources).mockResolvedValue({ items: [makeResource("i-1", { name: "web-1" })], truncated: false });
  renderWithClient(<ResourceArea {...props} service={service} type={service.types[typeIndex]} />);
  fireEvent.click(await screen.findByText("web-1"));
}
const section = () => within(screen.getByRole("region", { name: "CloudWatch 지표" }));

beforeEach(() => vi.clearAllMocks());

test("a supported type's detail draws a chart per metric for the last 3 hours, and another range reads again", async () => {
  vi.mocked(api.resourceMetrics).mockResolvedValue(metrics());
  await openDetail();
  await waitFor(() => expect(api.resourceMetrics).toHaveBeenCalledWith("prod", "ap-northeast-2", "ec2", "instances", expect.objectContaining({ id: "i-1" }), "3h"));
  expect(await section().findByRole("img", { name: "CPUUtilization · Average" })).toBeInTheDocument();
  // 제목 옆은 가장 최근 값이다
  expect(section().getByRole("img", { name: "CPUUtilization · Average" }).closest(".metric-chart")!.querySelector(".metric-latest")).toHaveTextContent("37.5%");
  expect(section().getByText("AWS/EC2 · ap-northeast-2")).toBeInTheDocument();
  // 이 기간에 쌓인 것이 없는 지표는 그 자리에 데이터 없음
  expect(section().getByText("데이터 없음")).toBeInTheDocument();
  fireEvent.click(section().getByRole("button", { name: "1일" }));
  await waitFor(() => expect(api.resourceMetrics).toHaveBeenLastCalledWith("prod", "ap-northeast-2", "ec2", "instances", expect.objectContaining({ id: "i-1" }), "1d"));
  expect(section().getByRole("button", { name: "1일" })).toHaveAttribute("aria-pressed", "true");
});

test("a replication group draws a line per node with each node's latest value", async () => {
  vi.mocked(api.resourceMetrics).mockResolvedValue(
    metrics({
      charts: [
        {
          metric: "CPUUtilization",
          stat: "Average",
          unit: "percent",
          series: [
            { label: "queue-001", times: [END - 60_000], values: [3.2] },
            { label: "queue-002", times: [END - 60_000], values: [1.1] },
          ],
        },
      ],
    }),
  );
  await openDetail();
  const chart = (await section().findByRole("img", { name: "CPUUtilization · Average" })).closest(".metric-chart") as HTMLElement;
  expect(chart).toHaveTextContent("queue-001 3.2%");
  expect(chart).toHaveTextContent("queue-002 1.1%");
});

test("a cluster member shows where to look instead of charts", async () => {
  vi.mocked(api.resourceMetrics).mockResolvedValue(metrics({ charts: [], note: "이 인스턴스는 클러스터 orders에 속해요" }));
  await openDetail();
  expect(await section().findByText("이 인스턴스는 클러스터 orders에 속해요")).toBeInTheDocument();
  expect(section().queryByRole("group", { name: "기간" })).not.toBeInTheDocument();
});

test("a daily metric says so and the range does not apply", async () => {
  vi.mocked(api.resourceMetrics).mockResolvedValue(metrics({ daily: true, period: 86_400 }));
  await openDetail();
  expect(await section().findByText(/하루에 한 번 쌓이는 지표라 최근 2주를/)).toBeInTheDocument();
  expect(section().getByRole("button", { name: "1시간" })).toBeDisabled();
});

test("a missing CloudWatch permission names the action", async () => {
  vi.mocked(api.resourceMetrics).mockRejectedValue({ kind: "accessDenied", action: "cloudwatch:GetMetricData" });
  await openDetail();
  expect(await section().findByText("권한 없음 (cloudwatch:GetMetricData)")).toBeInTheDocument();
});

test("a type without metrics has no section and asks for nothing", async () => {
  const plain: ServiceInfo = { ...sampleServices[0], metricTypes: [] };
  await openDetail(plain);
  expect(screen.queryByRole("region", { name: "CloudWatch 지표" })).not.toBeInTheDocument();
  expect(api.resourceMetrics).not.toHaveBeenCalled();
});

test("values read in their unit", () => {
  expect(formatMetric(2048, "bytes")).toBe("2.0 KB");
  expect(formatMetric(0.004, "seconds")).toBe("4ms");
  expect(formatMetric(1500, "milliseconds")).toBe("1.5초");
  expect(formatMetric(820, "microseconds")).toBe("820µs");
  expect(formatMetric(12.5, "countPerSecond")).toBe("12.5/초");
});
