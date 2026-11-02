import { invoke } from "../api/invoke";
import { argocdApi } from "./api";

vi.mock("../api/invoke", () => ({ invoke: vi.fn() }));
const m = vi.mocked(invoke);

beforeEach(() => {
  m.mockReset();
  m.mockResolvedValue(null);
});

const URL = "https://argocd.example";

test.each([
  ["setToken", () => argocdApi.setToken(URL, "tok"), "argocd_set_token", { url: URL, token: "tok" }],
  ["forgetToken", () => argocdApi.forgetToken(URL), "argocd_forget_token", { url: URL }],
  ["session", () => argocdApi.session(URL), "argocd_session", { url: URL }],
  ["apps", () => argocdApi.apps(URL), "argocd_apps", { url: URL }],
  ["appsets", () => argocdApi.appsets(URL), "argocd_appsets", { url: URL }],
  ["app", () => argocdApi.app(URL, "argocd", "web"), "argocd_app", { url: URL, namespace: "argocd", name: "web" }],
  ["tree", () => argocdApi.tree(URL, "argocd", "web"), "argocd_tree", { url: URL, namespace: "argocd", name: "web" }],
  ["refresh", () => argocdApi.refresh(URL, "argocd", "web", true), "argocd_refresh", { url: URL, namespace: "argocd", name: "web", hard: true }],
  [
    "sync",
    () => argocdApi.sync(URL, "argocd", "web", { prune: true, dryRun: false }),
    "argocd_sync",
    { url: URL, namespace: "argocd", name: "web", options: { prune: true, dryRun: false } },
  ],
])("%s calls its command with exactly these arguments and no AWS profile", async (_name, call, command, args) => {
  await call();
  expect(m).toHaveBeenCalledTimes(1);
  expect(m).toHaveBeenCalledWith(command, args);
  expect(Object.keys(m.mock.calls[0][1] as object)).not.toContain("profile");
});
