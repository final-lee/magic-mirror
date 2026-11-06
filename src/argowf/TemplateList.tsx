import { useMemo, useRef, useState } from "react";
import { ErrorState } from "../components/ErrorState";
import { Highlight } from "../components/Highlight";
import { ListFind, useListFind } from "../components/ListFind";
import { fuzzyFilter, tokenize } from "../lib/fuzzy";
import { cronsUsing, runsByTemplate, successRate, templateKey } from "./catalogData";
import { useTokenGate } from "./catalogHooks";
import {
  CAT_LOADING,
  CAT_NO_TEMPLATE_MATCH,
  CAT_NO_TEMPLATES,
  COL_NAME,
  TPL_CLUSTER,
  TPL_COL_CRONS,
  TPL_COL_PARAMS,
  TPL_COL_RATE,
  TPL_COL_SCOPE,
  TPL_SEARCH,
  TPL_NO_RUNS_RATE,
  rateText,
} from "./catalogText";
import { useTemplates } from "./queries";
import { ManifestEditor } from "./ManifestEditor";
import type { ArgoWfConn, CronRow, TemplateKind, TemplateRow, WfRow } from "./types";

interface Props {
  conn: ArgoWfConn;
  live: boolean;
  namespace?: string | null;
  workflows: WfRow[];
  crons: CronRow[];
  selected: { kind: TemplateKind; namespace: string | null; name: string } | null;
  onOpen: (kind: TemplateKind, namespace: string | null, name: string) => void;
  onTokenError: (message: string) => void;
}

/** 네임스페이스 템플릿을 이름순으로 먼저, ClusterWorkflowTemplate을 그 뒤에 */
const order = (a: TemplateRow, b: TemplateRow) =>
  Number(a.kind === "ClusterWorkflowTemplate") - Number(b.kind === "ClusterWorkflowTemplate") ||
  (a.namespace ?? "").localeCompare(b.namespace ?? "") ||
  a.name.localeCompare(b.name);

/**
 * WorkflowTemplate과 ClusterWorkflowTemplate 목록. 쓰는 Cron 수는 Cron의 workflowTemplateRef로,
 * 최근 실행 성공률은 Workflow의 템플릿 레이블로 센다(끝난 최근 20개 중 성공).
 */
export function TemplateList({ conn, live, namespace = null, workflows, crons, selected, onOpen, onTokenError }: Props) {
  const q = useTemplates(conn, namespace, live);
  useTokenGate([q.error], onTokenError);
  const listRef = useRef<HTMLDivElement>(null);
  const find = useListFind(listRef);
  const search = find.query;
  const [creating, setCreating] = useState<TemplateKind | null>(null);
  const runs = useMemo(() => runsByTemplate(workflows), [workflows]);
  const sorted = useMemo(() => (q.data ?? []).filter((t) => !namespace || t.namespace === null || t.namespace === namespace).sort(order), [q.data, namespace]);
  const tokens = useMemo(() => tokenize(search), [search]);
  const rows = useMemo(() => fuzzyFilter(sorted, search, (t) => [t.name, t.namespace ?? TPL_CLUSTER, t.description, t.kind, ...t.templates]), [sorted, search]);

  return (
    <div className="awc">
      {q.isError && <ErrorState error={q.error} profile={conn.ssoProfile ?? ""} compact onRetry={() => void q.refetch()} />}
      <div className="awc-bar">
        <h2 className="awc-title">템플릿</h2>
        <div className="awc-bar-end">
          <button className="btn small tone-create" onClick={() => setCreating("ClusterWorkflowTemplate")}>
            클러스터 템플릿 만들기…
          </button>
          <button className="btn tone-create small" onClick={() => setCreating("WorkflowTemplate")}>
            템플릿 만들기…
          </button>
        </div>
      </div>
      <div className="awc-scroll" ref={listRef}>
        <ListFind find={find} placeholder={TPL_SEARCH} count={rows.length} />
        {q.isPending ? (
          <div className="empty">{CAT_LOADING}</div>
        ) : sorted.length === 0 ? (
          !q.isError && <div className="empty">{CAT_NO_TEMPLATES}</div>
        ) : rows.length === 0 ? (
          <div className="empty">{CAT_NO_TEMPLATE_MATCH}</div>
        ) : (
          <table className="k8s-table awc-table" aria-label={TPL_SEARCH}>
            <thead>
              <tr>
                <th>{COL_NAME}</th>
                <th>{TPL_COL_SCOPE}</th>
                <th>{TPL_COL_PARAMS}</th>
                <th>{TPL_COL_CRONS}</th>
                <th>{TPL_COL_RATE}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const key = templateKey(t.kind, t.namespace, t.name);
                const rate = successRate(runs.get(key) ?? []);
                const on = selected !== null && selected.kind === t.kind && selected.namespace === t.namespace && selected.name === t.name;
                const open = () => onOpen(t.kind, t.namespace, t.name);
                return (
                  <tr
                    key={key}
                    className={`awc-row${on ? " on" : ""}`}
                    tabIndex={0}
                    aria-selected={on}
                    onClick={open}
                    onKeyDown={(e) => e.key === "Enter" && open()}
                  >
                    <td className="mono k8s-wrap">
                      <Highlight text={t.name} tokens={tokens} />
                    </td>
                    <td>{t.namespace === null ? <span className="awc-badge cluster">{TPL_CLUSTER}</span> : <span className="mono">{t.namespace}</span>}</td>
                    <td>{t.parameters.length}</td>
                    <td>{cronsUsing(crons, t).length}</td>
                    <td className={rate && rate.ok * 2 < rate.total ? "awc-rate-low" : undefined}>
                      {rate ? rateText(rate.ok, rate.total) : <span className="dim">{TPL_NO_RUNS_RATE}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {creating && (
        <ManifestEditor
          conn={conn}
          kind={creating}
          mode="create"
          namespace={namespace}
          onClose={() => setCreating(null)}
          onSaved={(r) => {
            const kind = creating;
            setCreating(null);
            void q.refetch();
            onOpen(kind, r.namespace, r.name);
          }}
        />
      )}
    </div>
  );
}
