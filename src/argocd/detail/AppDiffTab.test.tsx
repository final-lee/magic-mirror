import { fireEvent, screen, within } from "@testing-library/react";
import { renderWithClient } from "../../test/utils";
import type { AppDiffRow, ResRef } from "../types";
import { readApi } from "./api";
import { AppDiffTab } from "./AppDiffTab";
import { DIFF_CHANGED_ONLY, DIFF_LIST_LABEL, DIFF_NONE, DIFF_NO_CHANGES, DIFF_NO_MATCH, DIFF_OUT_OF_SYNC_ONLY, DIFF_UNCHANGED, diffSummary } from "./text";

vi.mock("./api", () => ({ readApi: { appDiff: vi.fn() } }));
const m = vi.mocked(readApi);
const URL = "https://argocd.example";

const line = (no: number, text: string) => ({ no, segments: [{ text, emph: false }] });
const row = (name: string, changed: boolean, syncStatus: string | null, over: Partial<AppDiffRow> = {}): AppDiffRow => ({
  res: { group: "apps", version: "v1", kind: "Deployment", namespace: "web", name },
  syncStatus, health: "Healthy", hook: false, live: "", target: "", changed,
  diff: changed
    ? { rows: [{ kind: "replace", left: line(1, `${name}: old`), right: line(1, `${name}: new`), hiddenRows: [] }], hunks: [0], stats: { added: 0, removed: 0, changed: 1 } }
    : { rows: [], hunks: [], stats: { added: 0, removed: 0, changed: 0 } },
  ...over,
});

function open(onOpen: (r: ResRef) => void = vi.fn()) {
  return renderWithClient(<AppDiffTab url={URL} namespace="argocd" name="web" version="1" enabled onOpen={onOpen} onTokenError={vi.fn()} />);
}
const listed = () => within(screen.getByRole("list", { name: DIFF_LIST_LABEL })).getAllByRole("listitem").map((i) => i.querySelector(".mono")?.textContent);

beforeEach(() => {
  vi.resetAllMocks();
  m.appDiff.mockResolvedValue([row("a", true, "OutOfSync"), row("b", false, "OutOfSync"), row("c", true, "Synced"), row("d", false, "Synced")]);
});

test("by default only the changed resources are listed, with their side-by-side lines", async () => {
  open();
  await screen.findByRole("list", { name: DIFF_LIST_LABEL });
  expect(m.appDiff).toHaveBeenCalledWith(URL, "argocd", "web");
  expect(listed()).toEqual(["a", "c"]);
  expect(screen.getByText("a: old")).toBeInTheDocument();
  expect(screen.getByText("a: new")).toBeInTheDocument();
  expect(screen.getByText(diffSummary(2, 4))).toBeInTheDocument();
});

test("changed only off lists every resource and the unchanged ones say nothing changed", async () => {
  open();
  await screen.findByRole("list", { name: DIFF_LIST_LABEL });
  fireEvent.click(screen.getByRole("checkbox", { name: DIFF_CHANGED_ONLY }));
  expect(listed()).toEqual(["a", "b", "c", "d"]);
  expect(screen.getAllByText(DIFF_UNCHANGED).length).toBeGreaterThan(0);
});

test("OutOfSync only narrows by what the app reports, and combines with changed only", async () => {
  open();
  await screen.findByRole("list", { name: DIFF_LIST_LABEL });
  fireEvent.click(screen.getByRole("checkbox", { name: DIFF_OUT_OF_SYNC_ONLY }));
  expect(listed()).toEqual(["a"]);
  fireEvent.click(screen.getByRole("checkbox", { name: DIFF_CHANGED_ONLY }));
  expect(listed()).toEqual(["a", "b"]);
});

test("filters that match nothing say so, and an app that matches Git entirely says that", async () => {
  m.appDiff.mockResolvedValue([row("a", false, "Synced")]);
  open();
  expect(await screen.findByText(DIFF_NO_CHANGES)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: DIFF_OUT_OF_SYNC_ONLY }));
  expect(screen.getByText(DIFF_NO_MATCH)).toBeInTheDocument();
});

test("an app without managed resources says so", async () => {
  m.appDiff.mockResolvedValue([]);
  open();
  expect(await screen.findByText(DIFF_NONE)).toBeInTheDocument();
});

test("many changed resources start folded and open one at a time; a few start open", async () => {
  m.appDiff.mockResolvedValue(["a", "b", "c", "d"].map((n) => row(n, true, "OutOfSync")));
  open();
  await screen.findByRole("list", { name: DIFF_LIST_LABEL });
  expect(screen.queryByText("a: new")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "a diff 펼치기·접기" }));
  expect(screen.getByText("a: new")).toBeInTheDocument();
  expect(screen.queryByText("b: new")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "a diff 펼치기·접기" }));
  expect(screen.queryByText("a: new")).toBeNull();
});

test("picking a resource name opens its detail", async () => {
  const onOpen = vi.fn();
  open(onOpen);
  fireEvent.click(await screen.findByRole("button", { name: "a" }));
  expect(onOpen).toHaveBeenCalledWith({ group: "apps", version: "v1", kind: "Deployment", namespace: "web", name: "a" });
});

test("a failed read shows the error and Retry reads again", async () => {
  m.appDiff.mockRejectedValueOnce({ kind: "other", message: "comparison failed" });
  open();
  expect(await screen.findByText("comparison failed")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  expect(await screen.findByRole("list", { name: DIFF_LIST_LABEL })).toBeInTheDocument();
});
