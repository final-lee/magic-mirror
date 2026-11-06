import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage } from "../api/errors";
import { desktop } from "../api/desktop";
import { invoke } from "../api/invoke";
import { useModal } from "../iam/useModal";
import { ApiRequired } from "./ApiRequired";
import { useTailscaleApi } from "./useTailscaleApi";
import * as t from "./orgText";

type Tailnet = { id: string; displayName: string; createdAt?: string };
type Created = Tailnet & { alreadyExists?: boolean; oauthClient?: { id: string; secret: string } };
type Action = { kind: "create"; name: string } | { kind: "delete"; tailnet: Tailnet };
export function OrgView() {
  const { tailnet, connected, isLoading } = useTailscaleApi();
  if (isLoading) return <div className="empty">{t.LOADING}</div>;
  if (!connected || !tailnet) return <ApiRequired title={t.TITLE} />;
  return <Organization tailnet={tailnet} />;
}
function Organization({ tailnet }: { tailnet: string }) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["tailscale", "org", tailnet],
    queryFn: () => invoke<Tailnet[]>("tailscale_org_tailnets", { tailnet }),
    retry: false,
  });
  const [name, setName] = useState("");
  const [action, setAction] = useState<Action | null>(null);
  return (
    <div className="argowf-list">
      <div className="awc-bar">
        <h2 className="awc-title">{t.TITLE}</h2>
        <span className="awc-stat">
          <b>{query.data?.length ?? 0}</b>
        </span>
        <div className="awc-bar-end">
          <button className="btn small" onClick={() => void query.refetch()}>
            {t.REFRESH}
          </button>
        </div>
      </div>
      <div className="awc-scroll">
        <div className="awc-body" style={{ flex: "none" }}>
          <h3>{t.MANAGE_TITLE}</h3>
          <p className="dim">{t.MANAGE_DESCRIPTION}</p>
          <div className="awc-editor-opts">
          <label>
            {t.NAME}
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <button
            className="btn small"
            disabled={!name.trim()}
            onClick={() => setAction({ kind: "create", name: name.trim() })}
          >
            {t.CREATE}
          </button>
          </div>
        </div>
        {query.error && <p role="alert">{errorMessage(query.error)}</p>}
          <table className="argowf-table">
            <thead>
              <tr>
                <th>{t.NAME}</th>
                <th>ID</th>
                <th>{t.ACTIONS}</th>
              </tr>
            </thead>
            <tbody>
              {(query.data ?? []).map((item) => (
                <tr key={item.id}>
                  <td>{item.displayName}</td>
                  <td>{item.id}</td>
                  <td>
                    <button className="btn small" onClick={() => setAction({ kind: "delete", tailnet: item })}>
                      {t.DELETE}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        {!query.isLoading && !query.error && !query.data?.length && <p className="dim">{t.EMPTY}</p>}
      </div>
      {action && (
        <OrgConfirmation
          key={action.kind}
          tailnet={tailnet}
          action={action}
          onClose={() => setAction(null)}
          onUndo={(item) => setAction({ kind: "delete", tailnet: item })}
          onDone={() => {
            setName("");
            void client.invalidateQueries({ queryKey: ["tailscale", "org", tailnet] });
          }}
        />
      )}
    </div>
  );
}
function OrgConfirmation({
  tailnet,
  action,
  onClose,
  onDone,
  onUndo,
}: {
  tailnet: string;
  action: Action;
  onClose: () => void;
  onDone: () => void;
  onUndo: (item: Tailnet) => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const [error, setError] = useState("");
  const close = () => {
    if (!busy) onClose();
  };
  const { sheetRef, trapTab } = useModal(close);
  async function apply() {
    setBusy(true);
    setError("");
    try {
      if (action.kind === "create")
        setCreated(await invoke<Created>("tailscale_org_create", { tailnet, displayName: action.name }));
      else
        await invoke("tailscale_org_delete", {
          tailnet,
          id: action.tailnet.id,
          name: action.tailnet.displayName,
          typed,
        });
      setDone(true);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
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
            {action.kind === "create" ? (
              <pre>
                POST /organizations/-/tailnets{"\n"}
                {JSON.stringify({ displayName: action.name }, null, 2)}
              </pre>
            ) : (
              <>
                <p>{t.DELETE_WARNING}</p>
                <pre>DELETE /tailnet/{encodeURIComponent(action.tailnet.id)}</pre>
                <label>
                  {t.TYPE_NAME}: <strong>{action.tailnet.displayName}</strong>
                  <input value={typed} onChange={(e) => setTyped(e.target.value)} />
                </label>
              </>
            )}
            <button
              className="btn small"
              disabled={busy || (action.kind === "delete" && typed !== action.tailnet.displayName)}
              onClick={() => void apply()}
            >
              {t.APPLY}
            </button>
          </>
        )}
        {created?.oauthClient && (
          <>
            <p>{t.SECRET_ONCE}</p>
            <div>{created.oauthClient.id}</div>
            <code>{created.oauthClient.secret}</code>
            <button className="btn small" onClick={() => void desktop.copy(created.oauthClient!.secret)}>
              {t.COPY}
            </button>
          </>
        )}
        {created && !created.alreadyExists && created.id && (
          <button className="btn small" onClick={() => onUndo({ id: created.id, displayName: created.displayName })}>
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
