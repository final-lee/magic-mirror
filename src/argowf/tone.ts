export function workflowActionTone(action: string): string {
  switch (action) {
    case "delete":
    case "terminate": return "tone-danger";
    case "stop":
    case "suspend": return "tone-caution";
    case "resume":
    case "values":
    case "setOutputs": return "tone-warn";
    default: return "tone-primary";
  }
}
