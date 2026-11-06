import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithClient } from "../../test/utils";
import { argocdApi } from "../api";
import { argoKeys } from "../queries";
import { MAP_TEXT } from "../text";
import type { ArgoApp } from "../types";
import { AppMaps } from "./AppMaps";

vi.mock("../api", () => ({ argocdApi: { apps: vi.fn(), appsets: vi.fn(), events: vi.fn() } }));
vi.mock("../detail/queries", () => ({ useAppHistory: () => ({ data: [] }) }));

test("app timeline includes new events without changing its query boundary", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-05T10:00:00Z"));
  vi.mocked(argocdApi.apps).mockResolvedValue([{ name: "api", namespace: "argocd", resourceVersion: "1", labels: {}, values: {} }]);
  vi.mocked(argocdApi.events).mockResolvedValue([]);
  const app = { name: "api", namespace: "argocd", appSet: null, history: [], resources: [] } as unknown as ArgoApp;
  const { qc } = renderWithClient(<AppMaps url="server" app={app} version="1" live={false} nodes={[]} onApp={() => {}} onResource={() => {}} />);
  fireEvent.click(screen.getByRole("tab", { name: MAP_TEXT.timeline }));
  await waitFor(() => expect(argocdApi.events).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(qc.getQueryCache().find({ queryKey: argoKeys.events("server"), exact: false })?.state.status).toBe("success"));
  const key = qc.getQueryCache().find({ queryKey: argoKeys.events("server"), exact: false })!.queryKey;
  clock.mockReturnValue(Date.parse("2026-11-05T11:00:00Z"));
  act(() => qc.setQueryData(key, [{ at: "2026-11-05T10:30:00Z", server: "server", namespace: "argocd", app: "api", kind: "operation", from: null, to: null, revision: "abc", phase: "Succeeded", startedAt: "2026-11-05T10:30:00Z", finishedAt: "2026-11-05T10:31:00Z", initiatedBy: null, message: null }]));
  expect(await screen.findByTitle(/abc/)).toBeInTheDocument();
  expect(argocdApi.events).toHaveBeenCalledTimes(1);
  clock.mockRestore();
});
