import { invoke } from "../api/invoke";
import type { PolicyPreviewKind, PolicyRuleMatch, PolicySaveOutcome, PolicyValidation, TsPolicy } from "./policyTypes";
import type { TsKeyDeletePreview, TsKeyDeleted, TsKeys, TsLock } from "./keyTypes";
import type { TsAuditLog, TsFlowLogs, TsLogStream, TsLogType, TsWebhook } from "./logTypes";
import type { Change, Device, Preview, ResultItem } from "./devicesApi";
import type { TsApiConnection, TsApiStatus, TsCredential, TsDiagnosis, TsNode } from "./types";
import type { ShareRequest } from "./shareTypes";

export const tailscaleApi = {
  node: () => invoke<TsNode>("tailscale_node"),
  diagnose: (url: string) => invoke<TsDiagnosis>("tailscale_diagnose", { url }),
  diagnosticTool: (kind: string, value = "", recordType = "") =>
    invoke<string>("tailscale_diagnostic_tool", { kind, value, recordType }),
  localRead: (kind: string) => invoke<string>("tailscale_local_read", { kind }),
  localApply: (kind: string, value: string, tailnet: string) =>
    invoke<string>("tailscale_local_apply", { kind, value, tailnet }),
  lockHistory: () => invoke<string>("tailscale_lock_history"),
  lockInit: (keys: string[], count: number) => invoke<string>("tailscale_lock_init", { keys, count }),
  lockChange: (kind: string, value: string) => invoke<string>("tailscale_lock_change", { kind, value }),
  shareRead: (kind: string) => invoke<string>("tailscale_share_read", { kind }),
  sharePreview: (request: ShareRequest) => invoke<string[]>("tailscale_share_preview", { request }),
  shareApply: (request: ShareRequest) => invoke<string>("tailscale_share_apply", { request }),
  pickFiles: () => invoke<string[] | null>("tailscale_pick_files"),
  pickFolder: () => invoke<string | null>("tailscale_pick_folder"),
  acceptRoutes: (enabled: boolean) => invoke<null>("tailscale_accept_routes", { enabled }),
  apiStatus: (tailnet: string | null) => invoke<TsApiStatus>("tailscale_api_status", { tailnet }),
  /** 자격 증명으로 기기 목록을 읽어 확인한 뒤에만 키체인에 저장한다. 자격 증명은 이 호출의 인자로만 나간다. */
  apiConnect: (tailnet: string, credential: TsCredential) => invoke<TsApiConnection>("tailscale_api_connect", { tailnet, credential }),
  apiForget: (tailnet: string) => invoke<void>("tailscale_api_forget", { tailnet }),
  policy: (tailnet: string) => invoke<TsPolicy>("tailscale_policy", { tailnet }),
  policyPreview: (tailnet: string, kind: PolicyPreviewKind, subject: string, text: string) =>
    invoke<PolicyRuleMatch[]>("tailscale_policy_preview", { tailnet, kind, subject, text }),
  policyValidate: (tailnet: string, text: string) => invoke<PolicyValidation>("tailscale_policy_validate", { tailnet, text }),
  /** `etag`는 `before`를 읽을 때 받은 값. 그 사이 정책이 바뀌었으면 거절된다. */
  policySave: (tailnet: string, before: string, after: string, etag: string) =>
    invoke<PolicySaveOutcome>("tailscale_policy_save", { tailnet, before, after, etag }),
  keys: (tailnet: string) => invoke<TsKeys>("tailscale_keys", { tailnet }),
  keyDeletePreview: (tailnet: string, id: string) => invoke<TsKeyDeletePreview>("tailscale_key_delete_preview", { tailnet, id }),
  /** `typed`는 미리보기의 `confirmName`(키 ID). 다르면 거절된다. 지운 키는 되돌릴 수 없다. */
  keyDelete: (tailnet: string, id: string, typed: string) => invoke<TsKeyDeleted>("tailscale_key_delete", { tailnet, id, typed }),
  /** 이 Mac의 Tailnet Lock 상태. CLI가 없으면 null */
  lockStatus: () => invoke<TsLock | null>("tailscale_lock_status"),
  /** `days`는 1, 7, 30 */
  logsAudit: (tailnet: string, days: number) => invoke<TsAuditLog>("tailscale_logs_audit", { tailnet, days }),
  logsFlows: (tailnet: string) => invoke<TsFlowLogs>("tailscale_logs_flows", { tailnet }),
  logsStream: (tailnet: string, logType: TsLogType) => invoke<TsLogStream>("tailscale_logs_stream", { tailnet, logType }),
  webhooks: (tailnet: string) => invoke<TsWebhook[]>("tailscale_webhooks", { tailnet }),
  dns: (tailnet: string) => invoke<Record<string, unknown>>("tailscale_dns", { tailnet }),
  dnsSave: (tailnet: string, before: unknown, after: unknown) =>
    invoke<string | null>("tailscale_dns_save", { tailnet, before, after }),
  dnsSplitSave: (tailnet: string, before: unknown, after: unknown, patch: unknown) =>
    invoke<string | null>("tailscale_dns_split_save", { tailnet, before, after, patch }),
  settings: (tailnet: string, contacts: boolean) =>
    invoke<Record<string, unknown>>("tailscale_settings", { tailnet, contacts }),
  settingsSave: (tailnet: string, field: string, before: unknown, after: unknown) =>
    invoke<string | null>("tailscale_settings_save", { tailnet, field, before, after }),
  contactSave: (tailnet: string, kind: string, before: unknown, email: unknown) =>
    invoke<string | null>("tailscale_contact_save", { tailnet, kind, before, email }),
  users: (tailnet: string) => invoke<{ users: Record<string, unknown>[] | null }>("tailscale_users", { tailnet, invites: false }),
  userInvites: (tailnet: string) => invoke<Record<string, unknown>[] | null>("tailscale_users", { tailnet, invites: true }),
  userApply: (args: { tailnet: string; action: string; id: string; value: unknown; before: unknown; typed: string }) =>
    invoke<unknown>("tailscale_user_apply", args),
};

export const devicesApi = {
  list: (tailnet: string) => invoke<Device[]>("tailscale_devices", { tailnet }),
  preview: (tailnet: string, ids: string[], action: string, value: unknown) => invoke<Preview>("tailscale_device_preview", { tailnet, ids, action, value }),
  apply: (tailnet: string, preview: Preview, confirmText: string | null) => invoke<ResultItem[]>("tailscale_device_apply", { tailnet, preview, confirmText }),
  changes: (tailnet: string) => invoke<Change[]>("tailscale_changes", { tailnet }),
  undo: (tailnet: string, id: string) => invoke<void>("tailscale_undo", { tailnet, id }),
  extraList: (tailnet: string, id: string, invites: boolean) =>
    invoke<unknown>("tailscale_device_extra_list", { tailnet, id, invites }),
  extraApply: (args: { tailnet: string; action: string; id: string; body: unknown; before: unknown; typed: string }) =>
    invoke<unknown>("tailscale_device_extra_apply", args),
};
