import type { ReactNode } from "react";
import { errorMessage } from "../api/errors";
import { desktop } from "../api/desktop";
import { useSettings } from "../api/queries";
import { ErrorState } from "../components/ErrorState";
import type { IamRoute } from "../iam/route";
import * as t from "./accessText";
import { useSnsPublicAccessCheck, useSnsTopicPolicy } from "./queries";
import { FindingsList } from "./SnsFindings";
import type { SnsTopicRef } from "./targets";
import type { SnsFinding, SnsPublicAccessReport } from "./types";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="sns-section" aria-label={title}>
      <h4 className="sns-heading">{title}</h4>
      {children}
    </section>
  );
}

/** 점검 목록: 정책 화면의 점검에, 유료 검사가 FAIL이면 그 결과를 더한다(이미 같은 점검이 있으면 그대로 둔다) */
function merge(findings: SnsFinding[], report: SnsPublicAccessReport | undefined): SnsFinding[] {
  if (!report?.finding || findings.some((f) => f.check === report.finding!.check)) return findings;
  return [report.finding, ...findings].sort(t.byLevel);
}

interface Props {
  target: SnsTopicRef;
  /** IAM 탭을 연다. route가 있으면 그 화면으로 간다(누가 할 수 있나 검색을 채워서) */
  onOpenIam?: (focus: string | null, route?: IamRoute) => void;
}

/**
 * 정책·점검: 점검 목록, 정책 문장(범위 배지), Access Analyzer 검증, 유료 공개 접근 검사 버튼,
 * 누가 발행·구독할 수 있나(정책 쪽 주체 + IAM의 '누가 할 수 있나'로 가는 단추).
 */
export function Policy({ target, onOpenIam }: Props) {
  const q = useSnsTopicPolicy(target);
  const check = useSnsPublicAccessCheck(target);
  const { settings } = useSettings();
  const policy = q.data;
  if (!policy) {
    return (
      <section className="center sns-pane" aria-label={t.POLICY_LABEL}>
        {q.isError ? <ErrorState error={q.error} profile={target.profile} onRetry={() => void q.refetch()} /> : <div className="empty">{t.POLICY_LOADING}</div>}
      </section>
    );
  }
  const disabled = settings?.snsChecks?.disabled ?? [];
  const all = merge(policy.findings, check.data);
  const shown = t.enabledOnly(all, disabled);
  const hidden = all.length - shown.length;
  const jump = (action: string) => onOpenIam?.(null, { view: "whoCan", search: { action, resource: target.topicArn } });

  return (
    <section className="center sns-pane" aria-label={t.POLICY_LABEL}>
      <Section title={t.SECTION_FINDINGS}>
        <FindingsList findings={shown} />
        {hidden > 0 && <p className="sns-note dim">{t.FINDINGS_HIDDEN(hidden)}</p>}
      </Section>

      <Section title={t.SECTION_STATEMENTS}>
        {policy.statementsError && <p className="sns-note sns-error">{t.STATEMENTS_ERROR(policy.statementsError)}</p>}
        {!policy.statementsError && policy.statements.length === 0 && <p className="sns-note dim">{t.NO_POLICY}</p>}
        <ul className="sns-statements" aria-label={t.SECTION_STATEMENTS}>
          {policy.statements.map((s) => (
            <li key={s.index} className="sns-statement">
              <span className={`sns-reach ${s.scope}`} title={t.REACH_LABEL[s.scope]}>
                {t.REACH_LABEL[s.scope]}
              </span>
              {s.effect === "Deny" && <span className="sns-reach deny">{t.DENY}</span>}
              <span>{s.sentence}</span>
              {s.sid && <span className="dim mono sns-where">{s.sid}</span>}
            </li>
          ))}
        </ul>
      </Section>

      <Section title={t.SECTION_VALIDATION}>
        <p className="sns-note dim">{t.VALIDATION_NOTE}</p>
        {policy.validation === null ? (
          <p className="sns-note dim">{t.VALIDATION_UNAVAILABLE}</p>
        ) : policy.validation.length === 0 ? (
          <p className="sns-note dim">{t.VALIDATION_NONE}</p>
        ) : (
          <ul className="sns-findings" aria-label={t.SECTION_VALIDATION}>
            {policy.validation.map((f, i) => (
              <li key={`${f.code}-${i}`} className="sns-finding">
                <div className="sns-finding-head">
                  <span className={`sns-level ${f.level}`}>{t.VALIDATION_LABEL[f.level]}</span>
                  <span className="mono dim">{f.code}</span>
                  <span>{f.message}</span>
                  {f.learnMore && (
                    <button type="button" className="link" onClick={() => void desktop.openUrl(f.learnMore!)}>
                      {t.LEARN_MORE}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t.SECTION_PUBLIC}>
        <p className="sns-note dim">{t.PUBLIC_NOTE}</p>
        <button
          type="button"
          className="btn small tone-refresh"
          title={t.PUBLIC_COST}
          disabled={check.isPending}
          onClick={() => check.mutate()}
        >
          {check.isPending ? t.PUBLIC_RUNNING : `${t.PUBLIC_RUN} ($0.002)`}
        </button>
        {check.data && (
          <div className="sns-note" role="status">
            <b className={check.data.result === "fail" ? "sns-error" : undefined}>{t.PUBLIC_RESULT[check.data.result]}</b>
            {check.data.message && <span className="dim"> · {check.data.message}</span>}
            {check.data.reasons.length > 0 && (
              <ul className="sns-finding-items mono">
                {check.data.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {check.isError && (
          <p className="sns-note sns-error" role="alert">
            {errorMessage(check.error)}
          </p>
        )}
      </Section>

      <Section title={t.SECTION_WHO}>
        <p className="sns-note dim">{t.WHO_NOTE}</p>
        {policy.access.length === 0 ? (
          <p className="sns-note dim">{t.WHO_EMPTY}</p>
        ) : (
          <table className="sns-table" aria-label={t.SECTION_WHO}>
            <thead>
              <tr>
                {Object.values(t.WHO_COLS).map((c) => (
                  <th key={c} scope="col" className="nosort">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {policy.access.map((row, i) => (
                <tr key={`${row.statement}-${row.principal.value}-${i}`}>
                  <td>
                    <span className={`sns-reach ${row.scope}`}>{t.REACH_LABEL[row.scope]}</span> {t.principalLabel(row.principal)}
                  </td>
                  <td className="sns-nowrap">{row.canPublish ? (row.effect === "Deny" ? t.WHO_DENIED : t.WHO_ALLOWED) : <span className="dim">–</span>}</td>
                  <td className="sns-nowrap">{row.canSubscribe ? (row.effect === "Deny" ? t.WHO_DENIED : t.WHO_ALLOWED) : <span className="dim">–</span>}</td>
                  <td className={row.conditions.length ? "mono" : "dim"}>{row.conditions.length ? row.conditions.join(" · ") : t.NO_CONDITIONS}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {onOpenIam && (
          <div className="sns-pane-head">
            <button type="button" className="btn small tone-nav" title={t.IAM_TITLE} onClick={() => jump("sns:Publish")}>
              {t.IAM_PUBLISH}
            </button>
            <button type="button" className="btn small tone-nav" title={t.IAM_TITLE} onClick={() => jump("sns:Subscribe")}>
              {t.IAM_SUBSCRIBE}
            </button>
          </div>
        )}
      </Section>
    </section>
  );
}
