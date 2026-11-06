import { classifyGenerated, countChanges } from "./appSetDiff";
import { groupProgress } from "./appSetProgress";
import { addSubscription, removeSubscription, subscriptionsOf } from "./notifications";
import type { AppSetApp, GeneratedApp } from "./types";

const gen = (name: string, yaml: string): GeneratedApp => ({ name, namespace: "argocd", project: "default", destination: null, sources: [], yaml });
const live = (name: string, yaml: string): AppSetApp => ({ name, namespace: "argocd", yaml });

test("generated apps are classified as added, removed, changed or same, and the differences come first", () => {
  const changes = classifyGenerated(
    [gen("web-new", "a: 1\n"), gen("web-same", "a: 1\n"), gen("web-edit", "a: 2\n")],
    [live("web-same", "a: 1\n"), live("web-edit", "a: 1\n"), live("web-gone", "a: 1\n")],
  );
  expect(changes.map((c) => [c.name, c.kind])).toEqual([
    ["web-new", "added"],
    ["web-gone", "removed"],
    ["web-edit", "changed"],
    ["web-same", "same"],
  ]);
  const edit = changes.find((c) => c.name === "web-edit");
  expect([edit?.before, edit?.after]).toEqual(["a: 1\n", "a: 2\n"]);
  expect(changes.find((c) => c.name === "web-gone")).toMatchObject({ before: "a: 1\n", after: null, generated: null });
  expect(changes.find((c) => c.name === "web-new")).toMatchObject({ before: null, after: "a: 1\n" });
  expect(countChanges(changes)).toEqual({ added: 1, removed: 1, changed: 1, same: 1 });
});

test("apps with the same name in another namespace are different apps", () => {
  const changes = classifyGenerated([gen("web", "a: 1\n")], [{ name: "web", namespace: "other", yaml: "a: 1\n" }]);
  expect(changes.map((c) => c.kind).sort()).toEqual(["added", "removed"]);
});

test("progressive sync steps collect the apps of their step number", () => {
  const status = (application: string, step: string | null) => ({ application, status: "Waiting", step, message: null, lastTransitionTime: null });
  const steps = groupProgress({
    strategy: { kind: "RollingSync", steps: [{ matches: ["env In stg"], maxUpdate: null }, { matches: [], maxUpdate: "25%" }] },
    applicationStatus: [status("b", "2"), status("a", "1"), status("c", "2"), status("x", null)],
  });
  expect(steps.map((s) => [s.step, s.apps.map((a) => a.application)])).toEqual([[1, ["a"]], [2, ["b", "c"]]]);
  expect(groupProgress({ strategy: null, applicationStatus: [status("a", "1")] })).toEqual([]);
});

const NOTIFY = "notifications.argoproj.io/subscribe.";

test("subscriptions are read from the annotations and everything else is ignored", () => {
  const found = subscriptionsOf({
    [`${NOTIFY}on-sync-failed.slack`]: "alerts;ops",
    [`${NOTIFY}on-deployed.email`]: "me@example.com",
    "argocd.argoproj.io/refresh": "normal",
    [`${NOTIFY}broken`]: "x",
  });
  expect(found).toEqual([
    { key: `${NOTIFY}on-deployed.email`, trigger: "on-deployed", service: "email", recipients: "me@example.com" },
    { key: `${NOTIFY}on-sync-failed.slack`, trigger: "on-sync-failed", service: "slack", recipients: "alerts;ops" },
  ]);
  expect(subscriptionsOf(undefined)).toEqual([]);
});

test("a known trigger name containing dots splits where the server says", () => {
  const [s] = subscriptionsOf({ [`${NOTIFY}on.deployed.slack`]: "ch" }, ["on.deployed"]);
  expect([s.trigger, s.service]).toEqual(["on.deployed", "slack"]);
});

test("adding a subscription sets one annotation and removing it sets null", () => {
  expect(addSubscription("on-sync-failed", "slack", " alerts ")).toEqual({ metadata: { annotations: { [`${NOTIFY}on-sync-failed.slack`]: "alerts" } } });
  expect(removeSubscription(`${NOTIFY}on-sync-failed.slack`)).toEqual({ metadata: { annotations: { [`${NOTIFY}on-sync-failed.slack`]: null } } });
});
