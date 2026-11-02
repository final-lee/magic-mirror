import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "../api/errors";
import { ErrorState } from "../components/ErrorState";
import { age } from "../k8s/format";
import { DETAIL_PCT } from "../k8s/lanes";
import { argocdApi } from "./api";
import { ArgoBadge, shortRev } from "./argoParts";
import { ArgoTree } from "./ArgoTree";
import { argoKeys, isTokenError, useArgoApp, useArgoTree } from "./queries";
import {
  ARGO_APPLICATION, ARGO_AUTOMATED_USER, ARGO_CANCEL, ARGO_DETAIL_LABEL, ARGO_DRY_RUN, ARGO_DRY_RUN_HINT, ARGO_HARD_REFRESH, ARGO_IN_CLUSTER, ARGO_NO,
  ARGO_NO_HISTORY, ARGO_NO_OPERATION, ARGO_PRUNE, ARGO_PRUNE_HINT, ARGO_REFRESH, ARGO_REFRESH_DONE, ARGO_SYNC, ARGO_SYNC_CONFIRM, ARGO_SYNC_DONE,
  ARGO_SYNC_NOTE, ARGO_SYNC_RUNNING, ARGO_SYNC_TITLE, ARGO_TARGET_REVISION, ARGO_YES, CLOSE, COL_NAME, H_ARGO_DEPLOYED, H_ARGO_HOOK_PHASE, H_ARGO_ID,
  H_MESSAGE, H_STATE, LOADING, L_ARGO_APPSET, L_ARGO_AUTOMATED, L_ARGO_CHART, L_ARGO_CLUSTER, L_ARGO_FINISHED, L_ARGO_HEALTH, L_ARGO_INITIATED,
  L_ARGO_MESSAGE, L_ARGO_NAMESPACE, L_ARGO_OPTIONS, L_ARGO_PATH, L_ARGO_PHASE, L_ARGO_PROJECT, L_ARGO_PRUNE, L_ARGO_RECONCILED, L_ARGO_REF, L_ARGO_REPO,
  L_ARGO_REVISIONS, L_ARGO_SELF_HEAL, L_ARGO_STARTED, L_ARGO_SYNC, L_ARGO_TARGET, L_ARGO_VALUES, SEC_ARGO_CONDITIONS, SEC_ARGO_DEST, SEC_ARGO_FAILED,
  SEC_ARGO_IMAGES, SEC_ARGO_OPERATION, SEC_ARGO_POLICY, SEC_ARGO_SOURCES, SEC_ARGO_STATUS, TAB_ARGO_HISTORY, TAB_ARGO_OVERVIEW, TAB_ARGO_RAW,
  TAB_ARGO_RESOURCES, argoRefreshPending,
} from "./text";
import type { ArgoApp, ArgoSyncOptions } from "./types";

interface Props {
  /** ArgoCD 서버 주소 */
  url: string;
  /** Application이 있는 네임스페이스 */
  namespace: string;
  name: string;
  /** 목록에서 본 resourceVersion(바뀌면 다시 읽는다). 목록에 없으면 null */
  resourceVersion: string | null;
  /** 탭이 보이는 동안만 트리를 주기적으로 다시 읽는다 */
  live: boolean;
  onClose: () => void;
  /** 토큰이 없거나 무효라는 오류가 나면 부른다(메시지 포함) */
  onTokenError: (message: string) => void;
  now?: number;
  /** 목록 너비 중 덮는 비율(%). 없으면 DETAIL_PCT */
  widthPct?: number;
}

type Tab = "overview" | "resources" | "history" | "raw";

const who = (v: string | null) => (v === "automated" ? ARGO_AUTOMATED_USER : v);
const yesNo = (v: boolean) => (v ? ARGO_YES : ARGO_NO);
const when = (iso: string | null, at: number) => (iso ? <span title={iso}>{age(iso, at)}</span> : null);
const revs = (list: string[]) => (list.length > 0 ? <span className="mono">{list.map(shortRev).join(", ")}</span> : null);
const destText = (d: ArgoApp["destination"]) => [d.name ?? d.server, d.namespace].filter(Boolean).join("/");

function Sect({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="k8s-sect" aria-label={title}>
      <h4>{title}</h4>
      {children}
    </section>
  );
}

/** 값이 없으면 줄을 그리지 않는 이름·값 한 줄 */
function Kv({ label, children }: { label: string; children: ReactNode }) {
  if (children === null || children === undefined || children === "" || children === false) return null;
  return (
    <div className="k8s-kv">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Overview({ app, at }: { app: ArgoApp; at: number }) {
  const op = app.operation;
  return (
    <div>
      <Sect title={SEC_ARGO_STATUS}>
        <dl className="kv">
          <Kv label={L_ARGO_SYNC}>
            <ArgoBadge status={app.syncStatus ?? "Unknown"} />
          </Kv>
          <Kv label={L_ARGO_REVISIONS}>{revs(app.syncRevisions)}</Kv>
          <Kv label={L_ARGO_HEALTH}>
            <ArgoBadge status={app.health ?? "Unknown"} />
            {app.healthMessage && <div className="argo-pre">{app.healthMessage}</div>}
          </Kv>
          <Kv label={L_ARGO_PROJECT}>{app.project}</Kv>
          <Kv label={L_ARGO_APPSET}>{app.appSet}</Kv>
          <Kv label={L_ARGO_RECONCILED}>{when(app.reconciledAt, at)}</Kv>
        </dl>
        {app.refreshRequested && <p className="dim">{argoRefreshPending(app.refreshRequested)}</p>}
      </Sect>
      <Sect title={SEC_ARGO_OPERATION}>
        {op ? (
          <dl className="kv">
            <Kv label={L_ARGO_PHASE}>{op.phase && <ArgoBadge status={op.phase} />}</Kv>
            <Kv label={L_ARGO_MESSAGE}>{op.message && <div className="argo-pre">{op.message}</div>}</Kv>
            <Kv label={L_ARGO_INITIATED}>{who(op.initiatedBy)}</Kv>
            <Kv label={L_ARGO_STARTED}>{when(op.startedAt, at)}</Kv>
            <Kv label={L_ARGO_FINISHED}>{when(op.finishedAt, at)}</Kv>
            <Kv label={L_ARGO_REVISIONS}>{revs(op.revisions)}</Kv>
          </dl>
        ) : (
          <p className="dim">{ARGO_NO_OPERATION}</p>
        )}
        {op && op.failedResults.length > 0 && (
          <section aria-label={SEC_ARGO_FAILED}>
            <h4 className="argo-sub">{SEC_ARGO_FAILED}</h4>
            <table className="k8s-table">
              <thead>
                <tr>
                  <th>{COL_NAME}</th>
                  <th>{H_STATE}</th>
                  <th>{H_MESSAGE}</th>
                  <th>{H_ARGO_HOOK_PHASE}</th>
                </tr>
              </thead>
              <tbody>
                {op.failedResults.map((r, i) => (
                  <tr key={i}>
                    <td className="mono k8s-wrap">
                      {r.kind}/{r.namespace ? `${r.namespace}/` : ""}
                      {r.name}
                    </td>
                    <td>
                      <ArgoBadge status={r.status} />
                    </td>
                    <td className="argo-pre">{r.message}</td>
                    <td>{r.hookPhase}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </Sect>
      {app.conditions.length > 0 && (
        <Sect title={SEC_ARGO_CONDITIONS}>
          {app.conditions.map((c, i) => (
            <div key={i} className={`argo-cond${c.type.includes("Error") ? " argo-cond-err" : ""}`}>
              <div>
                <b>{c.type}</b> <span className="dim">{when(c.lastTransitionTime, at)}</span>
              </div>
              <div className="argo-pre">{c.message}</div>
            </div>
          ))}
        </Sect>
      )}
      <Sect title={SEC_ARGO_SOURCES}>
        {app.sources.map((s, i) => (
          <dl key={i} className="kv argo-source">
            <Kv label={L_ARGO_REPO}>
              <span className="mono">{s.repoUrl}</span>
            </Kv>
            <Kv label={L_ARGO_CHART}>{s.chart}</Kv>
            <Kv label={L_ARGO_PATH}>{s.path}</Kv>
            <Kv label={L_ARGO_TARGET}>{s.targetRevision && shortRev(s.targetRevision)}</Kv>
            <Kv label={L_ARGO_REF}>{s.ref}</Kv>
            {s.helmValueFiles.length > 0 && (
              <Kv label={L_ARGO_VALUES}>
                {s.helmValueFiles.map((f) => (
                  <div key={f} className="mono">
                    {f}
                  </div>
                ))}
              </Kv>
            )}
          </dl>
        ))}
      </Sect>
      <Sect title={SEC_ARGO_DEST}>
        <dl className="kv">
          <Kv label={L_ARGO_CLUSTER}>
            {app.destination.name ?? app.destination.server}
            {app.destination.inCluster && <span className="k8s-chip argo-chip">{ARGO_IN_CLUSTER}</span>}
          </Kv>
          <Kv label={L_ARGO_NAMESPACE}>{app.destination.namespace}</Kv>
        </dl>
      </Sect>
      <Sect title={SEC_ARGO_POLICY}>
        <dl className="kv">
          <Kv label={L_ARGO_AUTOMATED}>{yesNo(app.syncPolicy.automated)}</Kv>
          {app.syncPolicy.automated && <Kv label={L_ARGO_PRUNE}>{yesNo(app.syncPolicy.prune)}</Kv>}
          {app.syncPolicy.automated && <Kv label={L_ARGO_SELF_HEAL}>{yesNo(app.syncPolicy.selfHeal)}</Kv>}
          <Kv label={L_ARGO_OPTIONS}>{app.syncPolicy.options.join(", ")}</Kv>
        </dl>
      </Sect>
      {app.images.length > 0 && (
        <Sect title={SEC_ARGO_IMAGES}>
          <ul className="k8s-links">
            {app.images.map((im) => (
              <li key={im} className="mono k8s-wrap">
                {im}
              </li>
            ))}
          </ul>
        </Sect>
      )}
    </div>
  );
}

function History({ app, at }: { app: ArgoApp; at: number }) {
  if (app.history.length === 0) return <p className="dim">{ARGO_NO_HISTORY}</p>;
  return (
    <table className="k8s-table">
      <thead>
        <tr>
          <th>{H_ARGO_ID}</th>
          <th>{L_ARGO_REVISIONS}</th>
          <th>{H_ARGO_DEPLOYED}</th>
          <th>{L_ARGO_INITIATED}</th>
        </tr>
      </thead>
      <tbody>
        {app.history.map((h) => (
          <tr key={h.id}>
            <td>{h.id}</td>
            <td className="mono k8s-wrap">{h.revisions.map(shortRev).join(", ")}</td>
            <td>{when(h.deployedAt, at)}</td>
            <td>{who(h.initiatedBy)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface SheetProps {
  app: ArgoApp;
  onCancel: () => void;
  onConfirm: (options: ArgoSyncOptions) => void;
}

/** Sync를 누르면 뜨는 확인 창. 무엇을 어디에 맞추는지 보이고, prune·dry run을 고른다(기본은 둘 다 끔). */
function SyncSheet({ app, onCancel, onConfirm }: SheetProps) {
  const [prune, setPrune] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const revisions = app.sources.map((s) => s.targetRevision ?? "HEAD").join(", ");
  return (
    <div
      className="modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="sheet" role="dialog" aria-modal="true" aria-label={ARGO_SYNC_TITLE}>
        <h3>{ARGO_SYNC_TITLE}</h3>
        <p>{ARGO_SYNC_NOTE}</p>
        <dl className="kv">
          <Kv label={ARGO_APPLICATION}>
            <span className="mono">{app.name}</span>
          </Kv>
          <Kv label={L_ARGO_PROJECT}>{app.project}</Kv>
          <Kv label={SEC_ARGO_DEST}>
            <span className="mono">{destText(app.destination)}</span>
          </Kv>
          <Kv label={ARGO_TARGET_REVISION}>
            <span className="mono">{revisions}</span>
          </Kv>
        </dl>
        <label className="k8s-check argo-opt">
          <input type="checkbox" aria-label={ARGO_PRUNE} checked={prune} onChange={(e) => setPrune(e.target.checked)} />
          {ARGO_PRUNE}
          <span className="dim">{ARGO_PRUNE_HINT}</span>
        </label>
        <label className="k8s-check argo-opt">
          <input type="checkbox" aria-label={ARGO_DRY_RUN} checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          {ARGO_DRY_RUN}
          <span className="dim">{ARGO_DRY_RUN_HINT}</span>
        </label>
        <div className="foot">
          <button className="btn plain" onClick={onCancel}>
            {ARGO_CANCEL}
          </button>
          <button className="btn primary" onClick={() => onConfirm({ prune, dryRun })}>
            {ARGO_SYNC_CONFIRM}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Application 하나의 상세(개요·리소스 트리·이력·YAML/JSON)와 Refresh·Sync 실행 */
export function ArgoDetail({ url, namespace, name, resourceVersion, live, onClose, onTokenError, now, widthPct = DETAIL_PCT }: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  const qc = useQueryClient();
  const q = useArgoApp(url, namespace, name, resourceVersion);
  const tree = useArgoTree(url, namespace, name, resourceVersion, tab === "resources", live);
  const app = q.data;
  const at = now ?? Date.now();

  const [pending, setPending] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const last = useRef<() => void>(() => {});
  const run = async (action: () => Promise<unknown>, done: string) => {
    last.current = () => void run(action, done);
    setPending(true);
    setNote(null);
    setError(null);
    try {
      await action();
      setNote(done);
      // 동작의 결과를 보이려고 상세와 트리를 다시 읽는다
      await Promise.all([qc.invalidateQueries({ queryKey: argoKeys.appOf(url, namespace, name) }), qc.invalidateQueries({ queryKey: argoKeys.treeOf(url, namespace, name) })]);
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  };
  const refresh = (hard: boolean) => void run(() => argocdApi.refresh(url, namespace, name, hard), ARGO_REFRESH_DONE);
  const sync = (options: ArgoSyncOptions) => {
    setSheet(false);
    void run(() => argocdApi.sync(url, namespace, name, options), ARGO_SYNC_DONE);
  };

  // 토큰 문제는 상세가 아니라 서버 단위의 일이라 토큰 폼으로 돌려보낸다
  const onToken = useRef(onTokenError);
  onToken.current = onTokenError;
  useEffect(() => {
    const bad = [q.error, tree.error, error].find(isTokenError);
    if (bad) onToken.current(errorMessage(bad));
  }, [q.error, tree.error, error]);

  const syncBlocked = app?.operationInProgress === true;
  const tabs: [Tab, string][] = [
    ["overview", TAB_ARGO_OVERVIEW],
    ["resources", TAB_ARGO_RESOURCES],
    ["history", TAB_ARGO_HISTORY],
    ["raw", TAB_ARGO_RAW],
  ];

  let body: ReactNode;
  if (q.isError) {
    body = <ErrorState error={q.error} profile="" compact onRetry={() => void q.refetch()} />;
  } else if (!app) {
    body = <div className="empty">{LOADING}</div>;
  } else if (tab === "overview") {
    body = <Overview app={app} at={at} />;
  } else if (tab === "resources") {
    body = tree.isError ? (
      <ErrorState error={tree.error} profile="" compact onRetry={() => void tree.refetch()} />
    ) : tree.data ? (
      <ArgoTree nodes={tree.data} resources={app.resources} />
    ) : (
      <div className="empty">{LOADING}</div>
    );
  } else if (tab === "history") {
    body = <History app={app} at={at} />;
  } else {
    body = <pre className="k8s-yaml mono argo-raw">{JSON.stringify(app.raw, null, 2)}</pre>;
  }

  return (
    <aside className="k8s-detail" aria-label={ARGO_DETAIL_LABEL} style={{ width: `${widthPct}%` }}>
      <div className="k8s-detail-head">
        <b>{ARGO_APPLICATION}</b>
        <span className="mono k8s-wrap">
          {namespace}/{name}
        </span>
        <span className="argo-acts k8s-push">
          <button className="btn small" disabled={pending} onClick={() => refresh(false)}>
            {ARGO_REFRESH}
          </button>
          <button className="btn small" disabled={pending} onClick={() => refresh(true)}>
            {ARGO_HARD_REFRESH}
          </button>
          <button className="btn small" disabled={pending || !app || syncBlocked} title={syncBlocked ? ARGO_SYNC_RUNNING : undefined} onClick={() => setSheet(true)}>
            {ARGO_SYNC}
          </button>
        </span>
        <button className="icon" aria-label={CLOSE} title={CLOSE} onClick={onClose}>
          ✕
        </button>
      </div>
      {note && (
        <p className="ok argo-note" role="status">
          {note}
        </p>
      )}
      {error !== null && <ErrorState error={error} profile="" compact onRetry={() => last.current()} />}
      <div role="tablist" className="k8s-tabs">
        {tabs.map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>
      <div className="k8s-detail-body">{body}</div>
      {sheet && app && <SyncSheet app={app} onCancel={() => setSheet(false)} onConfirm={sync} />}
    </aside>
  );
}
