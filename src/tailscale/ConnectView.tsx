import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { errorMessage } from "../api/errors";
import { useSettings } from "../api/queries";
import { tailscaleApi } from "./api";
import * as t from "./text";
import type { TsApiConnection, TsApiKind, TsCredential, TsNode } from "./types";
import { apiStatusKey, useApiStatus } from "./useTailscaleApi";

const KIND_NAME: Record<TsApiKind, string> = { oauth: t.KIND_OAUTH, token: t.KIND_TOKEN };

const suffixKey = (suffix: string) => suffix.trim().replace(/\.$/, "").toLowerCase();

interface FormProps {
  initialTailnet: string;
  initialKind: TsApiKind;
  busy: boolean;
  error: string | null;
  onSubmit: (tailnet: string, credential: TsCredential) => void;
  /** 주면 "취소" 버튼을 보인다(이미 연결돼 있을 때 폼을 닫는다) */
  onCancel?: () => void;
}

/** 자격 증명 입력 폼. 값은 이 폼의 상태에만 있고, 연결에 성공하면 폼과 함께 사라진다. */
function ConnectForm({ initialTailnet, initialKind, busy, error, onSubmit, onCancel }: FormProps) {
  const [tailnet, setTailnet] = useState(initialTailnet);
  const [kind, setKind] = useState<TsApiKind>(initialKind);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [token, setToken] = useState("");

  const credential: TsCredential =
    kind === "oauth" ? { kind, clientId: clientId.trim(), clientSecret: clientSecret.trim() } : { kind, token: token.trim() };
  const complete = tailnet.trim() !== "" && (credential.kind === "oauth"
    ? credential.clientId !== "" && credential.clientSecret !== ""
    : credential.token !== "");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (complete && !busy) onSubmit(tailnet.trim(), credential);
  };

  return (
    <form className="ts-connect-form" onSubmit={submit}>
      <p>{t.CONNECT_HELP}</p>
      <label>
        {t.TAILNET_LABEL}
        <input value={tailnet} onChange={(e) => setTailnet(e.target.value)} autoComplete="off" spellCheck={false} />
      </label>
      <fieldset>
        <legend>{t.KIND_LABEL}</legend>
        <label className="ts-radio">
          <input type="radio" name="ts-kind" checked={kind === "oauth"} onChange={() => setKind("oauth")} />
          {t.KIND_OAUTH} <span className="dim">({t.KIND_OAUTH_NOTE})</span>
        </label>
        <label className="ts-radio">
          <input type="radio" name="ts-kind" checked={kind === "token"} onChange={() => setKind("token")} />
          {t.KIND_TOKEN}
        </label>
      </fieldset>
      {kind === "oauth" ? (
        <>
          <p className="dim">{t.CONNECT_SCOPE_HELP}</p>
          <label>
            {t.CLIENT_ID}
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} />
          </label>
          <label>
            {t.CLIENT_SECRET}
            <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" spellCheck={false} />
          </label>
        </>
      ) : (
        <>
          <p className="dim">{t.CONNECT_TOKEN_HELP}</p>
          <label>
            {t.API_TOKEN}
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} />
          </label>
        </>
      )}
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      <div className="ts-connect-acts">
        <button className="btn small tone-primary" type="submit" disabled={busy || !complete}>
          {busy ? t.CONNECTING : t.CONNECT}
        </button>
        {onCancel && (
          <button className="btn small tone-ghost" type="button" onClick={onCancel} disabled={busy}>
            {t.CANCEL_CHANGE}
          </button>
        )}
      </div>
    </form>
  );
}

function ConnectResult({ result, mySuffix }: { result: TsApiConnection; mySuffix: string | null }) {
  const differs = result.magicDnsSuffix !== null && mySuffix !== null && suffixKey(result.magicDnsSuffix) !== suffixKey(mySuffix);
  return (
    <div className="ts-connect-result">
      <p>{t.connectResult(result.devices)}</p>
      <p>
        {t.MAGIC_DNS_RESULT}: {result.magicDnsSuffix ?? t.UNKNOWN}
      </p>
      {differs && (
        <p className="ts-warn" role="alert">
          {t.tailnetMismatch(mySuffix)}
        </p>
      )}
    </div>
  );
}

/** Tailscale API 자격 증명(키체인)을 연결·바꾸기·지우기. */
export function ConnectView({ node }: { node: TsNode }) {
  const qc = useQueryClient();
  const { update } = useSettings();
  const { tailnet, kind, isLoading, error: statusError } = useApiStatus();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<TsApiConnection | null>(null);

  if (isLoading) return <div className="empty">{t.API_LOADING}</div>;
  const connected = tailnet !== null && kind !== null;

  const connect = async (name: string, credential: TsCredential) => {
    setBusy(true);
    setFailure(null);
    try {
      const connection = await tailscaleApi.apiConnect(name, credential);
      // 설정에는 테일넷 하나만 둔다. 이전 테일넷의 자격 증명이 키체인에 남지 않게 지운다.
      if (tailnet !== null && tailnet !== name) await tailscaleApi.apiForget(tailnet);
      update({ tailscaleTailnet: name });
      await qc.invalidateQueries({ queryKey: apiStatusKey });
      setResult(connection);
      setEditing(false);
    } catch (e) {
      setFailure(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const forget = async () => {
    if (tailnet === null) return;
    setBusy(true);
    setFailure(null);
    try {
      await tailscaleApi.apiForget(tailnet);
      update({ tailscaleTailnet: null });
      await qc.invalidateQueries({ queryKey: apiStatusKey });
      setResult(null);
      setEditing(false);
    } catch (e) {
      setFailure(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!connected || editing) {
    return (
      <>
      <div className="awc-bar"><h2 className="awc-title">{t.TAB_CONNECT}</h2></div>
      <div className="awc-body"><div className="ts-connect">
        <ConnectForm
          initialTailnet={tailnet ?? node.tailnet ?? ""}
          initialKind={kind ?? "oauth"}
          busy={busy}
          error={failure ?? (statusError ? errorMessage(statusError) : null)}
          onSubmit={(name, credential) => void connect(name, credential)}
          onCancel={connected ? () => setEditing(false) : undefined}
        />
      </div></div>
      </>
    );
  }
  return (
    <>
    <div className="awc-bar"><h2 className="awc-title">{t.TAB_CONNECT}</h2></div>
    <div className="awc-body"><div className="ts-connect">
      <div className="ts-connect-status">
        <strong>{t.connected(tailnet, KIND_NAME[kind])}</strong>
        <button className="btn small tone-secondary" onClick={() => setEditing(true)} disabled={busy}>
          {t.CHANGE}
        </button>
        <button className="btn small tone-danger" onClick={() => void forget()} disabled={busy}>
          {t.FORGET}
        </button>
      </div>
      {failure && (
        <p className="err" role="alert">
          {failure}
        </p>
      )}
      {result && <ConnectResult result={result} mySuffix={node.magicDnsSuffix} />}
    </div></div>
    </>
  );
}
