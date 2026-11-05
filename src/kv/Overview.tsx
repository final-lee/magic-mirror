import type { ReactNode } from "react";
import { formatBytes } from "../lib/format";
import { formatCount, formatDuration, formatPercent } from "./format";
import { keyspaceTotals, summarize } from "./stats";
import * as t from "./text";
import type { KvOverview } from "./types";

/** bar: 0~1. usage면 90% 이상이 빨강·75% 이상이 노랑(차 가는 양), 아니면 늘 한 색(히트율처럼 높을수록 좋은 값) */
function Card({ title, value, sub, bar, usage = false }: { title: string; value: ReactNode; sub?: ReactNode; bar?: number | null; usage?: boolean }) {
  return (
    <div className="kv-card" role="group" aria-label={title}>
      <h4>{title}</h4>
      <div className="kv-card-value">{value}</div>
      {bar != null && (
        <div className="kv-meter" role="meter" aria-label={title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(bar * 100)}>
          <span className={usage ? (bar >= 0.9 ? "hot" : bar >= 0.75 ? "warm" : undefined) : "good"} style={{ width: `${Math.min(100, bar * 100)}%` }} />
        </div>
      )}
      {sub != null && <div className="kv-card-sub dim">{sub}</div>}
    </div>
  );
}

/**
 * 개요: 노드별 INFO를 모은 카드(메모리·히트율·초당 명령·연결·키·축출·가동 시간·복제 지연)와 노드 표, 키스페이스.
 * 합계는 기본 노드만 더한다(stats.ts). 서버리스는 노드 하나로 보인다.
 */
export function Overview({ overview }: { overview: KvOverview }) {
  const s = summarize(overview);
  const keyspace = keyspaceTotals(overview);
  const infoOf = new Map(overview.info.map((i) => [i.node, i]));
  const memoryPct = s.maxMemory ? s.usedMemory / s.maxMemory : null;
  return (
    <section className="center kv-overview kv-pane" aria-label={t.OVERVIEW_LABEL}>
      <div className="kv-cards">
        <Card
          title={t.CARD_MEMORY}
          value={s.maxMemory ? `${formatBytes(s.usedMemory)} / ${formatBytes(s.maxMemory)}` : formatBytes(s.usedMemory)}
          bar={memoryPct}
          usage
          sub={`${t.PEAK} ${formatBytes(s.usedMemoryPeak)}${s.fragmentation !== null ? ` · ${t.FRAGMENTATION} ${s.fragmentation.toFixed(2)}` : ""}`}
        />
        <Card title={t.CARD_HITS} value={s.hitRatio === null ? t.DASH : formatPercent(s.hitRatio)} bar={s.hitRatio} sub={t.HITS_MISSES(formatCount(s.hits), formatCount(s.misses))} />
        <Card title={t.CARD_OPS} value={formatCount(s.opsPerSec)} sub={overview.nodes.length > 1 ? t.OPS_NOTE : undefined} />
        <Card title={t.CARD_CLIENTS} value={formatCount(s.connectedClients)} />
        <Card title={t.CARD_KEYS} value={formatCount(overview.dbsize)} sub={`${t.COL.expires} ${formatCount(s.expires)}`} />
        <Card title={t.CARD_EVICTED} value={`${formatCount(s.evictedKeys)} · ${formatCount(s.expiredKeys)}`} sub={`${t.EVICTED} · ${t.EXPIRED}`} />
        <Card title={t.CARD_UPTIME} value={s.uptimeSeconds === null ? t.DASH : formatDuration(s.uptimeSeconds)} sub={`${overview.engine} ${overview.version}`} />
        {s.replicationLagSeconds !== null && <Card title={t.CARD_LAG} value={t.LAG_SECONDS(s.replicationLagSeconds)} />}
      </div>

      <h4 className="kv-section">{t.SECTION_NODES}</h4>
      {overview.mode === "serverless" && <p className="kv-note dim">{t.SERVERLESS_NODE_NOTE}</p>}
      <div className="kv-scroll">
      <table className="kv-table kv-nodes" aria-label={t.SECTION_NODES}>
        <thead>
          <tr>
            {[t.COL.role, t.COL.address, t.COL.shard, t.COL.slots, t.COL.memory, t.COL.clients, t.COL.ops, t.COL.lag, t.COL.uptime].map((c) => (
              <th key={c} scope="col" className="nosort">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {overview.nodes.map((n) => {
            const info = infoOf.get(n.address);
            return (
              <tr key={n.id}>
                <td>
                  <span className={`iam-chip kv-role-${n.role}`}>{t.ROLE_LABEL[n.role]}</span>
                </td>
                <td className="mono" title={n.address}>
                  {n.address}
                </td>
                <td className="mono">{n.shard ?? t.DASH}</td>
                <td className="mono">{n.slots ?? t.DASH}</td>
                <td className="mono num">{info ? (info.maxMemory ? `${formatBytes(info.usedMemory)} / ${formatBytes(info.maxMemory)}` : formatBytes(info.usedMemory)) : t.DASH}</td>
                <td className="mono num">{info ? formatCount(info.connectedClients) : t.DASH}</td>
                <td className="mono num">{info ? formatCount(info.opsPerSec) : t.DASH}</td>
                <td className="mono num">{info?.replicationLagSeconds != null ? t.LAG_SECONDS(info.replicationLagSeconds) : t.DASH}</td>
                <td className="mono num">{info ? formatDuration(info.uptimeSeconds) : t.DASH}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>

      {keyspace.length > 0 && (
        <>
          <h4 className="kv-section">{t.SECTION_KEYSPACE}</h4>
          <table className="kv-table kv-keyspace" aria-label={t.SECTION_KEYSPACE}>
            <thead>
              <tr>
                {[t.COL.db, t.COL.keys, t.COL.expires].map((c) => (
                  <th key={c} scope="col" className="nosort">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {keyspace.map((k) => (
                <tr key={k.db}>
                  <td className="mono">{`db${k.db}`}</td>
                  <td className="mono num">{formatCount(k.keys)}</td>
                  <td className="mono num">{formatCount(k.expires)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
