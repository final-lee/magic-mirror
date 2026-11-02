import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { isAppError } from "../api/errors";
import { ErrorState } from "../components/ErrorState";
import { BreakdownTable } from "./BreakdownTable";
import { DailyChart } from "./DailyChart";
import { canDrill, drill, filtersOf, ROOT, up, type DrillState } from "./drill";
import { dataAge, formatMoney } from "./format";
import { refreshCost, useCostBreakdown, useCostOverview, useCostTagKeys, useCostUsage } from "./queries";
import { SummaryCards } from "./SummaryCards";
import {
  ACCOUNT_LABEL,
  BREADCRUMB_LABEL,
  COST_TITLE,
  CRUMB_ROOT,
  EXCLUDE_CREDITS,
  GROUP_LABEL,
  GROUP_SELECT,
  LOADING,
  MEMBER_BLOCKED_HINT,
  METRIC_HINT,
  METRIC_LABEL,
  METRIC_SELECT,
  NO_ACTIVE_TAGS,
  NO_DATA_YET,
  ORG_NOTE,
  PERIOD_GROUP,
  PERIOD_LABEL,
  PERIODS,
  PERMISSIONS_HINT,
  REFRESH,
  REQUEST_PRICE,
  SHOW_LAST_MONTH,
  TAG_KEY_SELECT,
  usageLine,
} from "./text";
import type { CostGroupBy, CostMetric, CostPeriod } from "./types";

interface Props {
  profile: string;
}

/** 권한 오류 아래에 필요한 권한과 조직에서 막혔을 가능성을 적는다 */
function DeniedHint({ error }: { error: unknown }) {
  if (!isAppError(error) || error.kind !== "accessDenied") return null;
  return (
    <div className="cost-hint">
      <div>{PERMISSIONS_HINT}</div>
      <div>{MEMBER_BLOCKED_HINT}</div>
    </div>
  );
}

/**
 * 💰 비용 탭: 지금 프로필 계정의 비용. 요약 카드, 추이, 분해 표, 요청 계수기.
 * Cost Explorer는 요청마다 돈이 들어서 조회는 모두 백엔드 캐시(6시간)를 거치고, 새로고침만 캐시를 건너뛴다.
 */
export function CostTab({ profile }: Props) {
  const qc = useQueryClient();
  const [period, setPeriod] = useState<CostPeriod>("thisMonth");
  const [metric, setMetric] = useState<CostMetric>("UnblendedCost");
  const [excludeCredits, setExcludeCredits] = useState(true);
  const [path, setPath] = useState<DrillState>(ROOT);

  const base = { period, metric, excludeCredits, filters: filtersOf(path) };
  const overview = useCostOverview(profile, base);
  const tagKeys = useCostTagKeys(profile, path.group.kind === "tag");
  // 태그를 고르고 키를 아직 안 골랐으면 첫 활성 태그 키로 본다
  const group: CostGroupBy = path.group.kind === "tag" && !path.group.key && tagKeys.data?.[0] ? { kind: "tag", key: tagKeys.data[0] } : path.group;
  const shown: DrillState = { ...path, group };
  const ready = group.kind !== "tag" || !!group.key;
  const o = overview.data;
  // 개요가 성공한 뒤에 부른다. 오류가 두 번 뜨지 않고, 이번 달 1일처럼 범위가 없으면 부르지 않는다
  const breakdown = useCostBreakdown(profile, { ...base, groupBy: group }, ready && !!o?.range);
  const usage = useCostUsage(profile);

  const fetchedAt = [o?.fetchedAt, breakdown.data?.fetchedAt].filter((t): t is string => !!t).sort()[0];
  const busy = overview.isFetching || breakdown.isFetching;

  const pickGroup = (kind: CostGroupBy["kind"]) => setPath((p) => ({ ...p, group: kind === "tag" ? { kind, key: tagKeys.data?.[0] ?? "" } : { kind } }));

  return (
    <div className="cost">
      <div className="iam-bar">
        <b>{COST_TITLE}</b>
        <span className="dim">{profile}</span>
        {o && (
          <span className="dim">
            {ACCOUNT_LABEL} <span className="mono">{o.accountId}</span>
          </span>
        )}
        <span className="iam-bar-end">
          {fetchedAt && (
            <span className="dim" title={new Date(fetchedAt).toLocaleString("ko-KR")}>
              {dataAge(fetchedAt)}
            </span>
          )}
          <button className="btn small" onClick={() => void refreshCost(qc, profile)} disabled={busy}>
            {busy ? LOADING : REFRESH}
          </button>
        </span>
      </div>
      <div className="iam-note">
        <span aria-hidden="true">ⓘ</span> {ORG_NOTE}
      </div>
      <div className="cost-controls">
        <div className="k8s-seg" role="group" aria-label={PERIOD_GROUP}>
          {PERIODS.map((p) => (
            <button key={p} aria-pressed={period === p} onClick={() => setPeriod(p)}>
              {PERIOD_LABEL[p]}
            </button>
          ))}
        </div>
        <label className="sel" title={METRIC_HINT[metric]}>
          <small>{METRIC_SELECT}</small>
          <select aria-label={METRIC_SELECT} value={metric} onChange={(e) => setMetric(e.target.value as CostMetric)}>
            {(Object.keys(METRIC_LABEL) as CostMetric[]).map((m) => (
              <option key={m} value={m}>
                {METRIC_LABEL[m]}
              </option>
            ))}
          </select>
        </label>
        <label className="cost-check">
          <input type="checkbox" checked={excludeCredits} onChange={(e) => setExcludeCredits(e.target.checked)} />
          {EXCLUDE_CREDITS}
        </label>
      </div>
      <div className="cost-main">
        {overview.isError ? (
          <div>
            <ErrorState error={overview.error} profile={profile} onRetry={() => void overview.refetch()} />
            <DeniedHint error={overview.error} />
          </div>
        ) : !o ? (
          <div className="empty">{LOADING}</div>
        ) : (
          <>
            <SummaryCards overview={o} period={period} />
            {!o.range ? (
              <div className="empty small">
                <div>
                  <p>{NO_DATA_YET}</p>
                  <button className="btn plain" onClick={() => setPeriod("lastMonth")}>
                    {SHOW_LAST_MONTH}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <section className="cost-section">
                  <DailyChart overview={o} />
                </section>
                <section className="cost-section">
                  <div className="cost-section-bar">
                    <nav className="iam-crumb" aria-label={BREADCRUMB_LABEL}>
                      {path.crumbs.length === 0 ? (
                        <b>{CRUMB_ROOT}</b>
                      ) : (
                        <>
                          {path.crumbs.map((c, i) => (
                            <span key={i} className="cost-crumb">
                              <button className="link crumb-link" onClick={() => setPath((p) => up(p, i))}>
                                {i === 0 ? CRUMB_ROOT : path.crumbs[i - 1].label}
                              </button>
                              <span aria-hidden="true">›</span>
                            </span>
                          ))}
                          <b>{path.crumbs[path.crumbs.length - 1].label}</b>
                        </>
                      )}
                    </nav>
                    <span className="iam-bar-end">
                      <label className="sel">
                        <small>{GROUP_SELECT}</small>
                        <select aria-label={GROUP_SELECT} value={group.kind} onChange={(e) => pickGroup(e.target.value as CostGroupBy["kind"])}>
                          {(Object.keys(GROUP_LABEL) as CostGroupBy["kind"][]).map((k) => (
                            <option key={k} value={k}>
                              {GROUP_LABEL[k]}
                            </option>
                          ))}
                        </select>
                      </label>
                      {group.kind === "tag" && !!tagKeys.data?.length && (
                        <label className="sel">
                          <small>{TAG_KEY_SELECT}</small>
                          <select aria-label={TAG_KEY_SELECT} value={group.key} onChange={(e) => setPath((p) => ({ ...p, group: { kind: "tag", key: e.target.value } }))}>
                            {tagKeys.data.map((k) => (
                              <option key={k} value={k}>
                                {k}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                    </span>
                  </div>
                  {group.kind === "tag" && tagKeys.isError ? (
                    <>
                      <ErrorState compact error={tagKeys.error} profile={profile} onRetry={() => void tagKeys.refetch()} />
                      <DeniedHint error={tagKeys.error} />
                    </>
                  ) : group.kind === "tag" && tagKeys.data?.length === 0 ? (
                    <div className="empty small">{NO_ACTIVE_TAGS}</div>
                  ) : breakdown.isError ? (
                    <>
                      <ErrorState compact error={breakdown.error} profile={profile} onRetry={() => void breakdown.refetch()} />
                      <DeniedHint error={breakdown.error} />
                    </>
                  ) : breakdown.data ? (
                    <BreakdownTable
                      breakdown={breakdown.data}
                      compare={!!o.compareRange}
                      drillable={canDrill(shown)}
                      onDrill={(row) => setPath(drill(shown, row))}
                    />
                  ) : (
                    <div className="empty small">{LOADING}</div>
                  )}
                </section>
              </>
            )}
          </>
        )}
      </div>
      {usage.data && <div className="status">{usageLine(usage.data.requests, formatMoney(usage.data.requests * REQUEST_PRICE, "USD"))}</div>}
    </div>
  );
}
