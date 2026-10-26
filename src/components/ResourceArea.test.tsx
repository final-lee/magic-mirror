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
