import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { argocdApi } from "./api";
import { ArgoView } from "./ArgoView";
import {
  ARGO_ALL_PROJECTS, ARGO_GROUP_BY_SET, ARGO_HEALTH_GROUP, ARGO_IN_CLUSTER, ARGO_NO_APPS, ARGO_NO_MATCH, ARGO_PROJECT, ARGO_SEARCH, ARGO_SYNC_GROUP,
  ARGO_UNGROUPED, LOADING, TOKEN_INVALID, TOKEN_MISSING, argoAppCount,
} from "./text";
import type { ArgoApp, ArgoAppRow, ArgoAppSetRow } from "./types";

vi.mock("./api", () => ({ argocdApi: { apps: vi.fn(), appsets: vi.fn(), app: vi.fn(), tree: vi.fn(), refresh: vi.fn(), sync: vi.fn() } }));
const m = vi.mocked(argocdApi);
const URL = "https://argocd.example";
const NOW = Date.parse("2026-10-30T12:00:00Z");

const appRow = (name: string, values: Record<string, string> = {}): ArgoAppRow => ({
  name,
  namespace: "argocd",
  resourceVersion: "1",
  values: { sync: "Synced", health: "Healthy", project: "default", destination: "in-cluster", destNamespace: "web", revision: "0123456", ...values },
});
const setRow = (name: string, over: Partial<ArgoAppSetRow> = {}): ArgoAppSetRow => ({ name, namespace: "argocd", status: null, message: null, generators: [], ...over });

function setup(apps: ArgoAppRow[], sets: ArgoAppSetRow[] = [], props: Partial<Parameters<typeof ArgoView>[0]> = {}) {
  m.apps.mockResolvedValue(apps);
  m.appsets.mockResolvedValue(sets);
  const onTokenError = vi.fn();
  renderWithClient(<ArgoView url={URL} live onTokenError={onTokenError} now={NOW} {...props} />);
  return { onTokenError };
}
async function ready(apps: ArgoAppRow[], sets: ArgoAppSetRow[] = []) {
  const h = setup(apps, sets);
  await screen.findByRole("table");
  return h;
}

beforeEach(() => {
  vi.resetAllMocks();
  m.app.mockReturnValue(new Promise<ArgoApp>(() => {}));
  m.tree.mockReturnValue(new Promise(() => {}));
});

const names = () => Array.from(document.querySelectorAll("tr.argo-row")).map((r) => r.querySelector("td")?.firstChild?.textContent);
const headers = () => Array.from(document.querySelectorAll("tr.argo-group")).map((r) => r.querySelector("b")?.textContent);
const chip = (group: string, status: string) => within(screen.getByRole("group", { name: group })).getByRole("button", { name: new RegExp(`^${status}\\b`) });

test("reads this server's applications and ApplicationSets, and says it is loading first", async () => {
  setup([appRow("a")]);
  expect(screen.getByText(LOADING)).toBeInTheDocument();
  await screen.findByRole("table");
  expect(m.apps).toHaveBeenCalledWith(URL);
  expect(m.appsets).toHaveBeenCalledWith(URL);
});

describe("rows", () => {
  test("the table shows the app's columns with errors and warnings counted", async () => {
    await ready([appRow("web", { sync: "OutOfSync", health: "Progressing", operation: "Failed", lastSync: "2026-10-30T11:00:00Z", autoSync: "true", targetRevision: "main", errors: "2", warnings: "1" })]);
    const cells = within(document.querySelector("tr.argo-row") as HTMLElement).getAllByRole("cell");
    expect(cells.map((c) => c.textContent)).toEqual(["web오류 2경고 1", "default", `${ARGO_IN_CLUSTER}/web`, "OutOfSync", "Progressing", "Failed", "0123456", "1h", "켜짐"]);
    expect(cells[6]).toHaveAttribute("title", "main");
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["이름", "프로젝트", "대상", "Sync", "Health", "작업", "Revision", "마지막 동기화", "자동"]);
  });

  test("auto sync off is shown, and a missing value leaves the cell empty", async () => {
    await ready([appRow("off", { autoSync: "false" }), appRow("none")]);
    const auto = (n: string) => within(screen.getByText(n).closest("tr") as HTMLElement).getAllByRole("cell")[8].textContent;
    expect(auto("off")).toBe("꺼짐");
    expect(auto("none")).toBe("");
  });

  test("the cluster this ArgoCD runs in is labeled, by name or server; other clusters keep their name", async () => {
    await ready([
      appRow("by-name", { destination: "in-cluster" }),
      appRow("by-server", { destination: "https://kubernetes.default.svc", destNamespace: "db" }),
      appRow("remote", { destination: "x-dev2-cluster", destNamespace: "x" }),
      appRow("no-ns", { destination: "other", destNamespace: "" }),
    ]);
    const dest = (n: string) => within(screen.getByText(n).closest("tr") as HTMLElement).getAllByRole("cell")[2].textContent;
    expect(dest("by-name")).toBe(`${ARGO_IN_CLUSTER}/web`);
    expect(dest("by-server")).toBe(`${ARGO_IN_CLUSTER}/db`);
    expect(dest("remote")).toBe("x-dev2-cluster/x");
    expect(dest("no-ns")).toBe("other");
  });

  test("badge colors: Synced and Healthy green, OutOfSync and Progressing yellow, Degraded and Failed red, others dim", async () => {
    await ready([appRow("a"), appRow("b", { sync: "OutOfSync", health: "Degraded", operation: "Failed" }), appRow("c", { sync: "Unknown", health: "Suspended", operation: "Running" }), appRow("d", { health: "Progressing", operation: "Succeeded" })]);
    const badge = (t: string, i = 0) => screen.getAllByText(t, { selector: ".argo-badge" })[i];
    expect(badge("Synced")).toHaveClass("argo-ok");
    expect(badge("Healthy")).toHaveClass("argo-ok");
    expect(badge("Succeeded")).toHaveClass("argo-ok");
    expect(badge("OutOfSync")).toHaveClass("argo-warn");
    expect(badge("Progressing")).toHaveClass("argo-warn");
    expect(badge("Running")).toHaveClass("argo-warn");
    expect(badge("Degraded")).toHaveClass("argo-bad");
    expect(badge("Failed")).toHaveClass("argo-bad");
    expect(badge("Suspended")).toHaveClass("argo-dim");
    expect(badge("Unknown")).toHaveClass("argo-dim");
  });
});

describe("filtering", () => {
  const APPS = [
    appRow("a-ok"),
    appRow("b-out", { sync: "OutOfSync" }),
    appRow("c-degraded", { health: "Degraded" }),
    appRow("d-out-prog", { sync: "OutOfSync", health: "Progressing" }),
    appRow("e-unknown", { sync: "Unknown", health: "Unknown" }),
    appRow("f-nosync", { sync: "", health: "Healthy" }),
  ];

  test("chips count apps; several chips of one group are OR, the two groups are AND", async () => {
    await ready(APPS);
    expect(chip(ARGO_SYNC_GROUP, "Synced")).toHaveTextContent("Synced 2");
    expect(chip(ARGO_SYNC_GROUP, "OutOfSync")).toHaveTextContent("OutOfSync 2");
    expect(chip(ARGO_SYNC_GROUP, "Unknown")).toHaveTextContent("Unknown 2");
    expect(chip(ARGO_HEALTH_GROUP, "Healthy")).toHaveTextContent("Healthy 3");
    expect(chip(ARGO_HEALTH_GROUP, "Degraded")).toHaveTextContent("Degraded 1");
    expect(names()).toHaveLength(6);

    // 같은 묶음 안에서는 합집합
    fireEvent.click(chip(ARGO_SYNC_GROUP, "OutOfSync"));
    fireEvent.click(chip(ARGO_SYNC_GROUP, "Unknown"));
    expect(chip(ARGO_SYNC_GROUP, "OutOfSync")).toHaveAttribute("aria-pressed", "true");
    expect([...names()].sort()).toEqual(["b-out", "d-out-prog", "e-unknown", "f-nosync"]);
    // 다른 묶음과는 교집합
    fireEvent.click(chip(ARGO_HEALTH_GROUP, "Progressing"));
    fireEvent.click(chip(ARGO_HEALTH_GROUP, "Unknown"));
    expect([...names()].sort()).toEqual(["d-out-prog", "e-unknown"]);
    // 칩을 다시 누르면 풀리고, 하나도 안 고르면 전부
    fireEvent.click(chip(ARGO_HEALTH_GROUP, "Progressing"));
    expect(names()).toEqual(["e-unknown"]);
    fireEvent.click(chip(ARGO_HEALTH_GROUP, "Unknown"));
    fireEvent.click(chip(ARGO_SYNC_GROUP, "OutOfSync"));
    fireEvent.click(chip(ARGO_SYNC_GROUP, "Unknown"));
    expect(names()).toHaveLength(6);
  });

  test("picking chips never changes the chip counts", async () => {
    await ready(APPS);
    const counts = () => screen.getAllByRole("button", { name: /\d$/ }).map((b) => b.textContent);
    const before = counts();
    fireEvent.click(chip(ARGO_SYNC_GROUP, "OutOfSync"));
    fireEvent.click(chip(ARGO_HEALTH_GROUP, "Degraded"));
    expect(names()).toEqual([]);
    expect(counts()).toEqual(before);
  });

  test("a filter that matches nothing says so", async () => {
    await ready([appRow("a")]);
    fireEvent.click(chip(ARGO_HEALTH_GROUP, "Missing"));
    expect(screen.getByText(ARGO_NO_MATCH)).toBeInTheDocument();
  });

  test("project select and name search narrow the list and the chip counts", async () => {
    await ready([appRow("web-a", { project: "prod" }), appRow("web-b", { project: "dev", sync: "OutOfSync" }), appRow("db", { project: "prod" })]);
    const select = screen.getByRole("combobox", { name: ARGO_PROJECT });
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([ARGO_ALL_PROJECTS, "dev", "prod"]);
    expect(chip(ARGO_SYNC_GROUP, "OutOfSync")).toHaveTextContent("OutOfSync 1");
    fireEvent.change(select, { target: { value: "prod" } });
    expect([...names()].sort()).toEqual(["db", "web-a"]);
    expect(chip(ARGO_SYNC_GROUP, "OutOfSync")).toHaveTextContent("OutOfSync 0");
    fireEvent.change(screen.getByRole("textbox", { name: ARGO_SEARCH }), { target: { value: "WEB" } });
    expect(names()).toEqual(["web-a"]);
    expect(chip(ARGO_SYNC_GROUP, "Synced")).toHaveTextContent("Synced 1");
  });
});

describe("grouping by ApplicationSet", () => {
  test("headers show generators, the Error message and the count; the rest go last; Error, then problem groups, then by name", async () => {
    await ready(
      [appRow("web-a", { appSet: "web" }), appRow("web-b", { appSet: "web", sync: "OutOfSync" }), appRow("db-a", { appSet: "db" }), appRow("solo"), appRow("orphan", { appSet: "gone" })],
      [
        setRow("web", { generators: ["list", "git"], status: "Error", message: "generator failed: no repo" }),
        setRow("db", { generators: ["clusters"], status: "UpToDate" }),
        setRow("empty", { generators: ["list"], status: "Error", message: "boom" }),
      ],
    );
    // 오류 난 ApplicationSet이 맨 앞(앱 없는 empty도), 그 다음 문제 앱이 없는 묶음은 이름 순, 마지막이 ApplicationSet 없음
    expect(headers()).toEqual(["empty", "web", "db", "gone", ARGO_UNGROUPED]);
    const groups = Array.from(document.querySelectorAll("tr.argo-group")) as HTMLElement[];
    expect(within(groups[1]).getByText("generator: list, git")).toBeInTheDocument();
    expect(within(groups[1]).getByText("Error")).toHaveClass("argo-bad");
    expect(within(groups[1]).getByText("generator failed: no repo")).toBeInTheDocument();
    expect(within(groups[1]).getByText(argoAppCount(2))).toBeInTheDocument();
    expect(within(groups[2]).getByText("UpToDate")).toHaveClass("argo-ok");
    expect(within(groups[2]).getByText("generator: clusters")).toBeInTheDocument();
    // 앱 없는 ApplicationSet도 보인다
    expect(within(groups[0]).getByText("boom")).toBeInTheDocument();
    expect(within(groups[0]).getByText(argoAppCount(0))).toBeInTheDocument();
    // 목록에 없는 ApplicationSet(gone)은 이름만, 앱 없는 묶음은 마지막
    expect(within(groups[3]).getByText(argoAppCount(1))).toBeInTheDocument();
    expect(within(groups[4]).getByText(argoAppCount(1))).toBeInTheDocument();
    // 묶음 순서대로 앱이 따라오고, 묶음 안에서는 문제 앱이 먼저
    expect(names()).toEqual(["web-b", "web-a", "db-a", "orphan", "solo"]);
  });

  test("a group with a problem app comes before a clean one", async () => {
    await ready([appRow("a1", { appSet: "aaa" }), appRow("z1", { appSet: "zzz", health: "Degraded" })], [setRow("aaa"), setRow("zzz")]);
    expect(headers()).toEqual(["zzz", "aaa"]);
  });

  test("an ApplicationSet with no apps shows only while no filter is set", async () => {
    await ready([appRow("web-a", { appSet: "web" }), appRow("db-a", { appSet: "db", sync: "OutOfSync" }), appRow("solo")], [setRow("web"), setRow("db"), setRow("empty")]);
    // db는 문제 앱이 있어 앞, 나머지는 이름 순(앱 없는 empty도 보인다)
    expect(headers()).toEqual(["db", "empty", "web", ARGO_UNGROUPED]);
    fireEvent.click(chip(ARGO_SYNC_GROUP, "OutOfSync"));
    expect(headers()).toEqual(["db"]);
    fireEvent.click(chip(ARGO_SYNC_GROUP, "OutOfSync"));
    fireEvent.change(screen.getByRole("textbox", { name: ARGO_SEARCH }), { target: { value: "a" } });
    expect(headers()).not.toContain("empty");
  });

  test("the toggle flattens the list into one problem-first run", async () => {
    await ready([appRow("web-a", { appSet: "web" }), appRow("db-a", { appSet: "db", sync: "OutOfSync" }), appRow("solo")], [setRow("web"), setRow("db")]);
    fireEvent.click(screen.getByRole("checkbox", { name: ARGO_GROUP_BY_SET }));
    expect(headers()).toEqual([]);
    expect(names()).toEqual(["db-a", "solo", "web-a"]);
    fireEvent.click(screen.getByRole("checkbox", { name: ARGO_GROUP_BY_SET }));
    expect(headers()).toHaveLength(3);
  });

  test("grouping is on by default", async () => {
    await ready([appRow("a")]);
    expect(screen.getByRole("checkbox", { name: ARGO_GROUP_BY_SET })).toBeChecked();
    expect(headers()).toEqual([ARGO_UNGROUPED]);
  });
});

test("problem apps come first: out of sync, not healthy, with errors, or a failed operation", async () => {
  await ready([
    appRow("aa-fine"),
    appRow("bb-sync", { sync: "OutOfSync" }),
    appRow("cc-health", { health: "Degraded" }),
    appRow("dd-errors", { errors: "1" }),
    appRow("ee-failed", { operation: "Failed" }),
    appRow("ee2-error", { operation: "Error" }),
    appRow("ff-nohealth", { health: "" }),
    appRow("zz-fine"),
    appRow("yy-warn-only", { warnings: "3" }),
  ]);
  fireEvent.click(screen.getByRole("checkbox", { name: ARGO_GROUP_BY_SET }));
  expect(names()).toEqual(["bb-sync", "cc-health", "dd-errors", "ee-failed", "ee2-error", "ff-nohealth", "aa-fine", "yy-warn-only", "zz-fine"]);
});

describe("detail", () => {
  test("a row opens the detail for that app with its resourceVersion; clicking it again closes it", async () => {
    await ready([{ ...appRow("web"), resourceVersion: "42" }, appRow("db")]);
    fireEvent.click(screen.getByText("web"));
    await waitFor(() => expect(m.app).toHaveBeenCalledWith(URL, "argocd", "web"));
    expect(screen.getByRole("complementary", { name: "Application 상세" })).toHaveTextContent("argocd/web");
    expect(document.querySelector("tr.argo-row.on")).toHaveTextContent("web");
    fireEvent.click(screen.getByText("web", { selector: "td" }));
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  test("Enter on a focused row opens it too, and another row switches the detail", async () => {
    await ready([appRow("web"), appRow("db")]);
    fireEvent.keyDown(screen.getByText("web").closest("tr") as HTMLElement, { key: "Enter" });
    expect(await screen.findByRole("complementary")).toHaveTextContent("argocd/web");
    fireEvent.click(screen.getByText("db", { selector: "td" }));
    expect(screen.getByRole("complementary")).toHaveTextContent("argocd/db");
  });

  test("the close button closes it", async () => {
    await ready([appRow("web")]);
    fireEvent.click(screen.getByText("web"));
    fireEvent.click(await screen.findByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("complementary")).toBeNull();
  });
});

describe("empty and error states", () => {
  test("no applications says so", async () => {
    setup([]);
    expect(await screen.findByText(ARGO_NO_APPS)).toBeInTheDocument();
  });

  test("a list error is shown instead of the empty state, and Retry reads it again", async () => {
    m.apps.mockRejectedValueOnce({ kind: "other", message: "connection reset" });
    m.appsets.mockResolvedValue([]);
    const onTokenError = vi.fn();
    renderWithClient(<ArgoView url={URL} live onTokenError={onTokenError} now={NOW} />);
    expect(await screen.findByText("connection reset")).toBeInTheDocument();
    expect(screen.queryByText(ARGO_NO_APPS)).toBeNull();
    expect(onTokenError).not.toHaveBeenCalled();
    m.apps.mockResolvedValue([appRow("back")]);
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("back")).toBeInTheDocument();
    expect(screen.queryByText("connection reset")).toBeNull();
  });

  test("an ApplicationSet failure does not hide the applications", async () => {
    m.apps.mockResolvedValue([appRow("web")]);
    m.appsets.mockRejectedValue({ kind: "other", message: "appsets forbidden" });
    renderWithClient(<ArgoView url={URL} live onTokenError={vi.fn()} now={NOW} />);
    expect(await screen.findByText("appsets forbidden")).toBeInTheDocument();
    expect(screen.getByText("web")).toBeInTheDocument();
  });

  test.each([TOKEN_INVALID, TOKEN_MISSING])("a token error from the applications query is reported with its message (%s)", async (message) => {
    m.apps.mockRejectedValue({ kind: "other", message });
    m.appsets.mockResolvedValue([]);
    const onTokenError = vi.fn();
    renderWithClient(<ArgoView url={URL} live onTokenError={onTokenError} now={NOW} />);
    await waitFor(() => expect(onTokenError).toHaveBeenCalledWith(message));
  });

  test("a token error from the ApplicationSet query is reported too", async () => {
    m.apps.mockResolvedValue([appRow("web")]);
    m.appsets.mockRejectedValue({ kind: "other", message: TOKEN_INVALID });
    const onTokenError = vi.fn();
    renderWithClient(<ArgoView url={URL} live onTokenError={onTokenError} now={NOW} />);
    await waitFor(() => expect(onTokenError).toHaveBeenCalledWith(TOKEN_INVALID));
  });
});
