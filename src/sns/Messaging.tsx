import { errorMessage } from "../api/errors";
import { ErrorState } from "../components/ErrorState";
import { formatDate } from "../lib/format";
import * as t from "./accessText";
import { useSnsMessaging } from "./queries";
import type { SnsMessaging } from "./types";

function Sms({ sms }: { sms: SnsMessaging["sms"] }) {
  const attributes = Object.entries(sms.attributes);
  return (
    <section className="sns-section" aria-label={t.SECTION_SMS}>
      <h4 className="sns-heading">{t.SECTION_SMS}</h4>
      <div className="kv-cards">
        <div className="kv-card" role="group" aria-label="샌드박스 여부">
          <h4>샌드박스 여부</h4>
          <div className="kv-card-value">{sms.sandbox === null ? "모름" : sms.sandbox ? "샌드박스" : "운영"}</div>
          <div className="kv-card-sub dim">{sms.sandbox === null ? t.SANDBOX_UNKNOWN : sms.sandbox ? t.SANDBOX_ON : t.SANDBOX_OFF}</div>
        </div>
        {[
          [t.MONTH_SPENT, sms.monthSpentUsd === null ? t.NO_VALUE : t.usd(sms.monthSpentUsd)],
          [t.SUCCESS_RATE, sms.successRate === null ? t.NO_VALUE : t.percent(sms.successRate)],
          ["발신 번호 수", t.count(sms.originationNumbers.length)],
        ].map(([title, value]) => <div className="kv-card" role="group" aria-label={title} key={title}><h4>{title}</h4><div className="kv-card-value">{value}</div></div>)}
      </div>

      {sms.sandboxNumbers.length > 0 && (
        <>
          <h5 className="sns-subheading">
            {t.SANDBOX_NUMBERS} <span className="dim">· {t.SANDBOX_NUMBERS_NOTE}</span>
          </h5>
          <table className="sns-table" aria-label={t.SANDBOX_NUMBERS}><thead><tr><th className="nosort">번호</th><th className="nosort">상태</th></tr></thead><tbody>
            {sms.sandboxNumbers.map((n, i) => <tr key={`${n.phone}-${i}`}><td className="mono">{n.phone}</td><td>{n.status}</td></tr>)}
          </tbody></table>
        </>
      )}

      <h5 className="sns-subheading">{t.ORIGINATION_NUMBERS}</h5>
      {sms.originationNumbers.length === 0 ? (
        <p className="empty small">{t.ORIGINATION_EMPTY}</p>
      ) : (
        <table className="sns-table" aria-label={t.ORIGINATION_NUMBERS}><thead><tr><th className="nosort">번호</th><th className="nosort">상태</th><th className="nosort">국가</th><th className="nosort">경로</th><th className="nosort">기능</th></tr></thead><tbody>
          {sms.originationNumbers.map((n) => <tr key={n.phoneNumber}><td className="mono">{n.phoneNumber}</td><td>{n.status}</td><td>{n.country ?? "–"}</td><td>{n.routeType ?? "–"}</td><td>{n.capabilities.join("/") || "–"}</td></tr>)}
        </tbody></table>
      )}

      <h5 className="sns-subheading">{t.SMS_ATTRIBUTES}</h5>
      {attributes.length === 0 ? (
        <p className="sns-note dim">{t.SMS_ATTRIBUTES_EMPTY}</p>
      ) : (
        <table className="sns-table" aria-label={t.SMS_ATTRIBUTES}>
          <tbody>
            {attributes.map(([k, v]) => (
              <tr key={k}>
                <td className="sns-nowrap">{k}</td>
                <td className="mono">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Push({ apps }: { apps: SnsMessaging["apps"] }) {
  return (
    <section className="sns-section" aria-label={t.SECTION_PUSH}>
      <h4 className="sns-heading">{t.SECTION_PUSH}</h4>
      {apps.length === 0 ? (
        <p className="sns-note dim">{t.PUSH_EMPTY}</p>
      ) : (
        <table className="sns-table" aria-label={t.SECTION_PUSH}>
          <thead>
            <tr>
              {Object.values(t.PUSH_COLS).map((c) => (
                <th key={c} scope="col" className="nosort">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {apps.map((a) => (
              <tr key={a.arn} title={a.arn}>
                <td className="mono">{a.name}</td>
                <td className="sns-nowrap">{a.platform}</td>
                <td className="sns-nowrap">{t.APP_ENABLED[a.enabled === null ? "unknown" : a.enabled ? "true" : "false"]}</td>
                <td className="sns-nowrap">
                  {a.error ? (
                    <span className="sns-warn" role="img" aria-label={t.APP_ERROR} title={`${t.APP_ERROR}: ${errorMessage(a.error)}`}>
                      !
                    </span>
                  ) : (
                    t.endpointsText(a.endpoints, a.endpointsTruncated)
                  )}
                </td>
                <td className="sns-nowrap">{a.error ? "" : t.endpointsText(a.disabledEndpoints, false)}</td>
                <td className="sns-nowrap">{a.certExpiry ? formatDate(a.certExpiry) : <span className="dim">–</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** SMS·모바일 푸시(읽기). 계정 개요와 따로 읽는다 */
export function Messaging({ profile, region }: { profile: string; region: string }) {
  const q = useSnsMessaging(profile, region);
  if (!q.data) return q.isError ? <ErrorState error={q.error} profile={profile} onRetry={() => void q.refetch()} /> : <div className="empty small">{t.MESSAGING_LOADING}</div>;
  return (
    <>
      {q.data.errors.length > 0 && (
        <p className="sns-note dim" role="status">
          {`${t.MESSAGING_PARTIAL(q.data.errors.length)}: ${[...new Set(q.data.errors.map(errorMessage))].join(" · ")}`}
        </p>
      )}
      <Sms sms={q.data.sms} />
      <Push apps={q.data.apps} />
    </>
  );
}
