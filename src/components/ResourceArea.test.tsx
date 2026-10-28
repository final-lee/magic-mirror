import { act, fireEvent, screen } from "@testing-library/react";
import { ResourceArea } from "./ResourceArea";
import { makeResource, renderWithClient, sampleServices } from "../test/utils";
import { api } from "../api/client";

vi.mock("../api/client", () => ({ api: { listResources: vi.fn(), ssoLogin: vi.fn() } }));
vi.mock("../api/desktop", () => ({ desktop: { copy: vi.fn(), openUrl: vi.fn() } }));

const [ec2, s3] = sampleServices;

const props = {
  profile: "prod",
  region: "ap-northeast-2",
  account: "123456789012",
  filter: "",
  onOpenBucket: vi.fn(),
  onRefresh: vi.fn(),
  active: true,
};

test("lists resources and shows detail on selection", async () => {
  vi.mocked(api.listResources).mockResolvedValue({
    items: [makeResource("i-1", { name: "web-1", id: "i-1", state: "running" }, { fields: [{ label: "AMI", value: "ami-9" }] })],
    truncated: false,
  });
  renderWithClient(<ResourceArea {...props} service={ec2} type={ec2.types[0]} />);
  fireEvent.click(await screen.findByText("web-1"));
  expect(screen.getByText("ami-9")).toBeInTheDocument();
  expect(screen.getByText(/prod · 123456789012 · ap-northeast-2/)).toBeInTheDocument();
});

test("shows truncation notice", async () => {
  vi.mocked(api.listResources).mockResolvedValue({ items: [makeResource("a", { name: "a" })], truncated: true });
  renderWithClient(<ResourceArea {...props} service={ec2} type={ec2.types[0]} />);
  expect(await screen.findByText("1,000개까지만 표시해요")).toBeInTheDocument();
});

test("shows error state", async () => {
  vi.mocked(api.listResources).mockRejectedValue({ kind: "accessDenied", action: "ec2:DescribeInstances" });
  renderWithClient(<ResourceArea {...props} service={ec2} type={ec2.types[0]} />);
  expect(await screen.findByText("권한 없음 (ec2:DescribeInstances)")).toBeInTheDocument();
});

test("double clicking a bucket opens it with its region", async () => {
  vi.mocked(api.listResources).mockResolvedValue({
    items: [makeResource("assets", { name: "assets", region: "us-west-2" })],
    truncated: false,
  });
  const onOpenBucket = vi.fn();
  renderWithClient(<ResourceArea {...props} onOpenBucket={onOpenBucket} service={s3} type={s3.types[0]} />);
  fireEvent.doubleClick(await screen.findByText("assets"));
  expect(onOpenBucket).toHaveBeenCalledWith({ bucket: "assets", region: "us-west-2", prefix: "" });
  expect(screen.getByText(/· global/)).toBeInTheDocument();
});

test("keeps loaded rows and shows an inline banner when a refetch fails", async () => {
  vi.mocked(api.listResources).mockResolvedValueOnce({ items: [makeResource("i-1", { name: "web-1" })], truncated: false });
  const { qc } = renderWithClient(<ResourceArea {...props} service={ec2} type={ec2.types[0]} />);
  expect(await screen.findByText("web-1")).toBeInTheDocument();
  vi.mocked(api.listResources).mockRejectedValueOnce({ kind: "network", message: "timeout" });
  await act(async () => {
    await qc.invalidateQueries();
  });
  expect(await screen.findByText("네트워크 오류: timeout")).toBeInTheDocument();
  expect(screen.getByText("web-1")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  expect(props.onRefresh).toHaveBeenCalled();
});

describe("IAM workspace entry", () => {
  const iamService = {
    id: "iam",
    name: "IAM",
    global: true,
    types: ["users", "roles", "policies"].map((id) => ({ id, name: id, columns: [{ key: "name", label: "Name", kind: "text" as const }] })),
  };
  const typeOf = (id: string) => iamService.types.find((t) => t.id === id)!;
  const arn = "arn:aws:iam::123456789012:thing/target";
  const mockRows = (extra = {}) =>
    vi.mocked(api.listResources).mockResolvedValue({ items: [makeResource("target", { name: "target" }, { arn, ...extra })], truncated: false });

  test.each(["users", "roles", "policies"])("double clicking an IAM %s row opens the IAM workspace on its ARN", async (typeId) => {
    mockRows();
    const onOpenIam = vi.fn();
    renderWithClient(<ResourceArea {...props} onOpenIam={onOpenIam} service={iamService} type={typeOf(typeId)} />);
    fireEvent.doubleClick(await screen.findByText("target"));
    expect(onOpenIam).toHaveBeenCalledWith(arn);
  });

  test("Enter on the selected row opens it too", async () => {
    mockRows();
    const onOpenIam = vi.fn();
    renderWithClient(<ResourceArea {...props} onOpenIam={onOpenIam} service={iamService} type={typeOf("roles")} />);
    fireEvent.click(await screen.findByText("target"));
    fireEvent.keyDown(screen.getByTestId("resource-table"), { key: "Enter" });
    expect(onOpenIam).toHaveBeenCalledWith(arn);
  });

  test("a row without an ARN still opens the workspace, just without a target", async () => {
    mockRows({ arn: null });
    const onOpenIam = vi.fn();
    renderWithClient(<ResourceArea {...props} onOpenIam={onOpenIam} service={iamService} type={typeOf("users")} />);
    fireEvent.doubleClick(await screen.findByText("target"));
    expect(onOpenIam).toHaveBeenCalledWith(null);
  });

  test("other services do not call it", async () => {
    mockRows();
    const onOpenIam = vi.fn();
    renderWithClient(<ResourceArea {...props} onOpenIam={onOpenIam} service={ec2} type={ec2.types[0]} />);
    fireEvent.doubleClick(await screen.findByText("target"));
    expect(onOpenIam).not.toHaveBeenCalled();
  });
});

describe("PostgreSQL entry", () => {
  const column = (key: string) => ({ key, label: key, kind: "text" as const });
  const rdsService = {
    id: "rds",
    name: "RDS",
    global: false,
    types: ["db-instances", "db-clusters"].map((id) => ({ id, name: id, columns: [column("name"), column("engine")] })),
  };
  const typeOf = (id: string) => rdsService.types.find((t) => t.id === id)!;
  const dbRow = (id: string, engine: string, extra: Record<string, string> = {}) => makeResource(id, { name: id, engine, ...extra });
  const mockRows = (...items: ReturnType<typeof dbRow>[]) => vi.mocked(api.listResources).mockResolvedValue({ items, truncated: false });
  const target = (kind: "cluster" | "instance", id: string) => ({ profile: "prod", region: "ap-northeast-2", kind, id });
  const NOT_POSTGRES = "PostgreSQL 엔진만 열 수 있어요";

  afterEach(() => vi.useRealTimers());

  test.each(["aurora-postgresql", "postgres"])("double clicking a %s cluster opens it with the profile and region", async (engine) => {
    mockRows(dbRow("orders-aurora", engine));
    const onOpenPg = vi.fn();
    renderWithClient(<ResourceArea {...props} onOpenPg={onOpenPg} service={rdsService} type={typeOf("db-clusters")} />);
    fireEvent.doubleClick(await screen.findByText("orders-aurora"));
    expect(onOpenPg).toHaveBeenCalledTimes(1);
    expect(onOpenPg).toHaveBeenCalledWith(target("cluster", "orders-aurora"));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  test("double clicking an Aurora instance opens the cluster it belongs to", async () => {
    mockRows(dbRow("orders-aurora-1", "aurora-postgresql", { cluster: "orders-aurora" }));
    const onOpenPg = vi.fn();
    renderWithClient(<ResourceArea {...props} onOpenPg={onOpenPg} service={rdsService} type={typeOf("db-instances")} />);
    fireEvent.doubleClick(await screen.findByText("orders-aurora-1"));
    expect(onOpenPg).toHaveBeenCalledWith(target("cluster", "orders-aurora"));
  });

  test("a PostgreSQL instance without a cluster opens as an instance", async () => {
    mockRows(dbRow("billing-db", "postgres", { cluster: "" }));
    const onOpenPg = vi.fn();
    renderWithClient(<ResourceArea {...props} onOpenPg={onOpenPg} service={rdsService} type={typeOf("db-instances")} />);
    fireEvent.doubleClick(await screen.findByText("billing-db"));
    expect(onOpenPg).toHaveBeenCalledWith(target("instance", "billing-db"));
  });

  test("Enter on the selected row opens it too", async () => {
    mockRows(dbRow("orders-aurora", "aurora-postgresql"));
    const onOpenPg = vi.fn();
    renderWithClient(<ResourceArea {...props} onOpenPg={onOpenPg} service={rdsService} type={typeOf("db-clusters")} />);
    fireEvent.click(await screen.findByText("orders-aurora"));
    fireEvent.keyDown(screen.getByTestId("resource-table"), { key: "Enter" });
    expect(onOpenPg).toHaveBeenCalledWith(target("cluster", "orders-aurora"));
  });

  test("a PostgreSQL row opens nothing when the page gave no way to open tabs", async () => {
    mockRows(dbRow("orders-aurora", "aurora-postgresql"));
    renderWithClient(<ResourceArea {...props} service={rdsService} type={typeOf("db-clusters")} />);
    fireEvent.doubleClick(await screen.findByText("orders-aurora"));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  test.each([
    ["db-clusters", "aurora-mysql"],
    ["db-instances", "mysql"],
  ])("a %s row with the %s engine shows the notice instead of opening", async (typeId, engine) => {
    mockRows(dbRow("legacy", engine));
    const onOpenPg = vi.fn();
    renderWithClient(<ResourceArea {...props} onOpenPg={onOpenPg} service={rdsService} type={typeOf(typeId)} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    fireEvent.doubleClick(await screen.findByText("legacy"));
    expect(screen.getByRole("status")).toHaveTextContent(NOT_POSTGRES);
    expect(onOpenPg).not.toHaveBeenCalled();
  });

  test("the notice goes away after 5 seconds", async () => {
    mockRows(dbRow("legacy", "aurora-mysql"));
    renderWithClient(<ResourceArea {...props} onOpenPg={vi.fn()} service={rdsService} type={typeOf("db-clusters")} />);
    const row = await screen.findByText("legacy");
    vi.useFakeTimers();
    fireEvent.doubleClick(row);
    expect(screen.getByRole("status")).toHaveTextContent(NOT_POSTGRES);
    act(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(screen.getByRole("status")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  test("showing the notice again restarts the 5 seconds", async () => {
    mockRows(dbRow("legacy", "aurora-mysql"));
    renderWithClient(<ResourceArea {...props} onOpenPg={vi.fn()} service={rdsService} type={typeOf("db-clusters")} />);
    const row = await screen.findByText("legacy");
    vi.useFakeTimers();
    fireEvent.doubleClick(row);
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    fireEvent.doubleClick(row);
    act(() => {
      vi.advanceTimersByTime(3_000); // 처음부터는 6초, 두 번째부터는 3초
    });
    expect(screen.getByRole("status")).toHaveTextContent(NOT_POSTGRES);
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  test("other services do not call it, whatever the engine value says", async () => {
    mockRows(dbRow("web-1", "postgres", { cluster: "x" }));
    const onOpenPg = vi.fn();
    renderWithClient(<ResourceArea {...props} onOpenPg={onOpenPg} service={ec2} type={ec2.types[0]} />);
    fireEvent.doubleClick(await screen.findByText("web-1"));
    expect(onOpenPg).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
