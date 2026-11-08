import { useEffect, useState } from "react";
import { errorMessage } from "../api/errors";
import * as at from "./accessText";
import { snsApi } from "./api";
import * as t from "./editText";
import { recentSamples, sampleLabel } from "./samples";
import type { FilterResult, FilterSample, SnsFilterScope, SnsPlan, SnsPolicyFinding, SnsPublicAccessReport } from "./types";

type Verdict = keyof typeof t.VERDICT;

/** 한 정책에 대한 표본 판정. 정책이 없으면 모두 받는다 */
export function verdictOf(policy: string | null, result: FilterResult | undefined): Verdict {
  if (policy === null) return "none";
  if (!result?.verdict) return "unknown";
  return result.verdict.matched ? "accept" : "reject";
}

/** 계획의 바뀌는 값에서 필터 정책·범위의 지금 값과 바꾼 뒤 값. 바뀌지 않는 값은 `current`로 채운다 */
export function filterStates(plan: SnsPlan, current: { policy: string | null; scope: SnsFilterScope }) {
  const changed = (name: string) => plan.fields.find((f) => f.field === name);
  const policy = changed("filterPolicy");
  const scope = changed("filterPolicyScope");
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  const scopeOf = (value: unknown, fallback: SnsFilterScope): SnsFilterScope => (value === "MessageBody" || value === "MessageAttributes" ? value : fallback);
  return {
    before: { policy: policy ? text(policy.before) : current.policy, scope: scope ? scopeOf(scope.before, current.scope) : current.scope },
    after: { policy: policy ? text(policy.after) : current.policy, scope: scope ? scopeOf(scope.after, current.scope) : current.scope },
  };
}

interface FilterImpactProps {
  plan: SnsPlan;
  tabId: string;
  /** 이 구독의 지금 필터 정책 글(없으면 null)과 범위 */
  current: { policy: string | null; scope: SnsFilterScope };
}

/**
 * 필터 정책 변경 미리보기에 붙는 표: 필터 시험 화면의 최근 표본(탭 메모리)을 지금 정책과 바꾼 뒤 정책으로 판정한 결과.
 * 판정은 앱이 문서대로 계산한 값이다(sns_filter_test).
 */
export function FilterImpact({ plan, tabId, current }: FilterImpactProps) {
  const samples = recentSamples(tabId);
  const [rows, setRows] = useState<{ sample: FilterSample; before: Verdict; after: Verdict }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { before, after } = filterStates(plan, current);

  useEffect(() => {
    let live = true;
    setRows(null);
    setError(null);
    if (samples.length === 0) return;
    void Promise.all(
      samples.map((sample) =>
        snsApi.filterTest(
          [
            { key: "before", policy: before.policy, scope: before.scope },
            { key: "after", policy: after.policy, scope: after.scope },
          ],
          sample,
        ),
      ),
    )
      .then((all) => {
        if (live) setRows(samples.map((sample, i) => ({ sample, before: verdictOf(before.policy, all[i].find((r) => r.key === "before")), after: verdictOf(after.policy, all[i].find((r) => r.key === "after")) })));
      })
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
    // 계획이 바뀔 때(미리보기 다시 받기)만 다시 판정한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan.fingerprint]);

  return (
    <section className="sns-extra" aria-label={t.FILTER_IMPACT}>
      <h4>{t.FILTER_IMPACT}</h4>
      {samples.length === 0 ? (
        <p className="cp-none dim">{t.FILTER_IMPACT_NONE}</p>
      ) : error ? (
        <p className="sns-note sns-error" role="alert">
          {`${t.FILTER_IMPACT_FAILED}: ${error}`}
        </p>
      ) : !rows ? (
        <p className="dim" role="status">
          {t.FILTER_IMPACT_LOADING}
        </p>
      ) : (
        <table className="sns-table" aria-label={t.FILTER_IMPACT}>
          <thead>
            <tr>
              <th scope="col" className="nosort">{t.FILTER_IMPACT_COLS.sample}</th>
              <th scope="col" className="nosort">{t.FILTER_IMPACT_COLS.before}</th>
              <th scope="col" className="nosort">{t.FILTER_IMPACT_COLS.after}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={r.before !== r.after ? "sns-verdict-changed" : undefined}>
                <td className="mono">{sampleLabel(r.sample)}</td>
                <td>{t.VERDICT[r.before]}</td>
                <td>
                  {t.VERDICT[r.after]}
                  {r.before !== r.after && <span className="sns-changed"> · {t.VERDICT_CHANGED}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

interface PolicyChecksProps {
  profile: string;
  region: string;
  topicArn: string;
  plan: SnsPlan;
}

/** 주제 정책 저장 미리보기에 붙는 것: 저장할 문서의 무료 ValidatePolicy 지적과 유료(호출당 $0.002) CheckNoPublicAccess 버튼 */
export function PolicyChecks({ profile, region, topicArn, plan }: PolicyChecksProps) {
  const field = plan.fields.find((f) => f.field === "topicPolicy");
  const document = field && typeof field.after === "string" ? field.after : null;
  const [findings, setFindings] = useState<SnsPolicyFinding[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [report, setReport] = useState<SnsPublicAccessReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setFindings(null);
    setFailed(false);
    setReport(null);
    if (document === null) return;
    snsApi
      .validatePolicy(profile, region, document)
      .then((f) => live && setFindings(f))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [profile, region, document]);

  if (document === null) return null;
  const run = () => {
    setRunning(true);
    setError(null);
    snsApi
      .checkPolicyDocument(profile, region, topicArn, document)
      .then(setReport)
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setRunning(false));
  };

  return (
    <section className="sns-extra" aria-label={t.POLICY_CHECK}>
      <h4>{t.POLICY_CHECK}</h4>
      <p className="sns-note dim">{at.VALIDATION_NOTE}</p>
      {failed ? (
        <p className="sns-note dim">{at.VALIDATION_UNAVAILABLE}</p>
      ) : !findings ? (
        <p className="dim" role="status">
          {t.POLICY_CHECK_LOADING}
        </p>
      ) : findings.length === 0 ? (
        <p className="sns-note dim">{at.VALIDATION_NONE}</p>
      ) : (
        <ul className="sns-findings" aria-label={at.SECTION_VALIDATION}>
          {findings.map((f, i) => (
            <li key={`${f.code}-${i}`} className="sns-finding">
              <div className="sns-finding-head">
                <span className={`sns-level ${f.level}`}>{at.VALIDATION_LABEL[f.level]}</span>
                <span className="mono dim">{f.code}</span>
                <span>{f.message}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="sns-note dim">{at.PUBLIC_NOTE}</p>
      <button type="button" className="btn small tone-refresh" title={at.PUBLIC_COST} disabled={running} onClick={run}>
        {running ? at.PUBLIC_RUNNING : `${at.PUBLIC_RUN} ($0.002)`}
      </button>
      {report && (
        <div className="sns-note" role="status">
          <b className={report.result === "fail" ? "sns-error" : undefined}>{at.PUBLIC_RESULT[report.result]}</b>
          {report.message && <span className="dim"> · {report.message}</span>}
          {report.reasons.length > 0 && (
            <ul className="sns-finding-items mono">
              {report.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && (
        <p className="sns-note sns-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
