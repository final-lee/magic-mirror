import type { K8sChange } from "./types";

type Entry = { change: K8sChange; undoOf: string | null; create?: boolean };
export type ChangeTone = "primary" | "create" | "warn" | "caution" | "danger";

/** 확인 단계의 적용 버튼 색: 없애기 > 멈춤·되돌림 > (모두 만들기면) 만들기 > 상태 변경 > 실행. 섞인 묶음은 가장 무거운 것을 따른다. */
export function changeTone(entries: readonly Entry[], undo = false): ChangeTone {
  if (entries.some(({ change }) => change.type === "delete" || change.type === "drain" || change.type === "helmUninstall" || change.type === "accessEntryDelete" || change.type === "accessPolicyDisassociate" || (change.type === "bindingSubjects" && change.remove.length > 0))) return "danger";
  if (undo || entries.some(({ change, undoOf }) => undoOf !== null || change.type === "rolloutUndo" || change.type === "helmRollback" || (change.type === "suspend" && change.suspend))) return "caution";
  if (entries.length > 0 && entries.every(({ change, create }) => create || change.type === "helmInstall" || change.type === "bindingCreate" || change.type === "accessEntryCreate" || change.type === "recreate")) return "create";
  if (entries.some(({ change }) => change.type === "scale" || change.type === "restart" || change.type === "cordon" || change.type === "suspend")) return "warn";
  return "primary";
}
