import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage } from "../api/errors";
import { useModal } from "../iam/useModal";
import { tailscaleApi } from "./api";
import * as t from "./macControlsText";
import * as base from "./text";

interface Pending { kind: string; value: string; command: string; warning?: string; confirm?: string; undo?: { key: string; value: string } }
interface Account { id: string; nickname: string; account: string; tailnet: string; selected: boolean }
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

function Sheet({ pending, tailnet, onClose, onDone }: { pending: Pending; tailnet: string; onClose: () => void; onDone: () => void }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState("");
  const close = () => { if (!busy) onClose(); };
  const { sheetRef, trapTab } = useModal(close);
  const apply = async () => {
    setBusy(true);
    try { setResult((await tailscaleApi.localApply(pending.kind, pending.value, tailnet)) || t.RESULT); onDone(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  return <div className="modal" onClick={close}>
    <div className="sheet" role="dialog" aria-modal="true" ref={sheetRef} onKeyDown={trapTab} onClick={(e) => e.stopPropagation()}>
      <h2>{t.CONFIRM}</h2>
      <pre>{pending.command}</pre>
      {pending.warning && <p>{pending.warning}</p>}
      {pending.confirm && <label>{t.TYPE_CONFIRM}: {pending.confirm}<input value={typed} onChange={(e) => setTyped(e.target.value)} /></label>}
      {error && <div className="err">{error}</div>}
      {result !== null && <pre>{result}</pre>}
      <button className="btn small" onClick={close} disabled={busy}>{t.CANCEL}</button>
      {result === null && (
        <button className="btn small" onClick={() => void apply()} disabled={busy || (!!pending.confirm && typed !== pending.confirm)}>
          {t.CONFIRM}
        </button>
      )}
    </div>
  </div>;
}

const EXIT_ROW = /^((?:\d{1,3}\.){3}\d{1,3}|[0-9a-f]*:[0-9a-f:]+)\s+(\S+)/i;
const SUGGESTION = /Suggested exit node:\s*(\S+?)\.?(?:\s|$)/;
interface Exit { ip: string; name: string }

export function MacControls({ tailnet }: { tailnet: string }) {
  const client = useQueryClient();
  const prefs = useQuery({
    queryKey: ["tailscale", "local-prefs"],
    queryFn: async () => JSON.parse(await tailscaleApi.localRead("prefs")) as Record<string, boolean | string>,
    retry: false,
  });
  const accounts = useQuery({
    queryKey: ["tailscale", "accounts"],
    queryFn: async () => JSON.parse(await tailscaleApi.localRead("accounts")) as Account[],
    retry: false,
  });
  const exits = useQuery({
    queryKey: ["tailscale", "local-exits"],
    queryFn: async () => (await tailscaleApi.localRead("exits")).split("\n").flatMap((line): Exit[] => {
      const match = line.trim().match(EXIT_ROW);
      return match ? [{ ip: match[1], name: match[2] }] : [];
    }),
    retry: false,
  });
  const suggestion = useQuery({
    queryKey: ["tailscale", "local-suggestion"],
    queryFn: async () => (await tailscaleApi.localRead("suggestion")).match(SUGGESTION)?.[1] ?? "",
    retry: false,
  });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [undo, setUndo] = useState<{ key: string; value: string } | null>(null);
  const [versionCheck, setVersionCheck] = useState("");
  const [metrics, setMetrics] = useState("");
  const [filter, setFilter] = useState("");
  const checkVersion = async () => {
    try { setVersionCheck("…"); setVersionCheck(await tailscaleApi.localRead("version-check")); }
    catch (e) { setVersionCheck(errorMessage(e)); }
  };
  const readMetrics = async () => {
    try { setMetrics("…"); setMetrics(await tailscaleApi.localRead("metrics")); }
    catch (e) { setMetrics(errorMessage(e)); }
  };
  const preference = (key: string, value: string, previous: string) => setPending({
    kind: "preference",
    value: `--${key}=${value}`,
    command: `tailscale set ${quote(`--${key}=${value}`)}`,
    undo: { key, value: previous },
  });
  const action = (kind: string, command: string, warning?: string, confirm?: string, value = "") => setPending({ kind, command, warning, confirm, value });
  const exitList = exits.data ?? [];
  const suggested = suggestion.data ? exitList.find((exit) => exit.name === suggestion.data) ?? { ip: suggestion.data, name: suggestion.data } : null;
  const exitRow = (current: string) => {
    const known = exitList.find((exit) => exit.ip === current || exit.name === current);
    const selected = draft["exit-node"] ?? known?.ip ?? current;
    return (
      <>
        <div className="ts-inline">
          <select aria-label={t.EXIT_LABEL} value={selected} onChange={(e) => setDraft((old) => ({ ...old, "exit-node": e.target.value }))}>
            <option value="">{t.NO_EXIT}</option>
            {current && !known && <option value={current}>{current}</option>}
            {exitList.map((exit) => <option key={exit.ip} value={exit.ip}>{exit.name} ({exit.ip})</option>)}
          </select>
          <button className="btn small" disabled={selected === (known?.ip ?? current)}
            aria-label={`${t.prefLabel("exit-node")} ${t.APPLY}`}
            onClick={() => preference("exit-node", selected, current)}>
            {t.APPLY}
          </button>
        </div>
        {exits.isError && <div className="ts-hint">{t.EXIT_LIST_ERROR}</div>}
        {suggested && (
          <div className="ts-hint">
            {t.EXIT_SUGGESTED}: {suggested.name}{" "}
            <button className="btn small" disabled={selected === suggested.ip}
              onClick={() => setDraft((old) => ({ ...old, "exit-node": suggested.ip }))}>
              {t.USE_SUGGESTED}
            </button>
          </div>
        )}
      </>
    );
  };
  return <>
    <section className="ts-sec">
      <h3>{t.SEC_CONNECT}</h3>
      <p className="ts-desc">{t.SEC_CONNECT_DESC}</p>
      <div className="ts-connect-acts">
        <button className="btn small" onClick={() => action("connect", "tailscale up")}>{t.CONNECT}</button>
        <button className="btn small" onClick={() => action("disconnect", "tailscale down", t.DISCONNECT_WARNING)}>{t.DISCONNECT}</button>
        <button className="btn small" onClick={() => action("authenticate", "tailscale login")}>{t.LOGIN}</button>
        <button className="btn small" onClick={() => action("sign-out", "tailscale logout", t.LOGOUT_WARNING, "logout")}>{t.LOGOUT}</button>
        <button className="btn small" onClick={() => void checkVersion()}>{t.UPDATE_CHECK}</button>
        <button className="btn small" onClick={() => action("upgrade", "tailscale update --yes")}>{t.UPDATE}</button>
      </div>
      {versionCheck && <pre className="raw">{versionCheck}</pre>}
    </section>
    <section className="ts-sec">
      <h3>{t.SEC_PREFS}</h3>
      <p className="ts-desc">{t.SEC_PREFS_DESC}</p>
      {prefs.error && <div className="err">{errorMessage(prefs.error)}</div>}
      {prefs.data && Object.keys(prefs.data).length === 0 && <p className="dim">{t.PREFS_EMPTY}</p>}
      {prefs.data && Object.keys(prefs.data).length > 0 && (
        <table className="argowf-table ts-table">
          <thead>
            <tr><th>{t.COL_PREF}</th><th>{t.COL_VALUE}</th><th>{t.COL_CHANGE}</th></tr>
          </thead>
          <tbody>
            {Object.entries(prefs.data).map(([key, current]) => {
              const label = t.prefLabel(key);
              return (
                <tr key={key}>
                  <td title={`--${key}`}>{label}</td>
                  {typeof current === "boolean" ? (
                    <>
                      <td className={current ? undefined : "dim"}>{current ? base.ON : base.OFF}</td>
                      <td>
                        <button className="btn small" aria-label={`${label} ${current ? t.TURN_OFF : t.TURN_ON}`}
                          onClick={() => preference(key, String(!current), String(current))}>
                          {current ? t.TURN_OFF : t.TURN_ON}
                        </button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className={current ? undefined : "dim"}>{current || (key === "exit-node" ? base.NONE : t.EMPTY_VALUE)}</td>
                      <td>
                        {key === "exit-node" ? exitRow(String(current)) : (
                          <div className="ts-inline">
                            <input aria-label={label} value={draft[key] ?? String(current)}
                              onChange={(e) => setDraft((old) => ({ ...old, [key]: e.target.value }))} />
                            <button className="btn small" disabled={(draft[key] ?? String(current)) === String(current)}
                              aria-label={`${label} ${t.APPLY}`}
                              onClick={() => preference(key, draft[key] ?? String(current), String(current))}>
                              {t.APPLY}
                            </button>
                          </div>
                        )}
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {undo && (
        <div className="ts-connect-acts">
          <button className="btn small" onClick={() => preference(undo.key, undo.value, String(prefs.data?.[undo.key] ?? ""))}>
            {t.UNDO}: {t.prefLabel(undo.key)}
          </button>
        </div>
      )}
    </section>
    <section className="ts-sec">
      <h3>{t.SEC_ACCOUNTS}</h3>
      <p className="ts-desc">{t.SEC_ACCOUNTS_DESC}</p>
      {accounts.error && <div className="err">{errorMessage(accounts.error)}</div>}
      {accounts.data?.length === 0 && <p className="dim">{t.ACCOUNTS_EMPTY}</p>}
      {!!accounts.data?.length && (
        <table className="argowf-table ts-table">
          <thead>
            <tr><th>{t.COL_ACCOUNT}</th><th>{t.COL_TAILNET}</th><th>{t.COL_STATE}</th><th className="end" /></tr>
          </thead>
          <tbody>
            {accounts.data.map((account) => (
              <tr key={account.id}>
                <td>{account.nickname || account.account}</td>
                <td>{account.tailnet}</td>
                <td>{account.selected ? t.IN_USE : <span className="dim">—</span>}</td>
                <td className="end">
                  <div className="ts-inline">
                    <button className="btn small" disabled={account.selected}
                      onClick={() => action("account-select", `tailscale switch ${quote(account.id)}`, undefined, undefined, account.id)}>
                      {t.SWITCH}
                    </button>
                    <button className="btn small"
                      onClick={() => action("account-remove", `tailscale switch remove ${quote(account.id)}`, undefined, account.id, account.id)}>
                      {t.REMOVE}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
    <section className="ts-sec">
      <h3>{t.SEC_METRICS}</h3>
      <p className="ts-desc">{t.SEC_METRICS_DESC}</p>
      <details onToggle={(e) => { if (e.currentTarget.open && !metrics) void readMetrics(); }}>
        <summary>{t.METRICS}</summary>
        <div className="awc-editor-opts">
          <label>{t.FILTER}<input value={filter} onChange={(e) => setFilter(e.target.value)} /></label>
        </div>
        <pre className="raw">{metrics.split("\n").filter((line) => line.includes(filter)).join("\n")}</pre>
      </details>
    </section>
    {pending && (
      <Sheet pending={pending} tailnet={tailnet} onClose={() => setPending(null)} onDone={() => {
        if (pending.undo) setUndo(pending.undo);
        void client.invalidateQueries({ queryKey: ["tailscale"] });
      }} />
    )}
  </>;
}
