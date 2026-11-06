import { useMemo, useState } from "react";
import { ErrorState } from "../components/ErrorState";
import { desktop } from "../api/desktop";
import { argowfApi } from "./api";
import { ActionDialog, needsTypedName } from "./ActionDialog";
import { ManifestEditor } from "./ManifestEditor";
import { argoUiUrl, widgetUrls } from "./widgets";
import { cronKey, cronsUsing, namespacesOf, runsByTemplate, templateKey } from "./catalogData";
import { useCatalogAction, useTokenGate } from "./catalogHooks";
import { DetailFrame, Kv, RunsTable, Sect } from "./catalogParts";
import {
  CAT_LOADING,
  SEC_TPL_CRONS,
  SEC_TPL_DESC,
  SEC_TPL_PARAMS,
  SEC_TPL_TEMPLATES,
  TAB_TPL_OVERVIEW,
  TAB_TPL_RUNS,
  TAB_YAML,
  TPL_COL_DEFAULT,
  TPL_COL_DESC,
  TPL_COL_ENUM,
  TPL_DETAIL_LABEL,
  TPL_ENTRYPOINT,
  TPL_NO_CRONS,
  TPL_NO_DEADLINE,
  TPL_NO_PARAMS,
  TPL_RUN,
  TPL_SA,
  TPL_TEMPLATE_NAMES,
  COL_NAME,
} from "./catalogText";
import { SubmitForm } from "./SubmitForm";
import { useTemplate } from "./queries";
import type { ArgoWfConn, CronRow, TemplateKind, WfRow, WfTarget } from "./types";

interface Props {
  conn: ArgoWfConn;
  kind: TemplateKind;
  namespace: string | null;
  name: string;
  workflows: WfRow[];
  crons: CronRow[];
  onClose: () => void;
  onOpenWorkflow: (target: WfTarget) => void;
  onOpenCron: (namespace: string, name: string) => void;
  onTokenError: (message: string) => void;
}

type Tab = "overview" | "runs" | "yaml";

/** 템플릿 하나의 상세: 설명·파라미터·템플릿 이름들·쓰는 Cron, 최근 실행, YAML. 동작은 실행(파라미터 폼). */
export function TemplateDetail({ conn, kind, namespace, name, workflows, crons, onClose, onOpenWorkflow, onOpenCron, onTokenError }: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  const [form, setForm] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const act = useCatalogAction(conn, onTokenError);
  const q = useTemplate(conn, kind, namespace, name);
  useTokenGate([q.error], onTokenError);
  const runs = useMemo(() => runsByTemplate(workflows).get(templateKey(kind, namespace, name)) ?? [], [workflows, kind, namespace, name]);
  const users = useMemo(() => cronsUsing(crons, { kind, namespace, name }), [crons, kind, namespace, name]);
  const namespaces = useMemo(() => namespacesOf(workflows, crons), [workflows, crons]);
  const widgetNamespace = namespace ?? runs[0]?.namespace ?? namespaces[0] ?? null;
  const widgetLabel = `workflows.argoproj.io/${kind === "ClusterWorkflowTemplate" ? "cluster-workflow-template" : "workflow-template"}=${name}`;
  const row = q.data?.row;
  const now = Date.now();

  let body;
  if (q.isError) body = <ErrorState error={q.error} profile={conn.ssoProfile ?? ""} compact onRetry={() => void q.refetch()} />;
  else if (!q.data || !row) body = <div className="empty">{CAT_LOADING}</div>;
  else if (tab === "runs") body = <RunsTable runs={runs} now={now} onOpen={(w) => onOpenWorkflow({ kind: "live", namespace: w.namespace, name: w.name })} />;
  else if (tab === "yaml") body = <pre className="k8s-yaml mono">{q.data.yaml}</pre>;
  else {
    body = (
      <div>
        {row.description && (
          <Sect title={SEC_TPL_DESC}>
            <p className="awc-desc">{row.description}</p>
          </Sect>
        )}
        <Sect title={SEC_TPL_PARAMS}>
          {row.parameters.length === 0 ? (
            <p className="dim">{TPL_NO_PARAMS}</p>
          ) : (
            <table className="k8s-table awc-table">
              <thead>
                <tr>
                  <th>{COL_NAME}</th>
                  <th>{TPL_COL_DEFAULT}</th>
                  <th>{TPL_COL_ENUM}</th>
                  <th>{TPL_COL_DESC}</th>
                </tr>
              </thead>
              <tbody>
                {row.parameters.map((p) => (
                  <tr key={p.name}>
                    <td className="mono k8s-wrap">{p.name}</td>
                    <td className="mono k8s-wrap">{p.value}</td>
                    <td className="mono k8s-wrap">{p.enum.join(", ")}</td>
                    <td className="k8s-wrap">{p.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Sect>
        <Sect title={SEC_TPL_TEMPLATES}>
          <dl className="kv">
            <Kv label={TPL_ENTRYPOINT}>{row.entrypoint && <span className="mono">{row.entrypoint}</span>}</Kv>
            <Kv label={TPL_TEMPLATE_NAMES}>
              {row.templates.length > 0 && (
                <ul className="k8s-links">
                  {row.templates.map((t) => (
                    <li key={t} className="mono k8s-wrap">
                      {t}
                    </li>
                  ))}
                </ul>
              )}
            </Kv>
            <Kv label={TPL_SA}>{row.serviceAccount && <span className="mono">{row.serviceAccount}</span>}</Kv>
            <Kv label="activeDeadlineSeconds">{!row.hasDeadline && <span className="dim">{TPL_NO_DEADLINE}</span>}</Kv>
          </dl>
        </Sect>
        <Sect title={SEC_TPL_CRONS}>
          {users.length === 0 ? (
            <p className="dim">{TPL_NO_CRONS}</p>
          ) : (
            <ul className="k8s-links">
              {users.map((c) => (
                <li key={cronKey(c.namespace, c.name)}>
                  <button className="link mono" onClick={() => onOpenCron(c.namespace, c.name)}>
                    {c.namespace}/{c.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Sect>
      </div>
    );
  }

  return (
    <>
      <DetailFrame
        label={TPL_DETAIL_LABEL}
        kind={kind}
        title={namespace ? `${namespace}/${name}` : name}
        actions={
          <>
            <button className="btn small tone-primary" disabled={!row} onClick={() => setForm(true)}>
              {TPL_RUN}
            </button>
            <button className="btn small tone-secondary" onClick={() => setEditing(true)}>
              고치기
            </button>
            <button className="btn small tone-danger" onClick={() => setDeleting(true)}>
              삭제…
            </button>
            <button
              className="btn small tone-nav"
              onClick={() => void desktop.openUrl(argoUiUrl(conn.url, kind === "ClusterWorkflowTemplate" ? "clusterTemplate" : "template", namespace, name))}
            >
              Argo UI에서 열기
            </button>
            {widgetNamespace && (
              <>
                <button className="btn small tone-secondary" onClick={() => void desktop.copy(widgetUrls(conn.url, widgetNamespace, widgetLabel).badge)}>
                  상태 배지 주소 복사
                </button>
                <button className="btn small tone-secondary" onClick={() => void desktop.copy(widgetUrls(conn.url, widgetNamespace, widgetLabel).graph)}>
                  그래프 위젯 주소 복사
                </button>
              </>
            )}
          </>
        }
        tabs={[
          ["overview", TAB_TPL_OVERVIEW],
          ["runs", TAB_TPL_RUNS],
          ["yaml", TAB_YAML],
        ]}
        tab={tab}
        onTab={(t) => setTab(t as Tab)}
        onClose={onClose}
      >
        {body}
      </DetailFrame>
      {editing && (
        <ManifestEditor
          conn={conn}
          kind={kind}
          mode="edit"
          namespace={namespace}
          name={name}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void q.refetch();
          }}
        />
      )}
      {deleting && (
        <ActionDialog
          title={`${name} 삭제`}
          note="되돌릴 수 없어요."
          confirmLabel="삭제"
          danger
          requireName={needsTypedName(namespace, name) ? name : null}
          busy={act.busy}
          error={act.error}
          onCancel={() => setDeleting(false)}
          onConfirm={() =>
            void act
              .run(() => argowfApi.remove(conn, kind, namespace, name), "삭제했어요")
              .then((r) => {
                if (r) {
                  setDeleting(false);
                  onClose();
                }
              })
          }
        />
      )}
      {form && row && (
        <SubmitForm
          conn={conn}
          template={row}
          namespaces={namespaces}
          defaultNamespace={runs[0]?.namespace ?? namespaces[0] ?? ""}
          onClose={() => setForm(false)}
          onSubmitted={(ns, n) => {
            setForm(false);
            onOpenWorkflow({ kind: "live", namespace: ns, name: n });
          }}
          onTokenError={onTokenError}
        />
      )}
    </>
  );
}
