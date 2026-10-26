import { fireEvent, screen } from "@testing-library/react";
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
