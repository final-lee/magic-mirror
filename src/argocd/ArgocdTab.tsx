import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "../api/errors";
import { useSettings } from "../api/queries";
import { ErrorState } from "../components/ErrorState";
import { DiagnoseTargetProvider } from "../tailscale/DiagnoseContext";
import { argocdApi } from "./api";
import { ArgoServerEditor, ArgoServerForm } from "./ArgoServerEditor";
import { ArgoSteps } from "./ArgoSteps";
import { ArgoTokenForm } from "./ArgoTokenForm";
import { ArgoView } from "./ArgoView";
import { ArgoViewSwitcher, parseArgoView, type ArgoViewId } from "./ArgoViews";
import { argoKeys, isTokenError, useAppsWatch, useSession } from "./queries";
import { LOADING, SERVER_EDIT, SERVER_HELP, SERVER_LABEL, SERVER_NEXT, TOKEN_CHANGE, TOKEN_FORGET, sessionLine } from "./text";
import { ResourceSearch } from "./search/ResourceSearch";
import { useKubeContexts, withKubeContext } from "./ops/queries";
import { MetricsView } from "./metrics/MetricsView";
import { useArgoNotifier } from "./notify/useArgoNotifier";
import type { ArgoJump, ArgoOpenRequest, ArgocdServer, ArgoResourceFocus, ArgoViewState } from "./types";

const EMPTY_VIEW: ArgoViewState = { sync: [], health: [], envs: [], clusters: [], projects: [], labels: [], groupBy: null, thenBy: null };

/** 토큰 폼을 띄울 서버와, 그 폼에 먼저 보일 이유(없으면 null) */
interface Forced {
  url: string;
  message: string | null;
}

/**
 * ArgoCD 탭. 처음에는 서버 주소(1단계) → API 토큰(2단계) 순으로 연결하고, 그 뒤로는 서버를 골라 Application 목록을 본다.
 * 서버 목록은 설정에, 토큰은 백엔드가 키체인에 둔다. 토큰은 폼 안에서만 들고 있다가 보내고 이 탭에는 남기지 않는다.
 */
export function ArgocdTab({ active, jump, onJumpDone }: { active: boolean; jump?: ArgoJump | null; onJumpDone?: () => void }) {
  const { settings, update, isError: settingsFailed, error: settingsFailure } = useSettings();
  const qc = useQueryClient();
  const servers: ArgocdServer[] = settings?.argocdServers ?? [];
  const [selected, setSelected] = useState("");
  const server = servers.find((s) => s.url === selected) ?? servers[0] ?? null;
  const url = server?.url ?? "";
  const session = useSession(url, active && server !== null);
  const [forced, setForced] = useState<Forced | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const kubeContexts = useKubeContexts(editing);

  const onTokenError = useCallback((message: string) => setForced({ url, message }), [url]);

  const sessionTokenError = isTokenError(session.error);
  const needsToken = forced?.url === url || session.data === null || sessionTokenError;
  // 알림이 켜져 있으면 탭이 가려져 있어도 스트림을 열어 둬서 Degraded·작업 실패·OutOfSync 지속을 알린다
  const notifier = useArgoNotifier(server);
  useAppsWatch(url, (active || notifier.enabled) && !!session.data && !needsToken, notifier.listen);
  const reason = failure ?? (forced?.url === url ? forced.message : null) ?? (sessionTokenError ? errorMessage(session.error) : null);

  const selectServer = (next: string) => {
    setSelected(next);
    setFailure(null);
  };

  // 화면 전환: 서버마다 마지막으로 연 화면을 설정에 남긴다. 눌러서 바꾼 것은 설정이 돌아오기 전에도 바로 보이게 따로 쥔다.
  const [chosen, setChosen] = useState<Record<string, ArgoViewId>>({});
  const view = chosen[url] ?? parseArgoView(settings?.argocdViews?.[url]?.view);
  const chooseView = (next: ArgoViewId) => {
    setChosen((c) => ({ ...c, [url]: next }));
    update({ argocdViews: { ...settings?.argocdViews, [url]: { ...(settings?.argocdViews?.[url] ?? EMPTY_VIEW), view: next } } });
  };

  // 앱 목록 화면에 보내는 "이 앱(과 리소스)을 열어 주세요" 요청. 검색 화면과 ⌘K(jump)가 만든다. 앱 목록 화면이 받으면 비운다.
  const [request, setRequest] = useState<(ArgoOpenRequest & { url: string }) | null>(null);
  const nonce = useRef(0);
  const openApp = useCallback((target: string, app: { namespace: string; name: string }, resource: ArgoResourceFocus | null, history = false) => {
    setChosen((c) => ({ ...c, [target]: "apps" }));
    setRequest({ url: target, namespace: app.namespace, name: app.name, resource, tab: history ? "history" : undefined, nonce: ++nonce.current });
  }, []);
  useEffect(() => {
    if (!jump) return;
    selectServer(jump.url);
    openApp(jump.url, jump, jump.resource);
    onJumpDone?.();
  }, [jump]);

  // 새로 넣은 서버를 곧바로 골라 2단계(토큰)로 넘어간다
  const addServer = (added: ArgocdServer) => {
    update({ argocdServers: [...servers, added] });
    selectServer(added.url);
  };

  // 목록에서 빼면 그 서버의 토큰도 키체인에서 지우고, 그 서버의 필터·묶기 기억도 버린다
  const removeServer = (removed: string) => {
    const { [removed]: _dropped, ...views } = settings?.argocdViews ?? {};
    update({ argocdServers: servers.filter((s) => s.url !== removed), argocdViews: views });
    qc.removeQueries({ queryKey: argoKeys.server(removed) });
    argocdApi.forgetToken(removed).catch((e: unknown) => setFailure(errorMessage(e)));
  };

  const submitToken = async (token: string) => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await argocdApi.setToken(url, token);
      // 이전 토큰으로 읽은 목록과 오류는 버린다
      qc.removeQueries({ queryKey: argoKeys.data(url) });
      qc.setQueryData(argoKeys.session(url), result);
      setForced((f) => (f?.url === url ? null : f));
    } catch (e) {
      setFailure(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const forget = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await argocdApi.forgetToken(url);
      qc.removeQueries({ queryKey: argoKeys.data(url) });
      qc.setQueryData(argoKeys.session(url), null);
      setForced({ url, message: null });
    } catch (e) {
      setFailure(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (settingsFailed) return <div className="empty err">{errorMessage(settingsFailure)}</div>;
  if (!settings) return <div className="empty">{LOADING}</div>;

  let body: ReactNode;
  if (server === null) {
    body = (
      <div className="argo-token">
        <ArgoSteps step="server" />
        <p>{SERVER_HELP}</p>
        <ArgoServerForm servers={servers} onAdd={addServer} submitLabel={SERVER_NEXT} />
      </div>
    );
  } else if (needsToken) {
    // 토큰이 아직 쓸 만할 때(내가 바꾸려고 연 폼)만 닫을 수 있다. 쿼리가 토큰 오류를 보고했다면 닫아도 같은 오류가 되풀이된다.
    const cancelable = !!session.data && forced?.url === url && forced.message === null && failure === null;
    body = <ArgoTokenForm key={url} server={server} message={reason} busy={busy} onSubmit={(token) => void submitToken(token)} onCancel={cancelable ? () => setForced(null) : undefined} />;
  } else if (session.isError) {
    body = <ErrorState error={session.error} profile="" compact onRetry={() => void session.refetch()} />;
  } else if (session.data) {
    body = (
      <>
        <div className="argo" hidden={view !== "apps"}>
          <ArgoView
            key={url}
            url={url}
            live={active && view === "apps"}
            onTokenError={onTokenError}
            saved={settings.argocdViews?.[url] ?? null}
            onSave={(state) => update({ argocdViews: { ...settings.argocdViews, [url]: { ...state, view: settings.argocdViews?.[url]?.view } } })}
            open={request?.url === url ? request : null}
            onOpened={() => setRequest(null)}
          />
        </div>
        {view === "resources" && <ResourceSearch key={url} url={url} live={active} onOpen={(app, resource) => openApp(url, app, resource)} />}
        {view === "metrics" && <MetricsView key={url} url={url} live={active} onOpen={(row) => openApp(url, row, null)} />}
      </>
    );
  } else {
    body = <div className="empty">{LOADING}</div>;
  }

  const content = (
    <div className="argo">
      {server !== null && (
        <div className="argo-bar argo-top">
          <label className="k8s-field">
            {SERVER_LABEL}
            <select value={url} onChange={(e) => selectServer(e.target.value)}>
              {servers.map((s) => (
                <option key={s.url} value={s.url}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          {session.data && !needsToken && <span className="argo-session mono">{sessionLine(session.data.username, session.data.version)}</span>}
          {session.data && !needsToken && <ArgoViewSwitcher view={view} onChange={chooseView} />}
          {session.data && !needsToken && (
            <>
              <button className="btn small tone-warn" onClick={() => setForced({ url, message: null })}>
                {TOKEN_CHANGE}
              </button>
              <button className="btn small tone-danger" disabled={busy} onClick={() => void forget()}>
                {TOKEN_FORGET}
              </button>
            </>
          )}
          <button className="btn small k8s-push tone-secondary" aria-expanded={editing} onClick={() => setEditing(!editing)}>
            {SERVER_EDIT}
          </button>
        </div>
      )}
      {editing && server !== null && (
        <ArgoServerEditor
          servers={servers}
          onAdd={addServer}
          onRemove={removeServer}
          kubeContexts={kubeContexts.data}
          onKubeContext={(target, context) => update({ argocdServers: servers.map((s) => (s.url === target ? withKubeContext(s, context) : s)) })}
        />
      )}
      {body}
    </div>
  );
  return <DiagnoseTargetProvider value={url || null}>{content}</DiagnoseTargetProvider>;
}
