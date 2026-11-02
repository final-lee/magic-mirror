import { useEffect, useState, type ReactNode } from "react";
import { errorMessage } from "../api/errors";
import { ErrorState } from "../components/ErrorState";
import { ChangeActions } from "./ChangeActions";
import { can } from "./can";
import { Problems, valueKeys } from "./columns";
import { age } from "./format";
import { NODES, isPod, isSecret, isServiceAccount, resolveLink } from "./kinds";
import { DETAIL_PCT } from "./lanes";
import { PodLogs } from "./PodLogs";
import { useK8sObject, useK8sRules } from "./queries";
import { SecretKeys } from "./SecretKeys";
import { YamlEdit } from "./YamlEdit";
import { YamlView } from "./YamlView";
import {
  BACK, CHILDREN_TRUNCATED, CLOSE, COL_NAME, COLUMN_LABELS, CREATED_AT, DETAIL_LABEL, H_IMAGE, H_KIND, H_LAST_TERMINATION, H_MESSAGE,
  H_REASON, H_RESTARTS, H_STATE, INIT_MARK, LOADING, NO_RECENT_EVENTS, OPEN_IN_IAM, SEC_ANNOTATIONS, SEC_CHILDREN, SEC_CONDITIONS,
  SEC_CONTAINERS, SEC_EVENTS, SEC_LABELS, SEC_OWNERS, TAB_LOGS, TAB_SUMMARY, TAB_YAML, YAML_SECRET_NOTE, H_TIME, H_COUNT, openNode,
  CHANGE_DENIED, YAML_EDIT,
} from "./text";
import type { K8sChange, K8sContainer, K8sKind, K8sLink, K8sObjectView, K8sTarget, ObjectRef } from "./types";

interface Props {
  target: K8sTarget;
  context: string;
  ssoProfile: string;
  live: boolean;
  objectRef: ObjectRef;
  /** 목록에 있는 객체면 그 resourceVersion(바뀌면 다시 읽는다), 아니면 null */
  resourceVersion: string | null;
  kinds: K8sKind[];
  onOpen: (ref: ObjectRef) => void;
  onBack: (() => void) | null;
  onClose: () => void;
  onOpenIam?: (arn: string) => void;
  now?: number;
  changeMode?: boolean;
  onChange?: (change: K8sChange) => void;
  rolloutProgress?: string;
  /** 방금 적용을 마친 변경. YAML 적용이면 편집을 닫는다 */
  appliedChange?: K8sChange | null;
  /** 3열 목록 너비 중 덮는 비율(%). 없으면 DETAIL_PCT */
  widthPct?: number;
}

function Links({ title, links, kinds, onOpen }: { title: string; links: K8sLink[]; kinds: K8sKind[]; onOpen: (ref: ObjectRef) => void }) {
  return (
    <section className="k8s-sect" aria-label={title}>
      <h4>{title}</h4>
      <ul className="k8s-links">
        {links.map((l) => {
          const kind = resolveLink(l, kinds);
          const label = `${l.kind}/${l.name}`;
          return (
            <li key={l.uid}>
              {kind ? (
                <button className="link" onClick={() => onOpen({ kind, namespace: kind.namespaced ? l.namespace : null, name: l.name })}>
                  {label}
                </button>
              ) : (
                <span className="mono">{label}</span>
              )}{" "}
              <Problems problems={l.problems} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const stateText = (c: K8sContainer) => (c.state === "template" ? "" : c.reason ? `${c.state}: ${c.reason}` : c.state);

function Summary({ view, now, kinds, onOpen, onOpenIam, children }: { view: K8sObjectView; now: number; kinds: K8sKind[]; onOpen: (ref: ObjectRef) => void; onOpenIam?: (arn: string) => void; children?: ReactNode }) {
  const { row } = view;
  const node = isPod(view.kind) ? row.values.node : undefined;
  const role = isServiceAccount(view.kind) ? row.values.roleArn : undefined;
  return (
    <div>
      <Problems problems={row.problems} />
      <dl className="kv">
        {valueKeys(view.kind)
          .filter((k) => Object.prototype.hasOwnProperty.call(row.values, k))
          .map((k) => (
            <div key={k} className="k8s-kv">
              <dt>{COLUMN_LABELS[k] ?? k}</dt>
              <dd>{row.values[k]}</dd>
            </div>
          ))}
        <div className="k8s-kv">
          <dt>{CREATED_AT}</dt>
          <dd title={row.createdAt ?? ""}>{age(row.createdAt, now)}</dd>
        </div>
      </dl>
      <div className="k8s-actions">
        {node && (
          <button className="btn" onClick={() => onOpen({ kind: NODES, namespace: null, name: node })}>
            {openNode(node)}
          </button>
        )}
        {role && onOpenIam && (
          <button className="btn" onClick={() => onOpenIam(role)}>
            {OPEN_IN_IAM}
          </button>
        )}
      </div>
      {view.owners.length > 0 && <Links title={SEC_OWNERS} links={view.owners} kinds={kinds} onOpen={onOpen} />}
      {(view.children.length > 0 || view.childrenError) && (
        <>
          <Links title={SEC_CHILDREN} links={view.children} kinds={kinds} onOpen={onOpen} />
          {view.childrenTruncated && <p className="dim">{CHILDREN_TRUNCATED}</p>}
          {view.childrenError && <p className="err">{errorMessage(view.childrenError)}</p>}
        </>
      )}
      {children}
      {view.containers.length > 0 && (
        <section className="k8s-sect">
          <h4>{SEC_CONTAINERS}</h4>
          <table className="k8s-table">
            <thead>
              <tr><th>{COL_NAME}</th><th>{H_IMAGE}</th><th>{H_STATE}</th><th>{H_RESTARTS}</th><th>{H_LAST_TERMINATION}</th></tr>
            </thead>
            <tbody>
              {view.containers.map((c) => (
                <tr key={`${c.init}|${c.name}`}>
                  <td className="mono">{c.name}{c.init && <span className="k8s-chip">{INIT_MARK}</span>}</td>
                  <td className="mono">{c.image}</td>
                  <td title={c.message ?? ""}>{stateText(c)}</td>
                  <td>{c.state === "template" ? "" : c.restarts}</td>
                  <td>{c.lastTermination ? `${c.lastTermination.reason ?? ""} (${c.lastTermination.exitCode})` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {view.conditions.length > 0 && (
        <section className="k8s-sect">
          <h4>{SEC_CONDITIONS}</h4>
          <table className="k8s-table">
            <thead>
              <tr><th>{H_KIND}</th><th>{H_STATE}</th><th>{H_REASON}</th><th>{H_MESSAGE}</th></tr>
            </thead>
            <tbody>
              {view.conditions.map((c) => (
                <tr key={c.type}><td>{c.type}</td><td>{c.status}</td><td>{c.reason ?? ""}</td><td>{c.message ?? ""}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <section className="k8s-sect">
        <h4>{SEC_EVENTS}</h4>
        {view.eventsError ? (
          <p className="err">{errorMessage(view.eventsError)}</p>
        ) : view.events.length === 0 ? (
          <p className="dim">{NO_RECENT_EVENTS}</p>
        ) : (
          <table className="k8s-table">
            <thead>
              <tr><th>{H_TIME}</th><th>{H_KIND}</th><th>{H_REASON}</th><th>{H_MESSAGE}</th><th>{H_COUNT}</th></tr>
            </thead>
            <tbody>
              {view.events.map((e, i) => (
                <tr key={i} className={e.type === "Warning" ? "k8s-warn" : undefined}>
                  <td title={e.lastSeen ?? ""}>{age(e.lastSeen, now)}</td><td>{e.type}</td><td>{e.reason}</td><td>{e.message}</td><td>{e.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {Object.keys(row.labels).length > 0 && (
        <section className="k8s-sect">
          <h4>{SEC_LABELS}</h4>
          {Object.entries(row.labels).map(([k, v]) => <span key={k} className="tag">{k}={v}</span>)}
        </section>
      )}
      {Object.keys(view.annotations).length > 0 && (
        <section className="k8s-sect">
          <h4>{SEC_ANNOTATIONS}</h4>
          <dl className="kv">
            {Object.entries(view.annotations).map(([k, v]) => (
              <div key={k} className="k8s-kv"><dt className="mono">{k}</dt><dd className="mono k8s-wrap">{v}</dd></div>
            ))}
          </dl>
        </section>
      )}
    </div>
  );
}

/** 객체 하나의 상세(요약·YAML). 소유자·자식·노드 링크는 onOpen으로 상세 스택에 쌓는다. */
export function ObjectDetail({ target, context, ssoProfile, live, objectRef, resourceVersion, kinds, onOpen, onBack, onClose,
  onOpenIam, now, widthPct = DETAIL_PCT, changeMode, onChange, rolloutProgress, appliedChange }: Props) {
  const [tab, setTab] = useState<"summary" | "yaml" | "logs">("summary");
  const pod = isPod(objectRef.kind) && objectRef.namespace !== null;
  const q = useK8sObject(target, context, objectRef, resourceVersion, ssoProfile, live);
  const secret = isSecret(objectRef.kind);
  const rules = useK8sRules(target, context, objectRef.namespace ?? "default", ssoProfile, live && (changeMode === true || (secret && objectRef.namespace !== null)));
  const canRead = rules.data ? can(rules.data, { verb: "get", group: "", resource: "secrets", name: objectRef.name }) : "unknown";
  const at = now ?? Date.now();
  // 로그 탭은 Pod가 바뀔 때마다(resourceVersion) 상세를 다시 읽는 동안에도 흐름·옵션·찾기를 잃지 않게, 마지막으로 읽은 컨테이너로 계속 띄워 둔다
  const [podContainers, setPodContainers] = useState<K8sContainer[] | null>(null);
  useEffect(() => {
    if (pod && q.data) setPodContainers(q.data.containers.filter((c) => c.state !== "template"));
  }, [pod, q.data]);
  const logContainers = pod && q.data ? q.data.containers.filter((c) => c.state !== "template") : podContainers;
  const [editing, setEditing] = useState(false);
  useEffect(() => setEditing(false), [objectRef.kind, objectRef.namespace, objectRef.name, tab]);
  // 적용이 끝나면 편집을 닫는다(편집하던 글은 더 이상 현재 객체가 아니다)
  useEffect(() => {
    if (appliedChange?.type === "apply") setEditing(false);
  }, [appliedChange]);
  // 불완전한 규칙은 서버 판단에 맡기고 확실히 거부된 것만 끈다. 새 객체를 만드는 apply가 아니라 있는 객체를 고치므로 patch 권한을 본다.
  const patchRule = rules.data && can(rules.data, { verb: "patch", group: objectRef.kind.group, resource: objectRef.kind.plural, name: objectRef.name });
  const editDenied = patchRule === "no" ? CHANGE_DENIED("patch", objectRef.kind.plural) : undefined;
  return (
    <aside className="k8s-detail" aria-label={DETAIL_LABEL} style={{ width: `${widthPct}%` }}>
      <div className="k8s-detail-head">
        {onBack && (
          <button className="icon" aria-label={BACK} title={BACK} onClick={onBack}>
            ‹
          </button>
        )}
        <b>{objectRef.kind.kind}</b>
        <span className="mono k8s-wrap">{objectRef.namespace ? `${objectRef.namespace}/` : ""}{objectRef.name}</span>
        <button className="icon k8s-push" aria-label={CLOSE} title={CLOSE} onClick={onClose}>
          ✕
        </button>
      </div>
      {rolloutProgress && <p role="status">{rolloutProgress}</p>}
      {changeMode && onChange && q.data && <ChangeActions target={target} ssoProfile={ssoProfile} objectRef={objectRef} view={q.data} rules={rules.data} onStart={onChange} />}
      <div role="tablist" className="k8s-tabs">
        <button role="tab" aria-selected={tab === "summary"} onClick={() => setTab("summary")}>{TAB_SUMMARY}</button>
        <button role="tab" aria-selected={tab === "yaml"} onClick={() => setTab("yaml")}>{TAB_YAML}</button>
        {pod && <button role="tab" aria-selected={tab === "logs"} onClick={() => setTab("logs")}>{TAB_LOGS}</button>}
      </div>
      <div className={`k8s-detail-body${tab === "logs" ? " flush" : ""}`}>
        {tab === "logs" && pod && objectRef.namespace && logContainers ? (
          <PodLogs target={target} ssoProfile={ssoProfile} live={live} namespace={objectRef.namespace} pod={objectRef.name} containers={logContainers} />
        ) : q.isError ? (
          <ErrorState error={q.error} profile={ssoProfile} compact onRetry={() => void q.refetch()} onLoggedIn={() => void q.refetch()} />
        ) : !q.data ? (
          <div className="empty">{LOADING}</div>
        ) : tab === "summary" ? (
          <Summary view={q.data} now={at} kinds={kinds} onOpen={onOpen} onOpenIam={onOpenIam}>
            {q.data.secretKeys && objectRef.namespace && (
              <SecretKeys target={target} ssoProfile={ssoProfile} namespace={objectRef.namespace} name={objectRef.name} keys={q.data.secretKeys} canRead={canRead} />
            )}
          </Summary>
        ) : tab === "yaml" && editing && changeMode && onChange ? (
          <YamlEdit target={target} ssoProfile={ssoProfile} objectRef={objectRef} view={q.data} canRead={canRead} onPreview={onChange} onCancel={() => setEditing(false)} />
        ) : (
          <>
            {changeMode && onChange && (
              <div className="k8s-actions">
                <button className="btn small" disabled={!!editDenied} title={editDenied} aria-description={editDenied} onClick={() => setEditing(true)}>
                  {YAML_EDIT}
                </button>
              </div>
            )}
            {secret && <p className="dim">{YAML_SECRET_NOTE}</p>}
            <YamlView text={q.data.yaml} />
          </>
        )}
      </div>
    </aside>
  );
}
