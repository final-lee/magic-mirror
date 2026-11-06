import { useEffect, useState, type ReactNode } from "react";
import { desktop } from "../api/desktop";
import { ErrorState } from "../components/ErrorState";
import { Overview } from "./Overview";
import { Items } from "./items/Items";
import { openQuery, tableStoreKey } from "./items/store";
import { Design } from "./design/DesignTab";
import { StreamTab } from "./stream/StreamTab";
import { Operations } from "./ops/Operations";
import { ChangeLog } from "./change/ChangeLog";
import { useDynamoTablePoll } from "./queries";
import * as t from "./text";
import type { DynamoTable } from "./types";

export type DetailTab = keyof typeof t.DETAIL_TAB_LABELS;

/** 상세 탭 하나가 받는 것 */
export interface DetailContext {
  profile: string;
  region: string;
  table: DynamoTable;
  /** 이 탭이 보이는 탭인가(DynamoDB 탭이 보이고 이 상세 탭을 열어 둔 때) */
  active: boolean;
  openItems: () => void;
  onOpenLambda?: (functionArn: string) => void;
}

/**
 * 구현된 상세 탭, 보이는 순서대로. 단계마다 여기에 한 줄씩 더한다(아이템 D2, 설계 D3, 스트림 D5, 운영·기록 D6).
 * 탭 이름은 `text.DETAIL_TAB_LABELS`에 이미 있다.
 */
const DETAIL_TABS: { id: DetailTab; render: (ctx: DetailContext) => ReactNode }[] = [
  { id: "overview", render: ({ profile, region, table, openItems, active }) => <Overview profile={profile} region={region} table={table} active={active} onIndex={(index) => { openQuery(tableStoreKey(profile, region, table.name), { index }); openItems(); }} /> },
  { id: "items", render: (ctx) => <Items {...ctx} /> },
  { id: "design", render: (ctx) => <Design {...ctx} /> },
  { id: "stream", render: (ctx) => <StreamTab {...ctx} /> },
  { id: "ops", render: (ctx) => <Operations key={`${ctx.profile}:${ctx.region}:${ctx.table.name}`} {...ctx} /> },
  { id: "log", render: (ctx) => <ChangeLog {...ctx} /> },
];

interface Props {
  profile: string;
  region: string;
  /** DynamoDB 탭이 보이는가. 보일 때만 바뀌는 중인 테이블을 10초마다 읽는다 */
  active: boolean;
  /** 목록에서 읽은 테이블 */
  table: DynamoTable;
  /** 스트림 탭의 Lambda 노드에서 그 함수의 리소스 상세로 간다 */
  onOpenLambda?: (functionArn: string) => void;
}

/** 오른쪽 테이블 상세: 제목줄과 상세 탭. 테이블이 바뀌는 중이면 10초마다 다시 읽는다 */
export function TableDetail({ profile, region, active, table, onOpenLambda }: Props) {
  const [tab, setTab] = useState<DetailTab>("overview");
  const poll = useDynamoTablePoll(profile, region, table, active);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const current = DETAIL_TABS.find((d) => d.id === tab) ?? DETAIL_TABS[0];

  return (
    <section className="ddb-detail" aria-label={table.name}>
      <header className="ddb-detail-head">
        <h3 className="mono">{table.name}</h3>
        {!table.error && <span className="iam-chip">{t.statusLabel(table.status)}</span>}
        <div className="ddb-detail-end">
          <button
            type="button"
            className="btn small tone-secondary"
            onClick={() => {
              void desktop.copy(table.arn);
              setCopied(true);
            }}
          >
            {copied ? t.COPIED : t.COPY_ARN}
          </button>
        </div>
      </header>
      <div className="ddb-detail-tabs" role="tablist" aria-label={t.DETAIL_TABS_LABEL}>
        {DETAIL_TABS.map((d) => (
          <button key={d.id} type="button" role="tab" aria-selected={current.id === d.id} className={`ddb-detail-tab${current.id === d.id ? " on" : ""}`} onClick={() => setTab(d.id)}>
            {t.DETAIL_TAB_LABELS[d.id]}
          </button>
        ))}
      </div>
      {poll.isError && <ErrorState compact error={poll.error} profile={profile} onRetry={() => void poll.refetch()} />}
      <div className="ddb-detail-body">
        {table.error ? <div className="empty ddb-read-error">{t.tableReadFailed(table.error)}</div> : current.render({ profile, region, table, active, openItems: () => setTab("items"), onOpenLambda })}
      </div>
    </section>
  );
}
