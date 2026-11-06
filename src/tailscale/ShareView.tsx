import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useState } from "react";
import { errorMessage } from "../api/errors";
import { useModal } from "../iam/useModal";
import { tailscaleApi } from "./api";
import { parseServeStatus, parseServices, parseTargets, rowRequest, type ServeRow } from "./shareStatus";
import type { ShareRequest } from "./shareTypes";
import * as t from "./shareText";

const quote = (value: string) => /^[a-zA-Z0-9_./:=+-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
interface Preview { request: ShareRequest; args: string[]; confirm?: string }
function ShareSheet({ preview, onClose }: { preview: Preview; onClose: () => void }) {
  const client = useQueryClient();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const close = () => { if (!busy) onClose(); };
  const { sheetRef, trapTab } = useModal(close);
  const apply = async () => {
    setBusy(true);
    try { setResult((await tailscaleApi.shareApply(preview.request)) || t.DONE); void client.invalidateQueries({ queryKey: ["tailscale", "share"] }); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="modal" onClick={close}>
      <div className="sheet" role="dialog" aria-modal="true" ref={sheetRef} onKeyDown={trapTab} onClick={(e) => e.stopPropagation()}>
        <h2>{t.PREVIEW}</h2>
        <pre>{["tailscale", ...preview.args].map(quote).join(" ")}</pre>
        {preview.confirm && (
          <label>{t.TYPE_CONFIRM}: {preview.confirm}<input value={typed} onChange={(e) => setTyped(e.target.value)} /></label>
        )}
        {error && <div className="err">{error}</div>}
        {result !== null && <pre>{result}</pre>}
        <button className="btn small" disabled={busy} onClick={close}>{t.CANCEL}</button>
        {result === null && (
          <button className="btn small" disabled={busy || (!!preview.confirm && preview.confirm !== typed)} onClick={() => void apply()}>
            {t.CONFIRM}
          </button>
        )}
      </div>
    </div>
  );
}

const useShareRead = (kind: string) =>
  useQuery({ queryKey: ["tailscale", "share", kind], queryFn: () => tailscaleApi.shareRead(kind), retry: false });

function ServeTable({ rows, remove }: { rows: ServeRow[]; remove: (request: ShareRequest) => void }) {
  if (!rows.length) return <p className="dim">{t.ROWS_EMPTY}</p>;
  return (
    <table className="argowf-table ts-table">
      <thead>
        <tr>
          <th>{t.COL_ADDRESS}</th>
          <th>{t.COL_PROTO}</th>
          <th>{t.COL_PATH}</th>
          <th>{t.COL_TARGET}</th>
          <th>{t.COL_FUNNEL}</th>
          <th className="end" />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const address = `${row.host || t.THIS_DEVICE}${row.port ? `:${row.port}` : ""}`;
          const removeRequest = rowRequest(row, "serve");
          const funnelRequest = row.funnel ? rowRequest(row, "funnel") : null;
          return (
            <tr key={row.key}>
              <td>
                {address}
                {row.service && <div className="dim mono">{row.service}</div>}
              </td>
              <td>
                {row.proto}
                {row.foreground && <div className="dim">{t.FOREGROUND}</div>}
              </td>
              <td className="mono">{row.path || "—"}</td>
              <td>
                {row.target ? <span className="mono">{row.target}</span> : "—"}{" "}
                <span className="dim">({t.KIND[row.kind]})</span>
              </td>
              <td className={row.funnel ? undefined : "dim"}>{row.funnel ? t.ON : t.OFF_STATE}</td>
              <td className="end">
                {removeRequest ? (
                  <div className="ts-inline">
                    {funnelRequest && (
                      <button className="btn small" aria-label={`${t.FUNNEL_OFF}: ${address}${row.path}`}
                        onClick={() => remove(funnelRequest)}>
                        {t.FUNNEL_OFF}
                      </button>
                    )}
                    <button className="btn small" aria-label={`${t.REMOVE}: ${address}${row.path}`}
                      onClick={() => remove(removeRequest)}>
                      {t.REMOVE}
                    </button>
                  </div>
                ) : <span className="dim" title={t.NOT_REMOVABLE}>—</span>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function RawJson({ items }: { items: { title: string; text: string | undefined }[] }) {
  return (
    <details>
      <summary>{t.RAW}</summary>
      {items.map((item) => item.text && (
        <Fragment key={item.title}>
          <div className="ts-hint">{item.title}</div>
          <pre className="raw">{item.text}</pre>
        </Fragment>
      ))}
    </details>
  );
}

export function ShareView() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [scope, setScope] = useState("");
  const [service, setService] = useState("");
  const [port, setPort] = useState("443");
  const [mode, setMode] = useState("https");
  const [path, setPath] = useState("");
  const [target, setTarget] = useState("");
  const [files, setFiles] = useState("");
  const [peer, setPeer] = useState("");
  const [folder, setFolder] = useState("");
  const [domain, setDomain] = useState("");
  const serve = useShareRead("serve-status");
  const funnel = useShareRead("funnel-status");
  const services = useShareRead("services");
  const targets = useShareRead("targets");
  const downloads = useQuery({ queryKey: ["tailscale", "share", "downloads"], queryFn: () => tailscaleApi.shareRead("downloads"), retry: false });
  const domains = useQuery({
    queryKey: ["tailscale", "share", "cert-domains"],
    queryFn: async () => JSON.parse(await tailscaleApi.shareRead("cert-domains")) as string[],
    retry: false,
  });
  useEffect(() => { const value = downloads.data; if (value) setFolder((old) => old || value); }, [downloads.data]);
  useEffect(() => { const value = domains.data?.[0]; if (value) setDomain((old) => old || value); }, [domains.data]);
  const open = async (request: ShareRequest, confirm?: string) => {
    setError("");
    try { setPreview({ request, args: await tailscaleApi.sharePreview(request), confirm }); }
    catch (e) { setError(errorMessage(e)); }
  };
  const pickFiles = async () => {
    try { const selected = await tailscaleApi.pickFiles(); if (selected) setFiles(selected.join("\n")); }
    catch (e) { setError(errorMessage(e)); }
  };
  const pickFolder = async () => {
    try { const selected = await tailscaleApi.pickFolder(); if (selected) setFolder(selected); }
    catch (e) { setError(errorMessage(e)); }
  };
  const mapping = (action: string) => void open(
    { action, target, port, mode, path, service: scope === "service" ? service : scope },
    action === "mapping-off" ? port : undefined
  );
  const rows = serve.data === undefined && funnel.data === undefined ? null : parseServeStatus(serve.data, funnel.data);
  const serviceList = services.data === undefined ? null : parseServices(services.data);
  const targetList = parseTargets(targets.data ?? "");
  const refresh = () => { for (const query of [serve, funnel, services, targets]) void query.refetch(); };
  const folderField = (
    <label className="field">
      {t.FOLDER}
      <input value={folder} onChange={(e) => setFolder(e.target.value)} />
    </label>
  );
  return <>
    <div className="awc-bar">
      <h2 className="awc-title">{t.TITLE}</h2>
      <div className="awc-bar-end">
        <button className="btn small" onClick={refresh}>{t.REFRESH}</button>
      </div>
    </div>
    <div className="awc-scroll"><div className="awc-body">
    {error && <div className="err">{error}</div>}
    <section className="ts-sec">
      <h3>{t.SEC_SERVE}</h3>
      <p className="ts-desc">{t.SEC_SERVE_DESC}</p>
      {(serve.error || funnel.error) && <div className="err">{errorMessage(serve.error ?? funnel.error)}</div>}
      {rows && <ServeTable rows={rows} remove={(request) => void open(request, request.port)} />}
      {serve.data !== undefined && rows === null && <p className="err">{t.ROWS_PARSE_ERROR}</p>}
      <RawJson items={[{ title: t.SERVE, text: serve.data }, { title: t.FUNNEL, text: funnel.data }]} />
    </section>
    <section className="ts-sec">
      <h3>{t.MAPPING}</h3>
      <p className="ts-desc">{t.MAPPING_DESC}</p>
      <div className="awc-form-grid">
        <label className="field">
          {t.SCOPE}
          <select className="field-input" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">{t.LOCAL}</option>
            <option value="funnel">{t.PUBLIC}</option>
            <option value="service">Service</option>
          </select>
        </label>
        {scope === "service" ? (
          <label className="field">
            {t.SERVICE}
            <input value={service} onChange={(e) => setService(e.target.value)} />
          </label>
        ) : <div />}
        <label className="field">
          {t.PORT}
          <input value={port} onChange={(e) => setPort(e.target.value)} />
        </label>
        <label className="field">
          {t.PROTOCOL}
          <select className="field-input" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="https">HTTPS</option>
            <option value="tcp">TCP</option>
          </select>
        </label>
        <label className="field">
          {t.PATH}
          <input value={path} onChange={(e) => setPath(e.target.value)} />
        </label>
        <label className="field">
          {t.TARGET}
          <input value={target} onChange={(e) => setTarget(e.target.value)} />
        </label>
      </div>
      <div className="ts-connect-acts">
        <button className="btn small" onClick={() => mapping("mapping")}>{t.ADD}</button>
        <button className="btn small" onClick={() => mapping("mapping-off")}>{t.OFF}</button>
        <button className="btn small" onClick={() => void open({ action: "serve-reset" }, "Serve")}>{t.RESET_SERVE}</button>
        <button className="btn small" onClick={() => void open({ action: "funnel-reset" }, "Funnel")}>{t.RESET_FUNNEL}</button>
      </div>
    </section>
    <section className="ts-sec">
      <h3>{t.SEC_SERVICES}</h3>
      <p className="ts-desc">{t.SEC_SERVICES_DESC}</p>
      {services.error && <div className="err">{errorMessage(services.error)}</div>}
      {serviceList?.length === 0 && <p className="dim">{t.SERVICES_EMPTY}</p>}
      {!!serviceList?.length && (
        <table className="argowf-table ts-table">
          <thead>
            <tr><th>{t.COL_SERVICE}</th><th>{t.COL_HOST}</th><th>{t.COL_SERVICE_ADDRS}</th><th>{t.COL_PORTS}</th></tr>
          </thead>
          <tbody>
            {serviceList.map((item) => (
              <tr key={item.name}>
                <td className="mono">{item.name}</td>
                <td>{item.hostname || "—"}</td>
                <td className="mono">{item.addrs.map((addr) => <div key={addr}>{addr}</div>)}</td>
                <td className="mono">{item.ports.join(", ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {services.data !== undefined && serviceList === null && <pre className="raw">{services.data}</pre>}
      <h4>{t.SERVICES_FORM}</h4>
      <div className="awc-editor-opts">
        <label>
          {t.SERVICE}
          <input value={service} onChange={(e) => setService(e.target.value)} />
        </label>
        <button className="btn small" onClick={() => void open({ action: "advertise", service })}>{t.ADVERTISE}</button>
        <button className="btn small" onClick={() => void open({ action: "drain", service }, service)}>{t.DRAIN}</button>
        <button className="btn small" onClick={() => void open({ action: "clear", service }, service)}>{t.CLEAR}</button>
      </div>
    </section>
    <section className="ts-sec">
      <h3>{t.TAILDROP_SECTION}</h3>
      <p className="ts-desc">{t.TAILDROP_DESC}</p>
      <h4>{t.TARGETS}</h4>
      {targets.error && <div className="err">{errorMessage(targets.error)}</div>}
      {targets.data !== undefined && targetList.length === 0 && <p className="dim">{t.TARGETS_EMPTY}</p>}
      {targetList.length > 0 && (
        <table className="argowf-table ts-table">
          <thead>
            <tr><th>{t.COL_DEVICE}</th><th>{t.COL_IP}</th><th>{t.COL_STATUS}</th></tr>
          </thead>
          <tbody>
            {targetList.map((item) => {
              const age = item.status.match(/last seen (.+) ago/)?.[1];
              return (
                <tr key={item.ip}>
                  <td>{item.name}</td>
                  <td className="mono">{item.ip}</td>
                  <td title={item.status || undefined}>
                    {item.status.startsWith("offline") ? (
                      <><span className="dim">{t.OFFLINE}</span>{age && <span className="dim"> · {t.lastSeen(age)}</span>}</>
                    ) : t.ONLINE}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <h4>{t.SEND_GROUP}</h4>
      <div className="awc-form-grid">
        <label className="field wide">
          {t.FILES}
          <textarea value={files} onChange={(e) => setFiles(e.target.value)} />
        </label>
        <label className="field">
          {t.PEER}
          <input list="ts-taildrop-peers" value={peer} onChange={(e) => setPeer(e.target.value)} />
          <datalist id="ts-taildrop-peers">
            {targetList.map((item) => <option key={item.ip} value={item.name} />)}
          </datalist>
        </label>
      </div>
      <div className="ts-connect-acts">
        <button className="btn small" onClick={() => void pickFiles()}>{t.PICK_FILES}</button>
        <button className="btn small" onClick={() => void open({
          action: "send", files: files.split("\n").map((v) => v.trim()).filter(Boolean), target: peer,
        })}>{t.SEND}</button>
      </div>
      <h4>{t.RECEIVE_GROUP}</h4>
      <p className="ts-hint">{t.RECEIVE_HINT}</p>
      <div className="awc-form-grid">
        {folderField}
      </div>
      <div className="ts-connect-acts">
        <button className="btn small" onClick={() => void pickFolder()}>{t.PICK_FOLDER}</button>
        <button className="btn small" onClick={() => void open({ action: "receive", folder })}>{t.RECEIVE}</button>
      </div>
    </section>
    <section className="ts-sec">
      <h3>{t.CERT_SECTION}</h3>
      <p className="ts-desc">{t.CERT_DESC}</p>
      {domains.error && <div className="err">{errorMessage(domains.error)}</div>}
      <div className="awc-form-grid">
        <label className="field">
          {t.DOMAIN}
          <select className="field-input" value={domain} onChange={(e) => setDomain(e.target.value)}>
            {domains.data?.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        {folderField}
      </div>
      <div className="ts-connect-acts">
        <button className="btn small" onClick={() => void pickFolder()}>{t.PICK_FOLDER}</button>
        <button className="btn small" onClick={() => void open({ action: "certificate", folder, domain }, domain)}>{t.CERT}</button>
      </div>
    </section>
    </div></div>
    {preview && <ShareSheet preview={preview} onClose={() => setPreview(null)} />}
  </>;
}
