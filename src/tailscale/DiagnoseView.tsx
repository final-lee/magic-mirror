import { useState, type FormEvent, type ReactNode } from "react";
import { TailscaleDiagnosis } from "./TailscaleDiagnosis";
import { errorMessage } from "../api/errors";
import { formatDateTime, prettyJson } from "../iam/format";
import { tailscaleApi } from "./api";
import * as d from "./diagnosticToolsText";
import * as t from "./text";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown) => (typeof v === "string" && v ? v : "");
const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

/** `tailscale whois|whoami --json`에서 알아볼 만한 항목만 뽑는다. 하나도 없으면 빈 배열. */
function identityRows(json: unknown): [string, ReactNode][] {
  const root = obj(json);
  const node = obj(root.Node);
  const user = obj(root.UserProfile);
  const tailnet = obj(root.CurrentTailnet);
  const rows: [string, ReactNode][] = [];
  const add = (label: string, content: ReactNode, show: unknown = content) => { if (show) rows.push([label, content]); };
  const dnsName = str(node.Name).replace(/\.$/, "");
  add(d.IDENTITY.device, str(node.ComputedName) || str(node.Hostinfo && obj(node.Hostinfo).Hostname) || dnsName);
  add(d.IDENTITY.dnsName, dnsName);
  add(d.IDENTITY.user, <>{str(user.DisplayName)} <span className="dim">{str(user.LoginName)}</span></>, str(user.DisplayName) || str(user.LoginName));
  add(d.IDENTITY.tailnet, str(tailnet.Name));
  add(d.IDENTITY.suffix, str(tailnet.MagicDNSSuffix));
  const addresses = list(node.Addresses).map((a) => a.replace(/\/(32|128)$/, ""));
  add(d.IDENTITY.addresses, addresses.map((a) => <div key={a} className="mono">{a}</div>), addresses.length);
  const tags = list(node.Tags);
  add(d.IDENTITY.tags, tags.join(", "));
  if (typeof node.MachineAuthorized === "boolean") add(d.IDENTITY.authorized, node.MachineAuthorized ? d.AUTHORIZED : d.UNAUTHORIZED);
  add(d.IDENTITY.created, <span title={str(node.Created)}>{formatDateTime(str(node.Created))}</span>, str(node.Created));
  add(d.IDENTITY.keyExpiry, <span title={str(node.KeyExpiry)}>{formatDateTime(str(node.KeyExpiry))}</span>, str(node.KeyExpiry));
  add(d.IDENTITY.nodeId, <span className="mono">{str(node.StableID)}</span>, str(node.StableID));
  add(d.IDENTITY.nodeKey, <span className="mono">{str(node.Key)}</span>, str(node.Key));
  return rows;
}

function Identity({ text }: { text: string }) {
  let rows: [string, ReactNode][] = [];
  try { rows = identityRows(JSON.parse(text)); } catch { /* JSON이 아니면 원문만 보여준다 */ }
  if (!rows.length) return <pre className="raw">{text}</pre>;
  return (
    <>
      <dl className="ts-details">
        {rows.map(([label, content]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{content}</dd>
          </div>
        ))}
      </dl>
      <details>
        <summary>{d.RAW}</summary>
        <pre className="raw">{prettyJson(text)}</pre>
      </details>
    </>
  );
}

/** 아무 주소에나 T1 진단을 돌린다. */
export function DiagnoseView() {
  const [input, setInput] = useState("");
  const [submitted, setSubmitted] = useState<{ url: string; serial: number } | null>(null);
  const [name, setName] = useState("");
  const [recordType, setRecordType] = useState("");
  const [ip, setIp] = useState("");
  const [results, setResults] = useState<Record<string, { text: string; failed: boolean }>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const run = async (kind: string, value = "", type = "") => {
    setBusy((old) => ({ ...old, [kind]: true }));
    try {
      const output = await tailscaleApi.diagnosticTool(kind, value.trim(), type.trim());
      setResults((old) => ({ ...old, [kind]: { text: output, failed: false } }));
    } catch (error) {
      setResults((old) => ({ ...old, [kind]: { text: errorMessage(error), failed: true } }));
    } finally {
      setBusy((old) => ({ ...old, [kind]: false }));
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const url = input.trim();
    if (url) setSubmitted((old) => ({ url, serial: (old?.serial ?? 0) + 1 }));
  };
  const show = (kind: string, identity = false) => {
    const result = results[kind];
    if (!result) return null;
    if (result.failed) return <div className="err">{result.text}</div>;
    return identity ? <Identity text={result.text} /> : <pre className="raw">{result.text}</pre>;
  };
  return (
    <>
      <div className="awc-bar"><h2 className="awc-title">{t.TAB_DIAGNOSIS}</h2></div>
      <div className="awc-scroll">
        <div className="awc-body">
          <section className="ts-sec">
            <h3>{d.SEC_ADDRESS}</h3>
            <p className="ts-desc">{d.SEC_ADDRESS_DESC}</p>
            <form className="awc-editor-opts" onSubmit={submit}>
              <label htmlFor="ts-address">{t.ADDRESS_LABEL}</label>
              <input id="ts-address" value={input} onChange={(e) => setInput(e.target.value)} />
              <button className="btn primary small" type="submit" disabled={!input.trim()}>
                {t.DIAGNOSE_BUTTON}
              </button>
            </form>
            {submitted && <TailscaleDiagnosis key={`${submitted.url}-${submitted.serial}`} url={submitted.url} inWorkspace />}
          </section>
          <section className="ts-sec">
            <h3>{d.SEC_DNS_STATUS}</h3>
            <p className="ts-desc">{d.SEC_DNS_STATUS_DESC}</p>
            <div className="ts-connect-acts">
              <button className="btn small" disabled={busy["dns-status"]} onClick={() => void run("dns-status")}>{d.DNS_STATUS}</button>
            </div>
            {show("dns-status")}
          </section>
          <section className="ts-sec">
            <h3>{d.SEC_DNS_QUERY}</h3>
            <p className="ts-desc">{d.SEC_DNS_QUERY_DESC}</p>
            <form className="awc-editor-opts" onSubmit={(event) => { event.preventDefault(); void run("dns-query", name, recordType); }}>
              <label>{d.DNS_NAME}<input value={name} onChange={(event) => setName(event.target.value)} /></label>
              <label>{d.RECORD_TYPE}<input value={recordType} onChange={(event) => setRecordType(event.target.value)} /></label>
              <button className="btn small" disabled={!name.trim() || busy["dns-query"]}>{d.DNS_QUERY}</button>
            </form>
            {show("dns-query")}
          </section>
          <section className="ts-sec">
            <h3>{d.SEC_WHOIS}</h3>
            <p className="ts-desc">{d.SEC_WHOIS_DESC}</p>
            <form className="awc-editor-opts" onSubmit={(event) => { event.preventDefault(); void run("whois", ip); }}>
              <label>{d.IP}<input value={ip} onChange={(event) => setIp(event.target.value)} /></label>
              <button className="btn small" disabled={!ip.trim() || busy.whois}>{d.WHOIS}</button>
            </form>
            {show("whois", true)}
          </section>
          <section className="ts-sec">
            <h3>{d.SEC_WHOAMI}</h3>
            <p className="ts-desc">{d.SEC_WHOAMI_DESC}</p>
            <div className="ts-connect-acts">
              <button className="btn small" disabled={busy.whoami} onClick={() => void run("whoami")}>{d.WHOAMI}</button>
            </div>
            {show("whoami", true)}
          </section>
        </div>
      </div>
    </>
  );
}
