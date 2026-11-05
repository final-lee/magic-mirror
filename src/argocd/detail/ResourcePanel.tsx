import { useState, type ReactNode } from "react";
import { ErrorState } from "../../components/ErrorState";
import { age } from "../../k8s/format";
import { YamlView } from "../../k8s/YamlView";
import { ArgoBadge } from "../argoParts";
import { ARGO_HOOK, ARGO_PRUNING, LOADING } from "../text";
import type { ArgoTarget } from "../change/types";
import { ActionsTab } from "../ops/ActionsTab";
import { RES_TAB_ACTIONS } from "../ops/text";
import type { AppTarget, ArgoApp, ArgoResource, ArgoTreeNode, ResRef } from "../types";
import { DiffBody } from "./DiffBody";
import { EventsTable } from "./EventsTable";
import { logsKind } from "./helpers";
import { LinkButtons } from "./LinkButtons";
import { Kv, Sect } from "./parts";
import { useResourceEvents, useResourceLinks, useResourceView } from "./queries";
import { ResourceLogs } from "./ResourceLogs";
import {
  L_RES_API, L_RES_CREATED, L_RES_FLAGS, L_RES_HEALTH, L_RES_IMAGES, L_RES_INFO, L_RES_KIND, L_RES_MESSAGE, L_RES_NAMESPACE, L_RES_SYNC, RES_BACK, RES_CLUSTER_SCOPE,
  RES_NO_DESIRED, RES_NO_DIFF, RES_NO_LINKS, RES_NO_LIVE, RES_PANEL_LABEL, RES_TAB_DESIRED, RES_TAB_DIFF, RES_TAB_EVENTS, RES_TAB_LINKS, RES_TAB_LIVE, RES_TAB_LOGS,
  RES_TAB_SUMMARY,
} from "./text";
import { useTokenGuard } from "./useTokenGuard";

export type ResourceTab = "summary" | "live" | "desired" | "diff" | "events" | "logs" | "links" | "actions";

/** 이 리소스에서 볼 수 있는 탭. 로그는 Pod와 Pod를 거느린 워크로드에만 있다. 액션(실행·패치·삭제·터미널)은 맨 끝. */
export function resourceTabs(res: Pick<ResRef, "group" | "kind">): [ResourceTab, string][] {
  const tabs: [ResourceTab, string][] = [
    ["summary", RES_TAB_SUMMARY],
    ["live", RES_TAB_LIVE],
    ["desired", RES_TAB_DESIRED],
    ["diff", RES_TAB_DIFF],
    ["events", RES_TAB_EVENTS],
  ];
  if (logsKind(res) !== null) tabs.push(["logs", RES_TAB_LOGS]);
  tabs.push(["links", RES_TAB_LINKS], ["actions", RES_TAB_ACTIONS]);
  return tabs;
}

interface Props {
  url: string;
  target: AppTarget;
  /** 쓰기 요청의 대상(환경 포함)과 앱. 액션 탭이 권한·대상 클러스터·자동 동기화를 이 앱 기준으로 본다 */
  changeTarget: ArgoTarget;
  app: ArgoApp;
  /** 앱의 resourceVersion(바뀌면 live·diff를 다시 읽는다) */
  version: string | null;
  res: ResRef;
  /** 트리의 노드(Health·정보·이미지를 요약에 보인다). 트리에 없으면 null */
  node: ArgoTreeNode | null;
  /** 앱이 보고한 이 리소스의 Sync 상태·hook·삭제 예정. 없으면 null */
  status: ArgoResource | null;
  /** 탭이 보이는 동안만 이벤트를 주기적으로 다시 읽고 로그를 받는다 */
  live: boolean;
  onBack: () => void;
  onTokenError: (message: string) => void;
  now?: number;
}

/** 리소스 하나의 상세: 요약 / Live / Desired / Diff / Events / 로그 / 링크 */
export function ResourcePanel({ url, target, changeTarget, app, version, res, node, status, live, onBack, onTokenError, now }: Props) {
  const [tab, setTab] = useState<ResourceTab>("summary");
  const at = now ?? Date.now();
  const tabs = resourceTabs(res);
  const view = useResourceView(url, target, res, version);
  const events = useResourceEvents(url, target, res, tab === "events", live);
  const links = useResourceLinks(url, target, res, tab === "links");
  useTokenGuard([view.error, events.error, links.error], onTokenError);

  const fromView = (render: (v: NonNullable<typeof view.data>) => ReactNode) =>
    view.isError ? <ErrorState error={view.error} profile="" compact onRetry={() => void view.refetch()} /> : view.data ? render(view.data) : <div className="empty">{LOADING}</div>;

  let body: ReactNode;
  switch (tab) {
    case "summary":
      body = <Summary res={res} node={node} status={status} at={at} />;
      break;
    case "live":
      body = fromView((v) => (v.live ? <YamlView text={v.live} /> : <p className="dim">{RES_NO_LIVE}</p>));
      break;
    case "desired":
      body = fromView((v) => (v.desired ? <YamlView text={v.desired} /> : <p className="dim">{RES_NO_DESIRED}</p>));
      break;
    case "diff":
      body = fromView((v) => (v.diff ? <DiffBody diff={v.diff} /> : <p className="dim">{RES_NO_DIFF}</p>));
      break;
    case "events":
      body = events.isError ? (
        <ErrorState error={events.error} profile="" compact onRetry={() => void events.refetch()} />
      ) : events.data ? (
        <EventsTable events={events.data} now={at} />
      ) : (
        <div className="empty">{LOADING}</div>
      );
      break;
    case "logs":
      body = fromView((v) => <ResourceLogs url={url} target={target} res={res} containers={v.containers} live={live} />);
      break;
    case "links":
      body = links.isError ? (
        <ErrorState error={links.error} profile="" compact onRetry={() => void links.refetch()} />
      ) : links.data ? (
        <LinkButtons links={links.data} label={RES_TAB_LINKS} empty={RES_NO_LINKS} />
      ) : (
        <div className="empty">{LOADING}</div>
      );
      break;
    case "actions":
      body = <ActionsTab url={url} app={app} target={changeTarget} version={version} res={res} containers={view.data?.containers ?? []} onTokenError={onTokenError} />;
      break;
  }

  return (
    <section className="argo-res" aria-label={RES_PANEL_LABEL}>
      <div className="argo-res-head">
        <button className="btn small tone-secondary" onClick={onBack}>
          {RES_BACK}
        </button>
        <span className="dim">{res.kind}</span>
        <b className="mono k8s-wrap">{res.name}</b>
        {res.namespace && <span className="dim">{res.namespace}</span>}
      </div>
      <div role="tablist" className="k8s-tabs">
        {tabs.map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>
      <div className="argo-res-body">{body}</div>
    </section>
  );
}

function Summary({ res, node, status, at }: { res: ResRef; node: ArgoTreeNode | null; status: ArgoResource | null; at: number }) {
  return (
    <Sect title={RES_TAB_SUMMARY}>
      <dl className="kv">
        <Kv label={L_RES_KIND}>{res.kind}</Kv>
        <Kv label={L_RES_API}>{[res.group || "core", res.version].filter(Boolean).join("/")}</Kv>
        <Kv label={L_RES_NAMESPACE}>{res.namespace ?? RES_CLUSTER_SCOPE}</Kv>
        <Kv label={L_RES_HEALTH}>
          <ArgoBadge status={node?.health} />
        </Kv>
        <Kv label={L_RES_MESSAGE}>{node?.healthMessage}</Kv>
        <Kv label={L_RES_SYNC}>
          <ArgoBadge status={status?.status} />
        </Kv>
        <Kv label={L_RES_FLAGS}>
          {status?.hook || status?.requiresPruning ? (
            <>
              {status.hook && <span className="k8s-chip">{ARGO_HOOK}</span>}
              {status.requiresPruning && <span className="k8s-chip argo-chip-warn">{ARGO_PRUNING}</span>}
            </>
          ) : null}
        </Kv>
        <Kv label={L_RES_CREATED}>{node?.createdAt ? <span title={node.createdAt}>{age(node.createdAt, at)}</span> : null}</Kv>
        <Kv label={L_RES_IMAGES}>
          {node && node.images.length > 0 ? (
            <span className="mono k8s-wrap">
              {node.images.map((image) => (
                <div key={image}>{image}</div>
              ))}
            </span>
          ) : null}
        </Kv>
        <Kv label={L_RES_INFO}>
          {node && node.info.length > 0 ? (
            <span className="k8s-wrap">
              {node.info.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </span>
          ) : null}
        </Kv>
      </dl>
    </Sect>
  );
}
