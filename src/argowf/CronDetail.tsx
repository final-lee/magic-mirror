import { useMemo, useState } from "react";
import { ErrorState } from "../components/ErrorState";
import { desktop } from "../api/desktop";
import { formatDateTime } from "../iam/format";
import { argowfApi } from "./api";
import { ActionDialog, needsTypedName } from "./ActionDialog";
import { cronKey, runsByCron } from "./catalogData";
import { relTime } from "./catalogFormat";
import { useCatalogAction, useTokenGate } from "./catalogHooks";
import { DetailFrame, Kv, RunsTable, Sect } from "./catalogParts";
import {
  CAT_CONFIRM,
  CAT_LOADING,
  CRON_ACTIVE,
  CRON_CONCURRENCY,
  CRON_DELETE,
  CRON_DELETE_DONE,
  CRON_DELETE_NOTE,
  CRON_DETAIL_LABEL,
  CRON_ENTRYPOINT,
  CRON_KIND,
  CRON_LAST_SCHEDULED,
  CRON_MISSED,
  CRON_NEXT_NONE,
  CRON_NEXT_SUSPENDED,
  CRON_PARAMS,
  CRON_RESUME,
  CRON_RESUME_DONE,
  CRON_RESUME_NOTE,
  CRON_RUN,
  CRON_RUN_DONE,
  CRON_RUN_NOTE,
  CRON_SA,
  CRON_SCHEDULE,
  CRON_STARTING_DEADLINE,
  CRON_SUCCEEDED_FAILED,
  CRON_SUSPEND,
  CRON_SUSPENDED,
  CRON_SUSPEND_DONE,
  CRON_SUSPEND_NOTE,
  CRON_TEMPLATE,
  CRON_TIMEZONE,
  SEC_CRON_NEXT,
  SEC_CRON_SCHEDULE,
  SEC_CRON_SPEC,
  SEC_CRON_STATE,
  TAB_CRON_OVERVIEW,
  TAB_CRON_RUNS,
  TAB_YAML,
  cronStartingDeadline,
} from "./catalogText";
import { scheduleText } from "./cronText";
import { useCron } from "./queries";
import { ManifestEditor } from "./ManifestEditor";
import { argoUiUrl, widgetUrls } from "./widgets";
import type { ArgoWfConn, TemplateKind, WfRow, WfTarget } from "./types";

interface Props {
  conn: ArgoWfConn;
  namespace: string;
  name: string;
  workflows: WfRow[];
  live: boolean;
  onClose: () => void;
  onOpenWorkflow: (target: WfTarget) => void;
  onOpenTemplate: (kind: TemplateKind, namespace: string | null, name: string) => void;
  onTokenError: (message: string) => void;
}

type Tab = "overview" | "runs" | "yaml";
type Dialog = "run" | "toggle" | "delete";

/** CronWorkflow 하나의 상세: 스케줄·다음 5회·상태·workflowSpec 요약, 실행 이력, YAML. 동작은 지금 실행·정지/재개·삭제. */
export function CronDetail({ conn, namespace, name, workflows, live, onClose, onOpenWorkflow, onOpenTemplate, onTokenError }: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [editing, setEditing] = useState(false);
  const q = useCron(conn, namespace, name, live);
  const act = useCatalogAction(conn, onTokenError);
  useTokenGate([q.error], onTokenError);
  const runs = useMemo(() => runsByCron(workflows).get(cronKey(namespace, name)) ?? [], [workflows, namespace, name]);
  const detail = q.data;
  const row = detail?.row;
  const now = Date.now();
  const openRun = (w: WfRow) => onOpenWorkflow({ kind: "live", namespace: w.namespace, name: w.name });

  const confirm = async () => {
    if (!row || !dialog) return;
    if (dialog === "run") {
      const r = await act.run(() => argowfApi.cronAction(conn, namespace, name, { kind: "submit" }), CRON_RUN_DONE);
      if (!r) return;
      setDialog(null);
      // 새로 만든 Workflow는 곧바로 상세로 연다
      if (r.value) onOpenWorkflow({ kind: "live", namespace, name: r.value });
    } else if (dialog === "toggle") {
      const resume = row.suspended;
      const r = await act.run(
        () => argowfApi.cronAction(conn, namespace, name, { kind: resume ? "resume" : "suspend" }),
        resume ? CRON_RESUME_DONE : CRON_SUSPEND_DONE,
      );
      if (r) setDialog(null);
    } else {
      const r = await act.run(() => argowfApi.cronAction(conn, namespace, name, { kind: "delete" }), CRON_DELETE_DONE);
      if (!r) return;
      setDialog(null);
      onClose();
    }
  };
  const ask = (d: Dialog) => {
    act.clearError();
    setDialog(d);
  };

  const dialogText =
    dialog === "run"
      ? { title: CRON_RUN, note: CRON_RUN_NOTE }
      : dialog === "toggle"
        ? row?.suspended
          ? { title: CRON_RESUME, note: CRON_RESUME_NOTE }
          : { title: CRON_SUSPEND, note: CRON_SUSPEND_NOTE }
        : { title: CRON_DELETE, note: CRON_DELETE_NOTE };

  let body;
  if (q.isError) body = <ErrorState error={q.error} profile={conn.ssoProfile ?? ""} compact onRetry={() => void q.refetch()} />;
  else if (!detail || !row) body = <div className="empty">{CAT_LOADING}</div>;
  else if (tab === "runs") body = <RunsTable runs={runs} now={now} onOpen={openRun} />;
  else if (tab === "yaml") body = <pre className="k8s-yaml mono">{detail.yaml}</pre>;
  else {
    body = (
      <div>
        <Sect title={SEC_CRON_SCHEDULE}>
          <dl className="kv">
            <Kv label={CRON_SCHEDULE}>
              {row.schedules.map((s) => (
                <div key={s}>
                  <div>{scheduleText(s, row.timezone)}</div>
                  <div className="mono dim">{s}</div>
                </div>
              ))}
            </Kv>
            <Kv label={CRON_TIMEZONE}>{row.timezone}</Kv>
            <Kv label={CRON_CONCURRENCY}>{row.concurrencyPolicy}</Kv>
            <Kv label={CRON_STARTING_DEADLINE}>{row.startingDeadlineSeconds !== null && cronStartingDeadline(row.startingDeadlineSeconds)}</Kv>
          </dl>
        </Sect>
        <Sect title={SEC_CRON_NEXT}>
          {row.suspended && <p className="dim">{CRON_NEXT_SUSPENDED}</p>}
          {row.nextRuns.length === 0 ? (
            !row.suspended && <p className="dim">{CRON_NEXT_NONE}</p>
          ) : (
            <ol className={`awc-next${row.suspended ? " awc-off" : ""}`}>
              {row.nextRuns.map((t) => (
                <li key={t}>
                  <span className="mono">{formatDateTime(t)}</span> <span className="dim">{relTime(t, now)}</span>
                </li>
              ))}
            </ol>
          )}
        </Sect>
        <Sect title={SEC_CRON_STATE}>
          <dl className="kv">
            <Kv label={CRON_SUSPENDED}>{row.suspended && <span className="awc-badge">{CRON_SUSPENDED}</span>}</Kv>
            <Kv label={CRON_MISSED}>{row.missed && <span className="awc-badge warn">{CRON_MISSED}</span>}</Kv>
            <Kv label={CRON_ACTIVE}>
              {row.active.length > 0 && (
                <ul className="k8s-links">
                  {row.active.map((n) => (
                    <li key={n}>
                      <button className="link mono" onClick={() => onOpenWorkflow({ kind: "live", namespace, name: n })}>
                        {n}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Kv>
            <Kv label={CRON_SUCCEEDED_FAILED}>{row.succeeded !== null || row.failed !== null ? `${row.succeeded ?? 0} / ${row.failed ?? 0}` : null}</Kv>
            <Kv label={CRON_LAST_SCHEDULED}>
              {row.lastScheduledTime && (
                <span title={row.lastScheduledTime}>
                  {formatDateTime(row.lastScheduledTime)} <span className="dim">{relTime(row.lastScheduledTime, now)}</span>
                </span>
              )}
            </Kv>
          </dl>
        </Sect>
        <Sect title={SEC_CRON_SPEC}>
          <dl className="kv">
            <Kv label={CRON_ENTRYPOINT}>{detail.entrypoint && <span className="mono">{detail.entrypoint}</span>}</Kv>
            <Kv label={CRON_TEMPLATE}>
              {detail.template && (
                <button
                  className="link mono"
                  onClick={() =>
                    onOpenTemplate(
                      row.clusterTemplate ? "ClusterWorkflowTemplate" : "WorkflowTemplate",
                      row.clusterTemplate ? null : namespace,
                      detail.template!,
                    )
                  }
                >
                  {detail.template}
                </button>
              )}
            </Kv>
            <Kv label={CRON_SA}>{row.serviceAccount && <span className="mono">{row.serviceAccount}</span>}</Kv>
            <Kv label={CRON_PARAMS}>
              {detail.parameters.length > 0 && (
                <ul className="k8s-links">
                  {detail.parameters.map((p) => (
                    <li key={p.name} className="mono k8s-wrap">
                      {p.name}={p.value ?? ""}
                    </li>
                  ))}
                </ul>
              )}
            </Kv>
          </dl>
        </Sect>
      </div>
    );
  }

  return (
    <>
      <DetailFrame
        label={CRON_DETAIL_LABEL}
        kind={CRON_KIND}
        title={`${namespace}/${name}`}
        actions={
          <>
            <button className="btn small tone-primary" disabled={!row || act.busy} onClick={() => ask("run")}>
              {CRON_RUN}
            </button>
            <button className="btn small tone-warn" disabled={!row || act.busy} onClick={() => ask("toggle")}>
              {row?.suspended ? CRON_RESUME : CRON_SUSPEND}
            </button>
            <button className="btn small tone-danger" disabled={!row || act.busy} onClick={() => ask("delete")}>
              {CRON_DELETE}
            </button>
            <button className="btn small tone-secondary" onClick={() => setEditing(true)}>
              고치기
            </button>
            <button className="btn small tone-nav" onClick={() => void desktop.openUrl(argoUiUrl(conn.url, "cron", namespace, name))}>
              Argo UI에서 열기
            </button>
            <button
              className="btn small tone-secondary"
              onClick={() => void desktop.copy(widgetUrls(conn.url, namespace, `workflows.argoproj.io/cron-workflow=${name}`).badge)}
            >
              상태 배지 주소 복사
            </button>
            <button
              className="btn small tone-secondary"
              onClick={() => void desktop.copy(widgetUrls(conn.url, namespace, `workflows.argoproj.io/cron-workflow=${name}`).graph)}
            >
              그래프 위젯 주소 복사
            </button>
          </>
        }
        tabs={[
          ["overview", TAB_CRON_OVERVIEW],
          ["runs", TAB_CRON_RUNS],
          ["yaml", TAB_YAML],
        ]}
        tab={tab}
        onTab={(t) => setTab(t as Tab)}
        onClose={onClose}
        banner={
          act.note && (
            <p className="ok awc-note" role="status">
              {act.note}
            </p>
          )
        }
      >
        {body}
      </DetailFrame>
      {editing && (
        <ManifestEditor
          conn={conn}
          kind="CronWorkflow"
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
      {dialog && row && (
        <ActionDialog
          title={dialogText.title}
          note={dialogText.note}
          confirmLabel={CAT_CONFIRM}
          danger={dialog === "delete"}
          tone={dialog === "delete" ? "tone-danger" : dialog === "toggle" ? "tone-warn" : "tone-primary"}
          requireName={dialog === "delete" && needsTypedName(namespace, name) ? name : null}
          busy={act.busy}
          error={act.error}
          onConfirm={() => void confirm()}
          onCancel={() => setDialog(null)}
        >
          <p className="mono">
            {namespace}/{name}
          </p>
        </ActionDialog>
      )}
    </>
  );
}
