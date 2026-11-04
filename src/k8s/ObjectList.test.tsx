import { fireEvent, render, screen, within } from "@testing-library/react";
import { useRef } from "react";
import { DEPLOYMENTS, PODS, SECRETS } from "./kinds";
import { ObjectList } from "./ObjectList";
import { findFor, findInputs, pressFind } from "./testFind";
import { BAD_SELECTOR, COL_CPU, COL_CPU_OF_LIMIT, COL_CPU_OF_REQUEST, COL_NAMESPACE, LIST_EMPTY, LIST_NO_MATCH, LOADING, METRICS_UNAVAILABLE, ONLY_PROBLEMS, PROBLEM_LABELS } from "./text";
import type { K8sMetrics, K8sProblem, K8sRow } from "./types";
import { buildUsageIndex } from "./usage";

const row = (name: string, labels: Record<string, string> = {}, problems: K8sProblem[] = []): K8sRow => ({
  uid: `u-${name}`, name, namespace: "web", resourceVersion: "1", createdAt: null, labels, values: { ready: "1/1", status: "Running" }, problems,
});
const rows = [row("api", { app: "api" }), row("worker", { app: "worker" }, ["crashLoopBackOff"])];

/** 목록과 상세 자리를 함께 감싼 상자(⌘F host). 상세에 커서가 있어도 ⌘F는 이 목록으로 온다 */
function Host(props: Omit<Parameters<typeof ObjectList>[0], "host">) {
  const host = useRef<HTMLDivElement>(null);
  return (
    <div ref={host}>
      <ObjectList {...props} host={host} />
      <aside>
        <button>상세 단추</button>
      </aside>
    </div>
  );
}

function setup(over: Partial<Omit<Parameters<typeof ObjectList>[0], "host">> = {}) {
  const onSelect = vi.fn();
  render(<Host kind={PODS} rows={rows} status="ready" showNamespace={false} selectedUid={null} onSelect={onSelect} onClear={() => {}} now={0} {...over} />);
  return { onSelect };
}
const names = () => screen.queryAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[0].textContent);
const filter = findFor;

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

test("there is no search box until ⌘F opens the find line; Esc clears the query, closes the line and shows every row again", () => {
  setup();
  expect(findInputs()).toHaveLength(0);
  expect(screen.queryByRole("searchbox")).toBeNull();
  filter("WORK");
  expect(names()).toEqual(["worker"]);
  fireEvent.keyDown(findInputs()[0], { key: "Escape" });
  expect(findInputs()).toHaveLength(0);
  expect(names()).toEqual(["api", "worker"]);
});

test("⌘F with the cursor in the detail beside the list still opens the find line of the list it covers", () => {
  setup();
  screen.getByRole("button", { name: "상세 단추" }).focus();
  expect(pressFind()).toBe(true);
  expect(findInputs()).toHaveLength(1);
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

const usageIndex = (over: Partial<K8sMetrics> = {}) => buildUsageIndex({ podsUnavailable: null, nodesUnavailable: null, pods: [], nodes: [], ...over });

test("usage columns appear with fake metrics", () => {
  const usage = usageIndex({ pods: [{ namespace: "web", name: "api", cpuMilli: 120, memoryBytes: 2048, containers: [], owners: [] }] });
  setup({ usage });
  expect(screen.getByRole("columnheader", { name: new RegExp(`^${COL_CPU}`) })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: new RegExp(COL_CPU_OF_LIMIT) })).toBeInTheDocument();
  expect(screen.getByText("120m")).toBeInTheDocument();
  expect(screen.queryByText(METRICS_UNAVAILABLE.notInstalled)).toBeNull();
});

test("when metrics are unavailable one hint is shown and there are no usage columns", () => {
  setup({ usage: usageIndex({ podsUnavailable: "notInstalled" }) });
  expect(screen.getAllByText(METRICS_UNAVAILABLE.notInstalled)).toHaveLength(1);
  expect(screen.queryByRole("columnheader", { name: new RegExp(`^${COL_CPU}`) })).toBeNull();
  expect(screen.queryByRole("columnheader", { name: new RegExp(COL_CPU_OF_REQUEST) })).toBeNull();
});

test("kinds without usage columns never show the hint", () => {
  setup({ kind: SECRETS, usage: usageIndex({ podsUnavailable: "forbidden" }) });
  expect(screen.queryByText(METRICS_UNAVAILABLE.forbidden)).toBeNull();
});
