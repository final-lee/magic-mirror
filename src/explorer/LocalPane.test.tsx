import { fireEvent, screen } from "@testing-library/react";
import { LocalPane } from "./LocalPane";
import { parentDir } from "./queries";
import { explorerApi } from "./api";
import { renderWithClient } from "../test/utils";

vi.mock("./api", () => ({ explorerApi: { localList: vi.fn(), localHome: vi.fn() } }));

const base = {
  path: "/Users/me/web",
  onPathChange: vi.fn(),
  filter: "",
  selection: { selected: [], anchor: null },
  onSelectionChange: vi.fn(),
  focused: true,
  onFocus: vi.fn(),
  onDragStart: vi.fn(),
  dropActive: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(explorerApi.localList).mockResolvedValue([
    { name: "dist", path: "/Users/me/web/dist", isDir: true, size: null, modified: null },
    { name: "index.html", path: "/Users/me/web/index.html", isDir: false, size: 42, modified: null },
  ]);
});

test("parentDir", () => {
  expect(parentDir("/Users/me/web")).toBe("/Users/me");
  expect(parentDir("/Users/me/web/")).toBe("/Users/me");
  expect(parentDir("/Users")).toBe("/");
  expect(parentDir("/")).toBe("/");
});

test("lists entries, opens folders, goes up", async () => {
  renderWithClient(<LocalPane {...base} />);
  expect(explorerApi.localList).toHaveBeenCalledWith("/Users/me/web");
  fireEvent.doubleClick(await screen.findByText("📁 dist"));
  expect(base.onPathChange).toHaveBeenCalledWith("/Users/me/web/dist");
  fireEvent.doubleClick(screen.getByText("📄 index.html"));
  expect(base.onPathChange).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "상위 폴더" }));
  expect(base.onPathChange).toHaveBeenLastCalledWith("/Users/me");
  expect(screen.getByTestId("pane-local")).toHaveAttribute("data-pane", "local");
});

test("path bar can be edited", async () => {
  renderWithClient(<LocalPane {...base} />);
  fireEvent.click(screen.getByRole("button", { name: "경로 입력" }));
  const input = screen.getByLabelText("경로");
  fireEvent.change(input, { target: { value: "/tmp" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(base.onPathChange).toHaveBeenLastCalledWith("/tmp");
});

test("read error offers going home", async () => {
  vi.mocked(explorerApi.localList).mockRejectedValue({ kind: "other", message: "폴더를 열 수 없어요: denied" });
  vi.mocked(explorerApi.localHome).mockResolvedValue("/Users/me");
  renderWithClient(<LocalPane {...base} />);
  expect(await screen.findByText("폴더를 열 수 없어요: denied")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "홈으로" }));
  await vi.waitFor(() => expect(base.onPathChange).toHaveBeenLastCalledWith("/Users/me"));
});
