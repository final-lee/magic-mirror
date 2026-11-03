import { Channel } from "@tauri-apps/api/core";
import { invoke } from "../api/invoke";
import type {
  ArchivedAction,
  ArgoWfConn,
  ArgoWfInfo,
  ArgoWfServerRef,
  ArgoWfSession,
  ArgoWfUserInfo,
  ArtifactPreview,
  ArtifactRef,
  CronAction,
  CronDetail,
  CronRow,
  EventBindingRow,
  EventSourceRow,
  K8sEventRow,
  KubeContext,
  LintResult,
  ManifestKind,
  PluginRow,
  SensorRow,
  SubmitOptions,
  TemplateDetail,
  TemplateKind,
  TemplateRow,
  WfAction,
  WfBatchResult,
  WfDetail,
  WfDetailWatchEvent,
  WfListQuery,
  WfLogMessage,
  WfLogOptions,
  WfPage,
  WfWatchEvent,
} from "./types";

/** 명령 인자: 서버와, context 인증이면 exec 플러그인의 프로필(invoke가 SSO 만료를 그 프로필로 알린다, src/api/invoke.ts) */
const base = (conn: ArgoWfConn) => ({
  server: { url: conn.url, context: conn.context } satisfies ArgoWfServerRef,
  ...(conn.ssoProfile ? { profile: conn.ssoProfile } : {}),
});

/** 채널로 받는 흐름을 연다. 반환값은 stop에 넘기는 번호 */
function stream<T>(cmd: string, args: Record<string, unknown>, onMessage: (m: T) => void) {
  const onEvent = new Channel<T>();
  onEvent.onmessage = onMessage;
  return invoke<number>(cmd, { ...args, onEvent });
}

/** Argo Server 명령. AWS 프로필과 상관없다. 토큰은 setToken의 인자로만 나가고, copyToken만 사용자가 눌렀을 때 돌려준다. */
export const argowfApi = {
  contexts: () => invoke<KubeContext[]>("argowf_contexts"),
  setToken: (url: string, token: string) => invoke<ArgoWfSession>("argowf_set_token", { url, token }),
  forgetToken: (url: string) => invoke<void>("argowf_forget_token", { url }),
  /** ssoProfile: context의 exec 프로필(contexts()가 준다). 첫 연결에서 SSO가 만료됐어도 자동 로그인이 돈다 */
  session: (server: ArgoWfServerRef, ssoProfile: string | null) =>
    invoke<ArgoWfSession | null>("argowf_session", { server, ...(ssoProfile ? { profile: ssoProfile } : {}) }),
  info: (conn: ArgoWfConn) => invoke<ArgoWfInfo>("argowf_info", base(conn)),
  userInfo: (conn: ArgoWfConn) => invoke<ArgoWfUserInfo>("argowf_userinfo", base(conn)),
  /** CLI에 붙여 넣을 `Bearer …` 토큰(User Info의 [토큰 복사]). 화면은 클립보드에만 넣고 들고 있지 않는다 */
  copyToken: (conn: ArgoWfConn) => invoke<string>("argowf_copy_token", base(conn)),

  workflows: (conn: ArgoWfConn, query: WfListQuery) => invoke<WfPage>("argowf_workflows", { ...base(conn), query }),
  archived: (conn: ArgoWfConn, query: WfListQuery) => invoke<WfPage>("argowf_archived", { ...base(conn), query }),
  /** 목록 감시. resourceVersion은 목록 응답의 것(이어 붙인다) */
  watch: (conn: ArgoWfConn, namespace: string | null, labelSelector: string | null, resourceVersion: string | null, onMessage: (m: WfWatchEvent) => void) =>
    stream<WfWatchEvent>("argowf_watch", { ...base(conn), namespace, labelSelector, resourceVersion }, onMessage),
  /** resourceVersion: 막 읽은 상세의 것(가려졌다 돌아올 때 그 뒤부터 이어 받는다). null이면 지금부터 */
  watchWorkflow: (conn: ArgoWfConn, namespace: string, name: string, resourceVersion: string | null, onMessage: (m: WfDetailWatchEvent) => void) =>
    stream<WfDetailWatchEvent>("argowf_watch_workflow", { ...base(conn), namespace, name, resourceVersion }, onMessage),
  watchStop: (id: number) => invoke<void>("argowf_watch_stop", { id }),

  workflow: (conn: ArgoWfConn, namespace: string, name: string) => invoke<WfDetail>("argowf_workflow", { ...base(conn), namespace, name }),
  archivedWorkflow: (conn: ArgoWfConn, uid: string) => invoke<WfDetail>("argowf_archived_workflow", { ...base(conn), uid }),
  roleArn: (conn: ArgoWfConn, namespace: string, serviceAccount: string) =>
    invoke<string | null>("argowf_role_arn", { ...base(conn), namespace, serviceAccount }),
  events: (conn: ArgoWfConn, namespace: string, name: string) => invoke<K8sEventRow[]>("argowf_events", { ...base(conn), namespace, name }),

  /** 로그 흐름. 반환값은 logsStop에 넘기는 번호 */
  logs: (conn: ArgoWfConn, namespace: string, name: string, podName: string | null, options: WfLogOptions, onMessage: (m: WfLogMessage) => void) =>
    stream<WfLogMessage>("argowf_logs", { ...base(conn), namespace, name, podName, options }, onMessage),
  logsStop: (id: number) => invoke<void>("argowf_logs_stop", { id }),
  /** 저장 창을 띄워 글을 파일로 쓴다. 취소하면 null, 쓰면 경로 */
  saveText: (suggestedName: string, text: string) => invoke<string | null>("argowf_save_text", { suggestedName, text }),

  artifactPreview: (conn: ArgoWfConn, artifact: ArtifactRef) => invoke<ArtifactPreview>("argowf_artifact_preview", { ...base(conn), artifact }),
  /** 저장 창을 띄워 아티팩트를 내려받는다. 취소하면 null, 쓰면 경로 */
  saveArtifact: (conn: ArgoWfConn, artifact: ArtifactRef) => invoke<string | null>("argowf_save_artifact", { ...base(conn), artifact }),

  /** namespace: 고른 네임스페이스(null이면 모든 네임스페이스). 권한이 좁은 신원은 하나를 골라야 읽힌다 */
  crons: (conn: ArgoWfConn, namespace: string | null) => invoke<CronRow[]>("argowf_crons", { ...base(conn), namespace }),
  cron: (conn: ArgoWfConn, namespace: string, name: string) => invoke<CronDetail>("argowf_cron", { ...base(conn), namespace, name }),
  /** namespace: WorkflowTemplate만 그 네임스페이스로 읽는다(ClusterWorkflowTemplate은 늘 전부) */
  templates: (conn: ArgoWfConn, namespace: string | null) => invoke<TemplateRow[]>("argowf_templates", { ...base(conn), namespace }),
  template: (conn: ArgoWfConn, kind: TemplateKind, namespace: string | null, name: string) =>
    invoke<TemplateDetail>("argowf_template", { ...base(conn), kind, namespace, name }),

  /** resubmit·retry면 새로 만든(또는 다시 도는) Workflow 이름 */
  workflowAction: (conn: ArgoWfConn, namespace: string, name: string, action: WfAction) =>
    invoke<string | null>("argowf_workflow_action", { ...base(conn), namespace, name, action }),
  batchAction: (conn: ArgoWfConn, targets: { namespace: string; name: string }[], action: WfAction) =>
    invoke<WfBatchResult[]>("argowf_batch_action", { ...base(conn), targets, action }),
  archivedAction: (conn: ArgoWfConn, uid: string, namespace: string, action: ArchivedAction) =>
    invoke<string | null>("argowf_archived_action", { ...base(conn), uid, namespace, action }),
  /** submit이면 새 Workflow 이름 */
  cronAction: (conn: ArgoWfConn, namespace: string, name: string, action: CronAction) =>
    invoke<string | null>("argowf_cron_action", { ...base(conn), namespace, name, action }),
  /** 새 Workflow 이름(serverDryRun이면 만들어질 이름) */
  submitTemplate: (conn: ArgoWfConn, kind: TemplateKind, templateNamespace: string | null, namespace: string, name: string, options: SubmitOptions) =>
    invoke<string>("argowf_submit_template", { ...base(conn), kind, templateNamespace, namespace, name, options }),

  /** 편집용 YAML(status·managedFields 뺀 것) */
  manifest: (conn: ArgoWfConn, kind: ManifestKind, namespace: string | null, name: string) =>
    invoke<string>("argowf_manifest", { ...base(conn), kind, namespace, name }),
  lint: (conn: ArgoWfConn, kind: ManifestKind, namespace: string | null, yaml: string) =>
    invoke<LintResult>("argowf_lint", { ...base(conn), kind, namespace, yaml }),
  /** 만든 객체의 네임스페이스·이름. asNew면 서버가 가진 칸(name·resourceVersion·uid·status…)을 지우고 generateName으로 새로 만든다(YAML로 고쳐 다시 제출) */
  create: (conn: ArgoWfConn, kind: ManifestKind, namespace: string | null, yaml: string, asNew = false) =>
    invoke<{ namespace: string | null; name: string }>("argowf_create", { ...base(conn), kind, namespace, yaml, asNew }),
  update: (conn: ArgoWfConn, kind: ManifestKind, namespace: string | null, name: string, yaml: string) =>
    invoke<void>("argowf_update", { ...base(conn), kind, namespace, name, yaml }),
  remove: (conn: ArgoWfConn, kind: ManifestKind, namespace: string | null, name: string) =>
    invoke<void>("argowf_delete", { ...base(conn), kind, namespace, name }),

  eventBindings: (conn: ArgoWfConn, namespace: string | null) => invoke<EventBindingRow[]>("argowf_event_bindings", { ...base(conn), namespace }),
  eventSources: (conn: ArgoWfConn, namespace: string | null) => invoke<EventSourceRow[]>("argowf_event_sources", { ...base(conn), namespace }),
  sensors: (conn: ArgoWfConn, namespace: string | null) => invoke<SensorRow[]>("argowf_sensors", { ...base(conn), namespace }),
  /** EventSource·Sensor 로그 흐름. 반환값은 logsStop에 넘기는 번호 */
  resourceLogs: (conn: ArgoWfConn, kind: "EventSource" | "Sensor", namespace: string, name: string, onMessage: (m: WfLogMessage) => void) =>
    stream<WfLogMessage>("argowf_resource_logs", { ...base(conn), kind, namespace, name }, onMessage),
  plugins: (conn: ArgoWfConn, namespace: string | null) => invoke<PluginRow[]>("argowf_plugins", { ...base(conn), namespace }),
};
