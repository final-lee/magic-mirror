import type { DiffRow, DiffStats } from "../../explorer/types";
import type { ResRef } from "../types";
export interface ArgoTarget { namespace: string; name: string; project: string; env: string | null }
export interface Retry { limit: number; backoff?: { duration?: string; factor?: number; maxDuration?: string } }
export type ArgoChange =
  | { kind: "refresh"; hard: boolean }
  | { kind: "sync"; revision?: string | null; resources?: ResRef[] | null; prune: boolean; dryRun: boolean; applyOnly: boolean; force: boolean; serverSideApply: boolean; replace: boolean; pruneLast: boolean; createNamespace: boolean; applyOutOfSyncOnly: boolean; respectIgnoreDifferences: boolean; retry?: Retry | null }
  | { kind: "terminate" }
  | { kind: "rollback"; id: number; prune: boolean; dryRun: boolean; disableAutoSync: boolean }
  | { kind: "resourceAction"; res: ResRef; action: string; params: { name: string; value: string }[] }
  | { kind: "resourceActionBatch"; action: string; resources: ResRef[]; params: { name: string; value: string }[] }
  | { kind: "resourceDelete"; res: ResRef; force: boolean; orphan: boolean }
  | { kind: "resourcePatch"; res: ResRef; patch: string; patchType: string }
  | { kind: "appSpec"; yaml: string }
  | { kind: "appPatch"; patch: unknown }
  | { kind: "appDelete"; cascade: boolean; propagationPolicy: "foreground" | "background" | null }
  | { kind: "appCreate"; yaml: string; upsert: false }
  | { kind: "appSetUpsert"; yaml: string }
  | { kind: "appSetDelete"; name: string; namespace: string }
  | { kind: "appSetRefresh" };
export interface ApiCall { verb: string; path: string; body: unknown }
export interface TextDiff { rows: DiffRow[]; hunks: number[]; stats: DiffStats }
export interface ArgoPreview { title: string; calls: ApiCall[]; diff: TextDiff | null; impact: string[]; warnings: string[]; blocked: string | null; confirmName: string | null; expectedVersion: string | null }
export interface ArgoApplyResult { message: string }
export interface ArgoChangeRecord { at: string; server: string; user: string | null; namespace: string; name: string; kind: string; summary: string; calls: ApiCall[]; ok: boolean; error: string | null }
export interface ArgoServerSettings { url: string | null; execEnabled: boolean; statusBadgeEnabled: boolean; statusBadgeRootUrl: string | null; appLabelKey: string | null }
