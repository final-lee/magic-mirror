import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { dispatchKey } from "../keymap/registry";
import { renderWithClient } from "../test/utils";
import { argocdApi } from "./api";
import { ArgoView } from "./ArgoView";
import {
  ARGO_APPS_LABEL, ARGO_CLUSTER_FILTER, ARGO_ENV_GROUP, ARGO_ENV_SOURCE, ARGO_GROUP_BY, ARGO_GROUP_THEN, ARGO_HEALTH_GROUP, ARGO_IN_CLUSTER, ARGO_LABEL_FILTER, ARGO_NO_APPS,
  ARGO_NO_CLUSTER, ARGO_NO_LABEL, ARGO_NO_MATCH, ARGO_PICK_CLEAR, ARGO_PROJECT, ARGO_SYNC_GROUP, ARGO_UNGROUPED, LOADING, TOKEN_INVALID, TOKEN_MISSING,
  argoAppCount, argoCaution, argoErrors, argoGenerators, argoLabelRemove, argoOk, argoOkApps, argoOutOfSync, ARGO_EXPAND_ALL, ARGO_FOLD_OK,
} from "./text";
import type { ArgoApp, ArgoAppRow, ArgoAppSetRow, ArgoViewState } from "./types";

vi.mock("./api", () => ({ argocdApi: { apps: vi.fn(), appsets: vi.fn(), app: vi.fn(), tree: vi.fn(), refresh: vi.fn(), sync: vi.fn() } }));
const m = vi.mocked(argocdApi);
const URL = "https://argocd.example";
const NOW = Date.parse("2026-10-30T12:00:00Z");

const appRow = (name: string, values: Record<string, string> = {}, labels: Record<string, string> = {}): ArgoAppRow => ({
  name,
  namespace: "argocd",
  resourceVersion: "1",
  values: { sync: "Synced", health: "Healthy", project: "default", destination: "in-cluster", destNamespace: "web", revision: "0123456", ...values },
  labels,
});
const setRow = (name: string, over: Partial<ArgoAppSetRow> = {}): ArgoAppSetRow => ({ name, namespace: "argocd", status: null, message: null, generators: [], ...over });

function setup(apps: ArgoAppRow[], sets: ArgoAppSetRow[] = [], props: Partial<Parameters<typeof ArgoView>[0]> = {}) {
  m.apps.mockResolvedValue(apps);
  m.appsets.mockResolvedValue(sets);
  const onTokenError = vi.fn();
  renderWithClient(<ArgoView url={URL} live onTokenError={onTokenError} now={NOW} {...props} />);
  return { onTokenError };
}
/** 정상 묶음·정상 행은 처음에 접혀 있다. 접기와 상관없는 시험은 사용자가 모두 펴 둔 것처럼 시작한다 */
function expandAll() {
  for (;;) {
    const closed = Array.from(document.querySelectorAll<HTMLElement>(".argo-band[aria-expanded=false], .argo-subband[aria-expanded=false], .argo-okfold-btn[aria-expanded=false]"));
    if (closed.length === 0) return;
    closed.forEach((b) => fireEvent.click(b));
  }
}
async function ready(apps: ArgoAppRow[], sets: ArgoAppSetRow[] = []) {
  const h = setup(apps, sets);
  await screen.findByRole("table", { name: ARGO_APPS_LABEL });
  expandAll();
  return h;
}

beforeEach(() => {
  vi.resetAllMocks();
  m.app.mockReturnValue(new Promise<ArgoApp>(() => {}));
  m.tree.mockReturnValue(new Promise(() => {}));
});

/** 지금 보이는 행 이름(접힌 것은 빠진다) */
const shownNames = () => Array.from(document.querySelectorAll("tr.argo-row")).map((r) => r.querySelector("td")?.firstChild?.textContent);
/** 모두 펴고 본 행 이름 */
const names = () => {
  expandAll();
  return shownNames();
};
const findInput = () => {
  if (!screen.queryByRole("textbox", { name: "목록에서 찾기" })) {
    act(() => { dispatchKey(new KeyboardEvent("keydown", { key: "f", metaKey: true })); });
  }
  return screen.getByRole("textbox", { name: "목록에서 찾기" });
};
const cards = () => Array.from(document.querySelectorAll<HTMLElement>("section.argo-card"));
const headers = () => cards().map((c) => c.querySelector(".argo-band b")?.textContent);
const chip = (group: string, status: string) => within(screen.getByRole("group", { name: group })).getByRole("button", { name: new RegExp(`^${status}\\b`) });
/** 환경 칩처럼 이름이 한글일 수도 있는 칩("미분류 2"): \b가 한글에서는 듣지 않아 뒤의 개수로 끊는다 */
const chipN = (group: string, text: string) => within(screen.getByRole("group", { name: group })).getByRole("button", { name: new RegExp(`^${text} \\d`) });
const chipTexts = (group: string) => within(screen.getByRole("group", { name: group })).getAllByRole("button").map((b) => b.textContent);
/** 여러 개 고르는 목록: 단추를 눌러 열고, 목록 안의 체크 칸을 고른다 */
const msButton = (label: string) => screen.getByRole("button", { name: new RegExp(`^${label}:`) });
const openMs = (label: string) => fireEvent.click(msButton(label));
const msBox = (label: string, text: string) => within(screen.getByRole("group", { name: label })).getByRole("checkbox", { name: new RegExp(`^${text} \\d`) });
const msTexts = (label: string) => within(screen.getByRole("group", { name: label })).getAllByRole("checkbox").map((c) => c.closest("label")?.textContent);
const pickMs = (label: string, text: string) => {
  openMs(label);
  fireEvent.click(msBox(label, text));
  openMs(label);
};
/** 레이블 필터 입력 */
const labelInput = () => screen.getByRole("combobox", { name: ARGO_LABEL_FILTER });
const addLabel = (text: string) => {
  fireEvent.change(labelInput(), { target: { value: text } });
  fireEvent.keyDown(labelInput(), { key: "Enter" });
};
const labelChips = () => Array.from(document.querySelectorAll(".argo-lchip")).map((c) => c.firstChild?.textContent);
/** 묶기 기준 */
const primarySel = () => screen.getByRole("combobox", { name: ARGO_GROUP_BY });
const secondarySel = () => screen.getByRole("combobox", { name: ARGO_GROUP_THEN });
const groupBy = (dim: string, then = "none") => {
  fireEvent.change(primarySel(), { target: { value: dim } });
  fireEvent.change(secondarySel(), { target: { value: then } });
};
const optionTexts = (sel: HTMLElement) => within(sel).getAllByRole("option").map((o) => o.textContent);
const subHeaders = (scope: HTMLElement = document.body) => Array.from(scope.querySelectorAll("tr.argo-subgroup b")).map((b) => b.textContent);
const colHeaders = () => screen.getAllByRole("columnheader").map((h) => h.textContent);

test("reads this server's applications and ApplicationSets, and says it is loading first", async () => {
  setup([appRow("a")]);
  expect(screen.getByText(LOADING)).toBeInTheDocument();
  await screen.findByRole("table", { name: ARGO_APPS_LABEL });
  expect(m.apps).toHaveBeenCalledWith(URL);
  expect(m.appsets).toHaveBeenCalledWith(URL);
});

describe("rows", () => {
  test("the table shows the app's columns with errors and warnings counted", async () => {
    await ready([appRow("web", { sync: "OutOfSync", health: "Progressing", operation: "Failed", lastSync: "2026-10-30T11:00:00Z", autoSync: "true", targetRevision: "main", errors: "2", warnings: "1" })]);
    const cells = within(document.querySelector("tr.argo-row") as HTMLElement).getAllByRole("cell");
    expect(cells.map((c) => c.textContent)).toEqual(["web오류 2경고 1", "미분류", "default", `${ARGO_IN_CLUSTER}/web`, "OutOfSync", "Progressing", "Failed", "0123456", "1h", "켜짐"]);
    expect(cells[7]).toHaveAttribute("title", "main");
    expect(colHeaders()).toEqual(["이름", "환경", "프로젝트", "대상", "Sync", "Health", "작업", "Revision", "마지막 동기화", "자동"]);
  });

  test("auto sync off is shown, and a missing value leaves the cell empty", async () => {
    await ready([appRow("off", { autoSync: "false" }), appRow("none")]);
    const auto = (n: string) => within(screen.getByText(n).closest("tr") as HTMLElement).getAllByRole("cell")[9].textContent;
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
    const dest = (n: string) => within(screen.getByText(n).closest("tr") as HTMLElement).getAllByRole("cell")[3].textContent;
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
    const counts = () => [ARGO_SYNC_GROUP, ARGO_HEALTH_GROUP].flatMap(chipTexts);
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

  test("project list and name search narrow the list and the chip counts", async () => {
    await ready([appRow("web-a", { project: "prod" }), appRow("web-b", { project: "dev", sync: "OutOfSync" }), appRow("db", { project: "prod" })]);
    expect(msButton(ARGO_PROJECT)).toHaveTextContent("프로젝트: 전체");
    openMs(ARGO_PROJECT);
    expect(msTexts(ARGO_PROJECT)).toEqual(["dev1", "prod2"]);
    expect(chip(ARGO_SYNC_GROUP, "OutOfSync")).toHaveTextContent("OutOfSync 1");
    fireEvent.click(msBox(ARGO_PROJECT, "prod"));
    expect([...names()].sort()).toEqual(["db", "web-a"]);
    expect(chip(ARGO_SYNC_GROUP, "OutOfSync")).toHaveTextContent("OutOfSync 0");
    fireEvent.change(findInput(), { target: { value: "WEB-" } });
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
    // 빨강(오류: ApplicationSet Error 포함)이 맨 앞(앱 없는 empty도), 그 다음 노랑, 정상은 이름 순, 마지막이 ApplicationSet 없음
    expect(headers()).toEqual(["empty", "web", "db", "gone", ARGO_UNGROUPED]);
    const groups = cards();
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

  test("cards are colored by their worst app: red for errors (or an ApplicationSet Error), yellow for other problems, blue otherwise", async () => {
    await ready(
      [
        appRow("r1", { appSet: "red", health: "Degraded" }),
        appRow("r2", { appSet: "red", sync: "OutOfSync" }),
        appRow("r3", { appSet: "red" }),
        appRow("y1", { appSet: "yellow", sync: "OutOfSync" }),
        appRow("y2", { appSet: "yellow", health: "Progressing" }),
        appRow("b1", { appSet: "blue" }),
      ],
      [setRow("red"), setRow("yellow"), setRow("blue"), setRow("broken", { status: "Error", message: "x" })],
    );
    expect(headers()).toEqual(["broken", "red", "yellow", "blue"]);
    expect(cards().map((c) => c.className.match(/argo-card-(\w+)/)?.[1])).toEqual(["err", "err", "warn", "ok"]);
    // 요약 칩은 앱 하나를 한 칸으로만 센다: 오류 > OutOfSync > 그 밖의 주의 > 정상
    const [, red, yellow, blue] = cards();
    expect(within(red).getByText(argoErrors(1))).toHaveClass("argo-bad");
    expect(within(red).getByText(argoOutOfSync(1))).toHaveClass("argo-warn");
    expect(within(red).getByText(argoOk(1))).toHaveClass("argo-ok");
    expect(within(yellow).getByText(argoOutOfSync(1))).toBeInTheDocument();
    expect(within(yellow).getByText(argoCaution(1))).toBeInTheDocument();
    expect(within(yellow).queryByText(/^정상/)).toBeNull();
    expect(within(blue).getByText(argoOk(1))).toBeInTheDocument();
  });

  test("problem cards start open and healthy ones folded; a header click folds or opens just that card", async () => {
    setup([appRow("a1", { appSet: "aaa" }), appRow("b1", { appSet: "bbb", sync: "OutOfSync" })], [setRow("aaa"), setRow("bbb")]);
    await screen.findByRole("table", { name: ARGO_APPS_LABEL });
    expect(headers()).toEqual(["bbb", "aaa"]);
    expect(shownNames()).toEqual(["b1"]);
    const [problem, healthy] = cards();
    expect(healthy).toHaveClass("argo-card-quiet");
    expect(problem).not.toHaveClass("argo-card-quiet");
    fireEvent.click(within(healthy).getByRole("button", { expanded: false }));
    expect(shownNames()).toEqual(["b1", "a1"]);
    expect(healthy).not.toHaveClass("argo-card-quiet");
    fireEvent.click(within(problem).getByRole("button", { expanded: true }));
    expect(shownNames()).toEqual(["a1"]);
  });

  test("in a mixed card the healthy rows fold into one line under the problem rows", async () => {
    setup(
      [appRow("ok1", { appSet: "web" }), appRow("bad", { appSet: "web", health: "Degraded" }), appRow("ok2", { appSet: "web" })],
      [setRow("web")],
    );
    await screen.findByRole("table", { name: ARGO_APPS_LABEL });
    expect(shownNames()).toEqual(["bad"]);
    const fold = screen.getByRole("button", { name: new RegExp(argoOkApps(2)) });
    expect(fold).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(fold);
    expect(shownNames()).toEqual(["bad", "ok1", "ok2"]);
    fireEvent.click(fold);
    expect(shownNames()).toEqual(["bad"]);
  });

  test("picking a Sync or Health chip or searching shows what was found unfolded; what you opened yourself stays open", async () => {
    setup([appRow("a1", { appSet: "aaa" }), appRow("a2", { appSet: "aaa", sync: "OutOfSync" }), appRow("c1", { appSet: "ccc" })], [setRow("aaa"), setRow("ccc")]);
    await screen.findByRole("table", { name: ARGO_APPS_LABEL });
    expect(shownNames()).toEqual(["a2"]);
    fireEvent.click(chip(ARGO_HEALTH_GROUP, "Healthy"));
    expect(shownNames()).toEqual(["a2", "a1", "c1"]);
    fireEvent.click(chip(ARGO_HEALTH_GROUP, "Healthy"));
    expect(shownNames()).toEqual(["a2"]);
    fireEvent.change(findInput(), { target: { value: "1" } });
    expect(shownNames()).toEqual(["a1", "c1"]);
    fireEvent.change(findInput(), { target: { value: "" } });
    fireEvent.click(within(cards()[1]).getByRole("button", { expanded: false }));
    fireEvent.click(chip(ARGO_HEALTH_GROUP, "Healthy"));
    fireEvent.click(chip(ARGO_HEALTH_GROUP, "Healthy"));
    expect(shownNames()).toEqual(["a2", "c1"]);
  });

  test("Expand all opens every folded card, sub-group and healthy line; pressing it again goes back to the default", async () => {
    setup(
      [appRow("a1-dev", { appSet: "aaa" }), appRow("b1-dev", { appSet: "bbb", sync: "OutOfSync" }), appRow("b2-stg", { appSet: "bbb" }), appRow("b3-stg", { appSet: "bbb" })],
      [setRow("aaa"), setRow("bbb")],
    );
    await screen.findByRole("table", { name: ARGO_APPS_LABEL });
    groupBy("set", "env");
    expect(shownNames()).toEqual(["b1-dev"]);
    // 직접 접어 둔 문제 카드도 함께 편다
    fireEvent.click(cards()[0].querySelector(".argo-band") as HTMLElement);
    expect(shownNames()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: ARGO_EXPAND_ALL }));
    expect(shownNames()).toEqual(["b1-dev", "b2-stg", "b3-stg", "a1-dev"]);
    expect(document.querySelectorAll(".argo-cards [aria-expanded=false]")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: ARGO_FOLD_OK }));
    expect(shownNames()).toEqual(["b1-dev"]);
    expect(screen.getByRole("button", { name: ARGO_EXPAND_ALL })).toBeInTheDocument();
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
    fireEvent.change(findInput(), { target: { value: "a" } });
    expect(headers()).not.toContain("empty");
  });

  test("the toggle flattens the list into one problem-first run", async () => {
    await ready([appRow("web-a", { appSet: "web" }), appRow("db-a", { appSet: "db", sync: "OutOfSync" }), appRow("solo")], [setRow("web"), setRow("db")]);
    groupBy("none");
    expect(headers()).toEqual([]);
    expect(names()).toEqual(["db-a", "solo", "web-a"]);
    groupBy("set");
    expect(headers()).toHaveLength(3);
  });

  test("grouping is on by default", async () => {
    await ready([appRow("a")]);
    expect(primarySel()).toHaveValue("set");
    expect(secondarySel()).toHaveValue("none");
    expect(headers()).toEqual([ARGO_UNGROUPED]);
  });
});

test("worst first: errors (error conditions, Degraded or Missing, a failed operation), then other problems, then healthy", async () => {
  await ready([
    appRow("aa-fine"),
    appRow("bb-sync", { sync: "OutOfSync" }),
    appRow("cc-health", { health: "Degraded" }),
    appRow("dd-errors", { errors: "1" }),
    appRow("ee-failed", { operation: "Failed" }),
    appRow("ee2-error", { operation: "Error" }),
    appRow("ff-nohealth", { health: "" }),
    appRow("gg-missing", { health: "Missing" }),
    appRow("zz-fine"),
    appRow("yy-warn-only", { warnings: "3" }),
  ]);
  groupBy("none");
  expect(names()).toEqual(["cc-health", "dd-errors", "ee-failed", "ee2-error", "gg-missing", "bb-sync", "ff-nohealth", "aa-fine", "yy-warn-only", "zz-fine"]);
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

  test("찾기에서 Esc는 상세를 유지하고 검색어를 지운 뒤, 목록의 Esc는 상세를 닫는다", async () => {
    await ready([appRow("web"), appRow("db")]);
    fireEvent.click(screen.getByText("web"));
    const input = findInput();
    fireEvent.click(input);
    fireEvent.change(input, { target: { value: "web" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByRole("complementary")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "목록에서 찾기" })).toBeNull();
    expect(names()).toContain("db");
    fireEvent.keyDown(screen.getByText("web", { selector: "td" }), { key: "Escape" });
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  test("clicking the empty part of the list closes it; a header does not", async () => {
    await ready([appRow("web")]);
    fireEvent.click(screen.getByText("web"));
    expect(await screen.findByRole("complementary")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("columnheader")[0]);
    expect(screen.getByRole("complementary")).toBeInTheDocument();
    fireEvent.click(document.querySelector(".argo-scroll") as HTMLElement);
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
    expect(await screen.findByText(ARGO_UNGROUPED)).toBeInTheDocument();
    expect(names()).toEqual(["back"]);
    expect(screen.queryByText("connection reset")).toBeNull();
  });

  test("an ApplicationSet failure does not hide the applications", async () => {
    m.apps.mockResolvedValue([appRow("web")]);
    m.appsets.mockRejectedValue({ kind: "other", message: "appsets forbidden" });
    renderWithClient(<ArgoView url={URL} live onTokenError={vi.fn()} now={NOW} />);
    expect(await screen.findByText("appsets forbidden")).toBeInTheDocument();
    expect(names()).toEqual(["web"]);
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

describe("environment column", () => {
  test("each row shows its environment; the tooltip says where it was read", async () => {
    await ready([
      appRow("a-label", {}, { environment: "production" }),
      appRow("b-stg"),
      appRow("c", { destNamespace: "backend-prd" }),
      appRow("d", { destination: "x-dev2-cluster", destNamespace: "x" }),
      appRow("e"),
      appRow("pr-1-dev", {}, { preview: "true", slug: "pr-1" }),
    ]);
    const env = (n: string) => {
      const badge = within(screen.getByText(n).closest("tr") as HTMLElement).getAllByRole("cell")[1].firstElementChild as HTMLElement;
      return [badge.textContent, badge.getAttribute("title"), badge.className.match(/argo-env-(\w+)/)?.[1]];
    };
    expect(env("a-label")).toEqual(["prd", ARGO_ENV_SOURCE.label, "prd"]);
    expect(env("b-stg")).toEqual(["stg", ARGO_ENV_SOURCE.name, "stg"]);
    expect(env("c")).toEqual(["prd", ARGO_ENV_SOURCE.namespace, "prd"]);
    expect(env("d")).toEqual(["dev", ARGO_ENV_SOURCE.cluster, "dev"]);
    expect(env("e")).toEqual(["미분류", ARGO_ENV_SOURCE.none, "unknown"]);
    expect(env("pr-1-dev")).toEqual(["preview", ARGO_ENV_SOURCE.label, "preview"]);
  });

  test("the column is there when flat or grouped by something else, and gone when either level groups by environment", async () => {
    await ready([appRow("a-dev", { appSet: "web" }, { team: "ai" })], [setRow("web")]);
    const dataCells = () => (document.querySelector("tr.argo-row") as HTMLElement).children.length;
    expect(colHeaders()).toContain("환경");
    expect(dataCells()).toBe(10);
    groupBy("none");
    expect(colHeaders()).toContain("환경");
    groupBy("label:team", "cluster");
    expect(colHeaders()).toContain("환경");
    groupBy("env");
    expect(colHeaders()).not.toContain("환경");
    expandAll();
    expect(dataCells()).toBe(9);
    groupBy("set", "env");
    expect(colHeaders()).not.toContain("환경");
    expandAll();
    expect(dataCells()).toBe(9);
    groupBy("set", "project");
    expect(colHeaders()).toContain("환경");
    expandAll();
    expect(dataCells()).toBe(10);
  });
});

describe("environment, cluster, project and label filters", () => {
  test("environment chips: only environments in the data, in the fixed order; OR within, AND with the others", async () => {
    await ready([appRow("a-dev"), appRow("b-dev", { sync: "OutOfSync" }), appRow("c-stg"), appRow("d-prd"), appRow("e")]);
    expect(chipTexts(ARGO_ENV_GROUP)).toEqual(["dev 2", "stg 1", "prd 1", "미분류 1"]);
    fireEvent.click(chipN(ARGO_ENV_GROUP, "dev"));
    fireEvent.click(chipN(ARGO_ENV_GROUP, "stg"));
    expect(chipN(ARGO_ENV_GROUP, "dev")).toHaveAttribute("aria-pressed", "true");
    expect([...names()].sort()).toEqual(["a-dev", "b-dev", "c-stg"]);
    // 자기 칩의 숫자는 그대로, 다른 칩(Sync)의 숫자는 환경 조건을 따른다
    expect(chipTexts(ARGO_ENV_GROUP)).toEqual(["dev 2", "stg 1", "prd 1", "미분류 1"]);
    expect(chip(ARGO_SYNC_GROUP, "Synced")).toHaveTextContent("Synced 2");
    expect(chip(ARGO_SYNC_GROUP, "OutOfSync")).toHaveTextContent("OutOfSync 1");
    // 다른 조건과는 교집합이고, 그 조건이 환경 칩의 숫자를 줄인다
    fireEvent.click(chip(ARGO_SYNC_GROUP, "OutOfSync"));
    expect(names()).toEqual(["b-dev"]);
    expect(chipTexts(ARGO_ENV_GROUP)).toEqual(["dev 1", "stg 0", "prd 0", "미분류 0"]);
  });

  test("cluster list: in-cluster shown as this cluster, counts, OR within and AND with project, own picks keep the counts", async () => {
    await ready([
      appRow("a", { destination: "x-dev2-cluster", project: "p1" }),
      appRow("b", { destination: "x-dev2-cluster", project: "p2" }),
      appRow("c", { destination: "https://kubernetes.default.svc", project: "p1" }),
      appRow("d", { destination: "in-cluster", project: "p2" }),
      appRow("e", { destination: "ml-cluster", project: "p1" }),
    ]);
    expect(msButton(ARGO_CLUSTER_FILTER)).toHaveTextContent("클러스터: 전체");
    openMs(ARGO_CLUSTER_FILTER);
    expect(msTexts(ARGO_CLUSTER_FILTER)).toEqual(["ml-cluster1", "x-dev2-cluster2", `${ARGO_IN_CLUSTER}2`]);
    fireEvent.click(msBox(ARGO_CLUSTER_FILTER, "x-dev2-cluster"));
    fireEvent.click(msBox(ARGO_CLUSTER_FILTER, ARGO_IN_CLUSTER));
    expect(msBox(ARGO_CLUSTER_FILTER, ARGO_IN_CLUSTER)).toBeChecked();
    expect(msButton(ARGO_CLUSTER_FILTER)).toHaveTextContent("클러스터: 2개");
    expect([...names()].sort()).toEqual(["a", "b", "c", "d"]);
    expect(msTexts(ARGO_CLUSTER_FILTER)).toEqual(["ml-cluster1", "x-dev2-cluster2", `${ARGO_IN_CLUSTER}2`]);
    // 프로젝트와는 교집합. 클러스터 숫자는 프로젝트 조건만 따른다
    pickMs(ARGO_PROJECT, "p1");
    expect([...names()].sort()).toEqual(["a", "c"]);
    expect(msTexts(ARGO_CLUSTER_FILTER)).toEqual(["ml-cluster1", "x-dev2-cluster1", `${ARGO_IN_CLUSTER}1`]);
    // 선택 해제
    fireEvent.click(within(screen.getByRole("group", { name: ARGO_CLUSTER_FILTER })).getByRole("button", { name: ARGO_PICK_CLEAR }));
    expect(msButton(ARGO_CLUSTER_FILTER)).toHaveTextContent("클러스터: 전체");
    expect([...names()].sort()).toEqual(["a", "c", "e"]);
  });

  test("project list: several projects are OR; the counts follow the other filters", async () => {
    await ready([appRow("a", { project: "p1" }), appRow("b", { project: "p2", sync: "OutOfSync" }), appRow("c", { project: "p3" })]);
    pickMs(ARGO_PROJECT, "p1");
    pickMs(ARGO_PROJECT, "p2");
    expect(msButton(ARGO_PROJECT)).toHaveTextContent("프로젝트: 2개");
    expect([...names()].sort()).toEqual(["a", "b"]);
    fireEvent.click(chip(ARGO_SYNC_GROUP, "OutOfSync"));
    openMs(ARGO_PROJECT);
    expect(msTexts(ARGO_PROJECT)).toEqual(["p10", "p21", "p30"]);
    expect(names()).toEqual(["b"]);
  });

  test("the list closes on an outside click and on Escape (which returns focus to its button)", async () => {
    await ready([appRow("a")]);
    openMs(ARGO_PROJECT);
    expect(screen.getByRole("group", { name: ARGO_PROJECT })).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("group", { name: ARGO_PROJECT })).toBeNull();
    openMs(ARGO_PROJECT);
    fireEvent.mouseDown(screen.getByRole("checkbox"));
    expect(screen.getByRole("group", { name: ARGO_PROJECT })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("checkbox"), { key: "Escape" });
    expect(screen.queryByRole("group", { name: ARGO_PROJECT })).toBeNull();
    expect(msButton(ARGO_PROJECT)).toHaveFocus();
  });

  describe("label filter", () => {
    const LABELED = () =>
      ready([
        appRow("a", {}, { team: "ai", type: "api" }),
        appRow("b", {}, { team: "ai", type: "web" }),
        appRow("c", {}, { team: "data", type: "api" }),
        appRow("d", { sync: "OutOfSync" }, { team: "data", type: "consumer" }),
        appRow("e"),
      ]);
    const suggestions = () => (screen.queryByRole("listbox") ? within(screen.getByRole("listbox")).getAllByRole("option").map((o) => o.textContent) : []);

    test("suggests keys when empty and key=value pairs as you type, with counts", async () => {
      await LABELED();
      fireEvent.focus(labelInput());
      expect(suggestions()).toEqual(["team4", "type4"]);
      fireEvent.change(labelInput(), { target: { value: "team=" } });
      expect(suggestions()).toEqual(["team=ai2", "team=data2"]);
      fireEvent.change(labelInput(), { target: { value: "API" } });
      expect(suggestions()).toEqual(["type=api2"]);
      fireEvent.change(labelInput(), { target: { value: "zzz" } });
      expect(suggestions()).toEqual([]);
    });

    test("Enter adds a chip: the same key is OR, different keys are AND, a bare key means the label exists", async () => {
      await LABELED();
      addLabel("team=ai");
      expect(labelChips()).toEqual(["team=ai"]);
      expect(labelInput()).toHaveValue("");
      expect([...names()].sort()).toEqual(["a", "b"]);
      addLabel("team=data");
      expect([...names()].sort()).toEqual(["a", "b", "c", "d"]);
      addLabel("type=api");
      expect(labelChips()).toEqual(["team=ai", "team=data", "type=api"]);
      expect([...names()].sort()).toEqual(["a", "c"]);
      // 같은 칩을 또 더해도 하나
      addLabel("type=api");
      expect(labelChips()).toHaveLength(3);
      fireEvent.click(screen.getByRole("button", { name: argoLabelRemove("type=api") }));
      expect(labelChips()).toEqual(["team=ai", "team=data"]);
      expect([...names()].sort()).toEqual(["a", "b", "c", "d"]);
      fireEvent.click(screen.getByRole("button", { name: argoLabelRemove("team=ai") }));
      fireEvent.click(screen.getByRole("button", { name: argoLabelRemove("team=data") }));
      expect(names()).toHaveLength(5);
      addLabel("type");
      expect(labelChips()).toEqual(["type"]);
      expect([...names()].sort()).toEqual(["a", "b", "c", "d"]);
    });

    test("clicking a suggestion adds it; arrow keys and Enter pick one; the picked one is no longer offered", async () => {
      await LABELED();
      fireEvent.change(labelInput(), { target: { value: "team=" } });
      fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: /^team=data/ }));
      expect(labelChips()).toEqual(["team=data"]);
      expect([...names()].sort()).toEqual(["c", "d"]);
      fireEvent.change(labelInput(), { target: { value: "team=" } });
      expect(suggestions()).toEqual(["team=ai2"]);
      fireEvent.change(labelInput(), { target: { value: "type=" } });
      fireEvent.keyDown(labelInput(), { key: "ArrowDown" });
      fireEvent.keyDown(labelInput(), { key: "ArrowDown" });
      fireEvent.keyDown(labelInput(), { key: "Enter" });
      expect(labelChips()).toEqual(["team=data", "type=consumer"]);
    });

    test("Enter on a partial text takes the first suggestion, not the half-typed text; with no suggestion it takes the text", async () => {
      await LABELED();
      addLabel("type=con");
      expect(labelChips()).toEqual(["type=consumer"]);
      expect(names()).toEqual(["d"]);
      addLabel("owner=me");
      expect(labelChips()).toEqual(["type=consumer", "owner=me"]);
      // 빈 입력의 Enter는 아무것도 더하지 않는다
      fireEvent.keyDown(labelInput(), { key: "Enter" });
      expect(labelChips()).toHaveLength(2);
    });

    test("Escape closes the suggestions; the counts follow the other filters", async () => {
      await LABELED();
      fireEvent.click(chip(ARGO_SYNC_GROUP, "OutOfSync"));
      fireEvent.change(labelInput(), { target: { value: "team=" } });
      expect(suggestions()).toEqual(["team=ai0", "team=data1"]);
      fireEvent.keyDown(labelInput(), { key: "Escape" });
      expect(screen.queryByRole("listbox")).toBeNull();
    });
  });

  test("the search also matches label values and the destination namespace", async () => {
    await ready([appRow("alpha", { destNamespace: "payments-dev" }, { team: "Platform" }), appRow("beta"), appRow("gamma", {}, { team: "data" })]);
    const search = (q: string) => fireEvent.change(findInput(), { target: { value: q } });
    search("payments");
    expect(names()).toEqual(["alpha"]);
    search("PLATFORM");
    expect(names()).toEqual(["alpha"]);
    search("data");
    expect(names()).toEqual(["gamma"]);
    search("beta");
    expect(names()).toEqual(["beta"]);
    // 레이블 키는 찾지 않는다
    search("team");
    expect(names()).toEqual([]);
  });
});

describe("grouping levels", () => {
  test("options: ApplicationSet, environment, cluster, project, namespace, one per label key, none; the second level leaves out the first", async () => {
    await ready([appRow("a", {}, { team: "ai", type: "api" }), appRow("b", {}, { team: "data" })]);
    const all = ["ApplicationSet", "환경", "대상 클러스터", "프로젝트", "네임스페이스", "레이블: team", "레이블: type", "없음"];
    expect(optionTexts(primarySel())).toEqual(all);
    expect(optionTexts(secondarySel())).toEqual(all.filter((t) => t !== "ApplicationSet"));
    fireEvent.change(primarySel(), { target: { value: "label:team" } });
    expect(optionTexts(secondarySel())).toEqual(all.filter((t) => t !== "레이블: team"));
  });

  test("the second level is off with no first level, and cannot equal the first level", async () => {
    await ready([appRow("a-dev", { appSet: "web" })], [setRow("web")]);
    expect(secondarySel()).toBeEnabled();
    fireEvent.change(secondarySel(), { target: { value: "env" } });
    expect(secondarySel()).toHaveValue("env");
    // 1단계를 2단계와 같게 바꾸면 2단계는 없음이 된다
    fireEvent.change(primarySel(), { target: { value: "env" } });
    expect(secondarySel()).toHaveValue("none");
    expect(subHeaders()).toEqual([]);
    fireEvent.change(primarySel(), { target: { value: "none" } });
    expect(secondarySel()).toBeDisabled();
    expect(secondarySel()).toHaveValue("none");
    expect(headers()).toEqual([]);
  });

  test("by environment: worst first, then the fixed order, unknown last; no ApplicationSet extras", async () => {
    await ready(
      [
        appRow("a-prd"),
        appRow("b-dev"),
        appRow("c-ops"),
        appRow("d-stg", { sync: "OutOfSync" }),
        appRow("e"),
        appRow("pr-1", {}, { preview: "true" }),
        appRow("f-demo"),
        appRow("g-dev", { health: "Degraded", appSet: "web" }),
      ],
      [setRow("web", { generators: ["list"], status: "Error", message: "boom" }), setRow("empty")],
    );
    expect(screen.getByText(argoGenerators("list"))).toBeInTheDocument();
    groupBy("env");
    expect(headers()).toEqual(["dev", "stg", "prd", "ops", "demo", "preview", "미분류"]);
    expect(names()).toEqual(["g-dev", "b-dev", "d-stg", "a-prd", "c-ops", "f-demo", "pr-1", "e"]);
    // ApplicationSet의 generator·상태·메시지·앱 없는 카드는 ApplicationSet으로 묶을 때만
    expect(screen.queryByText(argoGenerators("list"))).toBeNull();
    expect(screen.queryByText("boom")).toBeNull();
    expect(screen.queryByText("Error")).toBeNull();
    expect(headers()).not.toContain("empty");
  });

  test("by cluster: errors, then problems, then healthy by name; apps without a destination go last within their color", async () => {
    await ready([
      appRow("a", { destination: "k8s-b-cluster" }),
      appRow("b", { destination: "k8s-a-cluster" }),
      appRow("c", { destination: "k8s-z-cluster", health: "Degraded" }),
      appRow("d", { destination: "", health: "Degraded" }),
      appRow("e", { destination: "in-cluster", sync: "OutOfSync" }),
    ]);
    groupBy("cluster");
    expect(headers()).toEqual(["k8s-z-cluster", ARGO_NO_CLUSTER, ARGO_IN_CLUSTER, "k8s-a-cluster", "k8s-b-cluster"]);
    expect(cards().map((c) => c.className.match(/argo-card-(\w+)/)?.[1])).toEqual(["err", "err", "warn", "ok", "ok"]);
  });

  test("by label: groups per value; apps without the label are a group too, never below a healthier one", async () => {
    await ready([
      appRow("a", {}, { team: "data" }),
      appRow("b", {}, { team: "ai" }),
      appRow("c", { sync: "OutOfSync" }, { team: "zed" }),
      appRow("d", { health: "Degraded" }),
      appRow("e", {}, { team: "ai" }),
    ]);
    groupBy("label:team");
    expect(headers()).toEqual([ARGO_NO_LABEL, "zed", "ai", "data"]);
    expect(within(cards()[2]).getByText(argoAppCount(2))).toBeInTheDocument();
  });

  test("by project and by namespace", async () => {
    await ready([appRow("a", { project: "p2", destNamespace: "n1" }), appRow("b", { project: "p1", destNamespace: "n2" }), appRow("c", { project: "p2", destNamespace: "n2" })]);
    groupBy("project");
    expect(headers()).toEqual(["p1", "p2"]);
    groupBy("namespace");
    expect(headers()).toEqual(["n1", "n2"]);
    expect(names()).toEqual(["a", "b", "c"]);
  });

  test("a second level puts foldable sub-headers with tally chips and a count inside each card, with the rows under them", async () => {
    await ready(
      [appRow("web-dev", { appSet: "web" }), appRow("web-prd", { appSet: "web", sync: "OutOfSync" }), appRow("web-stg", { appSet: "web" }), appRow("web-x", { appSet: "web" }), appRow("solo-dev")],
      [setRow("web", { generators: ["list"] })],
    );
    groupBy("set", "env");
    expect(headers()).toEqual(["web", ARGO_UNGROUPED]);
    const [web, loose] = cards();
    expect(subHeaders(web)).toEqual(["prd", "dev", "stg", "미분류"]);
    expect(subHeaders(loose)).toEqual(["dev"]);
    expect(names()).toEqual(["web-prd", "web-dev", "web-stg", "web-x", "solo-dev"]);
    // 소제목 줄은 표의 모든 열에 걸치고(환경으로 묶으니 9열), 요약 칩과 개수가 있다
    const prd = Array.from(web.querySelectorAll<HTMLElement>("tr.argo-subgroup")).find((tr) => tr.textContent?.startsWith("▾prd")) as HTMLElement;
    expect(prd.querySelector("td")).toHaveAttribute("colspan", "9");
    expect(within(prd).getByText(argoOutOfSync(1))).toHaveClass("argo-warn");
    expect(within(prd).getByText(argoAppCount(1))).toBeInTheDocument();
    // ApplicationSet 머리는 1단계일 때만: 2단계 소제목에는 generator가 없다
    expect(screen.getByText(argoGenerators("list"))).toBeInTheDocument();
    fireEvent.change(primarySel(), { target: { value: "env" } });
    fireEvent.change(secondarySel(), { target: { value: "set" } });
    expect(headers()).toEqual(["prd", "dev", "stg", "미분류"]);
    expandAll();
    expect(subHeaders(cards()[1])).toEqual(["web", ARGO_UNGROUPED]);
    expect(screen.queryByText(argoGenerators("list"))).toBeNull();
  });

  test("the second level is ordered like the first: worst first, then the fixed environment order or names, 'none' last within its color", async () => {
    await ready([
      appRow("x1-dev", { destination: "k8s-b-cluster" }),
      appRow("x2-dev", { destination: "k8s-a-cluster", health: "Degraded" }),
      appRow("x3-dev", { destination: "k8s-c-cluster", sync: "OutOfSync" }),
      appRow("x4-dev", { destination: "", health: "Degraded" }),
      appRow("x5-dev", { destination: "k8s-d-cluster" }),
    ]);
    groupBy("env", "cluster");
    expect(subHeaders()).toEqual(["k8s-a-cluster", ARGO_NO_CLUSTER, "k8s-c-cluster", "k8s-b-cluster", "k8s-d-cluster"]);
    // 1단계가 환경이라 환경 열은 없다
    expect(colHeaders()).not.toContain("환경");
    expect(names()).toEqual(["x2-dev", "x4-dev", "x3-dev", "x1-dev", "x5-dev"]);
  });

  test("a sub-header folds just its own rows and opens again; folding the card hides the sub-headers too", async () => {
    await ready([appRow("a-dev"), appRow("b-dev", { destination: "k8s-z-cluster" }), appRow("c-stg")]);
    groupBy("env", "cluster");
    expandAll();
    expect(shownNames()).toEqual(["b-dev", "a-dev", "c-stg"]);
    const band = Array.from(document.querySelectorAll<HTMLElement>("tr.argo-subgroup button")).find((b) => b.textContent?.includes(ARGO_IN_CLUSTER)) as HTMLElement;
    expect(band).toHaveAttribute("aria-expanded", "true");
    expect(band.closest("tr")).toHaveClass("argo-subgroup");
    fireEvent.click(band);
    expect(band).toHaveAttribute("aria-expanded", "false");
    expect(shownNames()).toEqual(["b-dev", "c-stg"]);
    expect(subHeaders(cards()[0])).toEqual(["k8s-z-cluster", ARGO_IN_CLUSTER]);
    fireEvent.click(band);
    expect(shownNames()).toEqual(["b-dev", "a-dev", "c-stg"]);
    fireEvent.click(cards()[0].querySelector(".argo-band") as HTMLElement);
    expect(subHeaders()).toEqual([ARGO_IN_CLUSTER]);
    expect(shownNames()).toEqual(["c-stg"]);
  });

  test("a healthy sub-group starts folded inside an open card; one with a problem starts open", async () => {
    setup([appRow("a-dev"), appRow("b-dev", { destination: "k8s-z-cluster", sync: "OutOfSync" })]);
    await screen.findByRole("table", { name: ARGO_APPS_LABEL });
    groupBy("env", "cluster");
    expect(subHeaders()).toEqual(["k8s-z-cluster", ARGO_IN_CLUSTER]);
    expect(shownNames()).toEqual(["b-dev"]);
  });

  test("filters apply before grouping: empty groups and sub-groups disappear", async () => {
    await ready([appRow("a-dev", { destination: "k8s-a-cluster" }), appRow("b-stg", { destination: "k8s-b-cluster" })]);
    groupBy("env", "cluster");
    expect(headers()).toEqual(["dev", "stg"]);
    fireEvent.click(chipN(ARGO_ENV_GROUP, "stg"));
    expect(headers()).toEqual(["stg"]);
    expandAll();
    expect(subHeaders()).toEqual(["k8s-b-cluster"]);
  });
});

describe("remembered filters and grouping", () => {
  const SAVED: ArgoViewState = {
    sync: ["OutOfSync"],
    health: [],
    envs: ["dev", "stg", "bogus"],
    clusters: [],
    projects: ["p1"],
    labels: ["type=api", "=broken"],
    groupBy: "env",
    thenBy: "label:type",
  };
  const rows = [
    appRow("a-dev", { sync: "OutOfSync", project: "p1" }, { type: "api" }),
    appRow("b-stg", { sync: "OutOfSync", project: "p1" }, { type: "api" }),
    appRow("c-dev", { project: "p1" }, { type: "api" }),
    appRow("d-prd", { sync: "OutOfSync", project: "p1" }, { type: "api" }),
    appRow("e-dev", { sync: "OutOfSync", project: "p2" }, { type: "api" }),
    appRow("f-dev", { sync: "OutOfSync", project: "p1" }, { type: "web" }),
  ];

  test("the saved view comes back: filters, grouping, and nothing unreadable", async () => {
    const onSave = vi.fn();
    setup(rows, [], { saved: SAVED, onSave });
    await screen.findByRole("table", { name: ARGO_APPS_LABEL });
    expect(names()).toEqual(["a-dev", "b-stg"]);
    expect(chip(ARGO_SYNC_GROUP, "OutOfSync")).toHaveAttribute("aria-pressed", "true");
    expect(chipN(ARGO_ENV_GROUP, "dev")).toHaveAttribute("aria-pressed", "true");
    expect(msButton(ARGO_PROJECT)).toHaveTextContent("프로젝트: 1개");
    expect(labelChips()).toEqual(["type=api"]);
    expect(primarySel()).toHaveValue("env");
    expect(secondarySel()).toHaveValue("label:type");
    expect(headers()).toEqual(["dev", "stg"]);
    expect(subHeaders()).toEqual(["api", "api"]);
    // 그리기만 해서는 저장하지 않는다
    expect(onSave).not.toHaveBeenCalled();
  });

  test("an unknown grouping falls back to the default", async () => {
    setup([appRow("a")], [], { saved: { ...SAVED, envs: [], sync: [], projects: [], labels: [], groupBy: "colour", thenBy: "label:" } });
    await screen.findByRole("table", { name: ARGO_APPS_LABEL });
    expect(primarySel()).toHaveValue("set");
    expect(secondarySel()).toHaveValue("none");
  });

  test("each change of filters or grouping is saved, the search text is not", async () => {
    const onSave = vi.fn();
    setup(rows, [], { onSave });
    await screen.findByRole("table", { name: ARGO_APPS_LABEL });
    fireEvent.change(findInput(), { target: { value: "dev" } });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(chip(ARGO_HEALTH_GROUP, "Healthy"));
    addLabel("type=web");
    groupBy("project", "env");
    expect(onSave).toHaveBeenLastCalledWith({
      sync: [],
      health: ["Healthy"],
      envs: [],
      clusters: [],
      projects: [],
      labels: ["type=web"],
      groupBy: "project",
      thenBy: "env",
    });
  });
});
