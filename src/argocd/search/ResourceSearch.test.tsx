import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithClient } from "../../test/utils";
import { argocdApi } from "../api";
import { argoKeys } from "../queries";
import type { ArgoAppRow, ArgoResourceRef, ArgoTreeNode } from "../types";
import { ResourceSearch } from "./ResourceSearch";
import { SEARCH_DUPLICATE_CHIP, SEARCH_DUPLICATE_FILTER, SEARCH_EMPTY, SEARCH_LABEL, SEARCH_NO_MATCH, SEARCH_RESULTS_LABEL, searchOpenApp } from "./text";

vi.mock("../api", () => ({ argocdApi: { apps: vi.fn() } }));
const m = vi.mocked(argocdApi);
const URL = "https://argocd.example";

const res = (kind: string, name: string, extra: Partial<ArgoResourceRef> = {}): ArgoResourceRef => ({ group: kind === "Deployment" ? "apps" : "", version: "v1", kind, name, namespace: "shop", ...extra });
const app = (name: string, resources: ArgoResourceRef[]): ArgoAppRow => ({ name, namespace: "argocd", resourceVersion: "1", values: { destination: "in-cluster" }, labels: {}, resources });

const APPS = [
  app("web", [res("Deployment", "api", { status: "Synced", health: "Healthy" }), res("Service", "api", { status: "Synced", health: "Healthy" })]),
  app("worker", [res("Deployment", "queue", { namespace: "jobs", status: "OutOfSync", health: "Degraded" }), res("Service", "api", { status: "Synced" })]),
];

const setup = () => {
  m.apps.mockResolvedValue(APPS);
  const onOpen = vi.fn();
  const view = renderWithClient(<ResourceSearch url={URL} live onOpen={onOpen} />);
  return { onOpen, ...view };
};
const table = () => screen.findByRole("table", { name: SEARCH_RESULTS_LABEL });
const inTable = async () => within(await table());
const rows = (t: HTMLElement) =>
  within(t)
    .getAllByRole("row")
    .slice(1)
    .map((r) => {
      const [kind, name] = Array.from(r.querySelectorAll("td")).map((td) => {
        const copy = td.cloneNode(true) as HTMLElement;
        copy.querySelectorAll(".k8s-chip").forEach((chip) => chip.remove());
        return copy.textContent;
      });
      return `${kind}/${name}`;
    });
/** 검색어는 한 박자 늦게 반영되니 기다리며 본다 */
const expectRows = (expected: string[]) => waitFor(() => expect(rows(screen.getByRole("table", { name: SEARCH_RESULTS_LABEL }))).toEqual(expected));
const type = (text: string) => fireEvent.change(screen.getByRole("searchbox", { name: SEARCH_LABEL }), { target: { value: text } });

beforeEach(() => vi.resetAllMocks());

test("searches every app's resources at once and narrows with the search box", async () => {
  setup();
  await expectRows(["Deployment/queue", "Deployment/api", "Service/api"]);
  type("queue");
  await expectRows(["Deployment/queue"]);
  type("nothing-like-this");
  expect(await screen.findByText(SEARCH_NO_MATCH)).toBeInTheDocument();
});

test("a resource managed by several apps carries a warning chip, lists both apps, and the filter keeps only those", async () => {
  setup();
  const t = await inTable();
  const service = t.getByText("Service").closest("tr") as HTMLElement;
  expect(within(service).getByText(SEARCH_DUPLICATE_CHIP)).toBeInTheDocument();
  expect(within(service).getByRole("button", { name: searchOpenApp("web") })).toBeInTheDocument();
  expect(within(service).getByRole("button", { name: searchOpenApp("worker") })).toBeInTheDocument();
  expect(t.getAllByText(SEARCH_DUPLICATE_CHIP)).toHaveLength(1);

  fireEvent.click(screen.getByRole("button", { name: new RegExp(SEARCH_DUPLICATE_FILTER) }));
  await expectRows(["Service/api"]);
});

test("kind, health and namespace filters combine, with counts that ignore their own choice", async () => {
  setup();
  await table();
  fireEvent.click(screen.getByRole("button", { name: /^종류/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Deployment/ }));
  await expectRows(["Deployment/queue", "Deployment/api"]);
  fireEvent.click(screen.getByRole("button", { name: /^Degraded/ }));
  await expectRows(["Deployment/queue"]);
  // 종류 선택 목록의 Service 개수는 종류 선택을 뺀 나머지 조건(Degraded)으로 센다
  expect(screen.getByRole("checkbox", { name: /Service/ }).closest("label")).toHaveTextContent("0");
});

test("choosing a row opens its first app with the resource, and an app button opens that app", async () => {
  const { onOpen } = setup();
  const t = await inTable();
  const service = t.getByText("Service").closest("tr") as HTMLElement;
  fireEvent.click(within(service).getByRole("button", { name: searchOpenApp("worker") }));
  expect(onOpen).toHaveBeenLastCalledWith({ namespace: "argocd", name: "worker" }, { group: "", kind: "Service", namespace: "shop", name: "api" });
  expect(onOpen).toHaveBeenCalledTimes(1);
  fireEvent.click(t.getByText("queue").closest("tr") as HTMLElement);
  expect(onOpen).toHaveBeenLastCalledWith({ namespace: "argocd", name: "worker" }, { group: "apps", kind: "Deployment", namespace: "jobs", name: "queue" });
});

test("children from trees opened earlier join the index as they arrive", async () => {
  const { qc } = setup();
  await table();
  const pod: ArgoTreeNode = { uid: "p", group: "", version: "v1", kind: "Pod", namespace: "shop", name: "api-7d9", parents: [], health: "Healthy", healthMessage: null, info: [], images: [], createdAt: null };
  act(() => qc.setQueryData(argoKeys.tree(URL, "argocd", "web", "1"), [pod]));
  type("api-7d9");
  await expectRows(["Pod/api-7d9"]);
  const t = await inTable();
  expect(within(t.getByText("api-7d9").closest("tr") as HTMLElement).getByRole("button", { name: searchOpenApp("web") })).toBeInTheDocument();
});

test("says so when no app lists any resource", async () => {
  m.apps.mockResolvedValue([{ name: "bare", namespace: "argocd", resourceVersion: "1", values: {}, labels: {} }]);
  renderWithClient(<ResourceSearch url={URL} live onOpen={vi.fn()} />);
  expect(await screen.findByText(SEARCH_EMPTY)).toBeInTheDocument();
});
