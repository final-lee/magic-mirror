import { Fragment, useCallback, useEffect, useState } from "react";
import { desktop } from "../api/desktop";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "../api/errors";
import { useSettings } from "../api/queries";
import { ErrorState } from "../components/ErrorState";
import { DiagnoseTargetProvider } from "../tailscale/DiagnoseContext";
import { ArgoServerEditor, ArgoServerForm } from "../argocd/ArgoServerEditor";
import { ArgoSteps } from "../argocd/ArgoSteps";
import { ArgoTokenForm } from "../argocd/ArgoTokenForm";
import { argowfApi } from "./api";
import {
  CATALOG_POLL_MS,
  argowfKeys,
  isForbidden,
  isTokenError,
  NO_INFO,
  useArgoWfInfo,
  useArgoWfSession,
  useCrons,
  useTemplates,
  useWorkflowPages,
} from "./queries";
import {
  ARGOWF_APIDOCS,
  ARGOWF_CONTEXT_REJECTED,
  ARGOWF_HELP,
  ARGOWF_HELP_URL,
  ARGOWF_PICK_NAMESPACE,
  ARGOWF_TOKEN_INVALID,
  ARGOWF_TOKEN_MISSING,
} from "./text";
import { WorkflowList } from "./WorkflowList";
import { WorkflowDetail } from "./WorkflowDetail";
import { CronList } from "./CronList";
import { CronDetail } from "./CronDetail";
import { TemplateList } from "./TemplateList";
import { TemplateDetail } from "./TemplateDetail";
import { ArchiveList } from "./ArchiveList";
import { Findings } from "./FindingsView";
import { EventBindings } from "./EventBindings";
import { EventFlow } from "./EventFlow";
import { EventSources } from "./EventSources";
import { ManifestEditor } from "./ManifestEditor";
import { NamespaceBox } from "./NamespaceBox";
import { PluginsView } from "./PluginsView";
import { Reports } from "./Reports";
import { Sensors } from "./Sensors";
import { UserInfoView } from "./UserInfoView";
import { expandLink, linksFor } from "./links";
import { emptyQuery } from "./wfQuery";
import type { LabelPick } from "../argocd/argoFilter";
import type { ArgoWfConn, ArgoWfInfo, ArgoWfSession, ArgoWfViewState, TemplateKind, WfTarget } from "./types";

type Detail =
  | { type: "workflow"; target: WfTarget }
  | { type: "cron"; namespace: string; name: string }
  | { type: "template"; kind: TemplateKind; namespace: string | null; name: string };
type Menu =
  | "Workflows"
  | "CronWorkflows"
  | "템플릿"
  | "보관함"
  | "Reports"
  | "Event Flow"
  | "Event Sources"
  | "Sensors"
  | "Event Bindings"
  | "점검"
  | "User Info"
  | "Plugins";
/** 왼쪽 메뉴: Workflow 쪽 · Argo Events 쪽 · 신원과 서버 쪽으로 묶는다 */
const MENU_GROUPS: Menu[][] = [
  ["Workflows", "CronWorkflows", "템플릿", "보관함", "Reports", "점검"],
  ["Event Flow", "Event Sources", "Sensors", "Event Bindings"],
  ["User Info", "Plugins"],
];
type Editor = { mode: "create" | "resubmit"; namespace: string | null; initialYaml?: string };

export function ArgoWfTab({ active }: { active: boolean }) {
  const { settings, update, isError, error } = useSettings();
  const qc = useQueryClient();
  const servers = settings?.argoWorkflowsServers ?? [];
  const [selected, setSelected] = useState("");
  const server = servers.find((s) => s.url === selected) ?? servers[0] ?? null;
  const url = server?.url ?? "";
  const contexts = useQuery({
    queryKey: ["argowf", "contexts"],
    queryFn: argowfApi.contexts,
    enabled: active && !!server,
    retry: false,
  });
  const ssoProfile = contexts.data?.find((context) => context.name === server?.context)?.ssoProfile ?? null;
  const session = useArgoWfSession({ url, context: server?.context ?? null }, ssoProfile, active && !!server && (!server.context || contexts.isFetched));
  const [forced, setForced] = useState<{ url: string; message: string | null } | null>(null);
  const [choose, setChoose] = useState(false);
  const [editing, setEditing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [contextChoice, setContextChoice] = useState("");
  const [tokenMode, setTokenMode] = useState(false);
  const onTokenError = useCallback(
    (message: string) => {
      if (message === ARGOWF_TOKEN_INVALID || message === ARGOWF_TOKEN_MISSING) setForced({ url, message });
    },
    [url],
  );
  const add = (s: { name: string; url: string }) => {
    update({ argoWorkflowsServers: [...servers, { ...s, context: null }] });
    setSelected(s.url);
    setChoose(true);
    setContextChoice("");
    setTokenMode(false);
    setEditing(false);
    setFailure(null);
  };
  const remove = (removed: string) => {
    const { [removed]: _removed, ...views } = settings?.argoWorkflowsViews ?? {};
    update({ argoWorkflowsServers: servers.filter((s) => s.url !== removed), argoWorkflowsViews: views });
    qc.removeQueries({ queryKey: argowfKeys.server(removed) });
    void argowfApi.forgetToken(removed).catch((e: unknown) => setFailure(errorMessage(e)));
  };
  const setContext = (context: string | null) => {
    if (!server) return;
    update({ argoWorkflowsServers: servers.map((s) => (s.url === url ? { ...s, context } : s)) });
    qc.removeQueries({ queryKey: argowfKeys.data(url) });
    setForced(null);
    setChoose(context === null);
    setFailure(null);
    setTokenMode(context === null);
  };
  const submit = async (token: string) => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await argowfApi.setToken(url, token);
      qc.removeQueries({ queryKey: argowfKeys.data(url) });
      qc.setQueryData(argowfKeys.session({ url, context: null }), result);
      setForced(null);
      setChoose(false);
    } catch (e) {
      setFailure(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const tokenError = isTokenError(session.error);
  const rejected = errorMessage(session.error) === ARGOWF_CONTEXT_REJECTED;
  const needsAuth = choose || forced?.url === url || session.data === null || tokenError || rejected;
  const conn: ArgoWfConn | null = server && session.data && !needsAuth ? { url, context: server.context, ssoProfile: session.data.ssoProfile } : null;
  const infoQuery = useArgoWfInfo(conn ?? { url, context: server?.context ?? null, ssoProfile: null }, conn !== null);
  useEffect(() => {
    if (infoQuery.error && isTokenError(infoQuery.error)) onTokenError(errorMessage(infoQuery.error));
  }, [infoQuery.error, onTokenError]);
  if (isError) return <div className="empty err">{errorMessage(error)}</div>;
  if (!settings) return <div className="empty">불러오는 중…</div>;
  const info = infoQuery.data ?? NO_INFO;
  const managed = info.managedNamespace || null;
  const namespace = managed ?? (server?.namespace || null);
  const patchServer = (patch: { namespace?: string | null; labelColumns?: string[] }) =>
    update({ argoWorkflowsServers: servers.map((s) => (s.url === url ? { ...s, ...patch } : s)) });
  const content = (
    <div className="argo argowf">
      {server && (
        <div className="argo-bar argo-top">
          <label>
            서버{" "}
            <select
              value={url}
              onChange={(e) => {
                setSelected(e.target.value);
                setForced(null);
                setChoose(false);
                setFailure(null);
              }}
            >
              {servers.map((s) => (
                <option key={s.url} value={s.url}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          {session.data && !needsAuth && (
            <span className="argo-session mono">
              {session.data.identity} · {session.data.version}
            </span>
          )}
          {conn && !infoQuery.isPending && <NamespaceBox conn={conn} value={namespace} lockedBy={managed} onCommit={(ns) => patchServer({ namespace: ns })} />}
          {session.data && !needsAuth && (
            <button className="btn small" onClick={() => setChoose(true)}>
              인증 변경
            </button>
          )}
          <button className="btn small k8s-push" onClick={() => setEditing(!editing)}>
            서버 편집
          </button>
        </div>
      )}
      {editing && <ArgoServerEditor servers={servers} onAdd={add} onRemove={remove} />}
      {!server ? (
        <div className="argo-token">
          <ArgoSteps step="server" />
          <p>Argo Server 주소를 넣어 주세요</p>
          <ArgoServerForm servers={servers} onAdd={add} submitLabel="다음" />
        </div>
      ) : needsAuth ? (
        <div className="argo-token">
          {tokenMode || (tokenError && !choose) || forced?.url === url ? (
            <>
              <ArgoTokenForm
                key={url}
                server={server}
                help="Argo Server API 토큰을 붙여 넣어요. 토큰은 이 Mac의 키체인에만 저장해요."
                message={failure ?? (forced?.url === url ? forced.message : null) ?? (tokenError ? errorMessage(session.error) : null)}
                busy={busy}
                onSubmit={(token) => void submit(token)}
                onCancel={() => {
                  setTokenMode(false);
                  setForced(null);
                  setChoose(true);
                }}
              />
              <button
                className="btn plain"
                onClick={() => {
                  setTokenMode(false);
                  setForced(null);
                  setChoose(true);
                }}
              >
                kubeconfig context로
              </button>
            </>
          ) : (
            <>
              <ol className="argo-steps" aria-label="연결 단계">
                <li>서버 주소</li>
                <li aria-current="step">인증</li>
              </ol>
              <p className="mono">
                {server.name} · {url}
              </p>
              <p>서버가 --auth-mode=client일 때 kubeconfig context의 신원으로 붙어요.</p>
              {server.url.toLowerCase().startsWith("http://") && (
                <p className="err" role="alert">
                  HTTP 연결은 인증 정보가 평문으로 전송돼요
                </p>
              )}
              {rejected && (
                <p className="err" role="alert">
                  {ARGOWF_CONTEXT_REJECTED}
                </p>
              )}
              {contexts.isError && <p className="err">{errorMessage(contexts.error)}</p>}
              <label>
                kubeconfig context
                <select aria-label="kubeconfig context" value={contextChoice || server.context || ""} onChange={(e) => setContextChoice(e.target.value)}>
                  <option value="">context 선택</option>
                  {contexts.data?.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name} · {c.cluster}
                    </option>
                  ))}
                </select>
              </label>
              <div className="argo-token-acts">
                <button
                  className="btn primary"
                  disabled={!(contextChoice || server.context)}
                  onClick={() => {
                    setContext(contextChoice || server.context);
                    setChoose(false);
                  }}
                >
                  연결
                </button>
                <button
                  className="btn plain"
                  onClick={() => {
                    setContext(null);
                    setForced({ url, message: null });
                  }}
                >
                  API 토큰으로
                </button>
                {session.data && choose && (
                  <button className="btn plain" onClick={() => setChoose(false)}>
                    취소
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      ) : session.isError ? (
        <div className="argowf-session-err">
          <ErrorState error={session.error} profile={ssoProfile ?? ""} onRetry={() => void session.refetch()} onLoggedIn={() => void session.refetch()} />
          <button className="btn small" onClick={() => setChoose(true)}>
            인증 변경
          </button>
        </div>
      ) : session.data && conn && !infoQuery.isPending ? (
        <Dashboard
          key={url}
          conn={conn}
          session={session.data}
          info={info}
          namespace={namespace}
          onNamespace={(ns) => patchServer({ namespace: ns })}
          labelColumns={server.labelColumns ?? []}
          onLabelColumns={(keys) => patchServer({ labelColumns: keys })}
          live={active}
          saved={settings.argoWorkflowsViews?.[url] ?? null}
          onSave={(view) => update({ argoWorkflowsViews: { ...settings.argoWorkflowsViews, [url]: view } })}
          onTokenError={onTokenError}
        />
      ) : (
        <div className="empty">불러오는 중…</div>
      )}
    </div>
  );
  return <DiagnoseTargetProvider value={url || null}>{content}</DiagnoseTargetProvider>;
}

function Dashboard({
  conn,
  session,
  info,
  namespace,
  onNamespace,
  labelColumns,
  onLabelColumns,
  live,
  saved,
  onSave,
  onTokenError,
}: {
  conn: ArgoWfConn;
  session: ArgoWfSession;
  info: ArgoWfInfo;
  /** 효과 네임스페이스(서버가 정한 것 > 설정). null이면 모든 네임스페이스 */
  namespace: string | null;
  onNamespace(ns: string | null): void;
  labelColumns: string[];
  onLabelColumns(keys: string[]): void;
  live: boolean;
  saved: ArgoWfViewState | null;
  onSave(v: ArgoWfViewState): void;
  onTokenError(m: string): void;
}) {
  const qc = useQueryClient();
  const [menu, setMenu] = useState<Menu>("Workflows");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [notice]);
  // 거르지 않은 첫 페이지: 요약·칩 개수·Cron/템플릿 이력·점검의 바탕. 실시간은 Workflows 목록이 따로 받는다
  const workflows = useWorkflowPages(conn, emptyQuery(namespace), live, { watch: false, pollMs: CATALOG_POLL_MS });
  const crons = useCrons(conn, namespace, live);
  const templates = useTemplates(conn, namespace, live);
  useEffect(() => {
    for (const e of [workflows.error, crons.error, templates.error]) if (e && isTokenError(e)) onTokenError(errorMessage(e));
  }, [workflows.error, crons.error, templates.error, onTokenError]);
  const ws = workflows.rows;
  const cs = (crons.data ?? []).filter((c) => !namespace || c.namespace === namespace);
  const ts = (templates.data ?? []).filter((t) => !namespace || t.namespace === null || t.namespace === namespace);
  const openWorkflow = (target: WfTarget) => setDetail({ type: "workflow", target });
  const openCron = (ns: string, name: string) => setDetail({ type: "cron", namespace: ns, name });
  const openTemplate = (kind: TemplateKind, ns: string | null, name: string) => setDetail({ type: "template", kind, namespace: ns, name });
  const pick = (m: Menu) => {
    setMenu(m);
    setDetail(null);
  };
  const filters = {
    phases: saved?.phases ?? [],
    namespaces: saved?.namespaces ?? [],
    sources: saved?.sources ?? [],
    labels: saved?.labels ?? [],
    mine: saved?.mine ?? false,
  };
  const addLabel = (p: LabelPick) => {
    const text = p.value === null ? p.key : `${p.key}=${p.value}`;
    if (!filters.labels.includes(text)) onSave({ ...filters, labels: [...filters.labels, text] });
    pick("Workflows");
  };
  const forbidden = namespace === null && workflows.isError && isForbidden(workflows.error);
  const apidocs = `${conn.url.replace(/\/+$/, "")}/apidocs`;
  return (
    <div className="argowf-workspace">
      <nav className="argowf-menu">
        {MENU_GROUPS.map((group, i) => (
          <Fragment key={group[0]}>
            {i > 0 && <div className="argowf-nav-gap" role="separator" />}
            {group.map((m) => (
              <button key={m} className="argowf-nav-item" aria-pressed={menu === m} onClick={() => pick(m)}>
                {m}
              </button>
            ))}
          </Fragment>
        ))}
        <div className="argowf-nav-gap" role="separator" />
        <button className="argowf-nav-item out" onClick={() => void desktop.openUrl(apidocs)}>
          {ARGOWF_APIDOCS}
        </button>
        <button className="argowf-nav-item out" onClick={() => void desktop.openUrl(ARGOWF_HELP_URL)}>
          {ARGOWF_HELP}
        </button>
        {linksFor(info.links, "chat").map((l) => (
          <button key={l.name} className="argowf-nav-item out" onClick={() => void desktop.openUrl(expandLink(l, {}))}>
            {l.name} ↗
          </button>
        ))}
      </nav>
      <main className="argowf-content">
        {workflows.isError && !forbidden && !isTokenError(workflows.error) && <p className="err">{errorMessage(workflows.error)}</p>}
        {notice && (
          <p role="status" className="argo-note">
            {notice}
          </p>
        )}
        {forbidden ? (
          <div className="argowf-pick" role="alert">
            <h3>{ARGOWF_PICK_NAMESPACE}</h3>
            <p className="dim">이 신원은 모든 네임스페이스를 읽을 권한이 없어요. 권한이 있는 네임스페이스 하나를 정해 주세요.</p>
            <NamespaceBox conn={conn} value={null} lockedBy={null} onCommit={onNamespace} />
          </div>
        ) : (
          <>
            {menu === "Workflows" && (
              <WorkflowList
                conn={conn}
                live={live}
                namespace={namespace}
                info={info}
                identity={session.identity}
                base={ws}
                crons={cs}
                saved={saved}
                labelColumns={labelColumns}
                onSave={onSave}
                onLabelColumns={onLabelColumns}
                onOpen={openWorkflow}
                onCreate={() => setEditor({ mode: "create", namespace })}
                onFindings={() => pick("점검")}
                onNotice={setNotice}
                onTokenError={onTokenError}
              />
            )}
            {menu === "CronWorkflows" && (
              <CronList
                conn={conn}
                live={live}
                namespace={namespace}
                workflows={ws}
                selected={detail?.type === "cron" ? detail : null}
                onOpen={openCron}
                onTokenError={onTokenError}
              />
            )}
            {menu === "템플릿" && (
              <TemplateList
                conn={conn}
                live={live}
                namespace={namespace}
                workflows={ws}
                crons={cs}
                selected={detail?.type === "template" ? detail : null}
                onOpen={openTemplate}
                onTokenError={onTokenError}
              />
            )}
            {menu === "보관함" && (
              <ArchiveList
                conn={conn}
                live={live}
                namespace={namespace}
                selected={detail?.type === "workflow" && detail.target.kind === "archived" ? detail.target.uid : null}
                onOpen={openWorkflow}
                onTokenError={onTokenError}
              />
            )}
            {menu === "Reports" && <Reports conn={conn} live={live} namespace={namespace} onOpenWorkflow={openWorkflow} onTokenError={onTokenError} />}
            {menu === "Event Flow" && (
              <EventFlow conn={conn} live={live} namespace={namespace} workflows={ws} onOpenWorkflow={openWorkflow} onTokenError={onTokenError} />
            )}
            {menu === "Event Sources" && <EventSources conn={conn} live={live} namespace={namespace} links={info.links} onTokenError={onTokenError} />}
            {menu === "Sensors" && <Sensors conn={conn} live={live} namespace={namespace} links={info.links} onTokenError={onTokenError} />}
            {menu === "Event Bindings" && (
              <EventBindings conn={conn} live={live} namespace={namespace} onOpenTemplate={openTemplate} onTokenError={onTokenError} />
            )}
            {menu === "점검" && (
              <Findings
                workflows={ws}
                crons={cs}
                templates={ts}
                now={Date.now()}
                onOpenWorkflow={openWorkflow}
                onOpenCron={openCron}
                onOpenTemplate={openTemplate}
              />
            )}
            {menu === "User Info" && <UserInfoView conn={conn} session={session} onTokenError={onTokenError} />}
            {menu === "Plugins" && <PluginsView conn={conn} session={session} namespace={namespace} live={live} onTokenError={onTokenError} />}
          </>
        )}
        {detail?.type === "workflow" && (
          <WorkflowDetail
            key={JSON.stringify(detail.target)}
            conn={conn}
            target={detail.target}
            live={live}
            kube={session.kube}
            info={info}
            onClose={() => setDetail(null)}
            onOpenWorkflow={openWorkflow}
            onOpenCron={openCron}
            onOpenTemplate={openTemplate}
            onLabelFilter={addLabel}
            onResubmitYaml={(ns, yaml) => setEditor({ mode: "resubmit", namespace: ns, initialYaml: yaml })}
            onTokenError={onTokenError}
            onNotice={setNotice}
          />
        )}
        {detail?.type === "cron" && (
          <CronDetail
            key={`${detail.namespace}/${detail.name}`}
            conn={conn}
            namespace={detail.namespace}
            name={detail.name}
            workflows={ws}
            live={live}
            onClose={() => setDetail(null)}
            onOpenWorkflow={openWorkflow}
            onOpenTemplate={openTemplate}
            onTokenError={onTokenError}
          />
        )}
        {detail?.type === "template" && (
          <TemplateDetail
            key={`${detail.kind}/${detail.namespace}/${detail.name}`}
            conn={conn}
            kind={detail.kind}
            namespace={detail.namespace}
            name={detail.name}
            workflows={ws}
            crons={cs}
            onClose={() => setDetail(null)}
            onOpenWorkflow={openWorkflow}
            onOpenCron={openCron}
            onTokenError={onTokenError}
          />
        )}
        {editor && (
          <div className="argowf-editor">
            <ManifestEditor
              conn={conn}
              kind="Workflow"
              mode={editor.mode}
              namespace={editor.namespace}
              initialYaml={editor.initialYaml}
              onClose={() => setEditor(null)}
              onSaved={(created) => {
                const ns = created.namespace ?? editor.namespace ?? namespace;
                setEditor(null);
                void qc.invalidateQueries({ queryKey: argowfKeys.data(conn.url) });
                setNotice(`${created.name}을(를) 만들었어요`);
                if (ns) {
                  setMenu("Workflows");
                  openWorkflow({ kind: "live", namespace: ns, name: created.name });
                }
              }}
            />
          </div>
        )}
      </main>
    </div>
  );
}
