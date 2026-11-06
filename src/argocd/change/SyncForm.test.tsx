import { fireEvent, screen, within } from "@testing-library/react";
import { renderWithClient } from "../../test/utils";
import { readApi } from "../detail/api";
import type { ArgoApp } from "../types";
import { SyncForm } from "./SyncForm";

vi.mock("../detail/api", () => ({ readApi: { history: vi.fn(), appDiff: vi.fn() } }));
const read = vi.mocked(readApi);
const r = (kind: string, name: string, status: string) => ({ group: kind === "Deployment" ? "apps" : "", version: "v1", kind, namespace: "web", name, status, hook: false, requiresPruning: false });
const app = { name: "web", namespace: "argocd", sources: [{}], resources: [r("Deployment", "web", "OutOfSync"), r("Service", "web-svc", "Synced"), r("ConfigMap", "cfg", "OutOfSync")] } as unknown as ArgoApp;
const row = (name: string, kind: string, changed: boolean) => ({ res: { group: "", version: "v1", kind, namespace: "web", name, uid: null }, syncStatus: "OutOfSync", health: null, hook: false, live: "", target: "", changed, diff: { rows: [], hunks: [], stats: { added: 1, removed: 0, changed: 0 } } });

beforeEach(() => {
  vi.resetAllMocks();
  read.history.mockResolvedValue([{ id: 2, deployedAt: null, deployStartedAt: null, initiatedBy: null, revisions: [{ revision: "abcdef0123", sourceIndex: 0, repoUrl: null, chart: null, path: null, targetRevision: null, metadata: { author: null, date: null, message: "ship it", tags: [], signatureInfo: null }, chartDetails: null, oci: null }] }]);
  read.appDiff.mockResolvedValue([row("web", "Deployment", true), row("cfg", "ConfigMap", true), row("web-svc", "Service", false)]);
});
const open = (onPreview = vi.fn()) => {
  renderWithClient(<SyncForm url="https://argocd.example" app={app} version="1" onCancel={vi.fn()} onPreview={onPreview} />);
  return onPreview;
};

test("selected resources, a recent revision, options and retry all end up in the change", async () => {
  const onPreview = open();
  fireEvent.click(await screen.findByRole("button", { name: /abcdef0/ }));
  fireEvent.click(screen.getByRole("button", { name: "OutOfSync만 선택" }));
  fireEvent.click(screen.getByLabelText("불필요한 리소스 삭제"));
  fireEvent.click(screen.getByLabelText("서버 측 적용"));
  fireEvent.change(screen.getByLabelText("재시도 횟수"), { target: { value: "3" } });
  fireEvent.change(screen.getByLabelText("재시도 대기 시간"), { target: { value: "10s" } });
  fireEvent.click(screen.getByRole("button", { name: "미리 보기" }));
  const change = onPreview.mock.calls[0][0];
  expect(change).toMatchObject({ kind: "sync", revision: "abcdef0123", prune: true, serverSideApply: true, retry: { limit: 3, backoff: { duration: "10s" } } });
  expect(change.resources.map((x: { name: string }) => x.name)).toEqual(["web", "cfg"]);
});

test("the embedded diff narrows to the selected resources and an invalid retry blocks the preview", async () => {
  open();
  const diff = await screen.findByRole("region", { name: "적용될 변경" });
  expect(await within(diff).findByText("cfg")).toBeInTheDocument();
  expect(within(diff).getByText("Deployment")).toBeInTheDocument();
  expect(within(diff).getByText("cfg")).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("web 선택"));
  expect(within(diff).queryByText("cfg")).toBeNull();
  fireEvent.change(screen.getByLabelText("재시도 횟수"), { target: { value: "-2" } });
  expect(screen.getByRole("button", { name: "미리 보기" })).toBeDisabled();
});
