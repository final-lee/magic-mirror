import { invoke } from "../../api/invoke";
import type { ArgoApplyResult, ArgoChange, ArgoChangeRecord, ArgoPreview, ArgoServerSettings, ArgoTarget } from "./types";
export const changeApi = {
  preview: (url: string, target: ArgoTarget, change: ArgoChange) => invoke<ArgoPreview>("argocd_preview", { url, target, change }),
  apply: (url: string, target: ArgoTarget, change: ArgoChange, expectedVersion: string | null, confirmName: string | null) => invoke<ArgoApplyResult>("argocd_apply", { url, target, change, expectedVersion, confirmName }),
  changes: (url: string) => invoke<ArgoChangeRecord[]>("argocd_changes", { url }),
  can: (url: string, checks: { resource: string; action: string; object: string }[]) => invoke<boolean[]>("argocd_can", { url, checks }),
  settings: (url: string) => invoke<ArgoServerSettings>("argocd_settings", { url }),
};
