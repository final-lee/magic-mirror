import { describe, expect, it } from "vitest";
import { fallbackDescribe } from "./DescribeView";
import type { K8sObjectView } from "./types";

describe("fallback describe", () => {
  it("shows the existing summary, conditions, containers and events", () => {
    const view = {
      kind: { kind: "Pod" },
      row: { name: "web", namespace: "demo", values: { Status: "Pending" } },
      conditions: [{ type: "Ready", status: "False", reason: "Waiting", message: "not ready" }],
      containers: [{ name: "app", image: "example:v1", state: "waiting", reason: "Pulling" }],
      events: [{ type: "Warning", reason: "Failed", message: "pull failed", count: 2 }],
    } as unknown as K8sObjectView;
    const output = fallbackDescribe(view);
    expect(output).toContain("Name: web");
    expect(output).toContain("Namespace: demo");
    expect(output).toContain("Status: Pending");
    expect(output).toContain("Ready: False (Waiting) not ready");
    expect(output).toContain("app: example:v1 waiting (Pulling)");
    expect(output).toContain("Warning Failed pull failed (2)");
  });
});
