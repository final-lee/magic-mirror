import { useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "../api/errors";
import { useSettings } from "../api/queries";
import { ErrorState } from "../components/ErrorState";
import * as t from "./accessText";
import { Messaging } from "./Messaging";
import { refreshSnsAccount, useSnsAccountOverview } from "./queries";
import type { SnsRoute } from "./route";
import { FindingsList } from "./SnsFindings";
import type { SnsTopicRef } from "./targets";
import type { SnsAccountOverview, SnsFinding } from "./types";

interface Props {
  profile: string;
  region: string;
  /** 주제 탭을 연다. route가 있으면 그 화면으로 간다 */
  onOpenTopic: (ref: SnsTopicRef, route?: SnsRoute) => void;
}

const POLICY_ROUTE: SnsRoute = { view: "policy" };

/** `📣 SNS` 계정 탭: 주제 표(지난 24시간), 고아·대기 구독, 점검 모음(끄기), 계정 지표, SMS·푸시 */
export function AccountTab({ profile, region, onOpenTopic }: Props) {
  const qc = useQueryClient();
  const q = useSnsAccountOverview(profile, region);
  const { settings, update } = useSettings();
  const ov = q.data;
  const disabled = settings?.snsChecks?.disabled ?? [];
  const reread = () => void refreshSnsAccount(qc, profile, region);
  const open = (arn: string, name: string, route?: SnsRoute) => onOpenTopic({ profile, region, topicArn: arn, topicName: name }, route);
  const toggle = (id: string, on: boolean) => {
    const next = on ? disabled.filter((d) => d !== id) : [...new Set([...disabled, id])];
    update({ snsChecks: { disabled: next } });
  };

  return (
    <div className="sns-tab" aria-label={t.ACCOUNT_LABEL}>
      <div className="sns-top" role="group" aria-label={t.ACCOUNT_LABEL}>
        <b className="sns-ident-name">{t.ACCOUNT_TITLE}</b>
        <span className="dim">{ov ? t.ACCOUNT_HEAD(ov.account, ov.region) : region}</span>
        <span className="sns-top-end">
          <button className="btn small tone-refresh" onClick={reread} disabled={q.isFetching}>
            {q.isFetching ? t.READING : t.REREAD}
          </button>
        </span>
      </div>
      <div className="sns-main">
        <section className="center sns-pane" aria-label={t.ACCOUNT_LABEL}>
          {!ov ? (
            q.isError ? <ErrorState error={q.error} profile={profile} onRetry={reread} /> : <div className="empty">{t.ACCOUNT_LOADING}</div>
          ) : (
            <Overview ov={ov} disabled={disabled} ready={settings !== undefined} onOpen={open} onToggle={toggle} />
          )}
          <Messaging profile={profile} region={region} />
        </section>
      </div>
    </div>
  );
}

function Overview({ ov, disabled, ready, onOpen, onToggle }: { ov: SnsAccountOverview; disabled: string[]; ready: boolean; onOpen: (arn: string, name: string, route?: SnsRoute) => void; onToggle: (id: string, on: boolean) => void }) {
  const shown = t.enabledOnly(ov.findings, disabled);
  const perTopic = (arn: string) => shown.filter((f) => f.topicArn === arn);
  const topicName = new Map(ov.topics.map((row) => [row.arn, row.name]));
  const openFinding = (f: SnsFinding) => onOpen(f.topicArn, f.topicName, POLICY_ROUTE);
  const metric = (n: number) => (ov.metricsAvailable ? t.count(n) : "–");

  return (
    <>
      {ov.errors.length > 0 && (
        <p className="sns-note dim" role="status">
          {`${t.PARTIAL(ov.errors.length)}: ${[...new Set(ov.errors.map(errorMessage))].join(" · ")}`}
        </p>
      )}
      <p className="sns-note dim">{t.WINDOW_NOTE}</p>
      {!ov.metricsAvailable && <p className="sns-note sns-error">{t.METRICS_UNAVAILABLE}</p>}
      {ov.truncated && <p className="sns-note dim">{t.TRUNCATED}</p>}

      <section className="sns-section" aria-label={t.SECTION_TOPICS}>
        <h4 className="sns-heading">{t.SECTION_TOPICS}</h4>
        {ov.topics.length === 0 ? (
          <p className="sns-note dim">{t.TOPICS_EMPTY}</p>
        ) : (
          <table className="sns-table" aria-label={t.SECTION_TOPICS}>
            <thead>
              <tr>
                {Object.values(t.TOPIC_COLS).map((c) => (
                  <th key={c} scope="col" className="nosort">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ov.topics.map((row) => {
                const found = perTopic(row.arn);
                return (
                  <tr key={row.arn} className="sns-row" onDoubleClick={() => onOpen(row.arn, row.name)}>
                    <td>
                      <button type="button" className="link sns-endpoint mono" title={t.OPEN_TOPIC(row.name)} onClick={() => onOpen(row.arn, row.name)}>
                        {row.name}
                      </button>
                      {row.error && (
                        <span className="sns-warn" role="img" aria-label={t.TOPIC_ERROR} title={`${t.TOPIC_ERROR}: ${errorMessage(row.error)}`}>
                          !
                        </span>
                      )}
                    </td>
                    <td className="sns-nowrap">{metric(row.published)}</td>
                    <td className="sns-nowrap">{metric(row.delivered)}</td>
                    <td className={`sns-nowrap${ov.metricsAvailable && row.failed > 0 ? " sns-error" : ""}`}>{metric(row.failed)}</td>
                    <td className="sns-nowrap">{metric(row.filteredOut)}</td>
                    <td className="sns-nowrap">{row.error ? "–" : t.count(row.subscriptions)}</td>
                    <td className="sns-nowrap">{row.error ? "–" : t.count(row.pending)}</td>
                    <td className="sns-nowrap">
                      {found.length === 0 ? (
                        <span className="dim">0</span>
                      ) : (
                        <button type="button" className={`link sns-level-count ${found[0].level}`} title={t.OPEN_TOPIC(row.name)} onClick={() => onOpen(row.arn, row.name, POLICY_ROUTE)}>
                          {found.length}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="sns-section" aria-label={t.SECTION_ORPHANS}>
        <h4 className="sns-heading">{t.SECTION_ORPHANS}</h4>
        <p className="sns-note dim">{t.ORPHANS_NOTE}</p>
        {ov.orphans.length === 0 ? (
          <p className="sns-note dim">{t.ORPHANS_EMPTY}</p>
        ) : (
          <ul className="sns-subscribed-list" aria-label={t.SECTION_ORPHANS}>
            {ov.orphans.map((o, i) => (
              <li key={`${o.subscriptionArn ?? o.topicArn}-${o.endpoint}-${i}`}>
                <span className="sns-state pending">{t.ORPHAN_REASON[o.reason]}</span>
                <span className="mono">{o.topicArn.split(":").pop()}</span>
                <span className="dim">{o.protocol}</span>
                <span className="mono">{o.endpoint}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="sns-section" aria-label={t.SECTION_PENDING}>
        <h4 className="sns-heading">{t.SECTION_PENDING}</h4>
        <p className="sns-note dim">{t.PENDING_NOTE}</p>
        {ov.pending.length === 0 ? (
          <p className="sns-note dim">{t.PENDING_EMPTY}</p>
        ) : (
          <ul className="sns-subscribed-list" aria-label={t.SECTION_PENDING}>
            {ov.pending.map((p, i) => (
              <li key={`${p.topicArn}-${p.endpoint}-${i}`}>
                {topicName.has(p.topicArn) ? (
                  <button type="button" className="link mono" title={t.OPEN_TOPIC(p.topicName)} onClick={() => onOpen(p.topicArn, p.topicName)}>
                    {p.topicName}
                  </button>
                ) : (
                  <span className="mono">{p.topicName}</span>
                )}
                <span className="dim">{p.protocol}</span>
                <span className="mono">{p.endpoint}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="sns-section" aria-label={t.SECTION_CHECKS}>
        <h4 className="sns-heading">{t.SECTION_CHECKS}</h4>
        <p className="sns-note dim">{t.CHECKS_NOTE}</p>
        <ul className="sns-checks" aria-label={t.SECTION_CHECKS}>
          {ov.checks.map((c) => {
            const on = !disabled.includes(c.id);
            return (
              <li key={c.id} className="sns-check">
                <label>
                  <input type="checkbox" checked={on} disabled={!ready} aria-label={t.CHECK_TOGGLE(c.title)} onChange={(e) => onToggle(c.id, e.target.checked)} />
                  <span className={`sns-level ${c.level}`}>{t.LEVEL_LABEL[c.level]}</span> {c.title}
                </label>
                <span className="dim sns-where">{t.CHECK_COUNT(ov.findings.filter((f) => f.check === c.id).length)}</span>
              </li>
            );
          })}
        </ul>
        <FindingsList findings={shown} onOpenTopic={openFinding} />
      </section>

      <section className="sns-section" aria-label={t.SECTION_ACCOUNT_METRICS}>
        <h4 className="sns-heading">{t.SECTION_ACCOUNT_METRICS}</h4>
        {ov.metrics.length === 0 ? (
          <p className="sns-note dim">{t.ACCOUNT_METRICS_EMPTY}</p>
        ) : (
          <table className="sns-table" aria-label={t.SECTION_ACCOUNT_METRICS}>
            <tbody>
              {ov.metrics.map((m) => (
                <tr key={m.name}>
                  <td className="mono">{m.name}</td>
                  <td className="sns-nowrap">{t.count(m.value)}</td>
                  <td className="dim sns-nowrap">{m.stat}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
