import { useMemo, type ReactNode } from "react";
import type { Resource, ServiceInfo } from "../api/types";
import { ResourceMetrics } from "../components/ResourceMetrics";
import { formatDateTime, prettyJson } from "../iam/format";
import { formatBytes } from "../lib/format";
import { formatCount, formatDuration } from "../kv/format";
import { DlqRedrive } from "./change/DlqRedrive";
import { SqsFindings } from "./SqsFindings";
import * as t from "./text";
import type { SqsQueue } from "./types";

/** ResourceMetrics가 읽는 서비스 정보: 지표 이름은 백엔드가 서비스·종류로 정한다 */
const SQS_SERVICE: ServiceInfo = { id: "sqs", name: "SQS", global: false, types: [], metricTypes: ["queues"] };

interface Props {
  profile: string;
  region: string;
  queue: SqsQueue;
  /** 이 리전의 큐 전체(DLQ·원본 이름을 찾고 변경 화면의 대상 후보로 쓴다) */
  queues: SqsQueue[];
  onSelect: (url: string) => void;
}

/** 리소스 목록과 같은 모양의 행. 지표는 큐 이름으로 읽는다 */
function metricsRow(q: SqsQueue): Resource {
  return { id: q.url, name: q.name, arn: q.arn, values: {}, tags: q.tags, fields: [], raw: "", consoleUrl: null };
}

const lastSegment = (arn: string) => arn.slice(arn.lastIndexOf(":") + 1);
const time = (ms: number | null) => (ms === null ? t.NO_DATA : formatDateTime(new Date(ms).toISOString()));

function Stat({ label, value, tone, title }: { label: string; value: string; tone?: "bad" | "warn"; title?: string }) {
  return (
    <div className={`sqs-stat${tone ? ` ${tone}` : ""}`} title={title}>
      <span className="sqs-stat-label">{label}</span>
      <b className="sqs-stat-value">{value}</b>
    </div>
  );
}

function Attr({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

export function Overview({ profile, region, queue, queues, onSelect }: Props) {
  const byArn = useMemo(() => new Map(queues.map((q) => [q.arn, q])), [queues]);
  const act = queue.activity;
  const count = (n: number | null | undefined) => (n === null || n === undefined ? t.NO_DATA : formatCount(n));
  const oldest = act?.oldestAgeSec;
  const link = (arn: string) => {
    const q = byArn.get(arn);
    return q ? (
      <button type="button" className="link mono" onClick={() => onSelect(q.url)} title={t.OPEN_QUEUE}>
        {q.name}
      </button>
    ) : (
      <span className="mono" title={arn}>
        {lastSegment(arn)}
      </span>
    );
  };
  const tags = Object.entries(queue.tags);
  const encryption = queue.kmsKey ? t.kmsKey(queue.kmsKey) : queue.sseManaged ? t.SSE_MANAGED : t.SSE_NONE;
  return (
    <div className="sqs-overview">
      {queue.isDlq && <DlqRedrive profile={profile} region={region} queue={queue} />}
      {queue.error && <div className="notice sqs-read-error" role="status">{`${t.READ_FAILED}: ${queue.error}`}</div>}

      <div className="sqs-stats">
        <Stat label={t.STAT_VISIBLE} value={formatCount(queue.visible)} tone={queue.isDlq && queue.visible > 0 ? "bad" : undefined} />
        <Stat label={t.STAT_IN_FLIGHT} value={formatCount(queue.inFlight)} />
        <Stat label={t.STAT_DELAYED} value={formatCount(queue.delayed)} />
        <Stat label={t.STAT_OLDEST} value={oldest === null || oldest === undefined ? t.NO_DATA : formatDuration(oldest)} title={act ? undefined : t.NO_ACTIVITY} />
        <Stat label={t.STAT_RECEIVED} value={count(act?.received15m)} title={act ? undefined : t.NO_ACTIVITY} />
        <Stat label={t.STAT_EMPTY_RECEIVES} value={count(act?.emptyReceives15m)} title={act ? undefined : t.NO_ACTIVITY} />
      </div>

      <section aria-label={t.FINDINGS_TITLE}>
        <div className="sect">{t.FINDINGS_TITLE}</div>
        <SqsFindings findings={queue.findings} />
      </section>

      <section aria-label={t.ATTRS_TITLE}>
        <div className="sect">{t.ATTRS_TITLE}</div>
        <dl className="sqs-attrs">
          <Attr label={t.ATTR.url}>
            <span className="mono sqs-wrap">{queue.url}</span>
          </Attr>
          <Attr label={t.ATTR.arn}>
            <span className="mono sqs-wrap">{queue.arn}</span>
          </Attr>
          <Attr label={t.ATTR.kind}>{queue.fifo ? t.KIND_FIFO : t.KIND_STANDARD}</Attr>
          <Attr label={t.ATTR.visibility}>{`${t.seconds(queue.visibilityTimeout)} (${formatDuration(queue.visibilityTimeout)})`}</Attr>
          <Attr label={t.ATTR.retention}>{`${t.seconds(queue.retention)} (${formatDuration(queue.retention)})`}</Attr>
          <Attr label={t.ATTR.delay}>{t.seconds(queue.delay)}</Attr>
          <Attr label={t.ATTR.maxSize}>{formatBytes(queue.maxSize)}</Attr>
          <Attr label={t.ATTR.waitTime}>{queue.waitTime === 0 ? `${t.seconds(0)} (${t.SHORT_POLLING})` : t.seconds(queue.waitTime)}</Attr>
          {queue.redrive && (
            <Attr label={t.ATTR.dlq}>
              {link(queue.redrive.dlqArn)} <span className="dim">{t.maxReceive(queue.redrive.maxReceiveCount)}</span>
            </Attr>
          )}
          {queue.sources.length > 0 && (
            <Attr label={t.ATTR.sources}>
              <span className="sqs-links">
                {queue.sources.map((arn) => (
                  <span key={arn}>{link(arn)}</span>
                ))}
              </span>
            </Attr>
          )}
          {queue.redriveAllow && (
            <Attr label={t.ATTR.redriveAllow}>
              <span className="mono sqs-wrap">{queue.redriveAllow}</span>
            </Attr>
          )}
          <Attr label={t.ATTR.encryption}>{encryption}</Attr>
          {queue.fifo && queue.contentDedup !== null && <Attr label={t.ATTR.contentDedup}>{queue.contentDedup ? t.ON : t.OFF}</Attr>}
          {queue.fifo && queue.dedupScope && <Attr label={t.ATTR.dedupScope}>{queue.dedupScope}</Attr>}
          {queue.fifo && queue.throughputLimit && <Attr label={t.ATTR.throughput}>{queue.throughputLimit}</Attr>}
          <Attr label={t.ATTR.created}>{time(queue.createdAt)}</Attr>
          <Attr label={t.ATTR.modified}>{time(queue.modifiedAt)}</Attr>
        </dl>
      </section>

      <section aria-label={t.TAGS_TITLE}>
        <div className="sect">{t.TAGS_TITLE}</div>
        {tags.length === 0 ? (
          <p className="dim">{t.NO_TAGS}</p>
        ) : (
          <div>
            {tags.map(([k, v]) => (
              <span className="tag" key={k}>
                {k}={v}
              </span>
            ))}
          </div>
        )}
      </section>

      <section aria-label={t.POLICY_TITLE}>
        <div className="sect">{t.POLICY_TITLE}</div>
        {queue.policy ? (
          <details className="sqs-policy">
            <summary>{t.POLICY_SHOW}</summary>
            <pre className="mono">{prettyJson(queue.policy)}</pre>
          </details>
        ) : (
          <p className="dim">{t.POLICY_NONE}</p>
        )}
      </section>

      <ResourceMetrics key={`${profile}|${region}|${queue.url}`} profile={profile} region={region} service={SQS_SERVICE} typeId="queues" row={metricsRow(queue)} />
    </div>
  );
}
