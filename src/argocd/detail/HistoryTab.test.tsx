import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithClient } from "../../test/utils";
import { desktop } from "../../api/desktop";
import { argocdApi } from "../api";
import type { ArgoEvent, ArgoHistoryEntry, RevisionInfo } from "../types";
import { readApi } from "./api";
import { HistoryTab } from "./HistoryTab";
import { HIST_LOCAL, HIST_NO_LOCAL, HIST_NO_MANIFEST_DIFF, HIST_SERVER, histCompareTitle } from "./text";

vi.mock("./api", () => ({ readApi: { history: vi.fn(), manifestsDiff: vi.fn() } }));
vi.mock("../api", () => ({ argocdApi: { events: vi.fn() } }));
vi.mock("../../api/desktop", () => ({ desktop: { openUrl: vi.fn(), copy: vi.fn(), reveal: vi.fn() } }));
const read = vi.mocked(readApi);
const events = vi.mocked(argocdApi.events);
const URL = "https://argocd.example";
const NOW = Date.parse("2026-10-30T12:00:00Z");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA2 = "abcdef0123456789abcdef0123456789abcdef01";

const info = (revision: string, over: Partial<RevisionInfo> = {}): RevisionInfo => ({
  revision, sourceIndex: 0, repoUrl: "https://github.com/acme/web.git", chart: null, path: null, targetRevision: null, metadata: null, chartDetails: null, oci: null, ...over,
});
const entry = (id: number, revisions: RevisionInfo[], over: Partial<ArgoHistoryEntry> = {}): ArgoHistoryEntry => ({ id, deployedAt: "2026-10-30T10:00:00Z", deployStartedAt: null, initiatedBy: "alice", revisions, ...over });

function open() {
  return renderWithClient(<HistoryTab url={URL} namespace="argocd" name="web" version="1" enabled now={NOW} onTokenError={vi.fn()} />);
}
const pick = (id: number) => fireEvent.click(screen.getByRole("checkbox", { name: `${id}번 배포 선택` }));

beforeEach(() => {
  vi.resetAllMocks();
  events.mockResolvedValue([]);
  read.history.mockResolvedValue([
    entry(9, [info(SHA2, { metadata: { author: "Kim <kim@acme.io>", date: "2026-10-30T09:00:00Z", message: "fix the probe\n\nlong body", tags: ["v1.4"], signatureInfo: null } })]),
    entry(8, [info(SHA), info("1.2.3", { sourceIndex: 1, repoUrl: "https://charts.acme.io", chart: "web", chartDetails: { description: "Web chart", home: null, maintainers: [] } })]),
    entry(7, [info("2.0.0", { repoUrl: "oci://registry.acme.io/web", oci: { version: "2.0.0", authors: null, createdAt: null, description: "OCI artifact", docsUrl: null, imageUrl: null, sourceUrl: "https://github.com/acme/web", } })]),
  ]);
});

test("every server entry shows its revision metadata: commit message, author, age, tags, chart and OCI details", async () => {
  open();
  const table = await screen.findByRole("table", { name: HIST_SERVER });
  expect(read.history).toHaveBeenCalledWith(URL, "argocd", "web");
  const rows = within(table).getAllByRole("row").slice(1);
  expect(rows).toHaveLength(3);
  expect(within(rows[0]).getByText("abcdef0")).toBeInTheDocument();
  expect(within(rows[0]).getByText(/fix the probe/)).toBeInTheDocument();
  expect(within(rows[0]).queryByText(/long body/)).toBeNull();
  expect(within(rows[0]).getByText(/Kim/)).toBeInTheDocument();
  expect(within(rows[0]).queryByText(/kim@acme.io/)).toBeNull();
  expect(within(rows[0]).getByText("v1.4")).toBeInTheDocument();
  expect(within(rows[1]).getByText("0123456")).toBeInTheDocument();
  expect(within(rows[1]).getByText("1.2.3")).toBeInTheDocument();
  expect(within(rows[1]).getByText("Web chart")).toBeInTheDocument();
  expect(within(rows[2]).getByText(/OCI artifact/)).toBeInTheDocument();
});

test("a Git commit links to its page in the browser; chart and tag revisions have no link", async () => {
  open();
  const table = await screen.findByRole("table", { name: HIST_SERVER });
  const rows = within(table).getAllByRole("row").slice(1);
  fireEvent.click(within(rows[0]).getByRole("button", { name: "커밋" }));
  expect(desktop.openUrl).toHaveBeenCalledWith(`https://github.com/acme/web/commit/${SHA2}`);
  // 둘째 줄: 커밋 하나만 링크, 차트 버전(1.2.3)에는 없다
  expect(within(rows[1]).getAllByRole("button", { name: "커밋" })).toHaveLength(1);
});

test("picking two entries compares their rendered manifests oldest to newest, whichever was picked first", async () => {
  read.manifestsDiff.mockResolvedValue({ rows: [{ kind: "replace", left: { no: 1, segments: [{ text: "image: web:1", emph: false }] }, right: { no: 1, segments: [{ text: "image: web:2", emph: false }] }, hiddenRows: [] }], hunks: [0], stats: { added: 0, removed: 0, changed: 1 } });
  open();
  await screen.findByRole("table", { name: HIST_SERVER });
  expect(read.manifestsDiff).not.toHaveBeenCalled();
  pick(9);
  expect(read.manifestsDiff).not.toHaveBeenCalled();
  pick(8);
  expect(await screen.findByText(histCompareTitle(8, 9))).toBeInTheDocument();
  // 8번은 소스가 둘이라 두 리비전을 소스 순서대로 모두 보낸다
  expect(read.manifestsDiff).toHaveBeenCalledWith(URL, "argocd", "web", [SHA, "1.2.3"], [SHA2]);
  expect(await screen.findByText("image: web:2")).toBeInTheDocument();
});

test("a third pick releases the oldest pick, and clearing removes the comparison", async () => {
  read.manifestsDiff.mockResolvedValue({ rows: [], hunks: [], stats: { added: 0, removed: 0, changed: 0 } });
  open();
  await screen.findByRole("table", { name: HIST_SERVER });
  pick(9);
  pick(8);
  await screen.findByText(histCompareTitle(8, 9));
  pick(7);
  expect(screen.getByRole("checkbox", { name: "9번 배포 선택" })).not.toBeChecked();
  expect(await screen.findByText(histCompareTitle(7, 8))).toBeInTheDocument();
  expect(await screen.findByText(HIST_NO_MANIFEST_DIFF)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "선택 풀기" }));
  expect(screen.queryByText(histCompareTitle(7, 8))).toBeNull();
});

test("a failed comparison shows the error", async () => {
  read.manifestsDiff.mockRejectedValue({ kind: "other", message: "repo server is down" });
  open();
  await screen.findByRole("table", { name: HIST_SERVER });
  pick(9);
  pick(7);
  expect(await screen.findByText("repo server is down")).toBeInTheDocument();
});

test("local operation records of this app only, newest first, with who and how long", async () => {
  const ev = (at: string, over: Partial<ArgoEvent> = {}): ArgoEvent => ({
    at, server: URL, namespace: "argocd", app: "web", kind: "operation", from: null, to: null, revision: SHA, phase: "Failed",
    startedAt: "2026-10-30T09:58:30Z", finishedAt: "2026-10-30T10:00:00Z", initiatedBy: "bob", message: "hook failed", ...over,
  });
  events.mockResolvedValue([ev("2026-10-30T10:00:00Z"), ev("2026-10-30T11:00:00Z", { phase: "Succeeded", message: "ok", initiatedBy: "automated", startedAt: "2026-10-30T10:59:00Z", finishedAt: "2026-10-30T11:00:00Z" }), ev("2026-10-30T11:30:00Z", { app: "other" })]);
  open();
  const table = await screen.findByRole("table", { name: HIST_LOCAL });
  const rows = within(table).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell").map((c) => c.textContent));
  expect(rows).toEqual([
    ["1h", "Succeeded", "0123456", "자동", "1분 0초", "ok"],
    ["2h", "Failed", "0123456", "bob", "1분 30초", "hook failed"],
  ]);
  expect(events).toHaveBeenCalledWith(URL, null);
});

test("without local records it says so, and a failed history read does not hide them", async () => {
  read.history.mockRejectedValue({ kind: "other", message: "history unavailable" });
  open();
  expect(await screen.findByText("history unavailable")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText(HIST_NO_LOCAL)).toBeInTheDocument());
});
