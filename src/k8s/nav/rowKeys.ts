import { DEPLOYMENTS, STATEFULSETS, hasWorkloadLogs, isPod, isService } from "../kinds";
import type { K8sKindRef, ObjectRef } from "../types";
import {
  KEY_ALREADY_CORDONED, KEY_LOADING, KEY_NOT_AVAILABLE, KEY_NOT_CORDONED, KEY_NO_SELECTION, KEY_ONLY,
} from "./text";

/** 목록의 고른 행에 쓰는 한 글자 키의 명령 이름 */
export type RowCommand =
  | "k8s.describe"
  | "k8s.yaml"
  | "k8s.edit"
  | "k8s.logs"
  | "k8s.shell"
  | "k8s.attach"
  | "k8s.forward"
  | "k8s.restart"
  | "k8s.cordon"
  | "k8s.uncordon"
  | "k8s.delete";

const isNode = (k: K8sKindRef) => k.group === "" && k.kind === "Node";
const isRestartable = (k: K8sKindRef) => k.group === "apps" && ["Deployment", "StatefulSet", "DaemonSet"].includes(k.kind);
/** scale 미리보기가 있는 종류 */
export const isScalable = (k: K8sKindRef) => [DEPLOYMENTS, STATEFULSETS].some((s) => s.group === k.group && s.kind === k.kind);

/** 이 종류에서 쓸 수 있는 키인가. describe·yaml·edit·delete는 모든 종류 */
export function applies(command: RowCommand, kind: K8sKindRef): boolean {
  switch (command) {
    case "k8s.logs":
      return isPod(kind) || hasWorkloadLogs(kind);
    case "k8s.shell":
      return isPod(kind) || isScalable(kind);
    case "k8s.attach":
      return isPod(kind);
    case "k8s.forward":
      return isPod(kind) || isService(kind);
    case "k8s.restart":
      return isRestartable(kind);
    case "k8s.cordon":
    case "k8s.uncordon":
      return isNode(kind);
    default:
      return true;
  }
}

/** 상세의 탭 버튼 이름(`data-tab`) */
const TAB: Partial<Record<RowCommand, string>> = {
  "k8s.describe": "describe",
  "k8s.yaml": "yaml",
  "k8s.logs": "logs",
  "k8s.shell": "shell",
  "k8s.attach": "shell",
};

/** 상세 도구 줄 버튼의 이름(`data-k8s-action`) */
const ACTION: Partial<Record<RowCommand, string>> = {
  "k8s.edit": "edit",
  "k8s.restart": "restart",
  "k8s.cordon": "cordon",
  "k8s.uncordon": "uncordon",
  "k8s.delete": "delete",
};

const find = <T extends HTMLElement>(root: ParentNode, selector: string) => root.querySelector<T>(selector);
const action = (root: ParentNode, name: string) => find<HTMLButtonElement>(root, `[data-k8s-action="${name}"]`);

/** 막힌 단추의 이유(권한 없음 등)는 단추의 title에 있다 */
const blocked = (el: HTMLElement) => ((el as HTMLButtonElement).disabled ? el.getAttribute("title") || KEY_NOT_AVAILABLE : null);

/**
 * 한 글자 키를 상세의 단추를 누르는 것으로 처리한다. 바꾸는 동작은 단추와 똑같이 미리보기부터 연다.
 * 단추가 그 종류·권한·상태에서 정하는 규칙(없거나 막힘)이 그대로 키의 규칙이다.
 * 돌려주는 글은 하지 못한 이유(상태 줄에 보인다). 했으면 null.
 */
export function pressRow(command: RowCommand, pane: HTMLElement | null, object: ObjectRef | null): string | null {
  if (!object) return KEY_NO_SELECTION;
  if (!applies(command, object.kind)) return KEY_ONLY[command] ?? KEY_NOT_AVAILABLE;
  const detail = pane ? find(pane, ".k8s-detail") : null;
  if (!detail) return KEY_LOADING;

  // s: Pod는 셸 탭, Deployment·StatefulSet은 scale
  if (command === "k8s.shell" && !isPod(object.kind)) return pressScale(detail);
  const tab = TAB[command];
  if (tab) {
    const button = find<HTMLButtonElement>(detail, `[role="tab"][data-tab="${tab}"]`);
    if (!button) return KEY_LOADING;
    button.click();
    // 셸 탭: s는 셸, a는 attach로 방식을 맞춰 둔다(세션을 연 뒤에는 방식 칸이 없다). 여는 것은 단추와 확인 단계를 거친다
    const mode = command === "k8s.shell" ? "mode-exec" : command === "k8s.attach" ? "mode-attach" : null;
    if (mode) action(detail, mode)?.click();
    return null;
  }
  if (command === "k8s.forward") {
    const port = action(detail, "forward");
    if (!port) return KEY_LOADING;
    port.focus();
    return null;
  }

  const name = ACTION[command] ?? "";
  const button = action(detail, name);
  if (!button) {
    // 이미 편집 중이면 편집 단추 자리에 편집 도구 줄이 있다
    if (command === "k8s.edit" && find(detail, ".k8s-toolbar-slot")) return null;
    if (command === "k8s.cordon" && action(detail, "uncordon")) return KEY_ALREADY_CORDONED;
    if (command === "k8s.uncordon" && action(detail, "cordon")) return KEY_NOT_CORDONED;
    return KEY_LOADING;
  }
  const reason = blocked(button);
  if (reason) return reason;
  button.click();
  return null;
}

/** Deployment·StatefulSet의 s: 복제본 수 칸으로 가서 숫자를 고친 뒤 Enter로 미리보기를 연다 */
function pressScale(detail: HTMLElement): string | null {
  const replicas = action(detail, "replicas") as HTMLInputElement | null;
  const button = action(detail, "scale");
  if (!replicas || !button) return KEY_LOADING;
  const reason = blocked(button);
  // 숫자가 잘못돼 막힌 것은 칸에서 고치면 되므로 권한 때문에 막힌 것만 이유를 보인다
  if (reason && reason !== KEY_NOT_AVAILABLE) return reason;
  replicas.focus();
  replicas.select();
  return null;
}
