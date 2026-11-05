import { fireEvent, screen } from "@testing-library/react";
import { renderWithClient } from "../../test/utils";
import { readApi } from "../detail/api";
import type { ArgoHistoryEntry } from "../types";
import { RollbackForm } from "./RollbackForm";

vi.mock("../detail/api", () => ({ readApi: { manifestsDiff: vi.fn() } }));
const read = vi.mocked(readApi);
const rev = (revision: string) => ({ revision, sourceIndex: 0, repoUrl: null, chart: null, path: null, targetRevision: null, metadata: { author: null, date: null, message: "fix probe", tags: [], signatureInfo: null }, chartDetails: null, oci: null });
const entry = (id: number, revision: string): ArgoHistoryEntry => ({ id, deployedAt: null, deployStartedAt: null, initiatedBy: null, revisions: [rev(revision)] });
const DIFF = { rows: [], hunks: [], stats: { added: 1, removed: 0, changed: 0 } };

function open(autoSync: boolean, onPreview = vi.fn()) {
  renderWithClient(<RollbackForm url="https://argocd.example" namespace="argocd" name="web" entry={entry(5, "old")} current={entry(7, "new")} autoSync={autoSync} onCancel={vi.fn()} onPreview={onPreview} />);
  return onPreview;
}
beforeEach(() => {
  vi.resetAllMocks();
  read.manifestsDiff.mockResolvedValue(DIFF);
});

test("shows the target revision's metadata and compares the current deployment with it", async () => {
  open(false);
  expect(await screen.findByText(/fix probe/)).toBeInTheDocument();
  expect(read.manifestsDiff).toHaveBeenCalledWith("https://argocd.example", "argocd", "web", ["new"], ["old"]);
});

test("without auto-sync there is no choice and the rollback keeps auto-sync untouched", () => {
  const onPreview = open(false);
  expect(screen.queryByLabelText("자동 동기화 끄고 롤백")).toBeNull();
  fireEvent.click(screen.getByLabelText("대상 리비전에 없는 리소스 삭제"));
  fireEvent.click(screen.getByRole("button", { name: "미리 보기" }));
  expect(onPreview).toHaveBeenCalledWith({ kind: "rollback", id: 5, prune: true, dryRun: false, disableAutoSync: false });
});

test("with auto-sync on, the rollback waits for the 'disable auto-sync' choice and sends it", () => {
  const onPreview = open(true);
  const go = screen.getByRole("button", { name: "미리 보기" });
  expect(go).toBeDisabled();
  fireEvent.click(screen.getByLabelText("자동 동기화 끄고 롤백"));
  expect(go).toBeEnabled();
  fireEvent.click(go);
  expect(onPreview).toHaveBeenCalledWith({ kind: "rollback", id: 5, prune: false, dryRun: false, disableAutoSync: true });
});
