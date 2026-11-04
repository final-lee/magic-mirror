import { render, screen } from "@testing-library/react";
import { grant } from "./fixtures";
import { PathLine, pathKey, uniquePaths, viaText } from "./paths";
import { SESSION_DEPENDENT, aggregatedFrom, viaDefault, viaGroup } from "./text";

test("grants with the same route are shown once, in their first-seen order", () => {
  const a = grant("dev");
  const sameRoute = { ...grant("dev"), rule: { ...a.rule, verbs: ["list"] } };
  const other = grant("prod");
  expect(uniquePaths([a, sameRoute, other])).toEqual([a, other]);
  expect(pathKey(a)).not.toBe(pathKey(grant("dev", { via: { kind: "group", group: "devs" } })));
  expect(pathKey(a)).not.toBe(pathKey(grant("dev", { aggregatedFrom: "x" })));
});

test("every way of receiving a permission has its own words", () => {
  expect(viaText({ kind: "group", group: "devs" })).toBe(viaGroup("devs"));
  expect(viaText({ kind: "defaultGroup", group: "system:authenticated" })).toBe(viaDefault("system:authenticated"));
  expect(viaText({ kind: "accessPolicy", policy: "arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy" })).toContain("AmazonEKSViewPolicy");
  expect(viaText({ kind: "builtin", group: "system:masters" })).toContain("system:masters");
});

test("a path line names the binding, the role, where it was aggregated from and the scope", () => {
  render(<PathLine grant={grant("dev", { aggregatedFrom: "system:aggregate-to-view", sessionDependent: true })} />);
  expect(screen.getByText("RoleBinding dev/b")).toBeInTheDocument();
  expect(screen.getByText("ClusterRole view")).toBeInTheDocument();
  expect(screen.getByText(`(${aggregatedFrom("system:aggregate-to-view")})`)).toBeInTheDocument();
  expect(screen.getByText(/네임스페이스 dev/)).toBeInTheDocument();
  expect(screen.getByText(SESSION_DEPENDENT)).toBeInTheDocument();
});
