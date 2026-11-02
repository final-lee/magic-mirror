import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../test/utils";
import { k8sApi } from "./api";
import { ChangeLog } from "./ChangeLog";
import { DEPLOYMENTS } from "./kinds";
import { CHANGE_UNDO } from "./text";
import type { K8sChange } from "./types";

vi.mock("./api", () => ({ k8sApi: { changeLog: vi.fn(), undo: vi.fn() } }));
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
