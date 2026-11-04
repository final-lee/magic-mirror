import { fireEvent, render, screen, within } from "@testing-library/react";
import { useRef } from "react";
import type { K8sPlugin } from "../../api/types";
import { resetKeymap, useKeymapListener } from "../../keymap/registry";
import type { K8sKindRef, ObjectRef } from "../types";
import { PluginActions } from "./PluginActions";
import { PLUGIN_CANCEL, PLUGIN_INVALID, PLUGIN_MENU, PLUGIN_NONE, PLUGIN_RUN, pluginConfirmTitle } from "./text";

const POD: K8sKindRef = { group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true };
const DEPLOYMENT: K8sKindRef = { group: "apps", version: "v1", kind: "Deployment", plural: "deployments", namespaced: true };
const pod: ObjectRef = { kind: POD, namespace: "prod", name: "web-1" };

const logs: K8sPlugin = { name: "로그", description: "컨테이너 로그를 따라가요", kinds: [POD], command: "kubectl -n $NAMESPACE logs -f $NAME -c $CONTAINER", confirm: true, key: "ctrl+alt+l" };
const describe: K8sPlugin = { name: "describe", kinds: ["*"], command: "kubectl describe $KIND $NAME --context $CONTEXT", confirm: false, key: "q" };
const rollout: K8sPlugin = { name: "롤아웃", kinds: [DEPLOYMENT], command: "kubectl rollout status $KIND $NAME", confirm: true, key: "w" };

function Harness({ plugins, object = pod, onRun }: { plugins: K8sPlugin[]; object?: ObjectRef; onRun: (command: string, title: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  useKeymapListener();
  return (
    <div ref={host}>
      <input aria-label="입력칸" />
      <PluginActions plugins={plugins} context="prod-admin" objectRef={object} container="app" host={host} onRun={onRun} />
    </div>
  );
}

beforeEach(() => resetKeymap());

const openMenu = () => fireEvent.click(screen.getByRole("button", { name: new RegExp(PLUGIN_MENU) }));

test("the menu lists only the plugins for this kind, and says why it is empty when there are none", () => {
  const { rerender } = render(<Harness plugins={[logs, describe, rollout]} onRun={vi.fn()} />);
  openMenu();
  const menu = screen.getByRole("menu");
  expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["로그⌃⌥L", "describeQ"]);
  rerender(<Harness plugins={[rollout]} onRun={vi.fn()} />);
  const button = screen.getByRole("button", { name: new RegExp(PLUGIN_MENU) });
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("title", PLUGIN_NONE);
});

test("choosing a plugin shows the exact expanded command and runs it only after confirmation", () => {
  const onRun = vi.fn();
  render(<Harness plugins={[logs]} onRun={onRun} />);
  openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: /로그/ }));
  const dialog = screen.getByRole("dialog", { name: pluginConfirmTitle("로그") });
  // 값은 모두 셸 단일 인자로 인용되어 있다
  expect(within(dialog).getByText("kubectl -n 'prod' logs -f 'web-1' -c 'app'")).toBeInTheDocument();
  expect(within(dialog).getByText("prod-admin")).toBeInTheDocument();
  expect(within(dialog).getByText("컨테이너 로그를 따라가요")).toBeInTheDocument();
  expect(onRun).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: PLUGIN_CANCEL }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(onRun).not.toHaveBeenCalled();

  openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: /로그/ }));
  fireEvent.click(screen.getByRole("button", { name: PLUGIN_RUN }));
  expect(onRun).toHaveBeenCalledTimes(1);
  expect(onRun).toHaveBeenCalledWith("kubectl -n 'prod' logs -f 'web-1' -c 'app'", "로그");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("a value with quotes or shell syntax stays one quoted argument in what is confirmed and what runs", () => {
  const onRun = vi.fn();
  render(<Harness plugins={[describe]} object={{ kind: DEPLOYMENT, namespace: "prod", name: "a'b; rm -rf ~" }} onRun={onRun} />);
  openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: /describe/ }));
  // confirm=false: 확인 없이 바로 실행한다
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(onRun).toHaveBeenCalledWith("kubectl describe 'deployments.apps' 'a'\\''b; rm -rf ~' --context 'prod-admin'", "describe");
});

test("a plugin key opens the same confirmation for a plugin that supports this kind and is ignored for others", () => {
  const onRun = vi.fn();
  render(<Harness plugins={[logs, describe, rollout]} onRun={onRun} />);
  // 이 종류(Pod)에 쓸 수 없는 플러그인의 키는 아무 일도 없다
  fireEvent.keyDown(document.body, { key: "w" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(onRun).not.toHaveBeenCalled();
  fireEvent.keyDown(document.body, { key: "l", ctrlKey: true, altKey: true });
  expect(screen.getByRole("dialog", { name: pluginConfirmTitle("로그") })).toBeInTheDocument();
  expect(onRun).not.toHaveBeenCalled();
  // 대화상자가 열려 있는 동안에는 다른 플러그인 키가 듣지 않는다
  fireEvent.keyDown(document.body, { key: "q" });
  expect(onRun).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: PLUGIN_CANCEL }));
  // 확인을 끈 플러그인의 키는 바로 실행한다
  fireEvent.keyDown(document.body, { key: "q" });
  expect(onRun).toHaveBeenCalledWith("kubectl describe 'pods' 'web-1' --context 'prod-admin'", "describe");
});

test("a plugin key typed into an input field is not a plugin key", () => {
  const onRun = vi.fn();
  render(<Harness plugins={[describe]} onRun={onRun} />);
  const input = screen.getByLabelText("입력칸");
  input.focus();
  fireEvent.keyDown(input, { key: "q" });
  expect(onRun).not.toHaveBeenCalled();
});

test("a saved template that cannot be quoted safely is refused with the reason and nothing runs", () => {
  const onRun = vi.fn();
  render(<Harness plugins={[{ name: "나쁨", kinds: ["*"], command: "echo $(id) $NAME", confirm: false }]} onRun={onRun} />);
  openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: /나쁨/ }));
  expect(screen.getByRole("alert")).toHaveTextContent(PLUGIN_INVALID);
  expect(onRun).not.toHaveBeenCalled();
});
