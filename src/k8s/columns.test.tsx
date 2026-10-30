import { render, screen } from "@testing-library/react";
import { Problems, columnsFor, valueKeys } from "./columns";
import { DEPLOYMENTS, NODES, PODS, SECRETS } from "./kinds";
import { COL_AGE, COL_NAME, COL_NAMESPACE, COL_PROBLEMS, COLUMN_LABELS, PROBLEM_LABELS } from "./text";
import type { K8sRow } from "./types";

const widget = { group: "mm.example.com", version: "v1", kind: "Widget", plural: "widgets", namespaced: true };

test("value keys per kind", () => {
  expect(valueKeys(PODS)).toEqual(["ready", "status", "restarts", "node", "ip"]);
  expect(valueKeys(DEPLOYMENTS)).toEqual(["ready", "upToDate", "available"]);
  expect(valueKeys(SECRETS)).toEqual(["type", "keys"]);
  expect(valueKeys(NODES)).toEqual(["status", "version", "instanceType", "zone", "group"]);
  expect(valueKeys(widget)).toEqual(["ready"]);
});

test("columns: name, namespace when all namespaces, values, problems, age", () => {
  const labels = (cols: ReturnType<typeof columnsFor>) => cols.map((c) => c.label);
  expect(labels(columnsFor(DEPLOYMENTS, true, 0))).toEqual([COL_NAME, COL_NAMESPACE, COLUMN_LABELS.ready, COLUMN_LABELS.upToDate, COLUMN_LABELS.available, COL_PROBLEMS, COL_AGE]);
  expect(labels(columnsFor(DEPLOYMENTS, false, 0))).not.toContain(COL_NAMESPACE);
  expect(labels(columnsFor(NODES, true, 0))).not.toContain(COL_NAMESPACE);
});

test("problems render as labelled badges", () => {
  render(<Problems problems={["crashLoopBackOff", "notReady"]} />);
  expect(screen.getByText(PROBLEM_LABELS.crashLoopBackOff)).toBeInTheDocument();
  expect(screen.getByText(PROBLEM_LABELS.notReady)).toBeInTheDocument();
});

test("age column sorts by creation time and renders relative age", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  const ageCol = columnsFor(PODS, false, now).find((c) => c.key === "age")!;
  const r: K8sRow = { uid: "u", name: "p", namespace: "web", resourceVersion: "1", createdAt: "2026-10-30T11:15:00Z", labels: {}, values: {}, problems: [] };
  expect(ageCol.sort!(r)).toBe(Date.parse("2026-10-30T11:15:00Z"));
  render(<>{ageCol.render(r)}</>);
  expect(screen.getByText("45m")).toBeInTheDocument();
});
