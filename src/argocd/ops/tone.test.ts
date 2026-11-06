import { describe, expect, it } from "vitest";
import { actionTone, changeTone } from "./tone";

describe("actionTone", () => {
  it.each([
    ["restart", "tone-warn"], ["resume", "tone-warn"], ["scale", "tone-warn"],
    ["promote-full", "tone-warn"], ["skip-current-step", "tone-warn"],
    ["pause", "tone-caution"], ["suspend", "tone-caution"], ["abort", "tone-caution"],
    ["retry", "tone-primary"], ["create-job", "tone-primary"], ["run", "tone-primary"],
    ["delete-pod", "tone-danger"], ["refresh", "tone-refresh"], ["unknown", "tone-secondary"],
  ])("maps %s to %s", (action, tone) => expect(actionTone(action)).toBe(tone));
});

it("colors an auto-sync toggle as a state change without changing other patches", () => {
  expect(changeTone({ kind: "appPatch", patch: { spec: { syncPolicy: { automated: null } } } })).toBe("tone-warn");
  expect(changeTone({ kind: "appPatch", patch: { spec: { project: "default" } } })).toBe("tone-primary");
});
