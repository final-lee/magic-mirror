import type { SqsChange } from "../types";

export function sqsChangeTone(change: SqsChange): "primary" | "danger" | "caution" {
  if (change.kind === "purge" || change.kind === "deleteMessages") return "danger";
  if (change.kind === "cancelMoveTask") return "caution";
  return "primary";
}
