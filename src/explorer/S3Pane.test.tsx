import { fireEvent, screen } from "@testing-library/react";
import { S3Pane } from "./S3Pane";
import { api } from "../api/client";
import { makeResource, renderWithClient, sampleServices } from "../test/utils";

vi.mock("../api/client", () => ({ api: { listResources: vi.fn(), listS3Objects: vi.fn(), ssoLogin: vi.fn() } }));

const s3Service = sampleServices[1];
const base = {
  profile: "prod",
  region: "ap-northeast-2",
  s3Service,
  location: null,
  onLocationChange: vi.fn(),
  filter: "",
  selection: { selected: [], anchor: null },
  onSelectionChange: vi.fn(),
  focused: false,
  onFocus: vi.fn(),
  onDragStart: vi.fn(),
  dropActive: false,
  onNewFolder: vi.fn(),
  onRename: vi.fn(),
  onDelete: vi.fn(),
  onRefresh: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listResources).mockResolvedValue({
    items: [makeResource("assets", { name: "assets", region: "us-west-2" })],
    truncated: false,
  });
  vi.mocked(api.listS3Objects).mockResolvedValue({
    entries: [
      { name: "img", key: "web/img/", isFolder: true, size: null, lastModified: null, storageClass: null },
      { name: "a.txt", key: "web/a.txt", isFolder: false, size: 3, lastModified: null, storageClass: null },
    ],
    nextToken: null,
  });
});

test("bucket list opens a bucket with its own region; actions disabled", async () => {
  renderWithClient(<S3Pane {...base} />);
  expect(screen.getByRole("button", { name: "+ 폴더" })).toBeDisabled();
  fireEvent.doubleClick(await screen.findByText("assets"));
  expect(base.onLocationChange).toHaveBeenCalledWith({ bucket: "assets", region: "us-west-2", prefix: "" });
  expect(screen.getByTestId("pane-s3")).toHaveAttribute("data-pane", "s3");
});

test("inside a bucket: folders open, breadcrumb and up navigate, buttons follow selection", async () => {
  const loc = { bucket: "assets", region: "us-west-2", prefix: "web/" };
  renderWithClient(<S3Pane {...base} location={loc} selection={{ selected: ["web/a.txt"], anchor: "web/a.txt" }} />);
  expect(api.listS3Objects).toHaveBeenCalledWith("prod", "us-west-2", "assets", "web/", null);
  fireEvent.doubleClick(await screen.findByText("📁 img"));
  expect(base.onLocationChange).toHaveBeenLastCalledWith({ ...loc, prefix: "web/img/" });
  fireEvent.click(screen.getByRole("button", { name: "상위 폴더" }));
  expect(base.onLocationChange).toHaveBeenLastCalledWith({ ...loc, prefix: "" });
  fireEvent.click(screen.getByRole("button", { name: "버킷 목록" }));
  expect(base.onLocationChange).toHaveBeenLastCalledWith(null);
  fireEvent.click(screen.getByRole("button", { name: "이름 변경" }));
  expect(base.onRename).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "삭제" }));
  expect(base.onDelete).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "+ 폴더" }));
  expect(base.onNewFolder).toHaveBeenCalled();
});

test("rename disabled with multiple selection; up at bucket root goes to bucket list", async () => {
  const loc = { bucket: "assets", region: "us-west-2", prefix: "" };
  renderWithClient(<S3Pane {...base} location={loc} selection={{ selected: ["a", "b"], anchor: "b" }} />);
  expect(screen.getByRole("button", { name: "이름 변경" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "상위 폴더" }));
  expect(base.onLocationChange).toHaveBeenLastCalledWith(null);
});
