import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { errorMessage } from "../../api/errors";
import { ErrorState } from "../../components/ErrorState";
import { useModal } from "../../iam/useModal";
import { age } from "../../k8s/format";
import { DETAIL_PCT } from "../../k8s/lanes";
import { YamlView } from "../../k8s/YamlView";
import { ArgoBadge } from "../argoParts";
import { envOf } from "../argoEnv";
import { ArgoTree } from "../ArgoTree";
import { ChangeSheet } from "../change/ChangeSheet";
import type { ArgoChange, ArgoTarget } from "../change/types";
import { Kv, Sect } from "../detail/parts";
import { isTokenError } from "../queries";
import type { ArgoAppRow } from "../types";
import { AppSetPreview } from "./AppSetPreview";
import { useAppSet, useAppSetEvents, useAppSetTree } from "./queries";
import { groupProgress } from "./appSetProgress";
import type { AppSetDetail } from "./types";
import {
  APPSET_COL_APP, APPSET_COL_DEST, APPSET_COL_HEALTH, APPSET_COL_MESSAGE, APPSET_COL_REVISION, APPSET_COL_STATUS, APPSET_COL_SYNC, APPSET_CONDITIONS, APPSET_DELETE,
  APPSET_DELETE_ABOUT, APPSET_DELETE_CONTINUE, APPSET_DELETE_PRESERVED, APPSET_DELETE_TITLE, APPSET_DELETE_WARN, APPSET_DETAIL_LABEL, APPSET_EVENT_COUNT, APPSET_EVENT_LAST,
  APPSET_EVENT_MESSAGE, APPSET_EVENT_REASON, APPSET_EVENT_TYPE, APPSET_GENERATORS, APPSET_GO_TEMPLATE, APPSET_KIND, APPSET_NO_APPS, APPSET_NO_CONDITIONS, APPSET_NO_EVENTS,
  APPSET_NO_GENERATORS, APPSET_NO_STRATEGY, APPSET_NO_TREE, APPSET_PRESERVE, APPSET_STEP_ALL, APPSET_STEP_MATCH, APPSET_STEP_MAX, APPSET_STRATEGY, APPSET_T_DEST, APPSET_T_NAME,
  APPSET_T_PROJECT, APPSET_T_SOURCES, APPSET_TAB_APPS, APPSET_TAB_EVENTS, APPSET_TAB_OVERVIEW, APPSET_TAB_PREVIEW, APPSET_TAB_TREE, APPSET_TAB_YAML, APPSET_TEMPLATE, appSetStep,
  CLOSE_LABEL, MANAGE_CANCEL, MANAGE_LOADING,
} from "./text";

type Tab = "overview" | "apps" | "tree" | "events" | "yaml" | "preview";

const TABS: [Tab, string][] = [
  ["overview", APPSET_TAB_OVERVIEW],
  ["apps", APPSET_TAB_APPS],
  ["tree", APPSET_TAB_TREE],
  ["events", APPSET_TAB_EVENTS],
  ["yaml", APPSET_TAB_YAML],
  ["preview", APPSET_TAB_PREVIEW],
];

interface Props {
  url: string;
  namespace: string;
  name: string;
  /** 목록의 앱 행: 이 ApplicationSet이 만든 앱(values.appSet)을 여기서 가린다 */
  rows: ArgoAppRow[];
  live: boolean;
  onClose: () => void;
  /** 만든 앱 한 줄을 누르면 그 앱의 상세로 간다 */
  onOpenApp: (namespace: string, name: string) => void;
  onTokenError: (message: string) => void;
  now?: number;
  widthPct?: number;
}

/** ApplicationSet 상세: 개요·만든 앱·트리·Events·YAML·미리 보기(편집·저장)와 삭제 */
export function AppSetPanel({ url, namespace, name, rows, live, onClose, onOpenApp, onTokenError, now, widthPct = DETAIL_PCT }: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  const [change, setChange] = useState<ArgoChange | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const detail = useAppSet(url, namespace, name, live);
  const events = useAppSetEvents(url, namespace, name, tab === "events");
  const tree = useAppSetTree(url, namespace, name, tab === "tree");
  const at = now ?? Date.now();
  const mine = useMemo(() => rows.filter((r) => r.namespace === namespace && r.values.appSet === name), [rows, namespace, name]);
  const set = detail.data;

  // 토큰 문제는 상세가 아니라 서버 단위의 일이라 토큰 폼으로 돌려보낸다
  const onToken = useRef(onTokenError);
  onToken.current = onTokenError;
  useEffect(() => {
    const bad = [detail.error, events.error, tree.error].find(isTokenError);
    if (bad) onToken.current(errorMessage(bad));
  }, [detail.error, events.error, tree.error]);

  const target: ArgoTarget = { namespace, name, project: set?.template.project ?? "default", env: envOf({ name, namespace, resourceVersion: "", labels: {}, values: {} }).env };

  let body: ReactNode;
  if (detail.isError) body = <ErrorState error={detail.error} profile="" compact onRetry={() => void detail.refetch()} />;
  else if (!set) body = <div className="empty">{MANAGE_LOADING}</div>;
  else if (tab === "overview") body = <Overview set={set} at={at} />;
  else if (tab === "apps") body = <MadeApps rows={mine} at={at} onOpen={onOpenApp} />;
  else if (tab === "tree") {
    body = tree.isError ? <ErrorState error={tree.error} profile="" compact onRetry={() => void tree.refetch()} /> : !tree.data ? <div className="empty">{MANAGE_LOADING}</div> : tree.data.length === 0 ? <p className="dim">{APPSET_NO_TREE}</p> : <ArgoTree nodes={tree.data} resources={[]} />;
  } else if (tab === "events") {
    body = events.isError ? <ErrorState error={events.error} profile="" compact onRetry={() => void events.refetch()} /> : !events.data ? <div className="empty">{MANAGE_LOADING}</div> : <Events events={events.data} at={at} />;
  } else if (tab === "yaml") body = <YamlView text={set.yaml} />;
  else body = <AppSetPreview url={url} set={set} onChange={setChange} />;

  return (
    <aside className="k8s-detail" aria-label={APPSET_DETAIL_LABEL} style={{ width: `${widthPct}%` }}>
      <div className="k8s-detail-head">
        <b>{APPSET_KIND}</b>
        <span className="mono k8s-wrap">
          {namespace}/{name}
        </span>
        <span className="argo-acts k8s-push">
          <button className="btn small tone-danger" disabled={!set} onClick={() => setConfirmDelete(true)}>
            {APPSET_DELETE}
          </button>
        </span>
        <button className="icon" aria-label={CLOSE_LABEL} title={CLOSE_LABEL} onClick={onClose}>
          ✕
        </button>
      </div>
      {note && (
        <p className="ok argo-note" role="status">
          {note}
        </p>
      )}
      <div role="tablist" className="k8s-tabs">
        {TABS.map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>
      <div className="k8s-detail-body">{body}</div>
      {confirmDelete && set && (
        <DeleteSheet
          set={set}
          count={mine.length}
          onCancel={() => setConfirmDelete(false)}
          onContinue={() => {
            setConfirmDelete(false);
            setChange({ kind: "appSetDelete", name, namespace });
          }}
        />
      )}
      {change && (
        <ChangeSheet
          url={url}
          target={target}
          change={change}
          onClose={() => setChange(null)}
          onDone={(message) => {
            const removed = change.kind === "appSetDelete";
            setChange(null);
            setNote(message);
            if (removed) onClose();
          }}
        />
      )}
    </aside>
  );
}

function Overview({ set, at }: { set: AppSetDetail; at: number }) {
  const progress = useMemo(() => groupProgress(set), [set]);
  return (
    <div>
      <Sect title={APPSET_CONDITIONS}>
        {set.conditions.length === 0 ? (
          <p className="dim">{APPSET_NO_CONDITIONS}</p>
        ) : (
          <table className="k8s-table">
            <tbody>
              {set.conditions.map((c) => (
                <tr key={c.type}>
                  <td>{c.type}</td>
                  <td className={c.type === "ErrorOccurred" && c.status === "True" ? "err" : undefined}>{c.status}</td>
                  <td className="k8s-wrap">{[c.reason, c.message].filter(Boolean).join(": ")}</td>
                  <td title={c.lastTransitionTime ?? ""}>{age(c.lastTransitionTime, at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Sect>
      <Sect title={APPSET_GENERATORS}>
        {set.generators.length === 0 ? (
          <p className="dim">{APPSET_NO_GENERATORS}</p>
        ) : (
          <ul className="mg-list">
            {set.generators.map((g, i) => (
              <li key={i}>
                <b>{g.kind}</b> {g.detail && <span className="mono dim">{g.detail}</span>}
              </li>
            ))}
          </ul>
        )}
      </Sect>
      <Sect title={APPSET_TEMPLATE}>
        <dl className="kv">
          <Kv label={APPSET_T_NAME}>{set.template.name && <span className="mono">{set.template.name}</span>}</Kv>
          <Kv label={APPSET_T_PROJECT}>{set.template.project}</Kv>
          <Kv label={APPSET_T_SOURCES}>
            {set.template.sources.length > 0 && (
              <>
                {set.template.sources.map((s) => (
                  <div key={s} className="mono k8s-wrap">
                    {s}
                  </div>
                ))}
              </>
            )}
          </Kv>
          <Kv label={APPSET_T_DEST}>{set.template.destination && <span className="mono">{set.template.destination}</span>}</Kv>
          <Kv label={APPSET_GO_TEMPLATE}>{set.goTemplate ? "true" : null}</Kv>
          <Kv label={APPSET_PRESERVE}>{set.preserveResourcesOnDeletion ? "true" : null}</Kv>
        </dl>
      </Sect>
      <Sect title={APPSET_STRATEGY}>
        {set.strategy === null || set.strategy.steps.length === 0 ? (
          <p className="dim">{APPSET_NO_STRATEGY}</p>
        ) : (
          <>
            <p className="dim">{set.strategy.kind}</p>
            {progress.map((step) => (
              <div key={step.step} className="mg-step">
                <b>{appSetStep(step.step)}</b>
                <span className="dim">
                  {APPSET_STEP_MATCH}: {step.info.matches.length > 0 ? step.info.matches.join(", ") : APPSET_STEP_ALL}
                  {step.info.maxUpdate && ` · ${APPSET_STEP_MAX} ${step.info.maxUpdate}`}
                </span>
                {step.apps.length > 0 && (
                  <table className="k8s-table">
                    <thead>
                      <tr>
                        <th>{APPSET_COL_APP}</th>
                        <th>{APPSET_COL_STATUS}</th>
                        <th>{APPSET_COL_MESSAGE}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {step.apps.map((a) => (
                        <tr key={a.application}>
                          <td className="mono">{a.application}</td>
                          <td>
                            <ArgoBadge status={a.status} />
                          </td>
                          <td className="k8s-wrap">{a.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </>
        )}
      </Sect>
    </div>
  );
}

function MadeApps({ rows, at, onOpen }: { rows: ArgoAppRow[]; at: number; onOpen: (namespace: string, name: string) => void }) {
  if (rows.length === 0) return <p className="dim">{APPSET_NO_APPS}</p>;
  return (
    <table className="k8s-table argo-table">
      <thead>
        <tr>
          <th>{APPSET_COL_APP}</th>
          <th>{APPSET_COL_SYNC}</th>
          <th>{APPSET_COL_HEALTH}</th>
          <th>{APPSET_COL_DEST}</th>
          <th>{APPSET_COL_REVISION}</th>
          <th>{APPSET_EVENT_LAST}</th>
        </tr>
      </thead>
      <tbody>
        {[...rows]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((r) => (
            <tr key={r.name} className="argo-row" tabIndex={0} onClick={() => onOpen(r.namespace, r.name)} onKeyDown={(e) => e.key === "Enter" && onOpen(r.namespace, r.name)}>
              <td className="mono k8s-wrap">{r.name}</td>
              <td>
                <ArgoBadge status={r.values.sync ?? "Unknown"} />
              </td>
              <td>
                <ArgoBadge status={r.values.health ?? "Unknown"} />
              </td>
              <td className="mono">{[r.values.destination, r.values.destNamespace].filter(Boolean).join("/")}</td>
              <td className="mono">{r.values.revision}</td>
              <td title={r.values.lastSync ?? ""}>{age(r.values.lastSync ?? null, at)}</td>
            </tr>
          ))}
      </tbody>
    </table>
  );
}

function Events({ events, at }: { events: { type: string; reason: string; message: string; count: number; lastSeen: string | null }[]; at: number }) {
  if (events.length === 0) return <p className="dim">{APPSET_NO_EVENTS}</p>;
  return (
    <table className="k8s-table">
      <thead>
        <tr>
          <th>{APPSET_EVENT_TYPE}</th>
          <th>{APPSET_EVENT_REASON}</th>
          <th>{APPSET_EVENT_MESSAGE}</th>
          <th>{APPSET_EVENT_COUNT}</th>
          <th>{APPSET_EVENT_LAST}</th>
        </tr>
      </thead>
      <tbody>
        {events.map((e, i) => (
          <tr key={i}>
            <td className={e.type === "Warning" ? "err" : undefined}>{e.type}</td>
            <td>{e.reason}</td>
            <td className="k8s-wrap">{e.message}</td>
            <td>{e.count}</td>
            <td title={e.lastSeen ?? ""}>{age(e.lastSeen, at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 삭제 전 설명: 만든 앱도 함께 지워진다(preserveResourcesOnDeletion이면 남는다). 이름 입력은 변경 미리 보기가 받는다 */
function DeleteSheet({ set, count, onCancel, onContinue }: { set: AppSetDetail; count: number; onCancel: () => void; onContinue: () => void }) {
  const { sheetRef, trapTab } = useModal(onCancel);
  useEffect(() => {
    sheetRef.current?.focus();
  }, [sheetRef]);
  return (
    <div className="modal" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={APPSET_DELETE_TITLE} ref={sheetRef} tabIndex={-1} onKeyDown={trapTab}>
        <h3>{APPSET_DELETE_TITLE}</h3>
        <p className={set.preserveResourcesOnDeletion ? undefined : "err"}>{set.preserveResourcesOnDeletion ? APPSET_DELETE_PRESERVED : APPSET_DELETE_WARN}</p>
        <p>{APPSET_DELETE_ABOUT(count)}</p>
        <div className="foot">
          <button className="btn plain tone-ghost" onClick={onCancel}>
            {MANAGE_CANCEL}
          </button>
          <button className="btn plain tone-danger" onClick={onContinue}>
            {APPSET_DELETE_CONTINUE}
          </button>
        </div>
      </div>
    </div>
  );
}
