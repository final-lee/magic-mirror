import { render, screen } from "@testing-library/react";
import { CommandPalette } from "../../keymap/CommandPalette";
import { COMMANDS, KEYBINDINGS } from "../../keymap/keybindings";
import { ShortcutsDialog } from "../../keymap/ShortcutsDialog";
import { resetKeymap } from "../../keymap/registry";
import { CONFIGMAPS, DAEMONSETS, DEPLOYMENTS, JOBS, NODES, PODS, REPLICASETS, SERVICES, STATEFULSETS } from "../kinds";
import { applies, isScalable, pressRow, type RowCommand } from "./rowKeys";
import { KEY_LOADING, KEY_NO_SELECTION, KEY_NOT_AVAILABLE } from "./text";

beforeEach(() => resetKeymap());

describe("which kinds a key applies to", () => {
  const cases: [RowCommand, string[], string[]][] = [
    ["k8s.logs", ["Pod", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "Service"], ["ConfigMap", "Node"]],
    ["k8s.shell", ["Pod", "Deployment", "StatefulSet"], ["DaemonSet", "Service", "Node"]],
    ["k8s.attach", ["Pod"], ["Deployment", "Service"]],
    ["k8s.forward", ["Pod", "Service"], ["Deployment", "Node"]],
    ["k8s.restart", ["Deployment", "StatefulSet", "DaemonSet"], ["Pod", "ReplicaSet", "Job"]],
    ["k8s.cordon", ["Node"], ["Pod"]],
    ["k8s.uncordon", ["Node"], ["Pod"]],
    ["k8s.describe", ["Pod", "ConfigMap", "Node"], []],
    ["k8s.yaml", ["Pod", "ConfigMap", "Node"], []],
    ["k8s.edit", ["Pod", "ConfigMap", "Node"], []],
    ["k8s.delete", ["Pod", "ConfigMap", "Node"], []],
  ];
  const byName = Object.fromEntries([PODS, DEPLOYMENTS, STATEFULSETS, DAEMONSETS, REPLICASETS, JOBS, SERVICES, CONFIGMAPS, NODES].map((k) => [k.kind, k]));
  test.each(cases)("%s", (command, yes, no) => {
    for (const k of yes) expect(applies(command, byName[k]), `${command} on ${k}`).toBe(true);
    for (const k of no) expect(applies(command, byName[k]), `${command} on ${k}`).toBe(false);
  });

  test("a same-named kind from another group is not the built-in one", () => {
    expect(applies("k8s.restart", { ...DEPLOYMENTS, group: "mm.example.com" })).toBe(false);
    expect(applies("k8s.cordon", { ...NODES, group: "mm.example.com" })).toBe(false);
    expect(isScalable({ ...STATEFULSETS, group: "x.io" })).toBe(false);
  });
});

describe("pressing without what the key needs", () => {
  const object = { kind: PODS, namespace: "prod", name: "web" };
  test("no selection, a detail that is not there yet, and a control that is missing explain themselves", () => {
    expect(pressRow("k8s.yaml", document.body, null)).toBe(KEY_NO_SELECTION);
    expect(pressRow("k8s.yaml", document.body, object)).toBe(KEY_LOADING);
    expect(pressRow("k8s.yaml", null, object)).toBe(KEY_LOADING);
    const pane = document.createElement("div");
    pane.innerHTML = '<aside class="k8s-detail"><div role="tablist"></div></aside>';
    expect(pressRow("k8s.logs", pane, object)).toBe(KEY_LOADING);
    expect(pressRow("k8s.delete", pane, object)).toBe(KEY_LOADING);
  });

  test("a disabled button gives its own reason, or a plain one when it has none, and is never clicked", () => {
    const pane = document.createElement("div");
    pane.innerHTML = '<aside class="k8s-detail"><button data-k8s-action="delete" disabled title="삭제 권한이 없어요"></button></aside>';
    const click = vi.fn();
    pane.querySelector("button")!.addEventListener("click", click);
    expect(pressRow("k8s.delete", pane, object)).toBe("삭제 권한이 없어요");
    pane.querySelector("button")!.removeAttribute("title");
    expect(pressRow("k8s.delete", pane, object)).toBe(KEY_NOT_AVAILABLE);
    expect(click).not.toHaveBeenCalled();
  });
});

describe("the shortcut sheet and the command palette list the keys", () => {
  const k8sCommands = Object.entries(COMMANDS).filter(([, c]) => c.scope === "k8s").map(([id]) => id);

  test("every EKS key has a named command", () => {
    for (const b of KEYBINDINGS.filter((x) => x.scope === "k8s")) expect(COMMANDS[b.command], `${b.key} → ${b.command}`).toBeDefined();
    expect(KEYBINDINGS.filter((b) => b.scope === "k8s").map((b) => b.key)).toEqual(
      expect.arrayContaining([":", "/", "j", "k", "g", "shift+g", "d", "y", "e", "l", "s", "a", "shift+f", "r", "c", "u", "ctrl+d", "0"]),
    );
  });

  test("the shortcut sheet shows them under their own EKS heading with the key caps", () => {
    render(<ShortcutsDialog onClose={() => {}} />);
    const section = screen.getByRole("region", { name: "EKS" });
    for (const cap of [":", "/", "J", "K", "G", "⇧G", "D", "Y", "E", "L", "S", "A", "⇧F", "R", "C", "U", "⌃D", "0"]) {
      expect(section.querySelector("kbd:not(:empty)") && Array.from(section.querySelectorAll("kbd")).some((k) => k.textContent === cap), cap).toBe(true);
    }
  });

  test("the palette lists a command only while something handles it", () => {
    render(<CommandPalette onRun={() => {}} onClose={() => {}} />);
    for (const id of k8sCommands) expect(screen.queryByText(COMMANDS[id].title)).toBeNull();
  });
});
