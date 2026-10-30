import { fireEvent, render, screen, within } from "@testing-library/react";
import { DEPLOYMENTS, PODS } from "./kinds";
import { ObjectList } from "./ObjectList";
import { BAD_SELECTOR, COL_NAMESPACE, FILTER_PLACEHOLDER, LIST_EMPTY, LIST_NO_MATCH, LOADING, ONLY_PROBLEMS, PROBLEM_LABELS } from "./text";
import type { K8sProblem, K8sRow } from "./types";

const row = (name: string, labels: Record<string, string> = {}, problems: K8sProblem[] = []): K8sRow => ({
  uid: `u-${name}`, name, namespace: "web", resourceVersion: "1", createdAt: null, labels, values: { ready: "1/1", status: "Running" }, problems,
});
const rows = [row("api", { app: "api" }), row("worker", { app: "worker" }, ["crashLoopBackOff"])];

function setup(over: Partial<Parameters<typeof ObjectList>[0]> = {}) {
  const onSelect = vi.fn();
  render(<ObjectList kind={PODS} rows={rows} status="ready" showNamespace={false} selectedUid={null} onSelect={onSelect} now={0} {...over} />);
  return { onSelect };
}
const names = () => screen.queryAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[0].textContent);
const filter = (text: string) => fireEvent.change(screen.getByRole("searchbox", { name: FILTER_PLACEHOLDER }), { target: { value: text } });

test("lists rows with the kind's columns and problem badges", () => {
  setup();
  expect(names()).toEqual(["api", "worker"]);
  expect(screen.getAllByText("Running")).toHaveLength(2);
  expect(screen.getByText(PROBLEM_LABELS.crashLoopBackOff)).toBeInTheDocument();
  expect(screen.queryByRole("columnheader", { name: new RegExp(COL_NAMESPACE) })).toBeNull();
});

test("namespace column only when all namespaces are shown", () => {
  setup({ showNamespace: true, kind: DEPLOYMENTS });
  expect(screen.getByRole("columnheader", { name: new RegExp(COL_NAMESPACE) })).toBeInTheDocument();
});

test("filters by name, by label selector, and by problems", () => {
  setup();
  filter("WORK");
  expect(names()).toEqual(["worker"]);
  filter("app=api");
  expect(names()).toEqual(["api"]);
  filter("");
  fireEvent.click(screen.getByRole("checkbox", { name: ONLY_PROBLEMS }));
  expect(names()).toEqual(["worker"]);
});

test("a bad selector is reported and does not hide rows", () => {
  setup();
  filter("app=");
  expect(screen.getByText(BAD_SELECTOR)).toBeInTheDocument();
  expect(names()).toEqual(["api", "worker"]);
});

test("empty and no-match messages", () => {
  setup({ rows: [] });
  expect(screen.getByText(LIST_EMPTY)).toBeInTheDocument();
});

test("no match message when the filter hides everything", () => {
  setup();
  filter("nothing-like-this");
  expect(screen.getByText(LIST_NO_MATCH)).toBeInTheDocument();
});

test("loading and selection", () => {
  const { onSelect } = setup({ status: "loading", rows: [] });
  expect(screen.getByText(LOADING)).toBeInTheDocument();
  expect(onSelect).not.toHaveBeenCalled();
});

test("clicking a row selects it", () => {
  const { onSelect } = setup({ selectedUid: "u-api" });
  fireEvent.click(screen.getByText("worker"));
  expect(onSelect).toHaveBeenCalledWith(rows[1]);
  expect(screen.getByText("api").closest("tr")).toHaveAttribute("aria-selected", "true");
});
