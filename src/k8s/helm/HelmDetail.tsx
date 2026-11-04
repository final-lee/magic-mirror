import { useEffect, useState } from "react";
import { ErrorState } from "../../components/ErrorState";
import { formatDateTime } from "../../iam/format";
import { can } from "../can";
import { DETAIL_PCT } from "../lanes";
import type { K8sChange, K8sKind, K8sRules, K8sTarget, ObjectRef } from "../types";
import { YamlView } from "../YamlView";
import { HelmUpgradeDialog } from "./HelmUpgradeDialog";
import { useHelmRelease } from "./queries";
import { StatusBadge } from "./StatusBadge";
import * as t from "./text";
import { HELM_RELEASE_KIND, type HelmReleaseDetail, type HelmResource, type HelmTool } from "./types";

interface Props {
  target: K8sTarget;
  context: string;
  ssoProfile: string;
  live: boolean;
  namespace: string;
  name: string;
  /** 이 클러스터가 내주는 종류. 리소스를 워크로드 화면에서 열 수 있는지 정한다 */
  kinds: K8sKind[];
  tool: HelmTool | undefined;
  /** 릴리스 네임스페이스의 내 권한(없으면 아직 읽는 중) */
  rules: K8sRules | undefined;
  onChange: (change: K8sChange) => void;
  onOpenObject: (ref: ObjectRef) => void;
  onClose: () => void;
  widthPct?: number;
}

type Tab = "summary" | "values" | "manifest" | "history" | "notes";

/** manifest의 리소스를 워크로드 화면에서 열 수 있는 종류로 바꾼다. 모르는 종류면 null */
export function resolveResource(resource: HelmResource, releaseNamespace: string, kinds: K8sKind[]): ObjectRef | null {
  const group = resource.apiVersion.includes("/") ? resource.apiVersion.split("/")[0] : "";
  const kind = kinds.find((k) => k.group === group && k.kind === resource.kind);
  if (!kind) return null;
  return { kind, namespace: kind.namespaced ? (resource.namespace ?? releaseNamespace) : null, name: resource.name };
}

/** 릴리스 상세: 요약, values, 매니페스트, 이력, notes. 위쪽 오른쪽 도구 모음에 업그레이드·롤백·삭제를 둔다. */
export function HelmDetail({ target, context, ssoProfile, live, namespace, name, kinds, tool, rules, onChange, onOpenObject, onClose, widthPct = DETAIL_PCT }: Props) {
  const [tab, setTab] = useState<Tab>("summary");
  const [viewing, setViewing] = useState<number | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [revision, setRevision] = useState("");
  const [keepHistory, setKeepHistory] = useState(false);
  const q = useHelmRelease(target, context, namespace, name, viewing, ssoProfile, live);
  const detail = q.data;

  // 다른 릴리스를 열면 처음으로
  useEffect(() => {
    setTab("summary");
    setViewing(null);
    setUpgrading(false);
    setRolling(false);
  }, [namespace, name]);

  const latest = detail !== undefined && detail.revision === detail.latest;
  const others = detail ? detail.history.filter((h) => h.revision !== detail.latest) : [];
  // 롤백에 쓸 리비전의 처음 값: 바로 앞 리비전
  useEffect(() => {
    if (rolling && !revision && others[0]) setRevision(String(others[0].revision));
  }, [rolling, revision, others]);

  const store = detail?.driver === "configMap" ? "configmaps" : "secrets";
  /** 불완전한 규칙은 서버 판단에 맡기고 확실히 거부된 것만 끈다 */
  const denied = (verb: string) => (rules && can(rules, { verb, group: "", resource: store }) === "no" ? t.DENIED(verb, store) : undefined);
  const blocked = tool === undefined ? t.TOOL_CHECKING : tool.available ? undefined : (tool.reason ?? t.TOOL_CHECKING);
  const reason = (verb: string) => blocked ?? (latest ? denied(verb) : t.NEED_LATEST);
  const write = reason("create");
  const remove = reason("delete");
  const rollbackReason = write ?? (others.length === 0 ? t.ACT_NO_OTHER_REVISION : undefined);

  const start = (change: { type: "helmRollback"; revision: number } | { type: "helmUninstall"; keepHistory: boolean }) =>
    onChange({ kind: HELM_RELEASE_KIND, namespace, name, ...change });

  return (
    <aside className="k8s-detail" aria-label={t.DETAIL_LABEL} style={{ width: `${widthPct}%` }}>
      <div className="k8s-detail-head">
        <b>Helm</b>
        <span className="mono k8s-wrap">{namespace}/{name}</span>
        {detail && <StatusBadge status={detail.status} />}
        <button className="icon k8s-push" aria-label={t.CLOSE} title={t.CLOSE} onClick={onClose}>
          ✕
        </button>
      </div>
      {detail && (
        <div className="k8s-actions k8s-toolbar">
          {rolling && (
            <>
              <label>
                {t.ACT_REVISION}{" "}
                <select value={revision} onChange={(e) => setRevision(e.target.value)}>
                  {others.map((h) => (
                    <option key={h.revision} value={h.revision}>{`${h.revision} — ${h.chart || h.status}`}</option>
                  ))}
                </select>
              </label>
              <button className="btn small tone-primary" disabled={!revision} onClick={() => {
                setRolling(false);
                start({ type: "helmRollback", revision: Number(revision) });
              }}>
                {t.ACT_PREVIEW}
              </button>
              <button className="btn small tone-ghost" onClick={() => setRolling(false)}>{t.ACT_CANCEL}</button>
            </>
          )}
          <label>
            <input type="checkbox" checked={keepHistory} onChange={(e) => setKeepHistory(e.target.checked)} /> {t.ACT_KEEP_HISTORY}
          </label>
          <button className="btn small tone-primary" disabled={!!write} title={write} aria-description={write} onClick={() => setUpgrading(true)}>
            {t.ACT_UPGRADE}
          </button>
          <button className="btn small tone-warn" disabled={!!rollbackReason} title={rollbackReason} aria-description={rollbackReason} onClick={() => setRolling(true)}>
            {t.ACT_ROLLBACK}
          </button>
          <button className="btn small tone-danger" disabled={!!remove} title={remove} aria-description={remove} onClick={() => start({ type: "helmUninstall", keepHistory })}>
            {t.ACT_UNINSTALL}
          </button>
        </div>
      )}
      {upgrading && detail && (
        <HelmUpgradeDialog
          detail={detail}
          onPreview={(change) => {
            setUpgrading(false);
            onChange(change);
          }}
          onClose={() => setUpgrading(false)}
        />
      )}
      {detail && !latest && (
        <p className="helm-banner" role="status">
          {t.VIEWING_OLD(detail.revision, detail.latest)}{" "}
          <button className="link" onClick={() => setViewing(null)}>{t.VIEW_LATEST}</button>
        </p>
      )}
      <div role="tablist" className="k8s-tabs">
        {([["summary", t.TAB_SUMMARY], ["values", t.TAB_VALUES], ["manifest", t.TAB_MANIFEST], ["history", t.TAB_HISTORY], ["notes", t.TAB_NOTES]] as [Tab, string][]).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      <div className="k8s-detail-body">
        {q.isError ? (
          <ErrorState error={q.error} profile={ssoProfile} compact onRetry={() => void q.refetch()} onLoggedIn={() => void q.refetch()} />
        ) : !detail ? (
          <div className="empty">{t.LOADING}</div>
        ) : tab === "summary" ? (
          <Summary detail={detail} kinds={kinds} onOpenObject={onOpenObject} />
        ) : tab === "values" ? (
          <Values detail={detail} canEdit={!write} onEdit={() => setUpgrading(true)} editReason={write} />
        ) : tab === "manifest" ? (
          <>
            <p className="dim">{t.MANIFEST_NOTE}</p>
            <YamlView text={detail.manifest} />
          </>
        ) : tab === "history" ? (
          <History detail={detail} viewing={detail.revision} writeReason={write} onView={setViewing} onRollback={(rev) => start({ type: "helmRollback", revision: rev })} />
        ) : detail.notes.trim() === "" ? (
          <p className="dim">{t.NOTES_EMPTY}</p>
        ) : (
          <pre className="helm-notes">{detail.notes}</pre>
        )}
      </div>
    </aside>
  );
}

function Summary({ detail, kinds, onOpenObject }: { detail: HelmReleaseDetail; kinds: K8sKind[]; onOpenObject: (ref: ObjectRef) => void }) {
  const chart = detail.chart;
  return (
    <div>
      {detail.status.startsWith("pending-") && <p className="err">{t.PENDING_NOTE}</p>}
      {detail.problem && detail.description && <p className="err">{detail.description}</p>}
      <section className="k8s-sect">
        <h4>{t.SEC_INFO}</h4>
        <dl className="kv">
          <Row label={t.LBL_NAMESPACE}>{detail.namespace}</Row>
          <Row label={t.LBL_STATUS}><StatusBadge status={detail.status} /></Row>
          <Row label={t.LBL_REVISION}>{detail.revision === detail.latest ? `${detail.revision}` : `${detail.revision} / ${detail.latest}`}</Row>
          <Row label={t.LBL_FIRST_DEPLOYED}>{formatDateTime(detail.firstDeployed)}</Row>
          <Row label={t.LBL_LAST_DEPLOYED}>{formatDateTime(detail.lastDeployed)}</Row>
          <Row label={t.LBL_DESCRIPTION}>{detail.description}</Row>
          <Row label={t.LBL_STORE}>{detail.driver === "configMap" ? t.STORE_CONFIGMAP : t.STORE_SECRET}</Row>
        </dl>
      </section>
      <section className="k8s-sect">
        <h4>{t.SEC_CHART}</h4>
        <dl className="kv">
          <Row label={t.LBL_CHART}>{`${chart.name}-${chart.version}`}</Row>
          <Row label={t.LBL_APP_VERSION}>{chart.appVersion}</Row>
          {chart.description && <Row label={t.LBL_DESCRIPTION}>{chart.description}</Row>}
          {chart.home && <Row label={t.LBL_HOME}>{chart.home}</Row>}
          {chart.kubeVersion && <Row label={t.LBL_KUBE_VERSION}>{chart.kubeVersion}</Row>}
        </dl>
        {chart.deprecated && <p className="err">{t.LBL_DEPRECATED}</p>}
      </section>
      {chart.dependencies.length > 0 && (
        <section className="k8s-sect">
          <h4>{t.SEC_DEPENDENCIES}</h4>
          <ul className="k8s-links">
            {chart.dependencies.map((d) => (
              <li key={d.name} className="mono">{`${d.name} ${d.version}`}{d.repository ? ` · ${d.repository}` : ""}</li>
            ))}
          </ul>
        </section>
      )}
      <section className="k8s-sect">
        <h4>{t.SEC_RESOURCES}</h4>
        {detail.resources.length === 0 ? (
          <p className="dim">{t.NO_RESOURCES}</p>
        ) : (
          <table className="k8s-table">
            <thead>
              <tr><th>{t.COL_KIND}</th><th>{t.COL_RESOURCE_NAME}</th><th>{t.COL_NAMESPACE}</th></tr>
            </thead>
            <tbody>
              {detail.resources.map((r, i) => {
                const ref = resolveResource(r, detail.namespace, kinds);
                return (
                  <tr key={`${r.apiVersion}/${r.kind}/${r.namespace}/${r.name}/${i}`}>
                    <td>{r.kind}</td>
                    <td className="mono k8s-wrap">
                      {ref ? (
                        <button className="link mono" title={t.OPEN_OBJECT} aria-label={`${t.OPEN_OBJECT}: ${r.kind}/${r.name}`} onClick={() => onOpenObject(ref)}>
                          {r.name}
                        </button>
                      ) : (
                        <span title={t.NOT_OPENABLE}>{r.name}</span>
                      )}
                    </td>
                    <td>{ref ? (ref.namespace ?? "") : (r.namespace ?? "")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
      {detail.hooks.length > 0 && (
        <section className="k8s-sect">
          <h4>{t.SEC_HOOKS}</h4>
          <table className="k8s-table">
            <tbody>
              {detail.hooks.map((h) => (
                <tr key={`${h.kind}/${h.name}`}><td>{h.kind}</td><td className="mono">{h.name}</td><td>{t.HOOK_EVENTS(h.events)}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="k8s-kv">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Values({ detail, canEdit, onEdit, editReason }: { detail: HelmReleaseDetail; canEdit: boolean; onEdit: () => void; editReason: string | undefined }) {
  return (
    <div>
      <section className="k8s-sect">
        <h4>{t.VALUES_USER}</h4>
        <p className="dim">{t.VALUES_USER_NOTE}</p>
        {detail.userValues === "" ? <p className="dim">{t.VALUES_USER_EMPTY}</p> : <YamlView text={detail.userValues} />}
        <button className="btn small tone-primary" disabled={!canEdit} title={editReason} aria-description={editReason} onClick={onEdit}>
          {t.VALUES_EDIT}
        </button>
      </section>
      <section className="k8s-sect">
        <h4>{t.VALUES_COMPUTED}</h4>
        <p className="dim">{t.VALUES_COMPUTED_NOTE}</p>
        <YamlView text={detail.computedValues} />
      </section>
    </div>
  );
}

function History({ detail, viewing, writeReason, onView, onRollback }: {
  detail: HelmReleaseDetail; viewing: number; writeReason: string | undefined; onView: (revision: number | null) => void; onRollback: (revision: number) => void;
}) {
  return (
    <table className="k8s-table helm-history" aria-label={t.TAB_HISTORY}>
      <thead>
        <tr>
          <th>{t.HISTORY_COL_REVISION}</th><th>{t.HISTORY_COL_STATUS}</th><th>{t.HISTORY_COL_UPDATED}</th><th>{t.HISTORY_COL_CHART}</th>
          <th>{t.HISTORY_COL_APP}</th><th>{t.HISTORY_COL_DESCRIPTION}</th><th />
        </tr>
      </thead>
      <tbody>
        {detail.history.map((h) => (
          <tr key={h.revision} className={h.revision === viewing ? "current" : undefined} data-viewing={h.revision === viewing ? "true" : undefined}>
            <td>{h.revision}{h.revision === detail.latest ? ` (${t.HISTORY_CURRENT})` : ""}</td>
            <td><StatusBadge status={h.status} /></td>
            <td>{h.unreadable ? t.HISTORY_UNREADABLE : formatDateTime(h.updated)}</td>
            <td className="mono">{h.chart}</td>
            <td>{h.appVersion}</td>
            <td className="k8s-wrap">{h.description}</td>
            <td className="helm-history-actions">
              {h.revision === viewing ? (
                <span className="dim">{t.HISTORY_SHOWING}</span>
              ) : (
                <button className="btn small tone-secondary" disabled={h.unreadable} onClick={() => onView(h.revision === detail.latest ? null : h.revision)}>
                  {t.HISTORY_VIEW}
                </button>
              )}
              {h.revision !== detail.latest && detail.revision === detail.latest && (
                <button className="btn small tone-warn" disabled={!!writeReason} title={writeReason} aria-description={writeReason} onClick={() => onRollback(h.revision)}>
                  {t.HISTORY_ROLLBACK}
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
