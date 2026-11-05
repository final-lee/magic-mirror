import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { errorMessage } from "../api/errors";
import { ErrorState } from "../components/ErrorState";
import { age } from "../k8s/format";
import { DETAIL_PCT } from "../k8s/lanes";
import { ArgoBadge, shortRev } from "./argoParts";
import { ArgoTree } from "./ArgoTree";
import { isTokenError, useArgoApp, useArgoTree } from "./queries";
import { envOf } from "./argoEnv";
import { useArgoCan } from "./can";
import { ChangeSheet } from "./change/ChangeSheet";
import { SyncForm } from "./change/SyncForm";
import { useArgoChange } from "./change/useArgoChange";
import { CHANGE_DENIED } from "./change/text";
import type { ArgoChange } from "./change/types";
import {
  ARGO_APPLICATION, ARGO_AUTOMATED_USER, ARGO_DETAIL_LABEL, ARGO_HARD_REFRESH, ARGO_IN_CLUSTER, ARGO_NO,
  ARGO_NO_HISTORY, ARGO_NO_OPERATION, ARGO_REFRESH, ARGO_SYNC, ARGO_SYNC_RUNNING, ARGO_YES, CLOSE, COL_NAME, H_ARGO_DEPLOYED, H_ARGO_HOOK_PHASE, H_ARGO_ID,
  H_MESSAGE, H_STATE, LOADING, L_ARGO_APPSET, L_ARGO_AUTOMATED, L_ARGO_CHART, L_ARGO_CLUSTER, L_ARGO_FINISHED, L_ARGO_HEALTH, L_ARGO_INITIATED,
  L_ARGO_MESSAGE, L_ARGO_NAMESPACE, L_ARGO_OPTIONS, L_ARGO_PATH, L_ARGO_PHASE, L_ARGO_PROJECT, L_ARGO_PRUNE, L_ARGO_RECONCILED, L_ARGO_REF, L_ARGO_REPO,
  L_ARGO_REVISIONS, L_ARGO_SELF_HEAL, L_ARGO_STARTED, L_ARGO_SYNC, L_ARGO_TARGET, L_ARGO_VALUES, SEC_ARGO_CONDITIONS, SEC_ARGO_DEST, SEC_ARGO_FAILED,
  SEC_ARGO_IMAGES, SEC_ARGO_OPERATION, SEC_ARGO_POLICY, SEC_ARGO_SOURCES, SEC_ARGO_STATUS, TAB_ARGO_HISTORY, TAB_ARGO_OVERVIEW, TAB_ARGO_RAW,
  TAB_ARGO_RESOURCES, argoRefreshPending,
} from "./text";
import type { AppTarget, ArgoApp, ArgoResourceFocus, ResRef } from "./types";
import { AppDiffTab } from "./detail/AppDiffTab";
import { DetailBar } from "./detail/DetailBar";
import { HistoryTab } from "./detail/HistoryTab";
import { OperationTab } from "./detail/OperationTab";
import { Kv, Sect } from "./detail/parts";
import { resKey } from "./detail/queries";
import { ResourcePanel } from "./detail/ResourcePanel";
import { TAB_ARGO_DIFF, TAB_ARGO_OPERATION } from "./detail/text";
import { ManageTab } from "./manage/ManageTab";
import { TAB_ARGO_MANAGE } from "./manage/text";
import { NetworkMap } from "./maps/NetworkMap";
import { MAP_TEXT } from "./text";
import { ROLLBACK_RUNNING, TERMINATE } from "./ops/text";

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
  /** 처음부터 골라 둘 리소스(전체 리소스 검색·⌘K에서 열 때). 없으면 아무것도 고르지 않는다 */
  focus?: ArgoResourceFocus | null;
  initialTab?: "history";
}

type Tab = "overview" | "resources" | "network" | "diff" | "operation" | "history" | "manage" | "raw";

/** 같은 리소스인가(group·kind·namespace·name) */
const sameResource = (a: { group: string; kind: string; namespace?: string | null; name: string }, b: { group: string; kind: string; namespace?: string | null; name: string }) =>
  a.group === b.group && a.kind === b.kind && (a.namespace ?? null) === (b.namespace ?? null) && a.name === b.name;

const who = (v: string | null) => (v === "automated" ? ARGO_AUTOMATED_USER : v);
const yesNo = (v: boolean) => (v ? ARGO_YES : ARGO_NO);
const when = (iso: string | null, at: number) => (iso ? <span title={iso}>{age(iso, at)}</span> : null);
const revs = (list: string[]) => (list.length > 0 ? <span className="mono">{list.map(shortRev).join(", ")}</span> : null);
const destText = (d: ArgoApp["destination"]) => [d.name ?? d.server, d.namespace].filter(Boolean).join("/");


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

/** Application 하나의 상세(개요·리소스 트리·이력·YAML/JSON)와 Refresh·Sync 실행 */
export function ArgoDetail({ url, namespace, name, resourceVersion, live, onClose, onTokenError, now, widthPct = DETAIL_PCT, focus, initialTab }: Props) {
  const [tab, setTab] = useState<Tab>(focus ? "resources" : initialTab ?? "overview");
  const q = useArgoApp(url, namespace, name, resourceVersion);
  const tree = useArgoTree(url, namespace, name, resourceVersion, tab === "resources" || tab === "network", live);
  const lastApp = useRef<{ key: string; app: ArgoApp } | null>(null);
  const appKey = JSON.stringify([url, namespace, name]);
  if (q.data) lastApp.current = { key: appKey, app: q.data };
  const app = q.data ?? (lastApp.current?.key === appKey ? lastApp.current.app : undefined);
  const at = now ?? Date.now();

  // 리소스 상세 패널: 트리·Diff·작업 탭에서 리소스를 고르면 리소스 탭에서 연다
  const [picked, setPicked] = useState<ResRef | null>(null);
  const openResource = (res: ResRef) => {
    setPicked(res);
    setTab("resources");
  };
  const readTarget = useMemo<AppTarget | null>(() => (app ? { namespace, name, project: app.project ?? "default" } : null), [app, namespace, name]);
  // 검색에서 열 때 가리킨 리소스를 트리에서 찾아 고른다(없으면 그냥 둔다)
  const focused = useRef(false);
  useEffect(() => {
    if (!focus || focused.current || !tree.data || !app) return;
    focused.current = true;
    const same = (r: { group: string; kind: string; namespace: string | null; name: string }) => sameResource(r, focus);
    const node = tree.data.find(same);
    const found = node ?? app.resources.find(same);
    if (found) setPicked({ group: found.group, version: found.version, kind: found.kind, namespace: found.namespace, name: found.name, uid: node?.uid ?? null });
  }, [focus, tree.data, app]);

  const [sheet, setSheet] = useState(false);
  const [change, setChange] = useState<ArgoChange | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const flow = useArgoChange(url);
  const target = useMemo(() => {
    if (!app) return null;
    const raw = app.raw as { metadata?: { labels?: Record<string, string> } } | null;
    const env = envOf({ name, namespace, resourceVersion: resourceVersion ?? "", labels: raw?.metadata?.labels ?? {}, values: { destNamespace: app.destination.namespace ?? "", destination: app.destination.name ?? app.destination.server ?? "" } }).env;
    return { namespace, name, project: app.project ?? "default", env };
  }, [app, name, namespace, resourceVersion]);
  const can = useArgoCan(url, target, ["get", "sync"]);
  const lastRefresh = useRef(false);
  const refresh = (hard: boolean) => {
    lastRefresh.current = hard;
    setNote(null);
    if (target) void flow.apply(target, { kind: "refresh", hard }, null).then((result) => setNote(result.message)).catch(() => {});
  };

  // 토큰 문제는 상세가 아니라 서버 단위의 일이라 토큰 폼으로 돌려보낸다
  const onToken = useRef(onTokenError);
  onToken.current = onTokenError;
  useEffect(() => {
    const bad = [q.error, tree.error, flow.error, can.error].find(isTokenError);
    if (bad) onToken.current(errorMessage(bad));
  }, [q.error, tree.error, flow.error, can.error]);

  const syncBlocked = app?.operationInProgress === true;
  // 동기화 권한이 있어야 작업 중단·롤백도 할 수 있다(서버가 같은 권한으로 막는다)
  const syncDenied = can.data?.[1] === false ? CHANGE_DENIED : null;
  const tabs: [Tab, string][] = [
    ["overview", TAB_ARGO_OVERVIEW],
    ["resources", TAB_ARGO_RESOURCES],
    ["network", MAP_TEXT.network],
    ["diff", TAB_ARGO_DIFF],
    ["operation", TAB_ARGO_OPERATION],
    ["history", TAB_ARGO_HISTORY],
    ["manage", TAB_ARGO_MANAGE],
    ["raw", TAB_ARGO_RAW],
  ];

  let body: ReactNode;
  if (q.isError && !app) {
    body = <ErrorState error={q.error} profile="" compact onRetry={() => void q.refetch()} />;
  } else if (!app || !readTarget) {
    body = <div className="empty">{LOADING}</div>;
  } else if (tab === "overview") {
    body = <Overview app={app} at={at} />;
  } else if (tab === "resources") {
    const same = picked ? (r: { group: string; kind: string; namespace: string | null; name: string }) => sameResource(r, picked) : null;
    body = picked && same && target ? (
      <ResourcePanel
        key={resKey(picked)}
        url={url}
        target={readTarget}
        changeTarget={target}
        app={app}
        version={resourceVersion}
        res={picked}
        node={tree.data?.find(same) ?? null}
        status={app.resources.find(same) ?? null}
        live={live}
        onBack={() => setPicked(null)}
        onTokenError={onTokenError}
        now={now}
      />
    ) : tree.isError ? (
      <ErrorState error={tree.error} profile="" compact onRetry={() => void tree.refetch()} />
    ) : tree.data ? (
      <ArgoTree nodes={tree.data} resources={app.resources} onSelect={(row) => setPicked({ group: row.group, version: row.version, kind: row.kind, namespace: row.namespace, name: row.name, uid: row.uid })} />
    ) : (
      <div className="empty">{LOADING}</div>
    );
  } else if (tab === "network") {
    body = tree.isError ? <ErrorState error={tree.error} profile="" compact onRetry={() => void tree.refetch()} /> : tree.data ? <NetworkMap nodes={tree.data} onOpen={openResource} /> : <div className="empty">{LOADING}</div>;
  } else if (tab === "diff") {
    body = <AppDiffTab url={url} namespace={namespace} name={name} version={resourceVersion} enabled onOpen={openResource} onTokenError={onTokenError} />;
  } else if (tab === "operation") {
    body = (
      <OperationTab
        url={url}
        app={app}
        now={now}
        onOpen={openResource}
        onTokenError={onTokenError}
        terminate={{ allowed: can.data?.[1] === true, reason: syncDenied, onTerminate: () => setChange({ kind: "terminate" }) }}
      />
    );
  } else if (tab === "history") {
    body = (
      <HistoryTab
        url={url}
        namespace={namespace}
        name={name}
        version={resourceVersion}
        enabled
        now={now}
        onTokenError={onTokenError}
        rollback={{ allowed: can.data?.[1] === true && !syncBlocked, reason: syncBlocked ? ROLLBACK_RUNNING : syncDenied, autoSync: app.syncPolicy?.automated === true, onChange: setChange }}
      />
    );
  } else if (tab === "manage") {
    body = target ? <ManageTab url={url} app={app} target={target} onDone={setNote} onDeleted={onClose} /> : <div className="empty">{LOADING}</div>;
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
          <button className="btn small tone-secondary" disabled={flow.pending || can.data?.[0] !== true} title={can.data?.[0] === false ? CHANGE_DENIED : undefined} onClick={() => refresh(false)}>
            {ARGO_REFRESH}
          </button>
          <button className="btn small tone-warn" disabled={flow.pending || can.data?.[0] !== true} title={can.data?.[0] === false ? CHANGE_DENIED : undefined} onClick={() => refresh(true)}>
            {ARGO_HARD_REFRESH}
          </button>
          {syncBlocked && (
            <button className="btn small tone-danger" disabled={flow.pending || can.data?.[1] !== true} title={syncDenied ?? undefined} onClick={() => setChange({ kind: "terminate" })}>
              {TERMINATE}
            </button>
          )}
          <button className="btn small tone-primary" disabled={flow.pending || !app || syncBlocked || can.data?.[1] !== true} title={syncBlocked ? ARGO_SYNC_RUNNING : can.data?.[1] === false ? CHANGE_DENIED : undefined} onClick={() => setSheet(true)}>
            {ARGO_SYNC}
          </button>
        </span>
        <button className="icon" aria-label={CLOSE} title={CLOSE} onClick={onClose}>
          ✕
        </button>
      </div>
      {readTarget && <DetailBar url={url} namespace={namespace} name={name} version={resourceVersion} live={live} onTokenError={onTokenError} />}
      {note && (
        <p className="ok argo-note" role="status">
          {note}
        </p>
      )}
      {flow.error !== null && <ErrorState error={flow.error} profile="" compact onRetry={() => refresh(lastRefresh.current)} />}
      <div role="tablist" className="k8s-tabs">
        {tabs.map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>
      <div className="k8s-detail-body">{body}</div>
      {sheet && app && (
        <SyncForm
          url={url}
          app={app}
          version={resourceVersion}
          onCancel={() => setSheet(false)}
          onPreview={(value) => {
            setSheet(false);
            setChange(value);
          }}
        />
      )}
      {change && target && <ChangeSheet url={url} target={target} change={change} onClose={() => setChange(null)} onDone={(message) => { setChange(null); setNote(message); }} />}
    </aside>
  );
}
