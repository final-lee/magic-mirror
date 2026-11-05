import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { rowKey } from "../argoGroup";
import { ARGO_ENV_TEXT } from "../text";
import type { ArgoAppRow } from "../types";
import { cachedTrees, useTreeVersion } from "../search/useArgoIndex";
import { imageInventory, type RepoImages } from "./images";
import { useTreeLoader } from "./queries";
import { METRICS_TEXT as T } from "./text";

function Flags({ repo }: { repo: RepoImages }) {
  return (
    <>
      {repo.latest && <span className="argo-metrics-flag">{T.flagLatest}</span>}
      {repo.untagged && <span className="argo-metrics-flag">{T.flagUntagged}</span>}
      {repo.envMismatch && <span className="argo-metrics-flag">{T.flagMismatch}</span>}
    </>
  );
}

/** 이미지 목록: 앱 목록의 이미지 요약과 열어 본 리소스 트리의 이미지를 저장소별 태그로 묶는다 */
export function ImagesPanel({ url, rows, onOpen }: { url: string; rows: ArgoAppRow[]; onOpen: (row: ArgoAppRow) => void }) {
  const qc = useQueryClient();
  const version = useTreeVersion(url);
  const trees = useMemo(() => cachedTrees(qc, url), [qc, url, version]);
  const cached = useMemo(() => new Set(trees.map((t) => rowKey(t.app.namespace, t.app.name))), [trees]);
  const loader = useTreeLoader(url, rows, cached);
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [query, setQuery] = useState("");
  const inventory = useMemo(() => imageInventory(rows, trees), [rows, trees]);
  const shown = inventory.filter((r) => (!flaggedOnly || r.latest || r.untagged || r.envMismatch) && r.repository.toLowerCase().includes(query.trim().toLowerCase()));
  const byKey = useMemo(() => new Map(rows.map((r) => [rowKey(r.namespace, r.name), r])), [rows]);
  return (
    <div className="argo-metrics-scroll">
      <div className="argo-metrics-bar">
        <input aria-label={T.imageSearch} placeholder={T.imageSearch} value={query} onChange={(e) => setQuery(e.target.value)} />
        <label><input type="checkbox" checked={flaggedOnly} onChange={(e) => setFlaggedOnly(e.target.checked)} /> {T.imageFilter}</label>
        {loader.progress === null ? (
          <button className="btn small tone-secondary" disabled={cached.size >= rows.length} onClick={() => void loader.start()}>{T.loadTrees}</button>
        ) : (
          <>
            <span>{T.loadingTrees(loader.progress.done, loader.progress.total)}</span>
            <button className="btn small tone-secondary" onClick={loader.stop}>{T.stopLoading}</button>
          </>
        )}
      </div>
      <div className="argo-metrics-note">{T.treesNote}</div>
      {shown.length === 0 ? <div className="argo-metrics-note">{T.imagesEmpty}</div> : (
        <table className="argo-metrics-table">
          <thead><tr><th>{T.imageRepo}</th><th>{T.imageTags}</th></tr></thead>
          <tbody>
            {shown.map((repo) => (
              <tr key={repo.repository}>
                <th>
                  <span className="mono">{repo.repository}</span>
                  <Flags repo={repo} />
                  <div className="argo-metrics-note">{T.imageApps(repo.appCount)}</div>
                </th>
                <td>
                  {repo.tags.map((use) => (
                    <details key={use.tag ?? ""}>
                      <summary><span className="mono">{use.tag ?? T.noTag}</span> · {T.imageApps(use.apps.length)}</summary>
                      <ul className="argo-metrics-list">
                        {use.apps.map((a) => (
                          <li key={a.key}>
                            <button className="argo-metrics-link" onClick={() => { const row = byKey.get(a.key); if (row) onOpen(row); }}>{a.name}</button> <span className="argo-metrics-note">{ARGO_ENV_TEXT[a.env]}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
