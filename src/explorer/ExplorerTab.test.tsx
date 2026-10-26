import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { ExplorerTab } from "./ExplorerTab";
import { explorerApi } from "./api";
import { api } from "../api/client";
import { makeResource, renderWithClient, sampleServices } from "../test/utils";
import type { TransferRequest } from "./types";

vi.mock("./api", () => ({
  explorerApi: {
    localHome: vi.fn(),
    localList: vi.fn(),
    planUpload: vi.fn(),
    planDownload: vi.fn(),
    findConflicts: vi.fn(),
    s3CreateFolder: vi.fn(),
    s3Rename: vi.fn(),
    s3CountUnder: vi.fn(),
    s3Delete: vi.fn(),
  },
  onTransferProgress: vi.fn(async () => () => {}),
}));
vi.mock("../api/client", () => ({ api: { listResources: vi.fn(), listS3Objects: vi.fn(), ssoLogin: vi.fn() } }));
const unlistenSpy = vi.fn();
let resolveListen: (() => void) | null = null;
let deferListen = false;
let dropHandler: ((e: { payload: { type: string; paths?: string[]; position?: { x: number; y: number } } }) => void) | null = null;
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn(async (cb) => {
      dropHandler = cb;
      if (deferListen) await new Promise<void>((r) => (resolveListen = r));
      return unlistenSpy;
    }),
  }),
}));

const m = vi.mocked(explorerApi);
const req = (id: string, key: string): TransferRequest => ({ id, direction: "upload", localPath: `/home/me/${key}`, bucket: "assets", region: "us-west-2", key });

function setup(extra = {}) {
  const transfers = { items: [], enqueue: vi.fn(), retry: vi.fn(), clearFinished: vi.fn() };
  const props = {
    profile: "prod",
    region: "ap-northeast-2",
    s3Service: sampleServices[1],
    filter: "",
    active: true,
    initialLocalPath: "/home/me",
    onLocalPathChange: vi.fn(),
    transfers,
    onOpenDiff: vi.fn(),
    onRefresh: vi.fn(),
    ...extra,
  };
  renderWithClient(<ExplorerTab {...props} />);
  return props;
}

async function openBucket() {
  fireEvent.doubleClick(await screen.findByText("assets"));
  await screen.findByText("📄 a.txt", { selector: "[data-pane=s3] *" });
}

beforeEach(() => {
  vi.clearAllMocks();
  dropHandler = null;
  deferListen = false;
  resolveListen = null;
  m.localHome.mockResolvedValue("/home/me");
  m.localList.mockResolvedValue([
    { name: "a.txt", path: "/home/me/a.txt", isDir: false, size: 1, modified: null },
    { name: "b.txt", path: "/home/me/b.txt", isDir: false, size: 1, modified: null },
  ]);
  vi.mocked(api.listResources).mockResolvedValue({ items: [makeResource("assets", { name: "assets", region: "us-west-2" })], truncated: false });
  vi.mocked(api.listS3Objects).mockResolvedValue({
    entries: [{ name: "a.txt", key: "a.txt", isFolder: false, size: 1, lastModified: null, storageClass: null }],
    nextToken: null,
  });
});

test("copy → uploads selection after conflict confirmation (skip conflicts)", async () => {
  const p = setup();
  await openBucket();
  fireEvent.click(screen.getByText("📄 a.txt", { selector: "[data-pane=local] *" }));
  fireEvent.click(screen.getByText("📄 b.txt"), { metaKey: true });
  m.planUpload.mockResolvedValue([req("1", "a.txt"), req("2", "b.txt")]);
  m.findConflicts.mockResolvedValue(["1"]);
  fireEvent.click(screen.getByRole("button", { name: "복사 →" }));
  expect(await screen.findByRole("dialog", { name: "덮어쓸까요?" })).toBeInTheDocument();
  expect(m.planUpload).toHaveBeenCalledWith(["/home/me/a.txt", "/home/me/b.txt"], "assets", "us-west-2", "");
  fireEvent.click(screen.getByRole("button", { name: "충돌 건너뛰기" }));
  await waitFor(() => expect(p.transfers.enqueue).toHaveBeenCalledWith([req("2", "b.txt")]));
});

test("← copy downloads without dialog when there are no conflicts", async () => {
  const p = setup();
  await openBucket();
  fireEvent.click(screen.getByText("📄 a.txt", { selector: "[data-pane=s3] *" }));
  const dl = { ...req("9", "a.txt"), direction: "download" as const };
  m.planDownload.mockResolvedValue([dl]);
  m.findConflicts.mockResolvedValue([]);
  fireEvent.click(screen.getByRole("button", { name: "← 복사" }));
  await waitFor(() => expect(p.transfers.enqueue).toHaveBeenCalledWith([dl]));
  expect(m.planDownload).toHaveBeenCalledWith("prod", "assets", "us-west-2", ["a.txt"], "/home/me");
});

test("delete asks with object count then deletes", async () => {
  setup();
  await openBucket();
  fireEvent.click(screen.getByText("📄 a.txt", { selector: "[data-pane=s3] *" }));
  m.s3CountUnder.mockResolvedValue(1);
  m.s3Delete.mockResolvedValue(1);
  fireEvent.click(screen.getByRole("button", { name: "삭제" }));
  expect(await screen.findByText("객체 1개를 삭제할까요? 되돌릴 수 없어요.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "삭제하기" }));
  await waitFor(() => expect(m.s3Delete).toHaveBeenCalledWith("prod", "assets", "us-west-2", ["a.txt"]));
});

test("rename conflict asks to overwrite then retries with overwrite", async () => {
  setup();
  await openBucket();
  fireEvent.click(screen.getByText("📄 a.txt", { selector: "[data-pane=s3] *" }));
  m.s3Rename.mockResolvedValueOnce({ kind: "conflict", target: "b.txt" }).mockResolvedValueOnce({ kind: "done" });
  fireEvent.click(screen.getByRole("button", { name: "이름 변경" }));
  fireEvent.change(await screen.findByLabelText("새 이름"), { target: { value: "b.txt" } });
  fireEvent.click(screen.getByRole("button", { name: "바꾸기" }));
  fireEvent.click(await screen.findByRole("button", { name: "덮어쓰기" }));
  await waitFor(() => expect(m.s3Rename).toHaveBeenLastCalledWith("prod", "assets", "us-west-2", "a.txt", "b.txt", true));
});

test("new folder error keeps dialog open", async () => {
  setup();
  await openBucket();
  m.s3CreateFolder.mockRejectedValue({ kind: "other", message: "이름을 입력하세요" });
  fireEvent.click(screen.getByRole("button", { name: "+ 폴더" }));
  fireEvent.click(await screen.findByRole("button", { name: "만들기" }));
  expect(await screen.findByText("이름을 입력하세요")).toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: "새 폴더" })).toBeInTheDocument();
});

test("compare opens diff for one local and one S3 file", async () => {
  const p = setup();
  await openBucket();
  fireEvent.click(screen.getByText("📄 a.txt", { selector: "[data-pane=local] *" }));
  fireEvent.click(screen.getByText("📄 a.txt", { selector: "[data-pane=s3] *" }));
  fireEvent.click(screen.getByRole("button", { name: "비교 ⌘D" }));
  expect(p.onOpenDiff).toHaveBeenCalledWith(
    { source: "local", path: "/home/me/a.txt" },
    { source: "s3", bucket: "assets", region: "us-west-2", key: "a.txt" },
  );
});

test("dragging from local to s3 pane uploads", async () => {
  setup();
  await openBucket();
  const s3Pane = screen.getByTestId("pane-s3");
  document.elementFromPoint = vi.fn(() => s3Pane);
  m.planUpload.mockResolvedValue([req("1", "b.txt")]);
  m.findConflicts.mockResolvedValue([]);
  const row = screen.getByText("📄 b.txt").closest("tr")!;
  fireEvent.pointerDown(row, { clientX: 0, clientY: 0, button: 0 });
  fireEvent.pointerMove(row, { clientX: 40, clientY: 0, buttons: 1 });
  act(() => {
    window.dispatchEvent(new MouseEvent("pointerup", { clientX: 400, clientY: 10 }));
  });
  await waitFor(() => expect(m.planUpload).toHaveBeenCalledWith(["/home/me/b.txt"], "assets", "us-west-2", ""));
});

test("Finder drop on the S3 pane uploads; before opening a bucket it explains", async () => {
  setup();
  await waitFor(() => expect(dropHandler).not.toBeNull());
  const s3Pane = screen.getByTestId("pane-s3");
  document.elementFromPoint = vi.fn(() => s3Pane);
  act(() => dropHandler!({ payload: { type: "drop", paths: ["/Users/me/x.png"], position: { x: 10, y: 10 } } }));
  expect(await screen.findByText("버킷을 먼저 여세요")).toBeInTheDocument();

  await openBucket();
  m.planUpload.mockResolvedValue([req("5", "x.png")]);
  m.findConflicts.mockResolvedValue([]);
  act(() => dropHandler!({ payload: { type: "drop", paths: ["/Users/me/x.png"], position: { x: 10, y: 10 } } }));
  await waitFor(() => expect(m.planUpload).toHaveBeenCalledWith(["/Users/me/x.png"], "assets", "us-west-2", ""));
});

test("conflict dialog overwrite enqueues all requests", async () => {
  const p = setup();
  await openBucket();
  fireEvent.click(screen.getByText("📄 a.txt", { selector: "[data-pane=local] *" }));
  const reqs = [req("1", "a.txt"), req("2", "b.txt")];
  m.planUpload.mockResolvedValue(reqs);
  m.findConflicts.mockResolvedValue(["1"]);
  fireEvent.click(screen.getByRole("button", { name: "복사 →" }));
  fireEvent.click(await screen.findByRole("button", { name: "모두 덮어쓰기" }));
  await waitFor(() => expect(p.transfers.enqueue).toHaveBeenCalledWith(reqs));
});

test("Finder drop not over the S3 pane starts nothing", async () => {
  setup();
  await openBucket();
  await waitFor(() => expect(dropHandler).not.toBeNull());
  for (const target of [screen.getByTestId("pane-local"), null]) {
    document.elementFromPoint = vi.fn(() => target);
    act(() => dropHandler!({ payload: { type: "drop", paths: ["/Users/me/x.png"], position: { x: 10, y: 10 } } }));
  }
  await new Promise((r) => setTimeout(r, 20));
  expect(m.planUpload).not.toHaveBeenCalled();
});

test("drop while a confirm dialog is open is ignored with a notice", async () => {
  const p = setup();
  await openBucket();
  fireEvent.click(screen.getByText("📄 a.txt", { selector: "[data-pane=local] *" }));
  m.planUpload.mockResolvedValue([req("1", "a.txt")]);
  m.findConflicts.mockResolvedValue(["1"]);
  fireEvent.click(screen.getByRole("button", { name: "복사 →" }));
  await screen.findByRole("button", { name: "모두 덮어쓰기" });
  m.planUpload.mockClear();
  document.elementFromPoint = vi.fn(() => screen.getByTestId("pane-s3"));
  act(() => dropHandler!({ payload: { type: "drop", paths: ["/Users/me/x.png"], position: { x: 10, y: 10 } } }));
  expect(await screen.findByText("확인 창을 먼저 닫아 주세요")).toBeInTheDocument();
  expect(m.planUpload).not.toHaveBeenCalled();
  expect(p.transfers.enqueue).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "모두 덮어쓰기" })).toBeInTheDocument();
});

test("Finder listener is unlistened on unmount", async () => {
  const { unmount } = renderWithClient(
    <ExplorerTab profile="prod" region="r" s3Service={sampleServices[1]} filter="" active initialLocalPath="/home/me" onLocalPathChange={vi.fn()} transfers={{ items: [], enqueue: vi.fn(), retry: vi.fn(), clearFinished: vi.fn() }} onOpenDiff={vi.fn()} onRefresh={vi.fn()} />,
  );
  await waitFor(() => expect(dropHandler).not.toBeNull());
  await act(async () => {});
  unmount();
  expect(unlistenSpy).toHaveBeenCalledTimes(1);
});

test("unmount before listen resolves unlistens once it resolves", async () => {
  deferListen = true;
  const { unmount } = renderWithClient(
    <ExplorerTab profile="prod" region="r" s3Service={sampleServices[1]} filter="" active initialLocalPath="/home/me" onLocalPathChange={vi.fn()} transfers={{ items: [], enqueue: vi.fn(), retry: vi.fn(), clearFinished: vi.fn() }} onOpenDiff={vi.fn()} onRefresh={vi.fn()} />,
  );
  await waitFor(() => expect(resolveListen).not.toBeNull());
  unmount();
  expect(unlistenSpy).not.toHaveBeenCalled();
  await act(async () => resolveListen!());
  await waitFor(() => expect(unlistenSpy).toHaveBeenCalledTimes(1));
});

test("dragging from s3 to local pane checks conflicts then downloads", async () => {
  const p = setup();
  await openBucket();
  const dl = { ...req("9", "a.txt"), direction: "download" as const };
  m.planDownload.mockResolvedValue([dl]);
  m.findConflicts.mockResolvedValue([]);
  document.elementFromPoint = vi.fn(() => screen.getByTestId("pane-local"));
  const row = screen.getByText("📄 a.txt", { selector: "[data-pane=s3] *" }).closest("tr")!;
  fireEvent.pointerDown(row, { clientX: 400, clientY: 0, button: 0 });
  fireEvent.pointerMove(row, { clientX: 40, clientY: 0, buttons: 1 });
  act(() => {
    window.dispatchEvent(new MouseEvent("pointerup", { clientX: 10, clientY: 10 }));
  });
  await waitFor(() => expect(m.planDownload).toHaveBeenCalledWith("prod", "assets", "us-west-2", ["a.txt"], "/home/me"));
  await waitFor(() => expect(m.findConflicts).toHaveBeenCalledWith("prod", [dl]));
  await waitFor(() => expect(p.transfers.enqueue).toHaveBeenCalledWith([dl]));
});

test("initialLocation opens that bucket's objects right away", async () => {
  setup({ initialLocation: { bucket: "assets", region: "us-west-2", prefix: "" } });
  expect(await screen.findByText("📄 a.txt", { selector: "[data-pane=s3] *" })).toBeInTheDocument();
  expect(vi.mocked(api.listS3Objects)).toHaveBeenCalledWith("prod", "us-west-2", "assets", "", null);
});

describe("navigation history", () => {
  const dirs: Record<string, { name: string; path: string; isDir: boolean; size: number; modified: null }[]> = {
    "/home/me": [{ name: "d1", path: "/home/me/d1", isDir: true, size: 0, modified: null }],
    "/home/me/d1": [{ name: "d2", path: "/home/me/d1/d2", isDir: true, size: 0, modified: null }],
    "/home/me/d1/d2": [{ name: "z.txt", path: "/home/me/d1/d2/z.txt", isDir: false, size: 1, modified: null }],
  };
  const pathText = (t: string) => screen.getByText(t, { selector: "[data-pane=local] .path b" });

  async function enterTwo() {
    m.localList.mockImplementation(async (path: string) => dirs[path] ?? []);
    const p = setup();
    fireEvent.doubleClick(await screen.findByText("📁 d1"));
    fireEvent.doubleClick(await screen.findByText("📁 d2"));
    await screen.findByText("📄 z.txt");
    return p;
  }

  test("mouse back/forward buttons move through local history", async () => {
    const p = await enterTwo();
    const pane = screen.getByTestId("pane-local");
    fireEvent.mouseUp(pane, { button: 3 });
    await screen.findByText("📁 d2");
    expect(pathText("/home/me/d1")).toBeInTheDocument();
    expect(p.onLocalPathChange).toHaveBeenLastCalledWith("/home/me/d1");
    fireEvent.mouseUp(pane, { button: 4 });
    await screen.findByText("📄 z.txt");
    expect(pathText("/home/me/d1/d2")).toBeInTheDocument();
  });

  test("a new navigation clears forward history", async () => {
    await enterTwo();
    const pane = screen.getByTestId("pane-local");
    fireEvent.mouseUp(pane, { button: 3 });
    await screen.findByText("📁 d2");
    fireEvent.click(screen.getAllByRole("button", { name: "상위 폴더" })[0]);
    await screen.findByText("📁 d1");
    fireEvent.mouseUp(pane, { button: 4 });
    expect(pathText("/home/me")).toBeInTheDocument();
  });

  test("meta+[ and meta+] navigate the focused pane; inactive tab ignores them", async () => {
    await enterTwo();
    fireEvent.keyDown(window, { key: "[", metaKey: true });
    await screen.findByText("📁 d2");
    fireEvent.keyDown(window, { key: "]", metaKey: true });
    await screen.findByText("📄 z.txt");
  });

  test("inactive tab ignores back button", async () => {
    m.localList.mockImplementation(async (path: string) => dirs[path] ?? []);
    setup({ active: false });
    fireEvent.doubleClick(await screen.findByText("📁 d1"));
    await screen.findByText("📁 d2");
    fireEvent.mouseUp(screen.getByTestId("pane-local"), { button: 3 });
    expect(m.localList).not.toHaveBeenLastCalledWith("/home/me");
    expect(pathText("/home/me/d1")).toBeInTheDocument();
  });
});
