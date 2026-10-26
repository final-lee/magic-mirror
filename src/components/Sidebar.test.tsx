import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Sidebar } from "./Sidebar";
import { makeResource, renderWithClient, sampleServices } from "../test/utils";
import { api } from "../api/client";

vi.mock("../api/client", () => ({
  api: { listResources: vi.fn() },
}));

const listResources = vi.mocked(api.listResources);

beforeEach(() => {
  listResources.mockReset();
  listResources.mockResolvedValue({ items: [makeResource("a", {}), makeResource("b", {})], truncated: false });
});

const base = {
  services: sampleServices,
  profile: "prod",
  region: "ap-northeast-2",
  selection: null,
  favorites: [],
  onSelect: () => {},
  onToggleFavorite: () => {},
};

test("shows services collapsed and fetches counts only when expanded", async () => {
  renderWithClient(<Sidebar {...base} />);
  expect(screen.getByText("EC2")).toBeInTheDocument();
  expect(screen.queryByText("Instances")).not.toBeInTheDocument();
  expect(listResources).not.toHaveBeenCalled();

  fireEvent.click(screen.getByText("EC2"));
  expect(screen.getByText("Instances")).toBeInTheDocument();
  await waitFor(() => expect(listResources).toHaveBeenCalledWith("prod", "ap-northeast-2", "ec2", "instances"));
  expect(listResources).toHaveBeenCalledWith("prod", "ap-northeast-2", "ec2", "volumes");
  await waitFor(() => expect(screen.getAllByText("2")).toHaveLength(2));
});

test("shows dash when count fetch fails", async () => {
  listResources.mockRejectedValue({ kind: "accessDenied", action: "iam:ListUsers" });
  renderWithClient(<Sidebar {...base} />);
  fireEvent.click(screen.getByText("IAM"));
  await waitFor(() => expect(screen.getByText("—")).toBeInTheDocument());
});

test("selected service starts expanded and clicking type selects", () => {
  const onSelect = vi.fn();
  renderWithClient(<Sidebar {...base} selection={{ service: "ec2", type: "volumes" }} onSelect={onSelect} />);
  expect(screen.getByText("Volumes").closest("[role=button]")).toHaveAttribute("aria-current", "true");
  fireEvent.click(screen.getByText("Instances"));
  expect(onSelect).toHaveBeenCalledWith({ service: "ec2", type: "instances" });
});

test("right click toggles favorite and favorites section lists entries", () => {
  const onToggleFavorite = vi.fn();
  renderWithClient(
    <Sidebar {...base} favorites={[{ service: "s3", type: "buckets" }]} onToggleFavorite={onToggleFavorite} />,
  );
  expect(screen.getByText("즐겨찾기")).toBeInTheDocument();
  expect(screen.getByText("S3 › Buckets")).toBeInTheDocument();
  fireEvent.contextMenu(screen.getByText("S3 › Buckets"));
  expect(onToggleFavorite).toHaveBeenCalledWith({ service: "s3", type: "buckets" });
  // 즐겨찾기 행은 조회를 일으키지 않는다
  expect(listResources).not.toHaveBeenCalled();
});

test("favorite of a disabled service is hidden", () => {
  renderWithClient(<Sidebar {...base} favorites={[{ service: "lambda", type: "functions" }]} />);
  expect(screen.queryByText("즐겨찾기")).not.toBeInTheDocument();
});
