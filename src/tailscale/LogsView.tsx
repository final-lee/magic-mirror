import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { errorMessage } from "../api/errors";
import { fuzzyKeep } from "../lib/fuzzy";
import { ApiRequired } from "./ApiRequired";
import { tailscaleApi } from "./api";
import type { TsAuditEvent, TsAuditLog, TsFlowRow, TsLogStream, TsLogType, TsWebhook } from "./logTypes";
import * as l from "./logsText";
import * as t from "./text";
import type { TsNode } from "./types";
import { useTailscaleApi } from "./useTailscaleApi";

const RANGES = [1, 7, 30];
const STREAM_LOG_TYPES: TsLogType[] = ["configuration", "network"];

const pad = (n: number) => String(n).padStart(2, "0");

/** 로컬 시각 `YYYY-MM-DD HH:mm:ss`. 읽을 수 없는 값은 그대로 보인다 */
export function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/** 구역 하나: 제목, 읽는 중, 오류(이 구역만), 내용. 한 구역의 권한 오류가 다른 구역을 막지 않는다 */
function Section({ title, query, controls, children }: {
  title: string; query: { isLoading: boolean; error: unknown }; controls?: ReactNode; children: ReactNode;
}) {
  return (
    <section className="ts-logs-section" aria-label={title}>
      <h3>{title}</h3>
      {controls}
      {query.isLoading ? (
        <p className="dim">{l.LOADING}</p>
      ) : query.error ? (
        <p className="err" role="alert">
          {l.SECTION_ERROR}: {errorMessage(query.error)}
        </p>
      ) : (
        children
      )}
    </section>
  );
}

function AuditRow({ event }: { event: TsAuditEvent }) {
  return (
    <tr>
      <td>{clock(event.time)}</td>
      <td>
        <strong>{event.actor.name || l.NONE}</strong>
        <div className="dim">{event.actor.kind}</div>
      </td>
      <td title={event.action}>
        {l.actionLabel(event.action)}
        {event.error && <div className="err">{l.FAILED}: {event.error}</div>}
      </td>
      <td>
        {event.target.name || l.NONE}
        <div className="dim">{[event.target.kind, event.target.property].filter(Boolean).join(" · ")}</div>
        {event.details && <div className="dim">{event.details}</div>}
        {(event.old !== null || event.new !== null) && (
          <div className="dim">
            {l.BEFORE} <code>{event.old ?? l.NONE}</code> → {l.AFTER} <code>{event.new ?? l.NONE}</code>
          </div>
        )}
      </td>
      <td className="dim">{event.origin}</td>
    </tr>
  );
}

function AuditSection({ days, setDays, query, audit }: {
  days: number;
  setDays: (days: number) => void;
  query: string;
  audit: UseQueryResult<TsAuditLog, Error>;
}) {
  const log = audit.data;
  const shown = fuzzyKeep(log?.events ?? [], query, (e) => [
    e.actor.name, e.actor.kind, e.action, l.actionLabel(e.action), e.target.name,
    e.target.kind, e.target.property, e.origin, e.details, e.error,
  ]);
  return (
    <Section
      title={l.AUDIT_TITLE}
      query={audit}
      controls={
        <div className="argowf-filters" role="group" aria-label={l.AUDIT_RANGE}>
          {RANGES.map((range) => (
            <button key={range} className="btn small" aria-pressed={days === range} onClick={() => setDays(range)}>
              {l.auditRange(range)}
            </button>
          ))}
        </div>
      }
    >
      {log && (
        <>
          <p className="dim ts-note">
            {l.auditCount(shown.length, log.total)}
            {log.total > log.events.length && ` · ${l.auditTruncated(log.events.length, log.total)}`}
          </p>
          <div className="argowf-table-wrap">
            <table className="argowf-table">
              <thead>
                <tr>
                  {[l.COL_TIME, l.COL_ACTOR, l.COL_ACTION, l.COL_TARGET, l.COL_ORIGIN].map((label) => (
                    <th key={label}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((event, i) => (
                  <AuditRow key={`${event.time}-${i}`} event={event} />
                ))}
              </tbody>
            </table>
          </div>
          {shown.length === 0 && <p className="empty small">{log.events.length === 0 ? l.AUDIT_EMPTY : l.AUDIT_NO_MATCH}</p>}
        </>
      )}
    </Section>
  );
}

function Endpoint({ ip, name }: { ip: string; name: string | null }) {
  return name ? (
    <>
      {name}
      <div className="dim">{ip}</div>
    </>
  ) : (
    <>{ip}</>
  );
}

function FlowRowView({ flow }: { flow: TsFlowRow }) {
  return (
    <tr>
      <td>{flow.nodeName ?? flow.nodeId}</td>
      <td>{l.FLOW_CLASS[flow.class]}</td>
      <td>{flow.proto}</td>
      <td>
        <Endpoint ip={flow.src} name={flow.srcName} />
      </td>
      <td>
        <Endpoint ip={flow.dst} name={flow.dstName} />
      </td>
      <td>{formatBytes(flow.txBytes)}</td>
      <td>{formatBytes(flow.rxBytes)}</td>
    </tr>
  );
}

function FlowSection({ tailnet }: { tailnet: string }) {
  const [query, setQuery] = useState("");
  const flows = useQuery({ queryKey: ["tailscale", "logs", "flows", tailnet], queryFn: () => tailscaleApi.logsFlows(tailnet), retry: false });
  const data = flows.data;
  const shown = fuzzyKeep(data?.flows ?? [], query, (f) => [f.nodeName, f.nodeId, f.proto, f.src, f.srcName, f.dst, f.dstName, l.FLOW_CLASS[f.class]]);
  return (
    <Section title={l.FLOW_TITLE} query={flows}>
      {data && !data.enabled && <p>{l.FLOW_OFF}</p>}
      {data?.enabled && (
        <>
          <div className="argowf-filters">
            <input className="k8s-filter" aria-label={l.FLOW_FILTER} placeholder={l.FLOW_FILTER} value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          {data.total > data.flows.length && <p className="dim ts-note">{l.flowTruncated(data.flows.length, data.total)}</p>}
          <div className="argowf-table-wrap">
            <table className="argowf-table">
              <thead>
                <tr>
                  {[l.COL_NODE, l.COL_CLASS, l.COL_PROTO, l.COL_SRC, l.COL_DST, l.COL_TX, l.COL_RX].map((label) => (
                    <th key={label}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((flow) => (
                  <FlowRowView key={`${flow.nodeId}-${flow.class}-${flow.proto}-${flow.src}-${flow.dst}`} flow={flow} />
                ))}
              </tbody>
            </table>
          </div>
          {shown.length === 0 && <p className="empty small">{data.flows.length === 0 ? l.FLOW_EMPTY : l.FLOW_NO_MATCH}</p>}
          <p className="dim ts-note">{l.FLOW_NOTE}</p>
        </>
      )}
    </Section>
  );
}

function StreamDetails({ stream }: { stream: TsLogStream }) {
  if (!stream.configured) return <p className="dim">{l.STREAM_NOT_CONFIGURED}</p>;
  const rows: [string, ReactNode][] = [
    [l.STREAM_DESTINATION, stream.destinationType ?? l.NONE],
    [l.STREAM_URL, stream.url ?? l.NONE],
    [l.STREAM_USER, stream.user ?? l.NONE],
    [l.STREAM_PERIOD, stream.uploadPeriodMinutes === null ? l.NONE : l.streamPeriod(stream.uploadPeriodMinutes)],
    [l.STREAM_COMPRESSION, stream.compression ?? l.NONE],
  ];
  const status = stream.status;
  return (
    <dl className="ts-details">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
      {status ? (
        <>
          <div>
            <dt>{l.STREAM_LAST_ACTIVITY}</dt>
            <dd>{status.lastActivity ? clock(status.lastActivity) : l.NONE}</dd>
          </div>
          <div>
            <dt>{l.STREAM_SENT}</dt>
            <dd>{l.streamSent(status.entriesSent, formatBytes(status.bytesSent))}</dd>
          </div>
          <div>
            <dt>{l.STREAM_REQUESTS}</dt>
            <dd>{l.streamRequests(status.requests, status.failedRequests)}</dd>
          </div>
          {status.lastError && (
            <div>
              <dt>{l.STREAM_LAST_ERROR}</dt>
              <dd className="err">{status.lastError}</dd>
            </div>
          )}
        </>
      ) : (
        <div>
          <dt />
          <dd className="dim">{l.STREAM_NO_STATUS}</dd>
        </div>
      )}
    </dl>
  );
}

/** 로그 종류마다 따로 읽어서 한쪽이 실패해도 다른 쪽은 보인다 */
function StreamCard({ tailnet, logType }: { tailnet: string; logType: TsLogType }) {
  const stream = useQuery({
    queryKey: ["tailscale", "logs", "stream", tailnet, logType],
    queryFn: () => tailscaleApi.logsStream(tailnet, logType),
    retry: false,
  });
  return (
    <div className="ts-stream" role="group" aria-label={l.STREAM_TYPES[logType]}>
      <h4>{l.STREAM_TYPES[logType]}</h4>
      {stream.isLoading ? (
        <p className="dim">{l.LOADING}</p>
      ) : stream.error ? (
        <p className="err" role="alert">
          {l.SECTION_ERROR}: {errorMessage(stream.error)}
        </p>
      ) : (
        stream.data && <StreamDetails stream={stream.data} />
      )}
    </div>
  );
}

function WebhookRow({ hook }: { hook: TsWebhook }) {
  return (
    <tr>
      <td>
        <code>{hook.endpoint}</code>
      </td>
      <td>{hook.provider || l.NONE}</td>
      <td>
        {hook.subscriptions.map((event) => (
          <span key={event} className="k8s-chip">
            {event}
          </span>
        ))}
      </td>
      <td>{hook.creator ?? l.NONE}</td>
      <td>{hook.created ? hook.created.slice(0, 10) : l.NONE}</td>
    </tr>
  );
}

function WebhookSection({ tailnet }: { tailnet: string }) {
  const hooks = useQuery({ queryKey: ["tailscale", "logs", "webhooks", tailnet], queryFn: () => tailscaleApi.webhooks(tailnet), retry: false });
  return (
    <Section title={l.WEBHOOK_TITLE} query={hooks}>
      {hooks.data?.length === 0 && <p className="dim">{l.WEBHOOK_EMPTY}</p>}
      {hooks.data && hooks.data.length > 0 && (
        <>
          <div className="argowf-table-wrap">
            <table className="argowf-table">
              <thead>
                <tr>
                  {[l.COL_ENDPOINT, l.COL_PROVIDER, l.COL_EVENTS, l.COL_CREATOR, l.COL_CREATED].map((label) => (
                    <th key={label}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {hooks.data.map((hook) => (
                  <WebhookRow key={hook.id} hook={hook} />
                ))}
              </tbody>
            </table>
          </div>
          <p className="dim ts-note">{l.WEBHOOK_NOTE}</p>
        </>
      )}
    </Section>
  );
}

function LogsPanel({ tailnet }: { tailnet: string }) {
  const qc = useQueryClient();
  const [days, setDays] = useState(7);
  const [query, setQuery] = useState("");
  const audit = useQuery({ queryKey: ["tailscale", "logs", "audit", tailnet, days], queryFn: () => tailscaleApi.logsAudit(tailnet, days), retry: false });
  return (
    <>
      <div className="awc-bar">
        <h2 className="awc-title">{l.TAB_LOGS}</h2>
        <span className="awc-stat">{l.auditRange(days)} <b>{audit.data?.total ?? 0}</b></span>
        <input className="k8s-filter" aria-label={l.AUDIT_FILTER} placeholder={l.AUDIT_FILTER} value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="awc-bar-end">
          <button className="btn small" onClick={() => void qc.invalidateQueries({ queryKey: ["tailscale", "logs"] })}>{l.REFRESH}</button>
        </div>
      </div>
      <div className="awc-body ts-logs">
      <AuditSection days={days} setDays={setDays} query={query} audit={audit} />
      <FlowSection tailnet={tailnet} />
      <section className="ts-logs-section" aria-label={l.STREAM_TITLE}>
        <h3>{l.STREAM_TITLE}</h3>
        {STREAM_LOG_TYPES.map((logType) => (
          <StreamCard key={logType} tailnet={tailnet} logType={logType} />
        ))}
      </section>
      <WebhookSection tailnet={tailnet} />
    </div>
    </>
  );
}

/** 설정 감사 로그, 네트워크 흐름 로그, 로그 스트리밍 상태, 웹훅. 구역마다 따로 읽는다. */
export function LogsView(_props: { node: TsNode }) {
  const { tailnet, connected, isLoading } = useTailscaleApi();
  if (isLoading) return <div className="empty">{t.API_LOADING}</div>;
  if (!connected || tailnet === null) return <ApiRequired title={l.TAB_LOGS} />;
  return <LogsPanel tailnet={tailnet} />;
}
