import { invoke } from "../../api/invoke";
import type { ChangeLogEntry, DynamoChange, DynamoPreview, Target } from "./types";
export const changeApi = {
  preview: (target: Target, change: DynamoChange) => invoke<DynamoPreview>("dynamo_preview", { ...target, change }),
  apply: (target: Target, change: DynamoChange, confirmName: string | null, undoOf: string | null) => invoke<{ message: string }>("dynamo_apply", { ...target, change, confirmName, undoOf }),
  changes: (target: Target) => invoke<ChangeLogEntry[]>("dynamo_changes", { ...target }),
  undoPreview: (target: Target, id: string) => invoke<[DynamoChange, DynamoPreview]>("dynamo_undo_preview", { ...target, id }),
};
