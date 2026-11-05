import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithClient } from "../../test/utils";
import { changeApi } from "../change/api";
import type { ArgoApp, ResRef } from "../types";
import { ActionsTab } from "./ActionsTab";
import { opsApi } from "./api";

vi.mock("./api", () => ({ opsApi: { resourceActions: vi.fn(), kubeContexts: vi.fn() } }));
vi.mock("../change/api", () => ({ changeApi: { can: vi.fn(), preview: vi.fn(), apply: vi.fn() } }));
const ops = vi.mocked(opsApi);
const change = vi.mocked(changeApi);
const target = { namespace: "argocd", name: "web", project: "default", env: null };
const res: ResRef = { group: "apps", version: "v1", kind: "Deployment", namespace: "web", name: "web", uid: null };
const app = { destination: { server: null, name: null, namespace: null, inCluster: false } } as ArgoApp;
const PREVIEW = { title: "t", calls: [], diff: null, impact: [], warnings: [], blocked: null, confirmName: null, expectedVersion: "1" };

function open(allowed: boolean[]) {
  // can: [update, delete] 먼저, 그다음 액션별
  change.can.mockImplementation(async (_u, checks) => checks.map((c) => (c.action === "update" || c.action === "delete" ? allowed[0] : allowed[1])));
  renderWithClient(<ActionsTab url="https://argocd.example" app={app} target={target} version="1" res={res} containers={[]} onTokenError={vi.fn()} />);
}
beforeEach(() => {
  vi.resetAllMocks();
  change.preview.mockResolvedValue(PREVIEW);
  ops.resourceActions.mockResolvedValue([
    { name: "restart", displayName: "Restart", disabled: false, iconClass: null, params: [] },
    { name: "scale", displayName: "Scale", disabled: false, iconClass: null, params: [{ name: "replicas", value: null, kind: "number", default: "1" }, { name: "note", value: null, kind: null, default: null }] },
    { name: "pause", displayName: "Pause", disabled: true, iconClass: null, params: [] },
  ]);
});

test("an action without params goes straight to the change preview", async () => {
  open([true, true]);
  const run = await screen.findByRole("button", { name: "Restart 실행" });
  await waitFor(() => expect(run).toBeEnabled());
  fireEvent.click(run);
  await waitFor(() => expect(change.preview).toHaveBeenCalledWith("https://argocd.example", target, { kind: "resourceAction", res, action: "restart", params: [] }));
});

test("an action with params asks for them, starts from the server's default and drops empty ones", async () => {
  open([true, true]);
  const run = await screen.findByRole("button", { name: "Scale 실행" });
  await waitFor(() => expect(run).toBeEnabled());
  fireEvent.click(run);
  fireEvent.change(screen.getByLabelText("replicas"), { target: { value: "4" } });
  fireEvent.click(screen.getByRole("button", { name: "미리 보기" }));
  await waitFor(() => expect(change.preview).toHaveBeenCalledWith("https://argocd.example", target, { kind: "resourceAction", res, action: "scale", params: [{ name: "replicas", value: "4" }] }));
});

test("delete sends the chosen force and orphan options; patch sends the patch type for a built-in kind", async () => {
  open([true, true]);
  const del = await screen.findByRole("button", { name: "리소스 삭제…" });
  await waitFor(() => expect(del).toBeEnabled());
  fireEvent.click(del);
  fireEvent.click(screen.getByLabelText("강제 삭제"));
  fireEvent.click(screen.getByLabelText("하위 리소스 남기기"));
  fireEvent.click(screen.getByRole("button", { name: "미리 보기" }));
  await waitFor(() => expect(change.preview).toHaveBeenCalledWith("https://argocd.example", target, { kind: "resourceDelete", res, force: true, orphan: true }));
});

test("without permission every write is disabled, and a server-disabled action stays disabled", async () => {
  open([false, false]);
  expect(await screen.findByRole("button", { name: "Restart 실행" })).toBeDisabled();
  await waitFor(() => expect(change.can).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("button", { name: "패치 편집…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "리소스 삭제…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Pause 실행" })).toBeDisabled();
});
