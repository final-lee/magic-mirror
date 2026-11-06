import type { ArgoChange } from "../change/types";

export function actionTone(action: string): string {
  const name = action.toLowerCase();
  if (name.startsWith("delete")) return "tone-danger";
  if (["pause", "suspend", "abort"].includes(name)) return "tone-caution";
  if (["restart", "resume", "scale", "skip-current-step"].includes(name) || name.startsWith("promote")) return "tone-warn";
  if (["retry", "create-job", "run"].includes(name)) return "tone-primary";
  if (name === "refresh") return "tone-refresh";
  return "tone-secondary";
}

export function changeTone(change: ArgoChange): string {
  switch (change.kind) {
    case "resourceAction":
    case "resourceActionBatch": return actionTone(change.action);
    case "resourceDelete":
    case "appDelete":
    case "appSetDelete": return "tone-danger";
    case "rollback":
    case "terminate": return "tone-caution";
    case "refresh":
    case "appSetRefresh": return "tone-refresh";
    case "appCreate": return "tone-create";
    case "appPatch": {
      const patch = change.patch as { spec?: { syncPolicy?: { automated?: unknown } } } | null;
      if (patch?.spec?.syncPolicy && Object.prototype.hasOwnProperty.call(patch.spec.syncPolicy, "automated")) return "tone-warn";
      return "tone-primary";
    }
    default: return "tone-primary";
  }
}
