import { ErrorState } from "../components/ErrorState";
import { formatCount } from "../kv/format";
import { useDynamoTopKeys } from "./queries";
import * as t from "./text";
import type { DynamoTable } from "./types";

interface Props {
  profile: string;
  region: string;
  table: DynamoTable;
}

/** Contributor Insights가 켜진 테이블의 최근 1시간 상위 키(접근이 많은 키, 스로틀된 키 각 10개까지) */
export function TopKeysCard({ profile, region, table }: Props) {
  const q = useDynamoTopKeys(profile, region, table.name, table.contributorInsights === "ENABLED");
  return (
    <section className="ddb-card" aria-label={t.CARD_TOP_KEYS}>
      <div className="ddb-card-head">
        <h4>{t.CARD_TOP_KEYS}</h4>
        <button type="button" className="btn small tone-refresh" onClick={() => void q.refetch()} disabled={q.isFetching}>
          {q.isFetching ? t.READING : t.REREAD}
        </button>
      </div>
      {q.isError ? (
        <ErrorState compact error={q.error} profile={profile} onRetry={() => void q.refetch()} />
      ) : !q.data ? (
        <p className="dim">{t.TOP_KEYS_LOADING}</p>
      ) : q.data.groups.every((g) => g.entries.length === 0) ? (
        <p className="dim">{t.TOP_KEYS_EMPTY}</p>
      ) : (
        q.data.groups
          .filter((g) => g.entries.length > 0)
          .map((g) => (
            <div key={`${g.kind}-${g.withSortKey}`} className="ddb-topkeys">
              <h5>{t.topKeyGroupTitle(g.kind, g.withSortKey)}</h5>
              <table className="ddb-table">
                <thead>
                  <tr>
                    <th>{t.TOP_KEY_COL_KEY}</th>
                    <th className="ddb-num">{t.TOP_KEY_COL_COUNT}</th>
                  </tr>
                </thead>
                <tbody>
                  {g.entries.map((e, i) => (
                    <tr key={`${e.keys.join("|")}-${i}`}>
                      <td className="mono">{e.keys.join(" · ")}</td>
                      <td className="ddb-num">{formatCount(Math.round(e.count))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))
      )}
    </section>
  );
}
