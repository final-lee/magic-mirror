import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { sampleTopology } from "./fixtures";
import { vpcApi } from "./api";
import { svgToPng } from "./toPng";
import { VpcMapTab } from "./VpcMapTab";

vi.mock("./api", () => ({ vpcApi: { topology: vi.fn(), savePng: vi.fn() } }));
vi.mock("./toPng", () => ({ svgToPng: vi.fn() }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
vi.mock("../api/desktop", () => ({ desktop: { copy: vi.fn(), openUrl: vi.fn() } }));

const m = vi.mocked(vpcApi);
const props = { profile: "prod", region: "ap-northeast-2", vpcId: "vpc-1", name: "prod", active: true };
const tile = (id: string) => document.querySelector(`.vm-tile[data-id="${id}"]`)!;
const chip = (id: string) => document.querySelector(`.vm-chip[data-id="${id}"]`)!;

beforeEach(() => {
  vi.clearAllMocks();
  m.topology.mockResolvedValue(sampleTopology());
});

test("renders subnet names, CIDRs, AZs and tier row names", async () => {
  renderWithClient(<VpcMapTab {...props} />);
  expect(await screen.findByText("pub-a")).toBeInTheDocument();
  expect(screen.getByText(/^10\.0\.10\.0\/24/)).toBeInTheDocument();
  expect(screen.getByText("ap-northeast-2c")).toBeInTheDocument();
  const svg = within(screen.getByRole("group", { name: /네트워크 구조도/ }));
  // tier 행 이름 + 범례(SVG 안)에 각각 한 번씩
  expect(svg.getAllByText("퍼블릭")).toHaveLength(2);
  expect(svg.getAllByText("프라이빗")).toHaveLength(2);
  expect(svg.getAllByText("격리")).toHaveLength(1); // 범례에만 있다(격리 서브넷 없음)
  expect(svg.getByText("기본 경로 대상")).toBeInTheDocument();
  expect(document.querySelector(".vm-legend")).toBeNull();
  expect(m.topology).toHaveBeenCalledWith("prod", "ap-northeast-2", "vpc-1");
});

test("clicking a resource shows its fields in the detail panel", async () => {
  renderWithClient(<VpcMapTab {...props} />);
  await screen.findByText("pub-a");
  fireEvent.click(tile("i-1"));
  const panel = document.querySelector(".detail") as HTMLElement;
  expect(within(panel).getByText("10.0.10.5")).toBeInTheDocument();
  expect(within(panel).getByText("AWS 콘솔에서 열기 ↗")).toBeInTheDocument();
});

test("same resource in several subnets highlights together", async () => {
  renderWithClient(<VpcMapTab {...props} />);
  await screen.findByText("pub-a");
  const tiles = document.querySelectorAll('.vm-tile[data-id="alb-1"]');
  expect(tiles).toHaveLength(2);
  fireEvent.click(tiles[0]);
  document.querySelectorAll('.vm-tile[data-id="alb-1"]').forEach((t) => expect(t).toHaveClass("focused"));
  expect(tile("nat-1")).not.toHaveClass("focused");
});

test("clicking a subnet lists routes and highlights default route targets", async () => {
  renderWithClient(<VpcMapTab {...props} />);
  await screen.findByText("pub-a");
  fireEvent.click(screen.getByRole("button", { name: "서브넷 pub-a" }));
  const panel = document.querySelector(".detail") as HTMLElement;
  expect(within(panel).getByText("igw-1 (active)")).toBeInTheDocument();
  expect(within(panel).getByText("0.0.0.0/0")).toBeInTheDocument();
  expect(within(panel).getByText("10.0.0.0/16")).toBeInTheDocument();
  expect(within(panel).getByText("local (active)")).toBeInTheDocument();
  expect(chip("igw-1")).toHaveClass("route-target");
  expect(tile("nat-1")).not.toHaveClass("route-target");

  fireEvent.click(screen.getByRole("button", { name: "서브넷 prv-a" }));
  expect(tile("nat-1")).toHaveClass("route-target");
  expect(chip("igw-1")).not.toHaveClass("route-target");
});

test("a subnet whose default route targets a peering highlights the pcx chip", async () => {
  const topo = sampleTopology();
  topo.routeTables[1].routes[1] = { destination: "0.0.0.0/0", target: "pcx-1", targetKind: "pcx", state: "active" };
  m.topology.mockResolvedValue(topo);
  renderWithClient(<VpcMapTab {...props} />);
  await screen.findByText("pub-a");
  fireEvent.click(screen.getByRole("button", { name: "서브넷 prv-a" }));
  expect(chip("pcx-1")).toHaveClass("route-target");
  expect(chip("igw-1")).not.toHaveClass("route-target");
});

test("clicking the empty canvas clears the selection", async () => {
  renderWithClient(<VpcMapTab {...props} />);
  await screen.findByText("pub-a");
  fireEvent.click(tile("i-1"));
  expect(screen.getByRole("complementary", { name: "상세" })).toBeInTheDocument();
  fireEvent.click(screen.getByTestId("vpc-canvas"));
  expect(screen.queryByRole("complementary", { name: "상세" })).toBeNull();
});

test("shows warnings", async () => {
  m.topology.mockResolvedValue({ ...sampleTopology(), warnings: ["RDS 조회 권한이 없어요"] });
  renderWithClient(<VpcMapTab {...props} />);
  expect(await screen.findByText("RDS 조회 권한이 없어요")).toBeInTheDocument();
});

test("shows error state", async () => {
  m.topology.mockRejectedValue({ kind: "accessDenied", action: "ec2:DescribeSubnets" });
  renderWithClient(<VpcMapTab {...props} />);
  expect(await screen.findByText(/ec2:DescribeSubnets/)).toBeInTheDocument();
});

test("PNG save passes toPng bytes to the backend and confirms", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  vi.mocked(svgToPng).mockResolvedValue(bytes);
  m.savePng.mockResolvedValue(true);
  renderWithClient(<VpcMapTab {...props} />);
  await screen.findByText("pub-a");
  fireEvent.click(screen.getByRole("button", { name: "PNG로 저장" }));
  expect(await screen.findByText("저장했어요")).toBeInTheDocument();
  expect(m.savePng).toHaveBeenCalledWith("prod-network.png", bytes);
});

test("PNG save failure shows an error", async () => {
  vi.mocked(svgToPng).mockResolvedValue(new Uint8Array([1]));
  m.savePng.mockRejectedValue({ kind: "other", message: "디스크가 가득 찼어요" });
  renderWithClient(<VpcMapTab {...props} />);
  await screen.findByText("pub-a");
  fireEvent.click(screen.getByRole("button", { name: "PNG로 저장" }));
  await waitFor(() => expect(screen.queryByText("저장했어요")).not.toBeInTheDocument());
  expect(document.querySelector(".vm-toolbar .err")).not.toBeNull();
});

const wheel = (el: Element) =>
  act(() => {
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -200, bubbles: true, cancelable: true }));
  });

test("wheel zooms the active tab", async () => {
  renderWithClient(<VpcMapTab {...props} />);
  await screen.findByText("pub-a");
  const before = screen.getByTestId("vpc-zoom").textContent;
  wheel(screen.getByTestId("vpc-canvas"));
  expect(screen.getByTestId("vpc-zoom").textContent).not.toBe(before);
});

test("wheel is ignored when the tab is inactive", async () => {
  renderWithClient(<VpcMapTab {...props} active={false} />);
  await screen.findByText("pub-a");
  const before = screen.getByTestId("vpc-zoom").textContent;
  wheel(screen.getByTestId("vpc-canvas"));
  expect(screen.getByTestId("vpc-zoom").textContent).toBe(before);
});

test("highlighted resources get a highlight ring and the bar says how many were found, with an off switch", async () => {
  renderWithClient(<VpcMapTab {...props} highlight={{ ids: ["i-1", "alb-1", "i-gone"], label: "prod-eks" }} />);
  await screen.findByText("pub-a");
  expect(tile("i-1")).toHaveClass("highlighted");
  document.querySelectorAll('.vm-tile[data-id="alb-1"]').forEach((t) => expect(t).toHaveClass("highlighted"));
  expect(tile("nat-1")).not.toHaveClass("highlighted");
  // 구조도에 없는 ID는 센다: 둘 찾고 하나는 없다
  const bar = screen.getByTestId("vpc-highlight");
  expect(bar).toHaveTextContent("prod-eks 강조 2개 (이 구조도에 없는 1개)");
  fireEvent.click(within(bar).getByRole("button", { name: "강조 끄기" }));
  expect(tile("i-1")).not.toHaveClass("highlighted");
  fireEvent.click(within(screen.getByTestId("vpc-highlight")).getByRole("button", { name: "prod-eks 강조 켜기" }));
  expect(tile("i-1")).toHaveClass("highlighted");
});

test("without a highlight nothing is highlighted and there is no bar", async () => {
  renderWithClient(<VpcMapTab {...props} />);
  await screen.findByText("pub-a");
  expect(document.querySelector(".vm-tile.highlighted")).toBeNull();
  expect(screen.queryByTestId("vpc-highlight")).toBeNull();
});

test("a new highlight turns a switched-off highlight back on", async () => {
  const { qc, rerender } = renderWithClient(<VpcMapTab {...props} highlight={{ ids: ["i-1"], label: "a" }} />);
  await screen.findByText("pub-a");
  fireEvent.click(screen.getByRole("button", { name: "강조 끄기" }));
  expect(tile("i-1")).not.toHaveClass("highlighted");
  rerender(
    <QueryClientProvider client={qc}>
      <VpcMapTab {...props} highlight={{ ids: ["nat-1"], label: "b" }} />
    </QueryClientProvider>,
  );
  expect(tile("nat-1")).toHaveClass("highlighted");
  expect(tile("i-1")).not.toHaveClass("highlighted");
});
