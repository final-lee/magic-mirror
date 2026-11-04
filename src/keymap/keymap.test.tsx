import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { eventKey, keyLabel, normalizeKey } from "./keys";
import { KEYBINDINGS } from "./keybindings";
import { evalWhen, resetKeymap, runCommand, useCommand, useKeymapListener } from "./registry";

beforeEach(() => resetKeymap());

test("key events become one notation: modifiers in order, letters lower-cased, shifted symbols as themselves", () => {
  expect(eventKey({ key: "F", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBe("cmd+f");
  expect(eventKey({ key: "R", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true })).toBe("shift+cmd+r");
  expect(eventKey({ key: ":", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true })).toBe(":");
  expect(eventKey({ key: "G", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true })).toBe("shift+g");
  expect(eventKey({ key: "Escape", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBe("cmd+escape");
  expect(eventKey({ key: "Shift", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true })).toBeNull();
  expect(normalizeKey("cmd+shift+R")).toBe("shift+cmd+r");
  expect([keyLabel("shift+cmd+r"), keyLabel("cmd+f"), keyLabel("f7"), keyLabel("ctrl+d"), keyLabel("escape")]).toEqual(["⇧⌘R", "⌘F", "F7", "⌃D", "⎋"]);
});

test("when clauses: && binds tighter than ||, ! negates", () => {
  const ctx: Record<string, boolean> = { a: true, b: false, c: true };
  const look = (k: string) => ctx[k] ?? false;
  expect(evalWhen(undefined, look)).toBe(true);
  expect(evalWhen("a && !b", look)).toBe(true);
  expect(evalWhen("b && a || c", look)).toBe(true);
  expect(evalWhen("b || !c", look)).toBe(false);
});

test("no two dispatcher bindings share a key in the same scope", () => {
  const seen: Record<string, string> = {};
  for (const b of KEYBINDINGS.filter((x) => x.handler === "registry")) {
    const id = `${b.scope}|${normalizeKey(b.key)}|${b.when ?? ""}`;
    expect(seen[id], `${b.key} → ${b.command} and ${seen[id]}`).toBeUndefined();
    seen[id] = b.command;
  }
});

function Host({ name, onRun, hidden = false, enabled = true }: { name: string; onRun: (n: string) => void; hidden?: boolean; enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useCommand("list.find", () => onRun(name), { host: ref, enabled });
  return (
    <div hidden={hidden}>
      <div ref={ref} data-testid={name}>
        <input aria-label={`${name} input`} />
        <button>{name}</button>
      </div>
    </div>
  );
}

function Root({ children }: { children: React.ReactNode }) {
  useKeymapListener();
  return <>{children}</>;
}

test("a command goes to the focused host, else the last pressed, else the last registered visible one; hidden hosts never", () => {
  const ran: string[] = [];
  const run = (n: string) => ran.push(n);
  render(
    <Root>
      <Host name="a" onRun={run} />
      <Host name="b" onRun={run} />
      <Host name="hidden" onRun={run} hidden />
      <Host name="off" onRun={run} enabled={false} />
    </Root>,
  );
  const press = () => fireEvent.keyDown(window, { key: "f", metaKey: true });
  press();
  expect(ran).toEqual(["b"]);
  fireEvent.pointerDown(screen.getByRole("button", { name: "a" }));
  press();
  expect(ran[ran.length - 1]).toBe("a");
  screen.getByRole("textbox", { name: "b input" }).focus();
  press();
  expect(ran[ran.length - 1]).toBe("b");
  expect(ran).not.toContain("hidden");
  expect(ran).not.toContain("off");
});

test("keys a component already handled, dialogs and missing handlers are left alone", () => {
  const ran: string[] = [];
  render(
    <Root>
      <Host name="a" onRun={(n) => ran.push(n)} />
    </Root>,
  );
  const input = screen.getByRole("textbox", { name: "a input" });
  input.addEventListener("keydown", (e) => e.preventDefault());
  fireEvent.keyDown(input, { key: "f", metaKey: true });
  expect(ran).toEqual([]);
  // 대화상자가 떠 있으면 ⌘F는 목록으로 가지 않는다
  const modal = document.createElement("div");
  modal.className = "modal";
  document.body.appendChild(modal);
  fireEvent.keyDown(window, { key: "f", metaKey: true });
  expect(ran).toEqual([]);
  modal.remove();
  expect(runCommand("app.refresh")).toBe(false);
});

function Nested({ onRun }: { onRun: (n: string) => void }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  // 바깥(목록 상자) 처리기가 나중에 등록돼도(부모 효과가 자식 뒤에 돈다) 포개진 안쪽이 이긴다
  useCommand("list.find", () => onRun("inner"), { host: inner });
  useCommand("list.find", () => onRun("outer"), { host: outer });
  return (
    <div ref={outer}>
      <button>list</button>
      <div ref={inner}>
        <input aria-label="log input" />
      </div>
    </div>
  );
}

test("nested hosts: focus inside the inner box goes to the inner handler, focus elsewhere in the outer box to the outer one", () => {
  const ran: string[] = [];
  render(
    <Root>
      <Nested onRun={(n) => ran.push(n)} />
    </Root>,
  );
  screen.getByRole("textbox", { name: "log input" }).focus();
  fireEvent.keyDown(window, { key: "f", metaKey: true });
  screen.getByRole("button", { name: "list" }).focus();
  fireEvent.keyDown(window, { key: "f", metaKey: true });
  expect(ran).toEqual(["inner", "outer"]);
});
