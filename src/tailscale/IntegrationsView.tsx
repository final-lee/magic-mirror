import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { desktop } from "../api/desktop";
import { errorMessage } from "../api/errors";
import { invoke } from "../api/invoke";
import { useModal } from "../iam/useModal";
import { ApiRequired } from "./ApiRequired";
import { useTailscaleApi } from "./useTailscaleApi";
import * as t from "./integrationsText";
import { integrationTone, revertTone } from "./tone";

type ObjectValue = Record<string, unknown>;
type Area = "webhook" | "posture" | "app" | "stream";
type Operation = {
  action: string;
  id: string;
  method: string;
  path: string;
  body: ObjectValue | null;
  before: ObjectValue | null;
  inverse?: Operation;
  revert?: boolean;
};
type Field = { key: string; options?: string[]; array?: boolean; secret?: boolean; number?: boolean };
const fields: Record<Area, Field[]> = {
  webhook: [
    { key: "endpointUrl" },
    { key: "providerType", options: ["", "slack", "mattermost", "googlechat", "discord"] },
    { key: "subscriptions", array: true },
  ],
  posture: [
    { key: "provider", options: ["falcon", "intune", "jamfpro", "kandji", "kolide", "sentinelone"] },
    { key: "cloudId" },
    { key: "clientId" },
    { key: "tenantId" },
    { key: "clientSecret", secret: true },
  ],
  app: [
    { key: "name" },
    { key: "description" },
    { key: "redirectURIs", array: true },
    { key: "scopes", array: true },
    { key: "allowedNodeAttributes", array: true },
  ],
  stream: [
    {
      key: "destinationType",
      options: ["splunk", "elastic", "panther", "cribl", "crowdstrike", "datadog", "axiom", "s3"],
    },
    { key: "url" },
    { key: "user" },
    { key: "token", secret: true },
    { key: "uploadPeriodMinutes", number: true },
    { key: "compressionFormat", options: ["none", "zstd", "gzip"] },
    { key: "s3Bucket" },
    { key: "s3Region" },
    { key: "s3KeyPrefix" },
    { key: "s3AuthenticationType", options: ["", "rolearn", "accesskey"] },
    { key: "s3RoleArn" },
    { key: "s3AccessKeyId" },
    { key: "s3SecretAccessKey", secret: true },
  ],
};
function request(action: string, id: string, body: ObjectValue | null, before: ObjectValue | null = null): Operation {
  const encoded = encodeURIComponent(id);
  const routes: Record<string, [string, string]> = {
    webhookCreate: ["POST", "/tailnet/-/webhooks"],
    webhookUpdate: ["PATCH", `/webhooks/${encoded}`],
    webhookDelete: ["DELETE", `/webhooks/${encoded}`],
    webhookTest: ["POST", `/webhooks/${encoded}/test`],
    webhookRotate: ["POST", `/webhooks/${encoded}/rotate`],
    postureCreate: ["POST", "/tailnet/-/posture/integrations"],
    postureUpdate: ["PATCH", `/posture/integrations/${encoded}`],
    postureDelete: ["DELETE", `/posture/integrations/${encoded}`],
    appCreate: ["POST", "/tailnet/-/oauth-apps"],
    appUpdate: ["PUT", `/tailnet/-/oauth-apps/${encoded}`],
    appDelete: ["DELETE", `/tailnet/-/oauth-apps/${encoded}`],
    streamPut: ["PUT", `/tailnet/-/logging/${encoded}/stream`],
    streamPutPrivate: ["PUT", `/tailnet/-/logging/${encoded}/stream`],
    streamDelete: ["DELETE", `/tailnet/-/logging/${encoded}/stream`],
    externalCreate: ["POST", "/tailnet/-/aws-external-id"],
    externalValidate: ["POST", `/tailnet/-/aws-external-id/${encoded}/validate-aws-trust-policy`],
  };
  const [method, path] = routes[action];
  return { action, id, method, path, body, before };
}
async function call(
  tailnet: string,
  action: string,
  id = "",
  body: ObjectValue | null = null,
  before: ObjectValue | null = null,
  typed = "",
) {
  return invoke<ObjectValue | null>("tailscale_integration_call", { tailnet, action, id, body, before, typed });
}
export function IntegrationsView() {
  const { tailnet, connected, isLoading } = useTailscaleApi();
  if (isLoading) return <div className="empty">{t.LOADING}</div>;
  if (!connected || !tailnet) return <ApiRequired title={t.TITLE} />;
  return <Integrations tailnet={tailnet} />;
}
function Integrations({ tailnet }: { tailnet: string }) {
  const client = useQueryClient();
  const [editor, setEditor] = useState<{ area: Area; id: string; initial: ObjectValue | null } | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [revision, setRevision] = useState(0);
  const [externalId, setExternalId] = useState("");
  const [roleArn, setRoleArn] = useState("");
  const refresh = () => void client.invalidateQueries({ queryKey: ["tailscale", "integrations", tailnet] });
  return (
    <div className="argowf-list">
      <div className="awc-bar">
        <h2 className="awc-title">{t.TITLE}</h2>
        <div className="awc-bar-end">
          <button className="btn small tone-refresh" onClick={refresh}>
            {t.REFRESH}
          </button>
        </div>
      </div>
      <div className="awc-scroll">
        <IntegrationSection
          tailnet={tailnet}
          area="webhook"
          title={t.WEBHOOKS}
          property="webhooks"
          onEdit={setEditor}
          onOperation={setOperation}
        />
        <IntegrationSection
          tailnet={tailnet}
          area="posture"
          title={t.POSTURE}
          property="integrations"
          onEdit={setEditor}
          onOperation={setOperation}
        />
        <IntegrationSection
          tailnet={tailnet}
          area="app"
          title={t.APPS}
          property="oauthApps"
          onEdit={setEditor}
          onOperation={setOperation}
        />
        <section className="awc-body" style={{ flex: "none" }}>
          <div className="ts-sec-head">
            <h3>{t.STREAM}</h3>
          </div>
          <p className="dim">{t.STREAM_DESCRIPTION}</p>
          <table className="argowf-table">
            <thead>
              <tr>
                <th>{t.STREAM_HEADERS.kind}</th>
                <th>{t.STREAM_HEADERS.destination}</th>
                <th>{t.STREAM_HEADERS.actions}</th>
              </tr>
            </thead>
            <tbody>
              {["configuration", "network"].map((id) => (
                <StreamRow key={id} tailnet={tailnet} id={id} onEdit={setEditor} onOperation={setOperation} />
              ))}
            </tbody>
          </table>
        </section>
      </div>
      {editor && (
        <IntegrationEditor
          key={`${editor.area}-${editor.id}`}
          {...editor}
          externalId={externalId}
          roleArn={roleArn}
          onRoleArn={setRoleArn}
          onExternalId={setExternalId}
          onOperation={setOperation}
          onClose={() => setEditor(null)}
          onPreview={(body, privateEndpoint) => {
            const action =
              editor.area === "stream"
                ? privateEndpoint
                  ? "streamPutPrivate"
                  : "streamPut"
                : `${editor.area}${editor.initial ? "Update" : "Create"}`;
            const op = request(action, editor.id, body, editor.initial);
            if (
              editor.initial &&
              (editor.area === "webhook" ||
                editor.area === "app" ||
                (editor.area === "posture" && !("clientSecret" in body)))
            ) {
              const previous: ObjectValue = {};
              for (const key of Object.keys(body)) if (key in editor.initial) previous[key] = editor.initial[key];
              op.inverse = request(action, editor.id, previous, body);
            }
            setEditor(null);
            setOperation(op);
          }}
        />
      )}
      {operation && (
        <IntegrationConfirmation
          key={revision}
          tailnet={tailnet}
          operation={operation}
          onClose={() => setOperation(null)}
          onDone={(result) => {
            if (typeof result?.externalId === "string") setExternalId(result.externalId);
            refresh();
          }}
          onUndo={(next) => {
            setOperation({ ...next, revert: true });
            setRevision((value) => value + 1);
          }}
        />
      )}
    </div>
  );
}
function IntegrationSection({
  tailnet,
  area,
  title,
  property,
  onEdit,
  onOperation,
}: {
  tailnet: string;
  area: Exclude<Area, "stream">;
  title: string;
  property: string;
  onEdit: (v: { area: Area; id: string; initial: ObjectValue | null }) => void;
  onOperation: (v: Operation) => void;
}) {
  const query = useQuery({
    queryKey: ["tailscale", "integrations", tailnet, area],
    queryFn: () => call(tailnet, `${area}List`),
    retry: false,
  });
  const data = query.data?.[property];
  const items: ObjectValue[] = Array.isArray(data) ? data : [];
  return (
    <section className="awc-body" style={{ flex: "none" }}>
      <div className="ts-sec-head">
        <h3>{title}</h3>
        <button className="btn small tone-create" onClick={() => onEdit({ area, id: "", initial: null })}>
          {t.CREATE_OPEN}
        </button>
      </div>
      <p className="dim">{t.SECTION_DESCRIPTIONS[area]}</p>
      {query.error && <p role="alert">{errorMessage(query.error)}</p>}
      {items.length > 0 ? (
        <table className="argowf-table">
          <thead><tr><th>{t.NAME_HEADER}</th><th>{t.IDENTIFIER}</th><th>{t.ACTIONS}</th></tr></thead>
          <tbody>
            {items.map((item) => {
              const id = String(item[area === "webhook" ? "endpointId" : "id"] ?? "");
              return (
                <tr key={id}>
                  <td>{String(item.name ?? item.provider ?? id)}</td>
                  <td>{id}</td>
                  <td>
                    <button className="btn small tone-primary" onClick={() => onEdit({ area, id, initial: item })}>
                      {t.EDIT_OPEN}
                    </button>
                    {area === "webhook" && (
                      <>
                        <button className="btn small tone-primary" onClick={() => onOperation(request("webhookTest", id, null))}>
                          {t.TEST}
                        </button>
                        <button className="btn small tone-warn" onClick={() => onOperation(request("webhookRotate", id, null))}>
                          {t.ROTATE}
                        </button>
                      </>
                    )}
                    <button className="btn small tone-danger" onClick={() => onOperation(request(`${area}Delete`, id, null, item))}>
                      {t.DELETE}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : !query.isLoading && !query.error ? <p className="dim">{t.EMPTY[area]}</p> : null}
    </section>
  );
}
function StreamRow({
  tailnet,
  id,
  onEdit,
  onOperation,
}: {
  tailnet: string;
  id: string;
  onEdit: (v: { area: Area; id: string; initial: ObjectValue | null }) => void;
  onOperation: (v: Operation) => void;
}) {
  const query = useQuery({
    queryKey: ["tailscale", "integrations", tailnet, "stream", id],
    queryFn: () => call(tailnet, "streamGet", id),
    retry: false,
  });
  const destination = query.data ? String(query.data.destinationType ?? "") : "";
  return (
    <tr>
      <td title={id}>{t.STREAM_KINDS[id] ?? id}</td>
      <td>
        {query.error ? (
          <span className="dim" role="alert">{errorMessage(query.error)}</span>
        ) : destination ? (
          <span title={destination}>{t.OPTION_LABELS[destination] ?? destination}</span>
        ) : (
          t.STREAM_OFF
        )}
      </td>
      <td>
        <button className="btn small tone-primary" onClick={() => onEdit({ area: "stream", id, initial: query.data ?? null })}>{t.CONFIGURE}</button>
        {query.data && <button className="btn small tone-danger" onClick={() => onOperation(request("streamDelete", id, null, query.data))}>{t.DISABLE}</button>}
      </td>
    </tr>
  );
}
function IntegrationEditor({
  area,
  id,
  initial,
  onClose,
  onPreview,
  externalId,
  roleArn,
  onExternalId,
  onRoleArn,
  onOperation,
}: {
  area: Area;
  id: string;
  initial: ObjectValue | null;
  onClose: () => void;
  onPreview: (body: ObjectValue, privateEndpoint: boolean) => void;
  externalId: string;
  roleArn: string;
  onExternalId: (value: string) => void;
  onRoleArn: (value: string) => void;
  onOperation: (value: Operation) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields[area].map((field) => {
        const value = initial?.[field.key];
        return [field.key, Array.isArray(value) ? value.join(", ") : String(value ?? field.options?.[0] ?? "")];
      }),
    ),
  );
  const [privateEndpoint, setPrivateEndpoint] = useState(false);
  const { sheetRef, trapTab } = useModal(onClose);
  function preview() {
    const body: ObjectValue = {};
    for (const field of fields[area]) {
      if (area === "webhook" && initial && field.key !== "subscriptions") continue;
      if (area === "posture" && initial && field.key === "provider") continue;
      const value = values[field.key]?.trim() ?? "";
      if (field.secret && !value) continue;
      if (field.number) {
        if (value) body[field.key] = Number(value);
      } else if (field.array) {
        const arr = value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (field.key !== "allowedNodeAttributes" || arr.length || initial) body[field.key] = arr;
      } else if (value || field.key === "providerType") body[field.key] = value;
    }
    onPreview(body, privateEndpoint);
  }
  return (
    <div
      className="modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="sheet wide"
        role="dialog"
        aria-modal="true"
        aria-label={t.EDIT}
        ref={sheetRef}
        onKeyDown={trapTab}
      >
        <h3>{area === "stream" ? t.STREAM_EDITOR : id || t.CREATE}</h3>
        <p className="dim">{t.EDITOR_DESCRIPTION}</p>
        <div className="awc-form-grid">
        {fields[area]
          .filter(
            (f) =>
              !(area === "webhook" && initial && f.key !== "subscriptions") &&
              !(area === "posture" && initial && f.key === "provider"),
          )
          .map((f) => (
            <label className="field" key={f.key} title={f.key}>
              {t.FIELD_LABELS[f.key]}
              {f.options ? (
                <select value={values[f.key]} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
                  {f.options.map((v) => (
                    <option key={v} value={v}>
                      {t.OPTION_LABELS[v] ?? (v || t.NO_CHOICE)}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type={f.secret ? "password" : f.number ? "number" : "text"}
                  value={values[f.key]}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                />
              )}
              {f.array && <small className="dim">{t.COMMA}</small>}
              {f.secret && initial && <small className="dim">{t.SECRET_KEEP}</small>}
            </label>
          ))}
        </div>
        {area === "stream" && (
          <>
            <div className="awc-editor-opts">
              <label>
                <input type="checkbox" checked={privateEndpoint} onChange={(e) => setPrivateEndpoint(e.target.checked)} />
                {t.PRIVATE_ENDPOINT}
              </label>
            </div>
            {values.destinationType === "s3" && (
              <>
                <h3>{t.AWS_EXTERNAL_ID}</h3>
                <p className="dim">{t.AWS_DESCRIPTION}</p>
                <div className="awc-form-grid">
                  <label className="field" title="externalId">
                    {t.EXTERNAL_ID_LABEL}
                    <input value={externalId} onChange={(e) => onExternalId(e.target.value)} />
                  </label>
                  <label className="field" title="roleArn">
                    {t.ROLE_ARN}
                    <input value={roleArn} onChange={(e) => onRoleArn(e.target.value)} />
                  </label>
                </div>
                <div className="awc-editor-opts">
                  <button className="btn small tone-create" onClick={() => onOperation(request("externalCreate", "", { reusable: true }))}>{t.EXTERNAL_ID}</button>
                  <button
                    className="btn small tone-refresh"
                    disabled={!externalId || !roleArn}
                    onClick={() => onOperation(request("externalValidate", externalId, { roleArn }))}
                  >
                    {t.VALIDATE}
                  </button>
                </div>
              </>
            )}
          </>
        )}
        <button
          className={`btn small tone-${area !== "stream" && !initial ? "create" : "primary"}`}
          onClick={preview}
        >
          {t.PREVIEW_OPEN}
        </button>
        <button className="btn small tone-ghost" onClick={onClose}>
          {t.CANCEL}
        </button>
      </div>
    </div>
  );
}
function IntegrationConfirmation({
  tailnet,
  operation,
  onClose,
  onDone,
  onUndo,
}: {
  tailnet: string;
  operation: Operation;
  onClose: () => void;
  onDone: (result: ObjectValue | null) => void;
  onUndo: (operation: Operation) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [typed, setTyped] = useState("");
  const [result, setResult] = useState<ObjectValue | null>(null);
  const [error, setError] = useState("");
  const close = () => {
    if (!busy) onClose();
  };
  const { sheetRef, trapTab } = useModal(close);
  const deleting = operation.action.endsWith("Delete") && operation.action !== "streamDelete";
  const baseTone = integrationTone(operation.action);
  const tone = operation.revert ? revertTone(baseTone) : baseTone;
  async function apply() {
    setBusy(true);
    setError("");
    try {
      const response = await call(tailnet, operation.action, operation.id, operation.body, operation.before, typed);
      setResult(response);
      setDone(true);
      onDone(response);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const secret =
    typeof result?.secret === "string"
      ? result.secret
      : typeof result?.clientSecret === "string"
        ? result.clientSecret
        : null;
  const createdId = operation.action === "webhookCreate" ? result?.endpointId : result?.id;
  const createdArea =
    operation.action === "webhookCreate"
      ? "webhook"
      : operation.action === "postureCreate"
        ? "posture"
        : operation.action === "appCreate"
          ? "app"
          : null;
  return (
    <div
      className="modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="sheet wide"
        role="dialog"
        aria-modal="true"
        aria-label={done ? t.DONE : t.PREVIEW}
        ref={sheetRef}
        onKeyDown={trapTab}
      >
        <h3>{done ? t.DONE : t.PREVIEW}</h3>
        {!done && (
          <>
            <pre>
              {operation.method} {operation.path}
              {operation.body && `\n${JSON.stringify(operation.body, null, 2)}`}
            </pre>
            {deleting && (
              <label>
                {t.TYPE_ID}: <strong>{operation.id}</strong>
                <input value={typed} onChange={(e) => setTyped(e.target.value)} />
              </label>
            )}
            <button
              className={`btn small tone-${tone}`}
              disabled={busy || (deleting && typed !== operation.id)}
              onClick={() => void apply()}
            >
              {t.APPLY}
            </button>
          </>
        )}
        {secret && (
          <>
            <p>{t.ONCE}</p>
            <code>{secret}</code>
            <button className="btn small tone-secondary" onClick={() => void desktop.copy(secret)}>
              {t.COPY}
            </button>
          </>
        )}
        {done && typeof result?.externalId === "string" && (
          <dl className="kv">
            <dt title="externalId">{t.EXTERNAL_ID_LABEL}</dt>
            <dd>{result.externalId}</dd>
          </dl>
        )}
        {done && operation.inverse && (
          <button
            className={`btn small tone-${revertTone(integrationTone(operation.inverse.action))}`}
            onClick={() => onUndo(operation.inverse!)}
          >
            {t.UNDO}
          </button>
        )}
        {done && createdArea && typeof createdId === "string" && (
          <button className="btn small tone-danger" onClick={() => onUndo(request(`${createdArea}Delete`, createdId, null))}>
            {t.UNDO}
          </button>
        )}
        <button className="btn small tone-ghost" disabled={busy} onClick={close}>
          {done ? t.CLOSE : t.CANCEL}
        </button>
        {error && <p role="alert">{error}</p>}
      </div>
    </div>
  );
}
