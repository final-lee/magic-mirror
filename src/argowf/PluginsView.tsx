import { useRef } from "react";
import { desktop } from "../api/desktop";
import { errorMessage } from "../api/errors";
import { ListFind, useListFind } from "../components/ListFind";
import { fuzzyKeep } from "../lib/fuzzy";
import { useTokenGate } from "./catalogHooks";
import { usePlugins } from "./catalogQueries";
import type { ArgoWfConn, ArgoWfSession } from "./types";

const PLUGINS_DOCS = "https://argo-workflows.readthedocs.io/en/release-4.1/plugins/";

export function PluginsView({
  conn,
  session,
  namespace,
  live,
  onTokenError,
}: {
  conn: ArgoWfConn;
  session: ArgoWfSession;
  namespace: string | null;
  live: boolean;
  onTokenError(m: string): void;
}) {
  const q = usePlugins(conn, namespace, live);
  useTokenGate([q.error], onTokenError);
  const rows = (q.data ?? []).filter((p) => !namespace || p.namespace === namespace);
  const listRef = useRef<HTMLDivElement>(null);
  const find = useListFind(listRef);
  const visible = fuzzyKeep(rows, find.query, (p) => [p.name, p.namespace, p.description, p.image]);
  const docs = (
    <button className="btn small tone-nav" onClick={() => void desktop.openUrl(PLUGINS_DOCS)}>
      문서 열기 ↗
    </button>
  );
  if (session.auth === "token")
    return (
      <div className="awc">
        <div className="awc-bar">
          <h2 className="awc-title">Plugins</h2>
          <div className="awc-bar-end">{docs}</div>
        </div>
        <div className="awc-body">
          <p className="awc-desc-line">토큰 연결에서는 실행기 플러그인 ConfigMap을 읽지 못해요. kubectl로 확인하세요.</p>
          <code className="mono">kubectl get configmaps -A -l workflows.argoproj.io/configmap-type=ExecutorPlugin</code>
        </div>
      </div>
    );
  return (
    <div className="awc">
      <div className="awc-bar">
        <h2 className="awc-title">Plugins</h2>
        <span className="dim">실행기 플러그인(ExecutorPlugin ConfigMap)</span>
        <div className="awc-bar-end">{docs}</div>
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
          <div className="empty">실행기 플러그인이 없어요</div>
        ) : visible.length === 0 ? (
          <div className="empty">맞는 항목이 없어요</div>
        ) : (
          <table className="k8s-table awc-table">
            <thead>
              <tr>
                <th>이름</th>
                <th>네임스페이스</th>
                <th>설명</th>
                <th>이미지</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => (
                <tr key={`${p.namespace}/${p.name}`}>
                  <td className="mono">{p.name}</td>
                  <td className="mono">{p.namespace}</td>
                  <td>{p.description || <span className="dim">—</span>}</td>
                  <td className="mono">{p.image}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
