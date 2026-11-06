import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ErrorState } from "../components/ErrorState";
import { useCopyShortcut } from "../hooks/useCopyShortcut";
import { hasProblem } from "./group";
import { refreshDynamo, useDynamoOverview } from "./queries";
import { TableDetail } from "./TableDetail";
import { TableList } from "./TableList";
import * as t from "./text";

interface Props {
  profile: string;
  region: string;
  /** 이 탭이 보이는 탭인가. 보일 때만 다시 읽는다 */
  active: boolean;
  /** 리소스 목록에서 연 테이블. nonce가 바뀔 때마다 그 테이블을 고른다(같은 테이블을 다시 열어도) */
  focus: { table: string; nonce: number } | null;
}

/** 리전 단위 DynamoDB 탭: 왼쪽 테이블 목록, 오른쪽 테이블 상세 */
export function DynamoTab({ profile, region, active, focus }: Props) {
  const qc = useQueryClient();
  const overview = useDynamoOverview(profile, region, active);
  const [selectedName, setSelectedName] = useState<string | null>(focus?.table ?? null);
  const [problemOnly, setProblemOnly] = useState(false);
  const [rereading, setRereading] = useState(false);

  const focusNonce = useRef(focus?.nonce);
  useEffect(() => {
    if (!focus || focus.nonce === focusNonce.current) return;
    focusNonce.current = focus.nonce;
    setSelectedName(focus.table);
  }, [focus]);

  const tables = useMemo(() => overview.data?.tables ?? [], [overview.data]);
  const selected = tables.find((tbl) => tbl.name === selectedName) ?? null;
  const problems = useMemo(() => tables.filter(hasProblem).length, [tables]);
  const root = useRef<HTMLDivElement>(null);
  useCopyShortcut(active ? selectedName : null, root);

  const reread = () => {
    setRereading(true);
    void refreshDynamo(qc, profile, region).finally(() => setRereading(false));
  };

  if (!overview.data) {
    return (
      <div className="ddb-tab" ref={root}>
        {overview.isError ? <ErrorState error={overview.error} profile={profile} onRetry={() => void overview.refetch()} /> : <div className="empty">{t.LOADING}</div>}
      </div>
    );
  }
  const data = overview.data;
  return (
    <div className="ddb-tab" ref={root}>
      <div className="ddb-top">
        <span className="dim">{t.tableCount(tables.length)}</span>
        {problems > 0 && <span className="ddb-top-problems">{t.problemCount(problems)}</span>}
        <span className="ddb-top-end">
          <button type="button" className="btn small tone-refresh" onClick={reread} disabled={rereading || overview.isFetching}>
            {rereading || overview.isFetching ? t.READING : t.REREAD}
          </button>
        </span>
      </div>
      {overview.isError && <ErrorState compact error={overview.error} profile={profile} onRetry={() => void overview.refetch()} />}
      {data.truncated && <div className="notice">{t.TRUNCATED}</div>}
      {data.gaps.length > 0 && (
        <div className="notice ddb-gaps">
          {t.GAPS_TITLE}
          <ul>
            {data.gaps.map((g) => (
              <li key={g.section}>{t.gapLine(g.section, g.error)}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="ddb-body">
        <TableList tables={tables} selected={selectedName} onSelect={setSelectedName} active={active} problemOnly={problemOnly} onProblemOnly={setProblemOnly} />
        {selected ? (
          <TableDetail key={selected.name} profile={profile} region={region} active={active} table={selected} />
        ) : (
          <div className="empty ddb-detail-empty">{selectedName ? t.TABLE_GONE : t.DETAIL_PICK}</div>
        )}
      </div>
    </div>
  );
}
