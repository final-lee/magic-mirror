import { fireEvent, render, screen, within } from "@testing-library/react";
import { GotoBar } from "./GotoBar";
import type { Goto, GotoContext } from "./goto";
import { HISTORY_MAX, loadHistory, pushHistory } from "./history";
import { TEST_KINDS } from "./testKinds";

const ctx: GotoContext = { kinds: TEST_KINDS, namespaces: ["default", "kube-system", "prod"] };

beforeEach(() => localStorage.clear());

function open() {
  const onGo = vi.fn<(g: Goto) => void>();
  const onClose = vi.fn<(went: boolean) => void>();
  const ui = <GotoBar ctx={ctx} onGo={onGo} onClose={onClose} />;
  const r = render(ui);
  const input = () => screen.getByRole("textbox", { name: "이동 명령" }) as HTMLInputElement;
  const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
  const key = (k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(input(), { key: k, ...init });
  return { onGo, onClose, input, type, key, rerender: () => r.rerender(ui), unmount: r.unmount };
}
const options = () => screen.queryAllByRole("option").map((o) => within(o).getAllByText(/./)[0].textContent);

test("the prompt takes the cursor and offers completions as you type", () => {
  const { input, type } = open();
  expect(input()).toHaveFocus();
  type("dep");
  expect(options()[0]).toBe("deployments");
  type("zzzq");
  expect(options()).toEqual([]);
  expect(screen.getByText("맞는 종류나 메뉴가 없어요")).toBeInTheDocument();
});

test("Enter on an exact name goes there, remembers it, and closes", () => {
  const { onGo, onClose, type, key } = open();
  type("deploy");
  key("Enter");
  expect(onGo).toHaveBeenCalledWith({ type: "kind", kind: expect.objectContaining({ plural: "deployments" }) });
  expect(onClose).toHaveBeenCalledWith(true);
  expect(loadHistory()).toEqual(["deploy"]);
});

test("Enter on a partial name does not guess: it says what was close and stays open", () => {
  const { onGo, onClose, type, key } = open();
  type("dep");
  key("Enter");
  expect(onGo).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("'dep'");
  expect(loadHistory()).toEqual([]);
  // 글자를 고치면 안내는 사라진다
  type("deploy");
  expect(screen.queryByRole("alert")).toBeNull();
});

test("Tab fills the best completion, Tab again the next one, Shift+Tab goes back, and typing starts over", () => {
  const { input, type, key } = open();
  type("po");
  const list = options();
  key("Tab");
  expect(input().value).toBe(list[0]);
  const first = input().value;
  key("Tab");
  expect(input().value).toBe(options()[1]);
  expect(input().value).not.toBe(first);
  key("Tab", { shiftKey: true });
  expect(input().value).toBe(first);
  key("Tab", { shiftKey: true });
  expect(input().value).toBe(options()[options().length - 1]);
  expect(screen.getAllByRole("option").filter((o) => o.getAttribute("aria-selected") === "true")).toHaveLength(1);
  type("svc");
  expect(input().value).toBe("svc");
});

test("Tab then Enter goes to the filled name", () => {
  const { onGo, type, key } = open();
  type("dep");
  key("Tab");
  key("Enter");
  expect(onGo).toHaveBeenCalledWith({ type: "kind", kind: expect.objectContaining({ plural: "deployments" }) });
});

test("Esc closes without going anywhere and is not passed on", () => {
  const { onGo, onClose, input } = open();
  const outer = vi.fn();
  document.addEventListener("keydown", outer);
  fireEvent.keyDown(input(), { key: "Escape" });
  document.removeEventListener("keydown", outer);
  expect(onClose).toHaveBeenCalledWith(false);
  expect(onGo).not.toHaveBeenCalled();
  expect(outer).not.toHaveBeenCalled();
});

test("the ✕ closes, and so does moving the cursor out of the prompt", () => {
  const { onClose } = open();
  fireEvent.click(screen.getByRole("button", { name: "이동 명령 닫기" }));
  expect(onClose).toHaveBeenCalledWith(false);
  onClose.mockClear();
  fireEvent.blur(screen.getByRole("textbox", { name: "이동 명령" }), { relatedTarget: document.body });
  expect(onClose).toHaveBeenCalledWith(false);
});

test("clicking a completion goes there without losing the cursor first", () => {
  const { onGo, type } = open();
  type("sv");
  const option = screen.getAllByRole("option")[0];
  expect(fireEvent.mouseDown(option)).toBe(false);
  fireEvent.click(option);
  expect(onGo).toHaveBeenCalledWith({ type: "kind", kind: expect.objectContaining({ plural: "services" }) });
});

test("choosing ambiguous kinds by click or Tab preserves the selected group and history", () => {
  const a = { ...TEST_KINDS[1], group: "one.example", kind: "Widget", plural: "widgets", singularName: "widget", shortNames: [], custom: true };
  const b = { ...a, group: "two.example" };
  const onGo = vi.fn();
  render(<GotoBar ctx={{ kinds: [a, b], namespaces: [] }} onGo={onGo} onClose={() => {}} />);
  const input = screen.getByRole("textbox", { name: "이동 명령" });
  fireEvent.change(input, { target: { value: "widgets" } });
  const options = screen.getAllByRole("option");
  const second = options.find((option) => option.textContent?.includes("two.example"))!;
  fireEvent.click(second);
  expect(onGo).toHaveBeenLastCalledWith({ type: "kind", kind: expect.objectContaining({ group: "two.example" }) });
  expect(loadHistory()[0]).toBe("widgets.two.example");
  fireEvent.keyDown(input, { key: "Tab" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onGo).toHaveBeenLastCalledWith({ type: "kind", kind: expect.objectContaining({ group: "one.example" }) });
});

describe(":ns", () => {
  test("completes namespaces after ns and a space, and Enter switches", () => {
    const { onGo, onClose, type, key, input } = open();
    type("ns ");
    expect(options()).toEqual(["all", "default", "kube-system", "prod"]);
    type("ns kub");
    key("Tab");
    expect(input().value).toBe("ns kube-system");
    key("Enter");
    expect(onGo).toHaveBeenCalledWith({ type: "namespace", namespace: "kube-system" });
    expect(onClose).toHaveBeenCalledWith(true);
  });

  test("ns all means every namespace, an unknown one is refused and stays open", () => {
    const first = open();
    first.type("ns all");
    first.key("Enter");
    expect(first.onGo).toHaveBeenCalledWith({ type: "namespace", namespace: "" });
    first.unmount();
    const second = open();
    second.type("ns nope");
    second.key("Enter");
    expect(second.onGo).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("네임스페이스 'nope'");
  });
});

describe("history", () => {
  test("an empty prompt lists the recent commands, newest first, and clicking one runs it", () => {
    pushHistory("pods");
    pushHistory("ns prod");
    pushHistory("helm");
    const { onGo } = open();
    const items = within(screen.getByRole("list", { name: "최근 명령" })).getAllByRole("listitem").map((li) => li.firstChild?.textContent);
    expect(items).toEqual(["helm", "ns prod", "pods"]);
    fireEvent.click(screen.getByText("ns prod"));
    expect(onGo).toHaveBeenCalledWith({ type: "namespace", namespace: "prod" });
    // 실행한 것이 맨 앞으로
    expect(loadHistory()[0]).toBe("ns prod");
  });

  test("↑ walks back through the commands, ↓ forward again and back to what was being typed", () => {
    pushHistory("pods");
    pushHistory("helm");
    pushHistory("ns prod");
    const { input, type, key } = open();
    type("dep");
    key("ArrowUp");
    expect(input().value).toBe("ns prod");
    key("ArrowUp");
    expect(input().value).toBe("helm");
    key("ArrowUp");
    expect(input().value).toBe("pods");
    // 맨 끝에서 더 올라가도 그대로
    key("ArrowUp");
    expect(input().value).toBe("pods");
    key("ArrowDown");
    expect(input().value).toBe("helm");
    key("ArrowDown");
    key("ArrowDown");
    expect(input().value).toBe("dep");
    // 되돌아온 뒤 ↓는 아무것도 하지 않는다
    key("ArrowDown");
    expect(input().value).toBe("dep");
  });

  test("with no history ↑↓ do nothing, and a failed command is not remembered", () => {
    const { input, type, key } = open();
    key("ArrowUp");
    expect(input().value).toBe("");
    type("nonsense");
    key("Enter");
    expect(loadHistory()).toEqual([]);
  });

  test("the same command is kept once, and only the latest ones are kept", () => {
    pushHistory("pods");
    pushHistory("helm");
    pushHistory(":pods ");
    expect(loadHistory()).toEqual(["pods", "helm"]);
    for (let i = 0; i < HISTORY_MAX + 5; i++) pushHistory(`c${i}`);
    expect(loadHistory()).toHaveLength(HISTORY_MAX);
    expect(loadHistory()[0]).toBe(`c${HISTORY_MAX + 4}`);
    pushHistory("   ");
    expect(loadHistory()[0]).toBe(`c${HISTORY_MAX + 4}`);
  });

  test("a damaged saved history is ignored", () => {
    localStorage.setItem("mm.k8s.goto-history", "{not json");
    expect(loadHistory()).toEqual([]);
    localStorage.setItem("mm.k8s.goto-history", JSON.stringify(["ok", 5, null]));
    expect(loadHistory()).toEqual(["ok"]);
  });
});
