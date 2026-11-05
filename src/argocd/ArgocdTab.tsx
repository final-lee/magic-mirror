import { useCallback, useState, type ReactNode } from "react";
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
import { argoKeys, isTokenError, useSession } from "./queries";
import { LOADING, SERVER_EDIT, SERVER_HELP, SERVER_LABEL, SERVER_NEXT, TOKEN_CHANGE, TOKEN_FORGET, sessionLine } from "./text";
import type { ArgocdServer } from "./types";

/** 토큰 폼을 띄울 서버와, 그 폼에 먼저 보일 이유(없으면 null) */
interface Forced {
  url: string;
  message: string | null;
}

/**
 * ArgoCD 탭. 처음에는 서버 주소(1단계) → API 토큰(2단계) 순으로 연결하고, 그 뒤로는 서버를 골라 Application 목록을 본다.
 * 서버 목록은 설정에, 토큰은 백엔드가 키체인에 둔다. 토큰은 폼 안에서만 들고 있다가 보내고 이 탭에는 남기지 않는다.
 */
export function ArgocdTab({ active }: { active: boolean }) {
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

  const onTokenError = useCallback((message: string) => setForced({ url, message }), [url]);

  const sessionTokenError = isTokenError(session.error);
  const needsToken = forced?.url === url || session.data === null || sessionTokenError;
  const reason = failure ?? (forced?.url === url ? forced.message : null) ?? (sessionTokenError ? errorMessage(session.error) : null);

  const selectServer = (next: string) => {
    setSelected(next);
    setFailure(null);
  };

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
      <ArgoView
        key={url}
        url={url}
        live={active}
        onTokenError={onTokenError}
        saved={settings.argocdViews?.[url] ?? null}
        onSave={(view) => update({ argocdViews: { ...settings.argocdViews, [url]: view } })}
      />
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
      {editing && server !== null && <ArgoServerEditor servers={servers} onAdd={addServer} onRemove={removeServer} />}
      {body}
    </div>
  );
  return <DiagnoseTargetProvider value={url || null}>{content}</DiagnoseTargetProvider>;
}
