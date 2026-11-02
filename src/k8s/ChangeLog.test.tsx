import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../test/utils";
import { k8sApi } from "./api";
import { ChangeDialog, useK8sChange } from "./ChangeFlow";
import { ChangeLog } from "./ChangeLog";
import { DEPLOYMENTS } from "./kinds";
import { CHANGE_UNDO } from "./text";
import type { K8sChange } from "./types";

vi.mock("./api", () => ({ k8sApi: { changeLog: vi.fn(), undo: vi.fn(), preview: vi.fn(), apply: vi.fn() } }));
const target = { profile: "p", region: "r", cluster: "c" };
const change: K8sChange = { kind: DEPLOYMENTS, namespace: "default", name: "web", type: "scale", replicas: 2 };

test("history is scoped to the cluster and undo prepares a preview only in change mode", async () => {
  vi.mocked(k8sApi.changeLog).mockResolvedValue([{ id: "one", at: "2026-10-30T11:00:00Z", target, change, summary: "scale web", ok: true, error: null, inverse: change, undoOf: null, undone: false }, { id: "two", at: "2026-10-30T11:00:00Z", target: { ...target, cluster: "other" }, change, summary: "other cluster", ok: true, error: null, inverse: change, undoOf: null, undone: false }]);
  vi.mocked(k8sApi.undo).mockResolvedValue({ target, change });
  const onStart = vi.fn();
  const qc = newQueryClient();
  const renderView = (mode: boolean) => withClientAndSso(<ChangeLog target={target} onStart={onStart} changeMode={mode} />, qc, ssoLoginStub());
  const { rerender } = render(renderView(false));
  expect(await screen.findByText("scale web")).toBeInTheDocument();
  expect(screen.queryByText("other cluster")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: CHANGE_UNDO })).not.toBeInTheDocument();
  rerender(renderView(true));
  fireEvent.click(screen.getByRole("button", { name: CHANGE_UNDO }));
  await waitFor(() => expect(onStart).toHaveBeenCalledWith(change, "one"));
});

/** 되돌리기가 일반 변경 미리보기와 적용을 거치는 화면이다. */
function HistoryFlow() {
  const flow = useK8sChange(target, "p", () => {});
  return (
    <>
      <ChangeLog target={target} onStart={flow.start} changeMode />
      {flow.pending && <ChangeDialog pending={flow.pending} apply={flow.apply} retry={flow.retry} cancel={flow.cancel} />}
    </>
  );
}

test("undo opens the shared preview and sends undoOf when applied", async () => {
  vi.mocked(k8sApi.changeLog).mockResolvedValue([
    { id: "one", at: "2026-10-30T11:00:00Z", target, change, summary: "scale web", ok: true,
      error: null, inverse: change, undoOf: null, undone: false },
    { id: "two", at: "2026-10-30T11:00:00Z", target, change, summary: "irreversible", ok: true,
      error: null, inverse: null, undoOf: null, undone: false },
    { id: "three", at: "2026-10-30T11:00:00Z", target, change, summary: "undone", ok: true,
      error: null, inverse: change, undoOf: null, undone: true },
  ]);
  vi.mocked(k8sApi.undo).mockResolvedValue({ target, change });
  vi.mocked(k8sApi.preview).mockResolvedValue({
    calls: [], diff: [], impact: [], warnings: [], confirmName: null, reversible: true,
  });
  vi.mocked(k8sApi.apply).mockResolvedValue({ logId: "new" });
  render(withClientAndSso(<HistoryFlow />, newQueryClient(), ssoLoginStub()));
  const buttons = await screen.findAllByRole("button", { name: CHANGE_UNDO });
  expect(buttons).toHaveLength(1);
  fireEvent.click(buttons[0]);
  expect(await screen.findByRole("dialog", { name: "되돌리기 미리보기" })).toBeInTheDocument();
  expect(k8sApi.preview).toHaveBeenCalledWith(target, change, "p");
  fireEvent.click(screen.getByRole("button", { name: "적용" }));
  await waitFor(() => expect(k8sApi.apply).toHaveBeenCalledWith(target, change, null, "one", "p"));
});
