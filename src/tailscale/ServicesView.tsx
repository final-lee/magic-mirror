import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { errorMessage } from "../api/errors";
import { invoke } from "../api/invoke";
import { useModal } from "../iam/useModal";
import { ApiRequired } from "./ApiRequired";
import { useTailscaleApi } from "./useTailscaleApi";
import * as t from "./servicesText";

type Service = {
  name: string;
  displayName?: string;
  addrs?: string[];
  ports?: string[];
  tags?: string[];
  comment?: string;
};
type Host = { stableNodeID: string; approvalLevel?: string; configured?: string };
type Operation = {
  kind: "put" | "delete" | "approval";
  name: string;
  body: Service | { approved: boolean } | null;
  before: Service | { approved: boolean } | null;
  device?: string;
};
const list = (value: string) =>
  value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const path = (name: string) => `/tailnet/-/services/${encodeURIComponent(name)}`;

export function ServicesView() {
  const { tailnet, connected, isLoading } = useTailscaleApi();
  if (isLoading) return <div className="empty">{t.LOADING}</div>;
  if (!connected || !tailnet) return <ApiRequired title={t.TITLE} />;
  return <Services tailnet={tailnet} />;
}

function Services({ tailnet }: { tailnet: string }) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["tailscale", "services", tailnet],
    queryFn: () => invoke<Service[]>("tailscale_services", { tailnet }),
    retry: false,
  });
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Service | null>(null);
  const [edit, setEdit] = useState<Service | null>(null);
  const [creating, setCreating] = useState(false);
  const [operation, setOperation] = useState<Operation | null>(null);
  const services = (query.data ?? []).filter((s) => s.name.toLowerCase().includes(search.toLowerCase()));
  const refresh = () => void qc.invalidateQueries({ queryKey: ["tailscale", "services", tailnet] });
  return (
    <div className="argowf-list">
      <div className="awc-bar">
        <h2 className="awc-title">{t.TITLE}</h2>
        <span className="awc-stat">
          <b>{services.length}</b>
        </span>
        <input
          className="k8s-filter"
          placeholder={t.SEARCH}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="awc-bar-end">
          <button
            className="btn small"
            onClick={() => {
              setCreating(true);
              setEdit({ name: "", addrs: [], ports: [], tags: [], comment: "" });
            }}
          >
            {t.CREATE}
          </button>
          <button className="btn small" onClick={() => void query.refetch()}>
            {t.REFRESH}
          </button>
        </div>
      </div>
      <div
        className="awc-scroll"
        onClick={(e) => {
          if (e.target === e.currentTarget) setSelected(null);
        }}
      >
        {query.error && <p role="alert">{errorMessage(query.error)}</p>}
          <table className="argowf-table">
            <thead>
              <tr>
                <th>{t.NAME}</th>
                <th>{t.ADDRS}</th>
                <th>{t.PORTS}</th>
                <th>{t.TAGS}</th>
                <th>{t.COMMENT}</th>
              </tr>
            </thead>
            <tbody>
              {services.map((service) => (
                <tr key={service.name} onClick={() => setSelected(selected?.name === service.name ? null : service)}>
                  <td>{service.name}</td>
                  <td>{(service.addrs ?? []).join(", ")}</td>
                  <td>{(service.ports ?? []).join(", ")}</td>
                  <td>{(service.tags ?? []).join(", ")}</td>
                  <td>{service.comment || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        {!services.length && !query.isLoading && !query.error && <p className="dim">{t.EMPTY}</p>}
      </div>
      {selected && (
        <ServicePanel
          tailnet={tailnet}
          service={selected}
          onClose={() => setSelected(null)}
          onEdit={() => {
            setCreating(false);
            setEdit(selected);
          }}
          onOperation={setOperation}
        />
      )}
      {edit && (
        <ServiceEditor
          initial={edit}
          creating={creating}
          onClose={() => setEdit(null)}
          onPreview={(body) => {
            setOperation({ kind: "put", name: creating ? body.name : edit.name, body, before: creating ? null : edit });
            setEdit(null);
          }}
        />
      )}
      {operation && (
        <ServiceConfirmation
          key={`${operation.kind}-${operation.name}-${JSON.stringify(operation.body)}`}
          tailnet={tailnet}
          operation={operation}
          onClose={() => setOperation(null)}
          onDone={() => {
            refresh();
            setSelected(null);
          }}
          onUndo={(inverse) => setOperation(inverse)}
        />
      )}
    </div>
  );
}

function ServicePanel({
  tailnet,
  service,
  onClose,
  onEdit,
  onOperation,
}: {
  tailnet: string;
  service: Service;
  onClose: () => void;
  onEdit: () => void;
  onOperation: (op: Operation) => void;
}) {
  const hosts = useQuery({
    queryKey: ["tailscale", "service-hosts", tailnet, service.name],
    queryFn: () => invoke<Host[]>("tailscale_service_hosts", { tailnet, name: service.name }),
    retry: false,
  });
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  return (
    <section className="awc-panel">
      <div className="ts-panel-head">
        <strong>{service.name}</strong>
        <button className="btn small" onClick={onEdit}>
          {t.EDIT}
        </button>
        <button
          className="btn small"
          onClick={() => onOperation({ kind: "delete", name: service.name, before: service, body: null })}
        >
          {t.DELETE}
        </button>
        <button className="btn small" onClick={onClose} aria-label={t.CLOSE}>
          ✕
        </button>
      </div>
      <div className="awc-body">
        <h3>{t.HOSTS}</h3>
        <p className="dim">{t.HOSTS_DESCRIPTION}</p>
        {hosts.data && hosts.data.length === 0 && <p className="dim">{t.NO_HOSTS}</p>}
        {hosts.error && <p role="alert">{errorMessage(hosts.error)}</p>}
        {(hosts.data ?? []).map((host) => (
          <HostRow
            key={host.stableNodeID}
            tailnet={tailnet}
            service={service.name}
            host={host}
            onOperation={onOperation}
          />
        ))}
      </div>
    </section>
  );
}
function HostRow({
  tailnet,
  service,
  host,
  onOperation,
}: {
  tailnet: string;
  service: string;
  host: Host;
  onOperation: (op: Operation) => void;
}) {
  const query = useQuery({
    queryKey: ["tailscale", "service-approval", tailnet, service, host.stableNodeID],
    queryFn: () =>
      invoke<{ approved: boolean; autoApproved: boolean }>("tailscale_service_approval", {
        tailnet,
        name: service,
        device: host.stableNodeID,
      }),
    retry: false,
  });
  return (
    <div className="awc-editor-opts">
      <strong>{host.stableNodeID}</strong>
      {host.configured != null && (
        <span title={String(host.configured)}>
          {t.CONFIGURED_PREFIX}{t.HOST_STATUS[String(host.configured)] ?? t.UNKNOWN}
        </span>
      )}
      {host.approvalLevel && (
        <span title={host.approvalLevel}>
          {t.APPROVAL_LEVEL_PREFIX}{t.HOST_STATUS[host.approvalLevel] ?? t.UNKNOWN}
        </span>
      )}
      {query.data && (
        <span title={String(query.data.approved)}>
          {query.data.approved ? t.HOST_STATUS.approved : t.HOST_STATUS.pending}
        </span>
      )}
      {query.error && <span role="alert">{errorMessage(query.error)}</span>}
      {query.data && (
        <button
          className="btn small"
          onClick={() =>
            onOperation({
              kind: "approval",
              name: service,
              device: host.stableNodeID,
              before: { approved: query.data.approved },
              body: { approved: !query.data.approved },
            })
          }
        >
          {query.data.approved ? t.REVOKE : t.APPROVE}
        </button>
      )}
    </div>
  );
}
function ServiceEditor({
  initial,
  creating,
  onClose,
  onPreview,
}: {
  initial: Service;
  creating: boolean;
  onClose: () => void;
  onPreview: (body: Service) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [displayName, setDisplayName] = useState(initial.displayName ?? "");
  const [addrs, setAddrs] = useState((initial.addrs ?? []).join(", "));
  const [ports, setPorts] = useState((initial.ports ?? []).join(", "));
  const [tags, setTags] = useState((initial.tags ?? []).join(", "));
  const [comment, setComment] = useState(initial.comment ?? "");
  const { sheetRef, trapTab } = useModal(onClose);
  return (
    <div
      className="modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={creating ? t.CREATE : t.EDIT}
        ref={sheetRef}
        onKeyDown={trapTab}
      >
        <h3>{creating ? t.CREATE : t.EDIT}</h3>
        <p className="dim">{t.EDITOR_DESCRIPTION}</p>
        <div className="awc-form-grid">
        <label className="field" title="name">
          {t.NAME}
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field" title="displayName">
          {t.DISPLAY_NAME}
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label className="field" title="addrs">
          {t.ADDRS}
          <input aria-label={t.ADDRS} value={addrs} onChange={(e) => setAddrs(e.target.value)} />
          <small className="dim">{t.COMMA_HELP}</small>
        </label>
        <label className="field" title="ports">
          {t.PORTS}
          <input aria-label={t.PORTS} value={ports} onChange={(e) => setPorts(e.target.value)} />
          <small className="dim">{t.PORTS_HELP}</small>
        </label>
        <label className="field" title="tags">
          {t.TAGS}
          <input aria-label={t.TAGS} value={tags} onChange={(e) => setTags(e.target.value)} />
          <small className="dim">{t.COMMA_HELP}</small>
        </label>
        <label className="field" title="comment">
          {t.COMMENT}
          <input value={comment} onChange={(e) => setComment(e.target.value)} />
        </label>
        </div>
        <div className="foot">
          <button
            className="btn small"
            disabled={!name.trim()}
            onClick={() =>
              onPreview({
                name: name.trim(),
                displayName,
                addrs: list(addrs),
                ports: list(ports),
                tags: list(tags),
                comment,
              })
            }
          >
            {t.PREVIEW}
          </button>
          <button className="btn small" onClick={onClose}>
            {t.CANCEL}
          </button>
        </div>
      </div>
    </div>
  );
}
function ServiceConfirmation({
  tailnet,
  operation,
  onClose,
  onDone,
  onUndo,
}: {
  tailnet: string;
  operation: Operation;
  onClose: () => void;
  onDone: () => void;
  onUndo: (op: Operation) => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const close = () => {
    if (!busy) onClose();
  };
  const { sheetRef, trapTab } = useModal(close);
  const url =
    operation.kind === "approval"
      ? `${path(operation.name)}/device/${encodeURIComponent(operation.device!)}/approved`
      : path(operation.name);
  const method = operation.kind === "put" ? "PUT" : operation.kind === "delete" ? "DELETE" : "POST";
  async function apply() {
    setBusy(true);
    setError("");
    try {
      if (operation.kind === "put")
        await invoke("tailscale_service_put", {
          tailnet,
          name: operation.name,
          body: operation.body,
          before: operation.before,
        });
      else if (operation.kind === "delete")
        await invoke("tailscale_service_delete", { tailnet, name: operation.name, typed, before: operation.before });
      else
        await invoke("tailscale_service_set_approval", {
          tailnet,
          name: operation.name,
          device: operation.device,
          approved: (operation.body as { approved: boolean }).approved,
        });
      setDone(true);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function undo() {
    if (operation.kind === "approval") onUndo({ ...operation, body: operation.before, before: operation.body });
    else if (operation.before)
      onUndo({
        kind: "put",
        name: operation.kind === "put" ? (operation.body as Service).name : operation.name,
        body: operation.before,
        before: operation.body,
      });
    else onUndo({ kind: "delete", name: (operation.body as Service).name, before: operation.body, body: null });
  }
  return (
    <div
      className="modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="sheet"
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
              {method} {url}
              {operation.body && `\n${JSON.stringify(operation.body, null, 2)}`}
            </pre>
            {operation.kind === "delete" && (
              <label>
                {t.CONFIRM_DELETE}: <strong>{operation.name}</strong>
                <input value={typed} onChange={(e) => setTyped(e.target.value)} />
              </label>
            )}
            <button
              className="btn small"
              disabled={busy || (operation.kind === "delete" && typed !== operation.name)}
              onClick={() => void apply()}
            >
              {t.APPLY}
            </button>
          </>
        )}
        {done && (
          <button className="btn small" onClick={undo}>
            {t.UNDO}
          </button>
        )}
        <button className="btn small" disabled={busy} onClick={close}>
          {done ? t.CLOSE : t.CANCEL}
        </button>
        {error && <p role="alert">{error}</p>}
      </div>
    </div>
  );
}
