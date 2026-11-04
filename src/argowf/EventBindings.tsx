import { useRef } from "react";
import { errorMessage } from "../api/errors";
import { ListFind, useListFind } from "../components/ListFind";
import { fuzzyKeep } from "../lib/fuzzy";
import { useTokenGate } from "./catalogHooks";
import { useEventBindings } from "./catalogQueries";
import type { ArgoWfConn, TemplateKind } from "./types";

export function EventBindings({
  conn,
  live,
  namespace,
  onOpenTemplate,
  onTokenError,
}: {
  conn: ArgoWfConn;
  live: boolean;
  namespace: string | null;
  onOpenTemplate(kind: TemplateKind, namespace: string | null, name: string): void;
  onTokenError(m: string): void;
}) {
  const q = useEventBindings(conn, namespace, live);
  useTokenGate([q.error], onTokenError);
  const rows = q.data ?? [];
  const listRef = useRef<HTMLDivElement>(null);
  const find = useListFind(listRef);
  const visible = fuzzyKeep(rows, find.query, (row) => [row.name, row.namespace, row.selector, row.template?.name, ...row.parameters]);
  return (
    <div className="awc">
      <div className="awc-bar">
        <h2 className="awc-title">Event Bindings</h2>
        <span className="dim">Argo Server의 이벤트 API(/api/v1/events)로 받은 이벤트를 템플릿 실행으로 잇는 WorkflowEventBinding</span>
      </div>
      <div className="awc-scroll" ref={listRef}>
        <ListFind find={find} count={visible.length} />
        {q.error ? (
          <div className="empty" role="alert">
            {errorMessage(q.error)}
          </div>
        ) : q.isPending ? (
          <div className="empty">불러오는 중…</div>
        ) : rows.length === 0 ? (
          <div className="empty">Event Binding이 없어요</div>
        ) : visible.length === 0 ? (
          <div className="empty">맞는 항목이 없어요</div>
        ) : (
          <table className="k8s-table awc-table">
            <thead>
              <tr>
                <th>이름</th>
                <th>네임스페이스</th>
                <th>선택자</th>
                <th>템플릿</th>
                <th>파라미터</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={`${row.namespace}/${row.name}`}>
                  <td className="mono">{row.name}</td>
                  <td className="mono">{row.namespace}</td>
                  <td className="mono">{row.selector}</td>
                  <td>
                    {row.template ? (
                      <button
                        className="link mono"
                        onClick={() =>
                          onOpenTemplate(
                            row.template!.clusterScope ? "ClusterWorkflowTemplate" : "WorkflowTemplate",
                            row.template!.clusterScope ? null : row.namespace,
                            row.template!.name,
                          )
                        }
                      >
                        {row.template.name}
                      </button>
                    ) : (
                      <span className="dim">—</span>
                    )}
                  </td>
                  <td className="mono">{row.parameters.join(", ") || <span className="dim">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
