import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { tailscaleApi } from "./api";
import { errorMessage } from "../api/errors";
import { useModal } from "../iam/useModal";
import { ApiRequired } from "./ApiRequired";
import { useTailscaleApi } from "./useTailscaleApi";
import * as t from "./settingsText";

type Change = { field: string; before: unknown; after: unknown; contact?: boolean; resend?: boolean };

export function SettingsView() {
  const { tailnet, connected, isLoading } = useTailscaleApi();
  if (isLoading) return <div className="empty">{t.LOADING}</div>;
  if (!tailnet || !connected) return <ApiRequired title={t.TITLE} />;
  return <SettingsPanel tailnet={tailnet} />;
}

function SettingsPanel({ tailnet }: { tailnet: string }) {
  const settings = useQuery({
    queryKey: ["tailscale", "settings", tailnet],
    queryFn: () => tailscaleApi.settings(tailnet, false),
    retry: false,
  });
  const contacts = useQuery({
    queryKey: ["tailscale", "contacts", tailnet],
    queryFn: () => tailscaleApi.settings(tailnet, true),
    retry: false,
  });
  const [change, setChange] = useState<Change | null>(null);
  const [undo, setUndo] = useState<Change | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  return <>
    <div className="awc-bar">
      <h2 className="awc-title">{t.TITLE}</h2>
      <div className="awc-bar-end">
        <button className="btn small" onClick={() => { void settings.refetch(); void contacts.refetch(); }}>
          {t.RELOAD}
        </button>
      </div>
    </div>
    <div className="awc-body awc-scroll">
      {notice && <div role="status">{notice}</div>}
      {settings.isError && <div className="err" role="alert">{errorMessage(settings.error)}</div>}
      {settings.data && Object.entries(t.GROUPS).map(([group, fields]) => (
        <section className="ts-sec" key={group}>
          <h3>{group}</h3>
          <p className="ts-desc">{t.GROUP_DESCRIPTION(group)}</p>
          <table className="argowf-table ts-table ts-settings">
            <thead>
              <tr><th>{t.SETTING}</th><th>{t.CURRENT}</th><th>{t.CHANGE}</th></tr>
            </thead>
            <tbody>
              {fields.filter((field) => field in settings.data!).map((field) => (
                <SettingField key={`${field}-${settings.dataUpdatedAt}`} field={field}
                  value={settings.data![field]} help={t.FIELDS[field]} preview={setChange} />
              ))}
            </tbody>
          </table>
        </section>
      ))}
      <section className="ts-sec">
        <h3>{t.CONTACTS}</h3>
        <p className="ts-desc">{t.CONTACTS_DESCRIPTION}</p>
        {contacts.isError && <div className="err" role="alert">{errorMessage(contacts.error)}</div>}
        {contacts.data && <table className="argowf-table ts-table">
          <thead><tr><th>{t.KIND}</th><th>{t.EMAIL}</th><th>{t.VERIFICATION}</th><th>{t.ACTIONS}</th></tr></thead>
          <tbody>{["account", "support", "security"].map((kind) => (
            <ContactField key={`${kind}-${contacts.dataUpdatedAt}`} kind={kind}
              value={contacts.data![kind]} preview={setChange} />
          ))}</tbody>
        </table>}
      </section>
      {undo && <button className="btn small" onClick={() => {
        const current = undo.contact ? contacts.data?.[undo.field] : settings.data?.[undo.field];
        if (undo.contact && current && typeof current === "object" && "email" in current
          && undo.before && typeof undo.before === "object" && "email" in undo.before
          && current.email === undo.before.email) {
          setChange({ ...undo, before: current });
        } else {
          setChange(undo);
        }
      }}>{t.UNDO}</button>}
    </div>
    {change && (
      <SettingsDialog tailnet={tailnet} change={change} cancel={() => setChange(null)} saved={(warning) => {
        if (!change.resend) {
          const oldEmail = change.before && typeof change.before === "object" && "email" in change.before
            ? change.before.email : "";
          setUndo({
            ...change,
            before: change.contact ? { email: change.after } : change.after,
            after: change.contact ? oldEmail : change.before,
          });
        }
        setNotice(warning || t.SAVED);
        setChange(null);
        void settings.refetch();
        void contacts.refetch();
      }} />
    )}
  </>;
}

function SettingField({ field, value, help, preview }: {
  field: string; value: unknown; help: string; preview: (change: Change) => void;
}) {
  const [text, setText] = useState(String(value ?? ""));
  const booleanField = [
    "aclsExternallyManagedOn", "devicesApprovalOn", "devicesAutoUpdatesOn", "usersApprovalOn",
    "networkFlowLoggingOn", "postureIdentityCollectionOn", "httpsEnabled",
  ].includes(field);
  const options = field === "routeSelection" ? ["active-passive-failover", "regional-routing", "regional-routing-failover", "magicroute"]
    : field === "usersRoleAllowedToJoinExternalTailnets" ? ["none", "admin", "member"] : null;
  const after = typeof value === "number" ? Number(text) : text;
  const toggle = booleanField || field === "regionalRoutingOn";
  return (
    <tr>
      <td title={field}>
        <span>{t.TITLES[field] ?? field}</span>
        <div className="ts-hint">{help}</div>
      </td>
      <td>
        {toggle ? (
          <span title={String(value)}>{value === null ? t.UNSET : value ? t.ON : t.OFF}</span>
        ) : options ? (
          <select aria-label={field} value={text} onChange={(e) => setText(e.target.value)}>
            {options.map((v) => <option key={v} value={v} title={v}>{t.VALUES[v] ?? v}</option>)}
          </select>
        ) : (
          <input aria-label={field} type={typeof value === "number" ? "number" : "text"}
            value={text} onChange={(e) => setText(e.target.value)} />
        )}
      </td>
      <td>
        {toggle ? (
          field !== "regionalRoutingOn" && (
            <button className="btn small" onClick={() => preview({ field, before: value, after: value !== true })}>
              {value === true ? t.TURN_OFF : t.TURN_ON}
            </button>
          )
        ) : (
          <button className="btn small" disabled={after === value}
            onClick={() => preview({ field, before: value, after })}>{t.PREVIEW}</button>
        )}
      </td>
    </tr>
  );
}

function ContactField({ kind, value, preview }: {
  kind: string; value: unknown; preview: (change: Change) => void;
}) {
  const email = value && typeof value === "object" && "email" in value && typeof value.email === "string" ? value.email : "";
  const [text, setText] = useState(email);
  const needsVerification = value && typeof value === "object" && "needsVerification" in value ? value.needsVerification : null;
  return (
    <tr>
      <td title={kind}>{t.CONTACT_NAMES[kind]}</td>
      <td>
        <input aria-label={kind} type="email" value={text} onChange={(e) => setText(e.target.value)} />
      </td>
      <td
        title={`needsVerification: ${String(needsVerification)}`}
      >
        {needsVerification === false
          ? t.VERIFIED
          : needsVerification === true
            ? t.VERIFICATION_PENDING
            : t.UNKNOWN}
      </td>
      <td>
        <button className="btn small" disabled={!text || text === email}
          onClick={() => preview({ field: kind, before: value ?? null, after: text, contact: true })}>{t.PREVIEW}</button>{" "}
        <button className="btn small"
          onClick={() => preview({ field: kind, before: value, after: null, contact: true, resend: true })}>{t.RESEND}</button>
      </td>
    </tr>
  );
}

function SettingsDialog({ tailnet, change, cancel, saved }: { tailnet: string; change: Change; cancel: () => void; saved: (warning: string | null) => void }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { sheetRef, trapTab } = useModal(() => { if (!sending) cancel(); });
  const path = change.contact ? `/tailnet/-/contacts/${change.field}${change.resend ? "/resend-verification-email" : ""}` : "/tailnet/-/settings";
  const body = change.contact ? change.resend ? null : { email: change.after } : { [change.field]: change.after };
  const apply = async () => {
    setSending(true);
    try {
      const warning = change.contact
        ? await tailscaleApi.contactSave(tailnet, change.field, change.before, change.resend ? null : change.after)
        : await tailscaleApi.settingsSave(tailnet, change.field, change.before, change.after);
      saved(warning);
    } catch (e) { setError(errorMessage(e)); setSending(false); }
  };
  return (
    <div className="modal" onClick={(e) => { if (e.target === e.currentTarget && !sending) cancel(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={t.PREVIEW} ref={sheetRef} onKeyDown={trapTab}>
        <h3>{t.PREVIEW}</h3>
        <p><code>{change.resend ? "POST" : "PATCH"} {path}</code></p>
        <pre>{JSON.stringify(body, null, 2)}</pre>
        <p>{JSON.stringify(change.before)} → {JSON.stringify(change.after)}</p>
        {error && <div className="err" role="alert">{error}</div>}
        <div className="foot">
          <button className="btn small" disabled={sending} onClick={cancel}>{t.CANCEL}</button>
          <button className="btn small" disabled={sending} onClick={() => void apply()}>{t.SAVE}</button>
        </div>
      </div>
    </div>
  );
}
