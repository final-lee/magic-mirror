import { invoke } from "@tauri-apps/api/core";
import type {
  AccessKeyInfo,
  AccessLevel,
  ActionGrant,
  ApplyResult,
  ChangeLogEntry,
  ChangePreview,
  Findings,
  IamChange,
  IamOverview,
  LastAccessed,
  PolicyRef,
  PolicyView,
  PrincipalView,
  SimulateResult,
  ValidationResult,
  WhoCanResult,
} from "./types";

// 명령 이름과 인자 이름은 설계 문서의 "계약"과 같아야 한다(Tauri가 camelCase 인자를 snake_case로 바꿔 준다).
export const iamApi = {
  // 읽기
  overview: (profile: string, force: boolean) => invoke<IamOverview>("iam_overview", { profile, force }),
  principal: (profile: string, arn: string) => invoke<PrincipalView>("iam_principal", { profile, arn }),
  principalActions: (profile: string, arn: string, prefix: string, level: AccessLevel) =>
    invoke<ActionGrant[]>("iam_principal_actions", { profile, arn, prefix, level }),
  policy: (profile: string, policyId: string) => invoke<PolicyView>("iam_policy", { profile, policyId }),
  actions: () => invoke<string[]>("iam_actions"),
  whoCan: (profile: string, action: string, resource: string | null) =>
    invoke<WhoCanResult>("iam_who_can", { profile, action, resource }),
  simulate: (profile: string, principalArns: string[], action: string, resource: string | null) =>
    invoke<SimulateResult[]>("iam_simulate", { profile, principalArns, action, resource }),
  findings: (profile: string) => invoke<Findings>("iam_findings", { profile }),
  accessKeys: (profile: string, userName: string) => invoke<AccessKeyInfo[]>("iam_access_keys", { profile, userName }),
  lastAccessed: (profile: string, arn: string) => invoke<LastAccessed>("iam_last_accessed", { profile, arn }),
  listPolicies: (profile: string, query: string) => invoke<PolicyRef[]>("iam_list_policies", { profile, query }),
  validatePolicy: (profile: string, document: string) =>
    invoke<ValidationResult>("iam_validate_policy", { profile, document }),
  // 쓰기 (모든 변경은 preview → 확인 → apply)
  preview: (profile: string, change: IamChange) => invoke<ChangePreview>("iam_preview", { profile, change }),
  apply: (profile: string, change: IamChange, confirmText: string | null, undoOf: string | null) =>
    invoke<ApplyResult>("iam_apply", { profile, change, confirmText, undoOf }),
  changeLog: () => invoke<ChangeLogEntry[]>("iam_change_log"),
  undoChange: (entryId: string) => invoke<IamChange>("iam_undo_change", { entryId }),
};
