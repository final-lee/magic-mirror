import { fireEvent, screen, within } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { devicesApi } from "./api";
import { RoutesView } from "./RoutesView";

vi.mock("./api", () => ({ devicesApi: { list: vi.fn(), preview: vi.fn(), apply: vi.fn() } }));
vi.mock("./useTailscaleApi", () => ({ useTailscaleApi: () => ({ tailnet: "example.com", connected: true, isLoading: false }) }));
vi.mock("../api/queries", () => ({ useResources: () => ({ data: { items: [{ id: "vpc-1", name: "VPC", values: { cidr: "10.0.0.0/16" } }] } }) }));
const router = { id: "d1", name: "router", findings: [], advertisedRoutes: ["10.0.0.0/16", "10.1.0.0/16"], enabledRoutes: ["10.0.0.0/16"] };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(devicesApi.list).mockResolvedValue([router]);
  vi.mocked(devicesApi.preview).mockResolvedValue({ items: [{ device: router, action: "routes", method: "POST", path: "/device/d1/routes", body: { routes: ["10.0.0.0/16", "10.1.0.0/16"] } }] });
});
test("previews the complete enabled route list and VPC coverage", async () => {
  renderWithClient(<RoutesView profile="profile" region="us-east-1" />);
  expect(await screen.findByText("전부")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "승인" }));
  expect(await screen.findByText("POST /device/d1/routes")).toBeInTheDocument();
  expect(devicesApi.preview).toHaveBeenCalledWith("example.com", ["d1"], "routes", ["10.0.0.0/16", "10.1.0.0/16"]);
  expect(devicesApi.apply).not.toHaveBeenCalled();
});

test("combines exit routes and previews approval of both without counting them as VPC coverage", async () => {
  vi.mocked(devicesApi.list).mockResolvedValue([{
    ...router,
    advertisedRoutes: ["0.0.0.0/0", "::/0"],
    enabledRoutes: ["192.168.0.0/16", "0.0.0.0/0"],
  }]);
  renderWithClient(<RoutesView profile="profile" region="us-east-1" />);
  const exit = await screen.findByText("Exit node");
  const row = exit.closest("tr")!;
  expect(screen.getAllByText("Exit node")).toHaveLength(1);
  expect(within(row).getByText("승인 대기")).toBeInTheDocument();
  expect(screen.getByText("없음")).toBeInTheDocument();
  fireEvent.click(within(row).getByRole("button", { name: "승인" }));
  expect(devicesApi.preview).toHaveBeenCalledWith(
    "example.com", ["d1"], "routes", ["192.168.0.0/16", "0.0.0.0/0", "::/0"],
  );
});

test("shows exit as approved only when both routes are enabled", async () => {
  vi.mocked(devicesApi.list).mockResolvedValue([{
    ...router, advertisedRoutes: ["::/0"], enabledRoutes: ["0.0.0.0/0", "::/0"],
  }]);
  renderWithClient(<RoutesView />);
  const labels = await screen.findAllByText("Exit node");
  expect(labels).toHaveLength(2);
  expect(labels[0].closest("tr")).toBe(labels[1].closest("tr"));
  expect(screen.queryByRole("button", { name: "승인" })).not.toBeInTheDocument();
});
