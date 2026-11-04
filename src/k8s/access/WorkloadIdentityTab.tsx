import { useRef, useState } from "react";
import { ErrorState } from "../../components/ErrorState";
import { ListFind, useListFind } from "../../components/ListFind";
import { vimTableKeys } from "../../iam/ListTable";
import { K8sError } from "../K8sError";
import { DETAIL_PCT } from "../lanes";
import type { K8sTarget } from "../types";
import { useWorkloadIdentity } from "./queries";
import {
  ASSOCIATION, CLOSE, EKS_SECTIONS, H_IRSA, H_PODS, H_POD_IDENTITY, H_SA, H_STATUS, IRSA_AUDIENCE, LOADING, MISSING_SA, NOTES_TITLE, NO_WORKLOADS, OIDC_ISSUER, ONLY_BROKEN, OPEN_IAM,
  PODS_TITLE, REASONS_TITLE, SECTION_LABELS, STATUS_BROKEN, STATUS_UNKNOWN, STATUS_WORKS, TARGET_ROLE, WORKLOAD_DETAIL_LABEL, WORKLOAD_FILTER, WORKLOAD_LABEL, WORKLOAD_TRUNCATED,
  gapText, podsMore,
} from "./text";
import type { Check, WorkloadIdentity } from "./types";

interface Props {
  target: K8sTarget;
  context: string | null;
  ssoProfile: string;
  live: boolean;
  /** 역할 ARN을 IAM 작업 공간에서 연다 */
  onOpenIam?: (arn: string) => void;
}

const roleName = (arn: string) => arn.split("/").pop() ?? arn;
const key = (w: WorkloadIdentity) => `${w.namespace}/${w.serviceAccount}`;
const checks = (w: WorkloadIdentity): Check[] => [w.irsa?.check, w.podIdentity?.check].filter((c): c is Check => c !== undefined);
const isBroken = (w: WorkloadIdentity) => checks(w).some((c) => c.kind === "broken");

function Status({ check }: { check: Check }) {
  const reason = check.kind === "broken" ? check.reasons.join(" · ") : check.kind === "unknown" ? check.message : undefined;
  const label = check.kind === "works" ? STATUS_WORKS : check.kind === "broken" ? STATUS_BROKEN : STATUS_UNKNOWN;
  return (
    <span className={`acc-badge ${check.kind === "works" ? "ok" : check.kind === "broken" ? "bad" : "warn"}`} title={reason}>
      {label}
    </span>
  );
}

function RoleLink({ arn, onOpenIam }: { arn: string; onOpenIam?: (arn: string) => void }) {
  if (!onOpenIam) return <span className="mono">{roleName(arn)}</span>;
  return (
    <button className="link mono" title={`${OPEN_IAM}: ${arn}`} onClick={(e) => {
      e.stopPropagation();
      onOpenIam(arn);
    }}>
      {roleName(arn)}
    </button>
  );
}

/** ServiceAccount의 IRSA·Pod Identity 연결과 쓰는 Pod. 역할의 신뢰 정책을 확인한 결과를 보인다. */
export function WorkloadIdentityTab({ target, context, ssoProfile, live, onOpenIam }: Props) {
  const q = useWorkloadIdentity(target, context, ssoProfile, live);
  // ⌘F: 이 표(과 열린 상세) 안에서만 찾는다. 평소에는 찾기 줄이 없다
  const tab = useRef<HTMLDivElement>(null);
  const find = useListFind(tab, { enabled: q.data !== undefined });
  const [onlyBroken, setOnlyBroken] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  if (q.isError) return <K8sError error={q.error} target={target} ssoProfile={ssoProfile} />;
  if (!q.data) return <div className="empty">{LOADING}</div>;
  const v = q.data;
  const needle = find.query.trim().toLowerCase();
  const rows = v.items.filter(
    (w) =>
      (!onlyBroken || isBroken(w)) &&
      (needle === "" || [key(w), w.irsa?.roleArn, w.podIdentity?.roleArn].some((s) => s?.toLowerCase().includes(needle))),
  );
  const chosen = v.items.find((w) => key(w) === selected);
  return (
    <div className="acc-workload" ref={tab}>
      <ListFind find={find} placeholder={WORKLOAD_FILTER} count={rows.length} />
      {v.gaps.map((g, i) => (
        <div key={`${g.section}-${i}`} className="k8s-gap">
          <p className="dim">{gapText(SECTION_LABELS[g.section])}</p>
          <ErrorState error={g.error} profile={EKS_SECTIONS.has(g.section) ? target.profile : ssoProfile} compact onRetry={() => void q.refetch()} onLoggedIn={() => void q.refetch()} />
        </div>
      ))}
      {v.truncated && <p className="dim">{WORKLOAD_TRUNCATED}</p>}
      <div className="acc-bar">
        <label className="acc-check">
          <input type="checkbox" checked={onlyBroken} onChange={(e) => setOnlyBroken(e.target.checked)} />
          {ONLY_BROKEN}
        </label>
        {v.oidcIssuer && (
          <span className="dim acc-push">
            {OIDC_ISSUER}: <span className="mono">{v.oidcIssuer}</span>
          </span>
        )}
      </div>
      <div className="tbl acc-table" tabIndex={0} onKeyDown={(e) => vimTableKeys(e, true)} onClick={(e) => {
        if (!(e.target as Element).closest("thead, tbody tr")) setSelected(null);
      }}>
        <table aria-label={WORKLOAD_LABEL}>
          <thead>
            <tr>
              <th>{H_SA}</th>
              <th>{H_IRSA}</th>
              <th>{H_POD_IDENTITY}</th>
              <th>{H_PODS}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((w) => (
              <tr key={key(w)} className={selected === key(w) ? "on" : undefined} aria-selected={selected === key(w)} onClick={() => setSelected((s) => (s === key(w) ? null : key(w)))}>
                <td>
                  <span className="mono">{key(w)}</span>
                  {!w.exists && <span className="acc-badge warn">{MISSING_SA}</span>}
                </td>
                <td>
                  {w.irsa ? (
                    <>
                      <RoleLink arn={w.irsa.roleArn} onOpenIam={onOpenIam} /> <Status check={w.irsa.check} />
                    </>
                  ) : (
                    <span className="dim">-</span>
                  )}
                </td>
                <td>
                  {w.podIdentity ? (
                    <>
                      <RoleLink arn={w.podIdentity.roleArn} onOpenIam={onOpenIam} /> <Status check={w.podIdentity.check} />
                    </>
                  ) : (
                    <span className="dim">-</span>
                  )}
                </td>
                <td>{w.podCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="empty small">{NO_WORKLOADS}</div>}
      </div>
      {chosen && (
        <aside className="k8s-detail" aria-label={WORKLOAD_DETAIL_LABEL} style={{ width: `${DETAIL_PCT}%` }}>
          <div className="k8s-detail-head">
            <b>{H_SA}</b>
            <span className="mono k8s-wrap">{key(chosen)}</span>
            <button className="icon k8s-push" aria-label={CLOSE} title={CLOSE} onClick={() => setSelected(null)}>
              ✕
            </button>
          </div>
          <div className="k8s-detail-body">
            {chosen.irsa && (
              <section className="k8s-sect" aria-label={H_IRSA}>
                <h4>{H_IRSA}</h4>
                <p>
                  <RoleLink arn={chosen.irsa.roleArn} onOpenIam={onOpenIam} /> <Status check={chosen.irsa.check} />
                </p>
                <p className="dim mono k8s-wrap">{chosen.irsa.roleArn}</p>
                <p className="dim">{IRSA_AUDIENCE}: <span className="mono">{chosen.irsa.audience}</span></p>
                <Reasons check={chosen.irsa.check} />
              </section>
            )}
            {chosen.podIdentity && (
              <section className="k8s-sect" aria-label={H_POD_IDENTITY}>
                <h4>{H_POD_IDENTITY}</h4>
                <p>
                  <RoleLink arn={chosen.podIdentity.roleArn} onOpenIam={onOpenIam} /> <Status check={chosen.podIdentity.check} />
                </p>
                <p className="dim mono k8s-wrap">{chosen.podIdentity.roleArn}</p>
                {chosen.podIdentity.targetRoleArn && (
                  <p className="dim">
                    {TARGET_ROLE}: <RoleLink arn={chosen.podIdentity.targetRoleArn} onOpenIam={onOpenIam} />
                  </p>
                )}
                <p className="dim">{ASSOCIATION}: <span className="mono">{chosen.podIdentity.associationId}</span></p>
                <Reasons check={chosen.podIdentity.check} />
              </section>
            )}
            {chosen.notes.length > 0 && (
              <section className="k8s-sect" aria-label={NOTES_TITLE}>
                <h4>{NOTES_TITLE}</h4>
                <ul>
                  {chosen.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </section>
            )}
            <section className="k8s-sect" aria-label={PODS_TITLE}>
              <h4>{PODS_TITLE}</h4>
              {chosen.podCount > chosen.pods.length && <p className="dim">{podsMore(chosen.pods.length, chosen.podCount)}</p>}
              <ul className="mono">
                {chosen.pods.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </section>
          </div>
        </aside>
      )}
    </div>
  );
}

function Reasons({ check }: { check: Check }) {
  if (check.kind === "works") return null;
  const lines = check.kind === "broken" ? check.reasons : [check.message];
  return (
    <>
      <h5 className="acc-h">{REASONS_TITLE}</h5>
      <ul>
        {lines.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </>
  );
}
