import { fireEvent, screen, waitFor } from "@testing-library/react";
import { S3Area } from "./S3Area";
import { renderWithClient } from "../test/utils";
import { api } from "../api/client";

vi.mock("../api/client", () => ({ api: { listS3Objects: vi.fn(), ssoLogin: vi.fn() } }));
vi.mock("../api/desktop", () => ({ desktop: { copy: vi.fn(), openUrl: vi.fn() } }));

const location = { bucket: "assets", region: "ap-northeast-2", prefix: "images/" };

test("lists entries, navigates into folders and via breadcrumb", async () => {
  vi.mocked(api.listS3Objects).mockResolvedValue({
    entries: [
      { name: "products", key: "images/products/", isFolder: true, size: null, lastModified: null, storageClass: null },
      { name: "logo.svg", key: "images/logo.svg", isFolder: false, size: 12, lastModified: null, storageClass: "STANDARD" },
    ],
    nextToken: null,
  });
  const onNavigate = vi.fn();
  const onBack = vi.fn();
  renderWithClient(
    <S3Area profile="prod" account="1" location={location} filter="" onNavigate={onNavigate} onBack={onBack} onRefresh={() => {}} />,
  );
  expect(api.listS3Objects).toHaveBeenCalledWith("prod", "ap-northeast-2", "assets", "images/", null);
  fireEvent.doubleClick(await screen.findByText("📁 products"));
  expect(onNavigate).toHaveBeenCalledWith("images/products/");
  fireEvent.doubleClick(screen.getByText("📄 logo.svg"));
  expect(onNavigate).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText("📄 logo.svg"));
  expect(screen.getByText("s3://assets/images/logo.svg")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "assets" }));
  expect(onNavigate).toHaveBeenLastCalledWith("");
  fireEvent.click(screen.getByRole("button", { name: "Buckets" }));
  expect(onBack).toHaveBeenCalled();
});

test("loads more pages", async () => {
  vi.mocked(api.listS3Objects)
    .mockResolvedValueOnce({
      entries: [{ name: "a", key: "images/a", isFolder: false, size: 1, lastModified: null, storageClass: null }],
      nextToken: "t1",
    })
    .mockResolvedValueOnce({
      entries: [{ name: "b", key: "images/b", isFolder: false, size: 1, lastModified: null, storageClass: null }],
      nextToken: null,
    });
  renderWithClient(
    <S3Area profile="prod" account="1" location={location} filter="" onNavigate={() => {}} onBack={() => {}} onRefresh={() => {}} />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "더 보기" }));
  await waitFor(() => expect(screen.getByText("📄 b")).toBeInTheDocument());
  expect(api.listS3Objects).toHaveBeenLastCalledWith("prod", "ap-northeast-2", "assets", "images/", "t1");
  expect(screen.queryByRole("button", { name: "더 보기" })).not.toBeInTheDocument();
});

test("keeps loaded entries and shows an inline banner when the next page fails", async () => {
  vi.mocked(api.listS3Objects)
    .mockResolvedValueOnce({
      entries: [{ name: "a", key: "images/a", isFolder: false, size: 1, lastModified: null, storageClass: null }],
      nextToken: "t1",
    })
    .mockRejectedValueOnce({ kind: "network", message: "timeout" });
  const onRefresh = vi.fn();
  renderWithClient(
    <S3Area profile="prod" account="1" location={location} filter="" onNavigate={() => {}} onBack={() => {}} onRefresh={onRefresh} />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "더 보기" }));
  expect(await screen.findByText("네트워크 오류: timeout")).toBeInTheDocument();
  expect(screen.getByText("📄 a")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  expect(onRefresh).toHaveBeenCalled();
});
