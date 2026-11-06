import { useMemo, type ReactNode } from "react";
import type { Resource, ServiceInfo } from "../api/types";
import { ResourceMetrics } from "../components/ResourceMetrics";
import { formatDateTime } from "../iam/format";
import { formatCount } from "../kv/format";
import { formatBytes } from "../lib/format";
import { Findings } from "./Findings";
import { TopKeysCard } from "./TopKeysCard";
import { useConnections } from "./stream/queries";
import * as t from "./text";
import type { DynamoIndex, DynamoTable, KeyAttr } from "./types";

/** `ResourceMetrics`가 쓰는 서비스 정보: 지표 종류는 테이블뿐이고, 목록 화면과 같은 쿼리 키를 쓰도록 id를 맞춘다 */
const DYNAMO_SERVICE: ServiceInfo = { id: "dynamodb", name: "DynamoDB", global: false, types: [], metricTypes: ["tables"] };

const key = (k: KeyAttr) => t.keyLabel(k.name, k.type);

function projectionLabel(i: DynamoIndex): string {
  if (i.projection.type === "KEYS_ONLY") return t.PROJECTION_KEYS_ONLY;
  if (i.projection.type === "INCLUDE") return t.projectionInclude(i.projection.attrs);
  return t.PROJECTION_ALL;
}

function IndexTable({ indexes, onIndex }: { indexes: DynamoIndex[]; onIndex?: (index: string) => void }) {
  if (indexes.length === 0) return <p className="dim">{t.NO_INDEXES}</p>;
  return (
    <table className="ddb-table">
      <thead>
        <tr>
          <th>{t.COL_INDEX_NAME}</th>
          <th>{t.COL_INDEX_KEYS}</th>
          <th>{t.COL_INDEX_PROJECTION}</th>
          <th>{t.COL_INDEX_STATUS}</th>
          <th>{t.COL_INDEX_CAPACITY}</th>
          <th className="ddb-num">{t.COL_INDEX_SIZE}</th>
        </tr>
      </thead>
      <tbody>
        {indexes.map((i) => (
          <tr key={`${i.kind}-${i.name}`}>
            <td>
              <button className="btn small tone-nav mono" onClick={() => onIndex?.(i.name)}>{i.name}</button> <span className="iam-chip">{t.INDEX_KIND[i.kind]}</span>
            </td>
            <td className="mono">{[i.pk, ...(i.sk ? [i.sk] : [])].map(key).join(" + ")}</td>
            <td>{projectionLabel(i)}</td>
            <td>
              {t.statusLabel(i.status)}
              {i.backfilling && <span className="iam-chip conditional ddb-gap-left">{t.BACKFILLING}</span>}
            </td>
            <td>{t.capacityLabel(i.read, i.write)}</td>
            <td className="ddb-num">{`${formatBytes(i.sizeBytes)} · ${formatCount(i.itemCount)}`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function scalingRows(table: DynamoTable): ReactNode {
  if (table.billing.mode === "onDemand") return t.NOT_APPLICABLE_ON_DEMAND;
  if (table.scaling === null) return t.UNREAD;
  if (table.scaling.length === 0) return t.NONE;
  return (
    <ul className="ddb-plain">
      {table.scaling.map((s) => (
        <li key={`${s.index ?? ""}-${s.dimension}`}>{t.scalingLine(s.index === null ? t.SCALING_TABLE_SCOPE : t.scalingIndexScope(s.index), t.DIRECTION[s.dimension], s.min, s.max, s.targetUtilization)}</li>
      ))}
    </ul>
  );
}

/** 설정 카드의 줄: 읽지 못한 부분(null)은 "읽지 못했어요"로 보인다 */
function settings(table: DynamoTable): [string, ReactNode][] {
  const ttl = table.ttl === null ? t.UNREAD : table.ttl.status === "ENABLED" ? t.ttlOn(table.ttl.attribute) : (t.TTL_STATUS[table.ttl.status] ?? table.ttl.status);
  const pitr = table.pitr === null ? t.UNREAD : table.pitr.status === "ENABLED" ? t.pitrOn(table.pitr.days) : t.OFF;
  const insights = table.contributorInsights === null ? t.UNREAD : (t.INSIGHTS_STATUS[table.contributorInsights] ?? table.contributorInsights);
  const policy = table.resourcePolicy === null ? t.UNREAD : table.resourcePolicy ? t.HAS : t.NONE;
  return [
    [t.SETTING_BILLING, table.billing.mode === "onDemand" ? t.billingOnDemand : t.billingProvisioned(table.billing.read, table.billing.write)],
    [t.SETTING_SCALING, scalingRows(table)],
    [t.SETTING_CLASS, t.classLabel(table.class)],
    [t.SETTING_TTL, ttl],
    [t.SETTING_PITR, pitr],
    [t.SETTING_PROTECTION, table.deletionProtection ? t.ON : t.OFF],
    [t.SETTING_STREAM, table.stream ? <span key="s" title={table.stream.arn}>{t.streamOn(table.stream.viewType)}</span> : t.OFF],
    [t.SETTING_SSE, table.sse.type === "KMS" ? <span key="k" className="mono ddb-wrap">{t.sseKms(table.sse.kmsKey)}</span> : t.SSE_OWNED],
    [t.SETTING_POLICY, policy],
    [t.SETTING_REPLICAS, table.replicas.length === 0 ? t.NONE : table.replicas.map((r) => t.replicaLine(r.region, r.status)).join(", ")],
    [t.SETTING_INSIGHTS, insights],
    [t.SETTING_SIZE, `${formatCount(table.itemCount)}개 · ${formatBytes(table.sizeBytes)}`],
    ...(table.createdAt === null ? [] : ([[t.SETTING_CREATED, formatDateTime(new Date(table.createdAt).toISOString())]] as [string, ReactNode][])),
  ];
}

interface Props {
  profile: string;
  region: string;
  table: DynamoTable;
  active?: boolean;
  onIndex?: (index: string) => void;
}

/** 개요: 키 · 인덱스 · 설정 · 건강 진단 · CloudWatch 지표 · (Contributor Insights가 켜져 있으면) 상위 키 */
export function Overview({ profile, region, table, onIndex, active = true }: Props) {
  const row = useMemo<Resource>(() => ({ id: table.name, name: table.name, arn: table.arn, values: {}, tags: {}, fields: [], raw: "", consoleUrl: null }), [table.name, table.arn]);
  const connections = useConnections(profile, region, table.name, active);
  return (
    <div className="ddb-overview">
      <section className="ddb-card" aria-label={t.CARD_KEYS}>
        <h4>{t.CARD_KEYS}</h4>
        <dl className="ddb-attrs">
          <dt>{t.KEY_PARTITION}</dt>
          <dd className="mono">{key(table.keys.pk)}</dd>
          <dt>{t.KEY_SORT}</dt>
          <dd className="mono">{table.keys.sk ? key(table.keys.sk) : t.NO_SORT_KEY}</dd>
        </dl>
      </section>
      <section className="ddb-card" aria-label={t.CARD_INDEXES}>
        <h4>{t.CARD_INDEXES}</h4>
        <IndexTable indexes={table.indexes} onIndex={onIndex} />
      </section>
      <section className="ddb-card" aria-label={t.CARD_SETTINGS}>
        <h4>{t.CARD_SETTINGS}</h4>
        <dl className="ddb-attrs">
          {settings(table).map(([label, value]) => (
            <div key={label} className="ddb-attr">
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="ddb-card" aria-label={t.CARD_FINDINGS}>
        <h4>{t.CARD_FINDINGS}</h4>
        <Findings findings={[...table.findings, ...(connections.data?.findings ?? [])].sort((a, b) => ({ fail: 0, warn: 1, info: 2 }[a.level] - { fail: 0, warn: 1, info: 2 }[b.level]))} />
      </section>
      <ResourceMetrics key={`${profile}|${region}|${table.name}`} profile={profile} region={region} service={DYNAMO_SERVICE} typeId="tables" row={row} />
      {table.contributorInsights === "ENABLED" && <TopKeysCard profile={profile} region={region} table={table} />}
    </div>
  );
}
