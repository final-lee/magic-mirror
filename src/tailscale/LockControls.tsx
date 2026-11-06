import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "../api/errors";
import { desktop } from "../api/desktop";
import { useModal } from "../iam/useModal";
import { tailscaleApi } from "./api";
import type { TsLock } from "./keyTypes";
import * as t from "./lockControlsText";

interface Operation {
  kind: string;
  value: string;
  command: string;
  confirm?: string;
  init?: { keys: string[]; count: number };
}
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

function LockSheet({ operation, close, done }: { operation: Operation; close: () => void; done: () => void }) {
  const client = useQueryClient();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const dismiss = () => { if (!busy) close(); };
  const { sheetRef, trapTab } = useModal(dismiss);
  const apply = async () => {
    setBusy(true);
    try {
      const output = operation.init
        ? await tailscaleApi.lockInit(operation.init.keys, operation.init.count)
        : await tailscaleApi.lockChange(operation.kind, operation.value);
      setResult(output || t.DONE);
      done();
      void client.invalidateQueries({ queryKey: ["tailscale", "lock"] });
    }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  const secrets = operation.init && result ? result.match(/disablement-secret:[0-9a-f]+/gi) ?? [] : [];
  return (
    <div className="modal" onClick={dismiss}>
      <div className="sheet" role="dialog" aria-modal="true" ref={sheetRef} onKeyDown={trapTab} onClick={(e) => e.stopPropagation()}>
        <h2>{t.CONFIRM}</h2>
        <pre>{operation.command}</pre>
        {operation.init && <p className="dim">{t.INIT_WARNING}</p>}
        {operation.confirm && (
          <label>{t.TYPE_CONFIRM}: {operation.confirm}<input value={typed} onChange={(e) => setTyped(e.target.value)} /></label>
        )}
        {error && <div className="err">{error}</div>}
        {result !== null && operation.init && (
          <section>
            <p className="err" role="alert"><strong>{t.INIT_SAVE_WARNING}</strong></p>
            {secrets.length ? (
              <ul>
                {secrets.map((secret) => (
                  <li key={secret}>
                    <code>{secret}</code>{" "}
                    <button className="btn small" onClick={() => void desktop.copy(secret).then(
                      () => setCopied(secret), (e) => setError(errorMessage(e))
                    )}>{copied === secret ? t.COPIED : t.COPY}</button>
                  </li>
                ))}
              </ul>
            ) : <pre>{result}</pre>}
          </section>
        )}
        {result !== null && !operation.init && <pre>{result}</pre>}
        <button className="btn small" onClick={dismiss} disabled={busy}>{t.CANCEL}</button>
        {result === null && (
          <button className="btn small" onClick={() => void apply()} disabled={busy || (!!operation.confirm && typed !== operation.confirm)}>
            {t.CONFIRM}
          </button>
        )}
      </div>
    </div>
  );
}

export function LockControls({ lock }: { lock: TsLock }) {
  const [node, setNode] = useState("");
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const [recovery, setRecovery] = useState("");
  const [extraKeys, setExtraKeys] = useState("");
  const [count, setCount] = useState("1");
  const [history, setHistory] = useState("");
  const [operation, setOperation] = useState<Operation | null>(null);
  const [undo, setUndo] = useState<Operation | null>(null);
  const trusted = lock.enabled && lock.thisKeyTrusted === true;
  const initialKeys = [...new Set([lock.publicKey ?? "", ...extraKeys.split(/\s+/)].filter(Boolean))];
  const initCount = Number(count);
  const canInit = !!lock.publicKey && initialKeys.every((value) => /^tlpub:[0-9a-f]{64}$/i.test(value))
    && Number.isInteger(initCount) && initCount > 0 && initCount <= 0xffffffff;
  const open = (kind: string, value: string, command: string, confirm?: string) => setOperation({ kind, value, command, confirm });
  const getHistory = async () => { try { setHistory(await tailscaleApi.lockHistory()); } catch (e) { setHistory(errorMessage(e)); } };
  return <>
    <section className="ts-sec">
      <h3>{t.HISTORY}</h3>
      <p className="ts-desc">{lock.enabled ? t.HISTORY_DESC : t.HISTORY_DISABLED}</p>
      <div className="ts-connect-acts">
        <button className="btn small" disabled={!lock.enabled} onClick={() => void getHistory()}>{t.HISTORY}</button>
      </div>
      {history && <pre className="raw">{history}</pre>}
    </section>
    {!lock.enabled && (
      <section className="ts-sec">
        <h3>{t.INIT}</h3>
        <p className="ts-desc">{t.INIT_WARNING}</p>
        <dl className="ts-details">
          <div>
            <dt>{t.INIT_OWN_KEY}</dt>
            <dd>{lock.publicKey ? <code>{lock.publicKey}</code> : t.INIT_NO_KEY}</dd>
          </div>
        </dl>
        <div className="awc-form-grid">
          <label className="field wide">
            {t.INIT_KEYS}
            <textarea value={extraKeys} onChange={(event) => setExtraKeys(event.target.value)} />
          </label>
          <label className="field">
            {t.INIT_COUNT}
            <input type="number" min="1" value={count} onChange={(event) => setCount(event.target.value)} />
          </label>
        </div>
        <div className="ts-connect-acts">
          <button className="btn small" disabled={!canInit} onClick={() => setOperation({
            kind: "initialize",
            value: "",
            command: `tailscale lock init --confirm --gen-disablements=${initCount} ${initialKeys.map(quote).join(" ")}`,
            confirm: "init",
            init: { keys: initialKeys, count: initCount },
          })}>{t.INIT}</button>
        </div>
      </section>
    )}
    {lock.enabled && !trusted && <p className="ts-warn">{t.NOT_TRUSTED}</p>}
    {lock.enabled && (
      <section className="ts-sec">
        <h3>{t.PEERS}</h3>
        <p className="ts-desc">{t.PEERS_DESC}</p>
        {lock.needsSignature.length === 0 ? <p className="dim">{t.PEERS_EMPTY}</p> : (
          <table className="argowf-table ts-table">
            <thead><tr><th>{t.PEER_NAME}</th><th>{t.PEER_NODE_KEY}</th><th className="end">{t.ACTION}</th></tr></thead>
            <tbody>
              {lock.needsSignature.map((peer) => (
                <tr key={`${peer.name}:${peer.nodeKey ?? ""}`}>
                  <td>{peer.name}</td>
                  <td>{peer.nodeKey ? <code>{peer.nodeKey}</code> : t.PEER_KEY_MISSING}</td>
                  <td className="end">
                    <button className="btn small" aria-label={t.signPeer(peer.name)} disabled={!trusted || !peer.nodeKey}
                      onClick={() => {
                        if (peer.nodeKey) open("sign-node", peer.nodeKey, `tailscale lock sign ${quote(peer.nodeKey)}`);
                      }}>{t.SIGN}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    )}
    {lock.enabled && (
      <section className="ts-sec">
        <h3>{t.ACTIONS}</h3>
        <p className="ts-desc">{t.ACTIONS_DESC}</p>
        <h4>{t.SIGN_GROUP}</h4>
        <div className="awc-form-grid">
          <label className="field wide">
            {t.NODE_KEY}
            <input value={node} onChange={(e) => setNode(e.target.value)} />
          </label>
        </div>
        <div className="ts-connect-acts">
          <button className="btn small" disabled={!trusted || !node}
            onClick={() => open("sign-node", node, `tailscale lock sign ${quote(node)}`)}>{t.SIGN}</button>
        </div>
        <h4>{t.TRUST_GROUP}</h4>
        <div className="awc-form-grid">
          <label className="field wide">
            {t.TRUSTED_KEY}
            <input value={key} onChange={(e) => setKey(e.target.value)} />
          </label>
        </div>
        <div className="ts-connect-acts">
          <button className="btn small" disabled={!trusted || !key}
            onClick={() => open("trust-key", key, `tailscale lock add ${quote(key)}`)}>{t.ADD}</button>
          <button className="btn small" disabled={!trusted || !key}
            onClick={() => open("untrust-key", key, `tailscale lock remove ${quote(key)}`, key)}>{t.REMOVE}</button>
          {undo && <button className="btn small" disabled={!trusted} onClick={() => setOperation(undo)}>{t.UNDO}</button>}
        </div>
        <h4>{t.RECOVERY}</h4>
        <p className="ts-hint">{t.RECOVERY_HINT}</p>
        <div className="awc-form-grid">
          <label className="field wide">
            {t.RECOVERY_KEYS}
            <input value={recovery} onChange={(e) => setRecovery(e.target.value)} />
          </label>
        </div>
        <div className="ts-connect-acts">
          <button className="btn small" disabled={!trusted || !recovery} onClick={() => open(
            "revoke-start", recovery, `tailscale lock revoke-keys ${recovery.trim().split(/\s+/).map(quote).join(" ")}`, "revoke"
          )}>{t.START}</button>
          <button className="btn small" disabled={!trusted || !recovery}
            onClick={() => open("revoke-cosign", recovery, `tailscale lock revoke-keys --cosign ${quote(recovery)}`)}>{t.COSIGN}</button>
          <button className="btn small" disabled={!trusted || !recovery}
            onClick={() => open("revoke-finish", recovery, `tailscale lock revoke-keys --finish ${quote(recovery)}`, "revoke")}>{t.FINISH}</button>
        </div>
        <h4>{t.OFF_GROUP}</h4>
        <p className="ts-hint">{t.OFF_HINT}</p>
        <div className="awc-form-grid">
          <label className="field">
            {t.SECRET}
            <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
          </label>
        </div>
        <div className="ts-connect-acts">
          <button className="btn small" disabled={!lock.enabled}
            onClick={() => open("local-off", "", "tailscale lock local-disable", "local-disable")}>{t.LOCAL_OFF}</button>
          <button className="btn small" disabled={!lock.enabled || !secret}
            onClick={() => open("tailnet-off", secret, `tailscale lock disable ${quote(secret)}`, "disable")}>{t.DISABLE}</button>
        </div>
      </section>
    )}
    {operation && <LockSheet operation={operation} close={() => { setOperation(null); setSecret(""); }} done={() => {
      if (operation.kind === "trust-key") {
        setUndo({ kind: "untrust-key", value: operation.value, command: `tailscale lock remove ${quote(operation.value)}`, confirm: operation.value });
      } else if (operation.kind === "untrust-key") {
        setUndo({ kind: "trust-key", value: operation.value, command: `tailscale lock add ${quote(operation.value)}` });
      }
    }} />}
  </>;
}
