import { useCallback, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "../api/errors";
import { useSettings } from "../api/queries";
import { argocdApi } from "./api";
import { ArgoServerEditor } from "./ArgoServerEditor";
import { ArgoTokenForm } from "./ArgoTokenForm";
import { ArgoView } from "./ArgoView";
import { argoKeys, isTokenError, useSession } from "./queries";
import { DEFAULT_SERVERS } from "./servers";
import { LOADING, RETRY, SERVER_EDIT, SERVER_LABEL, TOKEN_CHANGE, TOKEN_FORGET, sessionLine } from "./text";
import type { ArgocdServer } from "./types";

/** 토큰 폼을 띄울 서버와, 그 폼에 먼저 보일 이유(없으면 null) */
interface Forced {
  url: string;
  message: string | null;
}

/**
 * ArgoCD 탭: 서버를 고르고(목록은 설정에 저장), 토큰이 있으면 Application 목록을, 없으면 토큰 폼을 보인다.
 * 토큰은 폼 안에서만 들고 있다가 백엔드로 보내고(키체인에 저장), 이 탭에는 남기지 않는다.
 */
export function ArgocdTab({ active }: { active: boolean }) {
  const { settings, update, isError: settingsFailed, error: settingsFailure } = useSettings();
  const qc = useQueryClient();
  const servers: ArgocdServer[] = settings?.argocdServers?.length ? settings.argocdServers : DEFAULT_SERVERS;
  const [selected, setSelected] = useState("");
  const url = (servers.find((s) => s.url === selected) ?? servers[0]).url;
  const session = useSession(url, active && !!settings);
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
  if (needsToken) {
    // 토큰이 아직 쓸 만할 때(내가 바꾸려고 연 폼)만 닫을 수 있다. 쿼리가 토큰 오류를 보고했다면 닫아도 같은 오류가 되풀이된다.
    const cancelable = !!session.data && forced?.url === url && forced.message === null && failure === null;
    body = <ArgoTokenForm key={url} url={url} message={reason} busy={busy} onSubmit={(token) => void submitToken(token)} onCancel={cancelable ? () => setForced(null) : undefined} />;
  } else if (session.isError) {
    body = (
      <div className="error-banner">
        <p className="err">{errorMessage(session.error)}</p>
        <button className="btn" onClick={() => void session.refetch()}>
          {RETRY}
        </button>
      </div>
    );
  } else if (session.data) {
    body = <ArgoView key={url} url={url} live={active} onTokenError={onTokenError} />;
  } else {
    body = <div className="empty">{LOADING}</div>;
  }

  return (
    <div className="argo">
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
            <button className="btn small" onClick={() => setForced({ url, message: null })}>
              {TOKEN_CHANGE}
            </button>
            <button className="btn small" disabled={busy} onClick={() => void forget()}>
              {TOKEN_FORGET}
            </button>
          </>
        )}
        <button className="btn small k8s-push" aria-expanded={editing} onClick={() => setEditing(!editing)}>
          {SERVER_EDIT}
        </button>
      </div>
      {editing && <ArgoServerEditor servers={servers} onChange={(next) => update({ argocdServers: next })} />}
      {body}
    </div>
  );
}
