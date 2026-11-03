import { useEffect, useState } from "react";
import { desktop } from "../api/desktop";
import { errorMessage } from "../api/errors";
import { ActionDialog, needsTypedName } from "./ActionDialog";
import { argowfApi } from "./api";
import { useCatalogAction, useTokenGate } from "./catalogHooks";
import { useEventSources, useSensors } from "./catalogQueries";
import { ManifestEditor } from "./ManifestEditor";
import { ARGO_EVENTS_MISSING } from "./text";
import type { ArgoWfConn, ArgoWfLink, EventSourceRow, SensorRow } from "./types";

export interface EventResourceProps {
  conn: ArgoWfConn;
  live: boolean;
  namespace: string | null;
  links: ArgoWfLink[];
  onTokenError(m: string): void;
}
export function EventResources({ conn, live, namespace, links, onTokenError, kind }: EventResourceProps & { kind: "EventSource" | "Sensor" }) {
  const sources = useEventSources(conn, namespace, live, kind === "EventSource");
  const sensors = useSensors(conn, namespace, live, kind === "Sensor");
  const q = kind === "EventSource" ? sources : sensors;
  const [selection, setSelection] = useState<{ row: EventSourceRow | SensorRow; namespace: string | null } | null>(null);
  const selected = selection && selection.namespace === namespace ? selection.row : null;
  const [editor, setEditor] = useState<"create" | "edit" | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const action = useCatalogAction(conn, onTokenError);
  useTokenGate([q.error], onTokenError);
  useEffect(() => {
    setSelection(null);
    setShowLogs(false);
    setDeleting(false);
    setEditor((current) => (current === "edit" ? null : current));
  }, [namespace]);
  useEffect(() => {
    if (!live || !selected || !showLogs) return;
    let id: number | null = null;
    let cancelled = false;
    setLogs([]);
    argowfApi
      .resourceLogs(conn, kind, selected.namespace, selected.name, (m) => {
        if (cancelled) return;
        if (m.type === "lines") setLogs((old) => [...old, ...m.lines.map((line) => `${line.pod} ${line.text}`)].slice(-5000));
        if (m.type === "error") setLogs((old) => [...old, errorMessage(m.error)]);
      })
      .then((value) => {
        if (cancelled) void argowfApi.logsStop(value);
        else id = value;
      })
      .catch((e) => {
        if (!cancelled) setLogs([errorMessage(e)]);
      });
    return () => {
      cancelled = true;
      if (id !== null) void argowfApi.logsStop(id);
    };
  }, [conn.url, conn.context, conn.ssoProfile, kind, namespace, live, selected?.namespace, selected?.name, showLogs]);
  const raw = q.error ? errorMessage(q.error) : null;
  const error = raw?.includes(ARGO_EVENTS_MISSING) ? ARGO_EVENTS_MISSING : raw;
  const title = kind === "EventSource" ? "Event Sources" : "Sensors";
  const rows = q.data ?? [];
  return (
    <div className="awc">
      <div className="awc-bar">
        <h2 className="awc-title">{title}</h2>
        {!error && (
          <div className="awc-bar-end">
            <button className="btn primary small" onClick={() => setEditor("create")}>
              만들기
            </button>
          </div>
        )}
      </div>
      <div className="awc-scroll">
        {error ? (
          <div className="empty" role="alert">
            {error}
          </div>
        ) : q.isPending ? (
          <div className="empty">불러오는 중…</div>
        ) : rows.length === 0 ? (
          <div className="empty">{kind === "EventSource" ? "EventSource가 없어요" : "Sensor가 없어요"}</div>
        ) : (
          <table className="k8s-table awc-table">
            <thead>
              <tr>
                <th>이름</th>
                <th>네임스페이스</th>
                <th>상태</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const on = selected?.namespace === row.namespace && selected.name === row.name;
                return (
                  <tr
                    key={`${row.namespace}/${row.name}`}
                    className={`awc-row${on ? " on" : ""}`}
                    aria-selected={on}
                    onClick={() => {
                      setSelection({ row, namespace });
                      setShowLogs(false);
                    }}
                  >
                    <td>
                      <button className="link mono">{row.name}</button>
                    </td>
                    <td className="mono">{row.namespace}</td>
                    <td>{row.status ?? <span className="dim">–</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {selected && (
        <section className="awc-panel" aria-label={`${selected.name} 상세`}>
          <h3 className="mono">{selected.name}</h3>
          <dl className="kv">
            <dt>네임스페이스</dt>
            <dd className="mono">{selected.namespace}</dd>
            <dt>상태</dt>
            <dd>
              {selected.status ?? "–"} {selected.message && <span className="dim">{selected.message}</span>}
            </dd>
            {"types" in selected ? (
              <>
                <dt>종류</dt>
                <dd>{selected.types.join(", ") || "–"}</dd>
                <dt>이벤트</dt>
                <dd>{selected.eventNames.join(", ") || "–"}</dd>
              </>
            ) : (
              <>
                <dt>의존성</dt>
                <dd>{selected.dependencies.map((d) => `${d.name} (${d.eventSourceName}/${d.eventName})`).join(", ") || "–"}</dd>
                <dt>트리거</dt>
                <dd>{selected.triggers.map((t) => `${t.name} (${t.type}: ${t.target ?? ""})`).join(", ") || "–"}</dd>
              </>
            )}
          </dl>
          <div className="awc-acts">
            <button className="btn small" aria-pressed={showLogs} onClick={() => setShowLogs(!showLogs)}>
              로그
            </button>
            {showLogs &&
              links
                .filter((l) => l.scope === (kind === "EventSource" ? "event-source-logs" : "sensor-logs"))
                .map((l) => (
                  <button
                    key={l.url}
                    className="btn small"
                    onClick={() =>
                      void desktop.openUrl(l.url.replaceAll("${metadata.name}", selected.name).replaceAll("${metadata.namespace}", selected.namespace))
                    }
                  >
                    {l.name} ↗
                  </button>
                ))}
            <button className="btn small" onClick={() => setEditor("edit")}>
              고치기
            </button>
            <button className="btn small danger" onClick={() => setDeleting(true)}>
              삭제
            </button>
          </div>
          {showLogs && <pre>{logs.join("\n") || "로그를 기다리는 중…"}</pre>}
          <details>
            <summary>YAML</summary>
            <pre>{selected.yaml}</pre>
          </details>
        </section>
      )}
      {editor && (
        <ManifestEditor
          conn={conn}
          kind={kind}
          mode={editor}
          namespace={editor === "edit" ? (selected?.namespace ?? namespace) : namespace}
          name={editor === "edit" ? selected?.name : undefined}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            setSelection(null);
            void q.refetch();
          }}
        />
      )}
      {deleting && selected && (
        <ActionDialog
          title={`${selected.name} 삭제`}
          note="되돌릴 수 없어요."
          confirmLabel="삭제"
          danger
          requireName={needsTypedName(selected.name, selected.namespace) ? selected.name : null}
          busy={action.busy}
          error={action.error}
          onCancel={() => setDeleting(false)}
          onConfirm={() =>
            void action
              .run(() => argowfApi.remove(conn, kind, selected.namespace, selected.name), "삭제했어요")
              .then((r) => {
                if (r) {
                  setDeleting(false);
                  setSelection(null);
                  void q.refetch();
                }
              })
          }
        />
      )}
    </div>
  );
}
