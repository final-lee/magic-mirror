import { DETAIL_PCT } from "../lanes";
import { useK8sRules } from "../queries";
import type { K8sChange, K8sTarget, ObjectRef } from "../types";
import { fixBlock, fixChange, targetLabel, targetLinks } from "./logic";
import { SeverityChip } from "./SeverityChip";
import {
  AWS_TARGET_NOTE, CATEGORY_LABELS, CHECK_BY_ID, CLOSE, DETAIL_LABEL, FIX_BUTTON, FIX_BUTTON_TITLE, FIX_NOTE, H_CATEGORY, H_NAMESPACE, H_SEVERITY_DETAIL, H_TARGET,
  NO_FIX, OPEN_ACCESS, OPEN_IAM, OPEN_OBJECT, OPEN_SERVICE_ACCOUNT, SEC_EVIDENCE, SEC_FIX, SEC_REMEDY, SEC_SUMMARY, SEC_WHY,
} from "./text";
import type { Finding } from "./types";

interface Props {
  finding: Finding;
  target: K8sTarget;
  context: string;
  ssoProfile: string;
  live: boolean;
  widthPct?: number;
  onClose: () => void;
  /** 고치기: 기존 변경 미리보기를 시작한다 */
  onChange: (change: K8sChange) => void;
  onOpenObject: (ref: ObjectRef) => void;
  /** IAM 작업 공간에서 ARN을 연다. 없으면 단추를 그리지 않는다 */
  onOpenIam?: (arn: string) => void;
  onOpenAccess: () => void;
}

/** 문제 하나의 상세: 증거, 왜 중요한지, 해결 방법. 위쪽 오른쪽 도구 모음에 대상으로 가는 단추와 자동 고치기를 둔다. */
export function FindingDetail({ finding, target, context, ssoProfile, live, widthPct = DETAIL_PCT, onClose, onChange, onOpenObject, onOpenIam, onOpenAccess }: Props) {
  const info = CHECK_BY_ID[finding.check];
  const fix = finding.fix;
  const rules = useK8sRules(target, context, fix?.namespace ?? null, ssoProfile, live && fix !== null);
  const blocked = fix ? fixBlock(fix, rules.data) : undefined;
  const links = targetLinks(finding);
  return (
    <aside className="k8s-detail" aria-label={DETAIL_LABEL} style={{ width: `${widthPct}%` }}>
      <div className="k8s-detail-head">
        <SeverityChip severity={finding.severity} />
        <b>{info.title}</b>
        <span className="mono k8s-wrap">{targetLabel(finding.target)}</span>
        <button className="icon k8s-push tone-ghost" aria-label={CLOSE} title={CLOSE} onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="k8s-actions k8s-toolbar">
        {links.map((link) => {
          if (link.type === "object") {
            return (
              <button key="object" className="btn tone-nav" onClick={() => onOpenObject(link.ref)}>
                {link.label === "serviceAccount" ? OPEN_SERVICE_ACCOUNT : OPEN_OBJECT}
              </button>
            );
          }
          if (link.type === "iam") {
            return onOpenIam ? (
              <button key="iam" className="btn tone-nav" onClick={() => onOpenIam(link.arn)}>
                {OPEN_IAM}
              </button>
            ) : null;
          }
          return (
            <button key="access" className="btn tone-nav" onClick={onOpenAccess}>
              {OPEN_ACCESS}
            </button>
          );
        })}
        {fix && (
          <button className="btn tone-primary" disabled={!!blocked} title={blocked ?? FIX_BUTTON_TITLE} aria-description={blocked ?? FIX_BUTTON_TITLE} onClick={() => onChange(fixChange(fix))}>
            {FIX_BUTTON}
          </button>
        )}
      </div>
      <div className="k8s-detail-body">
        <section className="k8s-sect" aria-label={SEC_SUMMARY}>
          <h4>{SEC_SUMMARY}</h4>
          <p className="sec-message">{finding.message}</p>
          <dl className="kv">
            <dt>{H_SEVERITY_DETAIL}</dt>
            <dd>
              <SeverityChip severity={finding.severity} />
            </dd>
            <dt>{H_CATEGORY}</dt>
            <dd>{CATEGORY_LABELS[info.category]}</dd>
            <dt>{H_TARGET}</dt>
            <dd className="mono k8s-wrap">{targetLabel(finding.target)}</dd>
            {finding.namespace && (
              <>
                <dt>{H_NAMESPACE}</dt>
                <dd className="mono">{finding.namespace}</dd>
              </>
            )}
          </dl>
          {finding.target.type === "aws" && <p className="dim">{AWS_TARGET_NOTE}</p>}
        </section>
        <section className="k8s-sect" aria-label={SEC_EVIDENCE}>
          <h4>{SEC_EVIDENCE}</h4>
          <ul className="sec-evidence">
            {finding.evidence.map((line, i) => (
              <li key={i} className="mono k8s-wrap">
                {line}
              </li>
            ))}
          </ul>
        </section>
        <section className="k8s-sect" aria-label={SEC_WHY}>
          <h4>{SEC_WHY}</h4>
          <p>{info.why}</p>
        </section>
        <section className="k8s-sect" aria-label={SEC_REMEDY}>
          <h4>{SEC_REMEDY}</h4>
          <p>{info.remedy}</p>
        </section>
        <section className="k8s-sect" aria-label={SEC_FIX}>
          <h4>{SEC_FIX}</h4>
          {fix ? (
            <>
              <p>{fix.summary}</p>
              {fix.caution && <p className="sec-caution">{fix.caution}</p>}
              <p className="dim">{FIX_NOTE}</p>
              {blocked && <p className="err">{blocked}</p>}
            </>
          ) : (
            <p className="dim">{NO_FIX}</p>
          )}
        </section>
      </div>
    </aside>
  );
}
