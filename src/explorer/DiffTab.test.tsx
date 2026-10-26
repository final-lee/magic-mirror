import { fireEvent, screen, waitFor } from "@testing-library/react";
import { DiffTab } from "./DiffTab";
import { explorerApi } from "./api";
import { renderWithClient } from "../test/utils";
import type { DiffResult, DiffRow } from "./types";

vi.mock("./api", () => ({ explorerApi: { diffFiles: vi.fn(), openExternalDiff: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));

const left = { source: "local" as const, path: "/w/index.html" };
const right = { source: "s3" as const, bucket: "assets", region: "r", key: "web/index.html" };
const side = (label: string, size = 10) => ({ label, size, modified: null, md5: null });
const eq = (no: number, text: string): DiffRow => ({
  kind: "equal",
  left: { no, segments: [{ text, emph: false }] },
  right: { no, segments: [{ text, emph: false }] },
  hiddenRows: [],
});

const textResult: DiffResult = {
  left: side("/w/index.html"),
  right: side("s3://assets/web/index.html"),
  mode: "text",
  rows: [
    eq(1, "<html>"),
    {
      kind: "replace",
      left: { no: 2, segments: [{ text: "v", emph: false }, { text: "2.4", emph: true }] },
      right: { no: 2, segments: [{ text: "v", emph: false }, { text: "2.3", emph: true }] },
      hiddenRows: [],
    },
    { kind: "collapsed", left: null, right: null, hiddenRows: [eq(3, "hidden-a"), eq(4, "hidden-b")] },
    { kind: "insert", left: null, right: { no: 5, segments: [{ text: "<div id=banner>", emph: false }] }, hiddenRows: [] },
  ],
  hunks: [1, 3],
  stats: { added: 1, removed: 0, changed: 1 },
  metaVerdict: null,
  reason: null,
};

function setup(extra = {}) {
  const transfers = { items: [], enqueue: vi.fn(), retry: vi.fn(), clearFinished: vi.fn() };
  const props = { profile: "prod", left, right, active: true, transfers, diffTool: "filemerge" as const, diffToolCommand: null, ...extra };
  renderWithClient(<DiffTab {...props} />);
  return props;
}

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
});

test("renders side-by-side rows with emphasis, stats and expands collapsed rows", async () => {
  vi.mocked(explorerApi.diffFiles).mockResolvedValue(textResult);
  setup();
  expect(explorerApi.diffFiles).toHaveBeenCalledWith("prod", left, right);
  expect(await screen.findByText("2.4")).toHaveClass("emph");
  expect(screen.getByText("+1 −0 ~1")).toBeInTheDocument();
  expect(screen.getByText("/w/index.html")).toBeInTheDocument();
  expect(screen.getByText("s3://assets/web/index.html")).toBeInTheDocument();
  expect(screen.queryByText("hidden-a")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "… 2줄 같음" }));
  expect(screen.getAllByText("hidden-a")).toHaveLength(2);
});

test("next/previous change scrolls to hunk rows, also with F7", async () => {
  vi.mocked(explorerApi.diffFiles).mockResolvedValue(textResult);
  setup();
  await screen.findByText("2.4");
  fireEvent.click(screen.getByRole("button", { name: "▼ 다음" }));
  expect(screen.getByTestId("drow-1")).toHaveClass("current");
  fireEvent.keyDown(window, { key: "F7" });
  expect(screen.getByTestId("drow-3")).toHaveClass("current");
  fireEvent.keyDown(window, { key: "F7", shiftKey: true });
  expect(screen.getByTestId("drow-1")).toHaveClass("current");
  expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
});

test("identical files show a same banner", async () => {
  vi.mocked(explorerApi.diffFiles).mockResolvedValue({ ...textResult, rows: [eq(1, "a")], hunks: [], stats: { added: 0, removed: 0, changed: 0 } });
  setup();
  expect(await screen.findByText("두 파일이 같아요")).toBeInTheDocument();
});

test("meta mode shows verdict and reason", async () => {
  vi.mocked(explorerApi.diffFiles).mockResolvedValue({
    left: { label: "/w/a.png", size: 2048, modified: null, md5: "aaa" },
    right: { label: "s3://assets/a.png", size: 2048, modified: null, md5: "aaa" },
    mode: "meta",
    rows: [],
    hunks: [],
    stats: { added: 0, removed: 0, changed: 0 },
    metaVerdict: "same",
    reason: "binary",
  });
  setup();
  expect(await screen.findByText("같은 파일로 보여요")).toBeInTheDocument();
  expect(screen.getByText("바이너리 파일이라 내용 대신 정보만 비교해요")).toBeInTheDocument();
  expect(screen.getAllByText("2.0 KB")).toHaveLength(2);
});

test("upload to S3 asks and enqueues an exact-key transfer", async () => {
  vi.mocked(explorerApi.diffFiles).mockResolvedValue(textResult);
  const p = setup();
  await screen.findByText("2.4");
  fireEvent.click(screen.getByRole("button", { name: "S3로 업로드 →" }));
  fireEvent.click(await screen.findByRole("button", { name: "덮어쓰기" }));
  await waitFor(() => expect(p.transfers.enqueue).toHaveBeenCalled());
  const [reqs] = p.transfers.enqueue.mock.calls[0];
  expect(reqs).toEqual([
    expect.objectContaining({ direction: "upload", localPath: "/w/index.html", bucket: "assets", region: "r", key: "web/index.html" }),
  ]);
});

test("upload/download buttons hidden for local↔local; external tool errors are shown", async () => {
  vi.mocked(explorerApi.diffFiles).mockResolvedValue(textResult);
  vi.mocked(explorerApi.openExternalDiff).mockRejectedValue({ kind: "other", message: "FileMerge를 찾을 수 없어요" });
  setup({ right: { source: "local", path: "/w/b.html" } });
  await screen.findByText("2.4");
  expect(screen.queryByRole("button", { name: "S3로 업로드 →" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "외부 도구로 열기" }));
  expect(await screen.findByText("FileMerge를 찾을 수 없어요")).toBeInTheDocument();
  expect(explorerApi.openExternalDiff).toHaveBeenCalledWith("prod", left, { source: "local", path: "/w/b.html" }, "filemerge", null);
});
