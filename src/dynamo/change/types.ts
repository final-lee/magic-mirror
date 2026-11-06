export type DynamoChange =
  | { kind: "ttl"; enabled: boolean; attribute: string }
  | { kind: "pitr"; enabled: boolean; days: number | null }
  | { kind: "deletionProtection"; enabled: boolean }
  | { kind: "stream"; enabled: boolean; viewType: string | null }
  | { kind: "tableClass"; class: string }
  | { kind: "billing"; mode: "onDemand" | "provisioned"; read: number | null; write: number | null; indexes: { name: string; read: number; write: number }[] }
  | { kind: "contributorInsights"; enabled: boolean }
  | { kind: "createBackup"; name: string }
  | { kind: "deleteBackup"; arn: string }
  | { kind: "restoreBackup"; arn: string; target: string }
  | { kind: "restorePitr"; time: string | null; target: string }
  | { kind: "exportS3"; bucket: string; prefix: string; format: string; time: string | null };
export interface Target { profile: string; region: string; table: string }
export interface DynamoPreview { title: string; calls: { api: string; params: unknown }[]; diff: unknown; impact: string[]; warnings: string[]; blocked: string | null; confirmName: string | null; inverse: DynamoChange | null }
export interface ChangeLogEntry { id: string; at: string; kind: string; summary: string; calls: string[]; ok: boolean; error: string | null; reversible: boolean; undone: boolean; undoOf: string | null; restoredTable: string | null }
