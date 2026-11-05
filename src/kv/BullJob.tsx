import type { ReactNode } from "react";
import { DetailPanel } from "../components/DetailPanel";
import type { DetailData } from "../lib/detail";
import { formatMs, parseJobKey, parseQueueKey, progressPercent, STATE_LABEL } from "./bull";
import * as bt from "./bullText";
import { formatUnix } from "./format";
import { KvError } from "./KvError";
import { FlowGraph } from "./graph/FlowGraph";
import { useKvBullFlow, useKvBullJob } from "./queries";
import * as t from "./text";
import type { KvBullJob, KvTarget } from "./types";
import { StringValue } from "./ValueViewer";

const at = (ms: number | null) => (ms === null ? t.DASH : formatUnix(ms / 1000));
const span = (from: number | null, to: number | null) => (from !== null && to !== null && to >= from ? formatMs(to - from) : null);

/** 만듦 → 시작 → 끝 시간선과 구간 길이(대기, 처리). 아직 오지 않은 단계는 줄표다. */
function Timeline({ job }: { job: KvBullJob }) {
  const waited = span(job.timestamp, job.processedOn);
  const processed = span(job.processedOn, job.finishedOn);
  const step = (label: string, ms: number | null) => (
    <li className={`kv-tl-step${ms === null ? " todo" : ""}`}>
      <b>{label}</b>
      <span className="mono">{at(ms)}</span>
    </li>
  );
  return (
    <ol className="kv-timeline" aria-label={bt.TIMELINE}>
      {step(bt.T_CREATED, job.timestamp)}
      <li className="kv-tl-gap dim">{waited ? bt.T_WAITED(waited) : job.delayUntil !== null ? bt.DELAY_UNTIL(at(job.delayUntil)) : ""}</li>
      {step(bt.T_STARTED, job.processedOn)}
      <li className="kv-tl-gap dim">{processed ? bt.T_PROCESSED(processed) : ""}</li>
      {step(bt.T_FINISHED, job.finishedOn)}
    </ol>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="kv-jsect">
      <h4 className="kv-section">
        {title}
        {note && <small className="dim"> · {note}</small>}
      </h4>
      {children}
    </section>
  );
}

const textBytes = (s: string) => new TextEncoder().encode(s).length;

interface Props {
  target: KvTarget;
  prefix: string;
  /** 이 작업이 사는 큐 */
  queue: string;
  id: string;
  onClose: () => void;
  /** 흐름의 부모·자식으로 건너간다(큐가 다를 수 있다) */
  onOpenJob: (queue: string, id: string) => void;
  /** 흐름 그래프를 큐 상세의 화면 전체에 크게 연다 */
  onBigFlow?: (queue: string, id: string) => void;
}

/**
 * 🐂 작업 상세(목록의 70%를 덮는 오른쪽 상세): 시간선, 시도 횟수, 진행률, 데이터·옵션·반환값(JSON 정리), 스택(시도별), 로그, 흐름(부모·자식으로 이동).
 * 값은 화면과 쿼리 캐시에만 있다.
 */
export function BullJob({ target, prefix, queue, id, onClose, onOpenJob, onBigFlow }: Props) {
  const q = useKvBullJob(target, prefix, queue, id);
  const job = q.data;
  // 부모나 자식이 있는 작업만 흐름 그래프를 읽는다(flow 명령은 위·아래로 걸으며 키를 여럿 읽는다)
  const hasFlow = !!job && (job.parent !== null || job.children.length > 0);
  const flow = useKvBullFlow(target, prefix, queue, id, hasFlow);
  const detail: DetailData = {
    title: bt.JOB_TITLE(id, job?.name ?? ""),
    subtitle: bt.JOB_SUBTITLE(queue, job ? STATE_LABEL[job.state] : t.LOADING),
    rows: job
      ? [
          { label: bt.ATTEMPTS, value: String(job.attemptsMade) },
          ...(job.priority ? [{ label: bt.PRIORITY_LABEL, value: String(job.priority) }] : []),
        ]
      : [],
    tags: {},
    copy: { label: bt.JOB_COPY_ID, value: id },
    consoleUrl: null,
    raw: null,
  };
  const pct = job ? progressPercent(job.progress) : null;
  const parentQueue = job?.parent ? parseQueueKey(prefix, job.parent.queueKey) : null;
  return (
    <DetailPanel detail={detail} onShowRaw={() => {}} onClose={onClose}>
      {!job ? (
        q.isError ? (
          <KvError error={q.error} target={target} compact />
        ) : (
          <div className="empty small">{t.LOADING}</div>
        )
      ) : (
        <div className="kv-job">
          <Section title={bt.TIMELINE}>
            <Timeline job={job} />
          </Section>
          {job.failedReason && (
            <div className="kv-jfail" role="alert">
              {job.failedReason}
            </div>
          )}
          {job.progress !== null && (
            <Section title={bt.PROGRESS}>
              {pct !== null ? (
                <span className="kv-prog">
                  <span className="kv-meter" role="progressbar" aria-label={bt.PROGRESS} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                    <span style={{ width: `${pct}%` }} />
                  </span>
                  <span className="mono">{pct}%</span>
                </span>
              ) : (
                <pre className="kv-pre mono">{job.progress}</pre>
              )}
            </Section>
          )}
          <Section title={bt.DATA}>
            <StringValue text={job.data} base64={null} bytes={textBytes(job.data)} truncated={job.dataTruncated} />
          </Section>
          {job.opts !== null && (
            <Section title={bt.OPTS}>
              <StringValue text={job.opts} base64={null} bytes={textBytes(job.opts)} truncated={false} />
            </Section>
          )}
          {job.returnvalue !== null && (
            <Section title={bt.RETURN_VALUE}>
              <StringValue text={job.returnvalue} base64={null} bytes={textBytes(job.returnvalue)} truncated={false} />
            </Section>
          )}
          {job.stacktrace.length > 0 && (
            <Section title={bt.STACKTRACE}>
              {job.stacktrace.map((s, i) => (
                <div key={i}>
                  {job.stacktrace.length > 1 && <small className="dim">{bt.ATTEMPT_N(i + 1)}</small>}
                  <pre className="kv-pre mono">{s}</pre>
                </div>
              ))}
            </Section>
          )}
          {job.logs.length > 0 && (
            <Section title={bt.LOGS} note={bt.LOGS_NOTE}>
              <pre className="kv-pre mono">{job.logs.join("\n")}</pre>
            </Section>
          )}
          {(job.parent || job.children.length > 0) && (
            <Section title={bt.FLOW}>
              {flow.data ? (
                <>
                  <FlowGraph flow={flow.data} onOpen={onOpenJob} />
                  {onBigFlow && (
                    <button type="button" className="btn small kv-flow-open" onClick={() => onBigFlow(queue, id)}>
                      {t.FLOW_BIG}
                    </button>
                  )}
                </>
              ) : flow.isError ? (
                <KvError compact error={flow.error} target={target} />
              ) : (
                <div className="empty small">{t.LOADING}</div>
              )}
              {job.parent && (
                <p className="kv-flow">
                  <span className="dim">{bt.PARENT}</span>{" "}
                  {parentQueue ? (
                    <button type="button" className="link mono" onClick={() => onOpenJob(parentQueue, job.parent!.id)}>
                      {`${job.parent.queueKey}:${job.parent.id}`}
                    </button>
                  ) : (
                    <span className="mono">{`${job.parent.queueKey}:${job.parent.id}`}</span>
                  )}
                </p>
              )}
              {job.children.length > 0 && (
                <table className="kv-table" aria-label={bt.CHILDREN}>
                  <tbody>
                    {job.children.map((c) => {
                      const ref = parseJobKey(prefix, c.key);
                      return (
                        <tr key={c.key}>
                          <td className="mono">
                            {ref ? (
                              <button type="button" className="link mono" onClick={() => onOpenJob(ref.queue, ref.id)}>
                                {c.key}
                              </button>
                            ) : (
                              c.key
                            )}
                          </td>
                          <td>
                            <span className={`iam-chip ${c.done ? "kv-auth-no-password" : "kv-auth-password"}`}>{c.done ? bt.CHILD_DONE : bt.CHILD_PENDING}</span>
                          </td>
                          <td className="mono kv-reason">{c.result ?? ""}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Section>
          )}
        </div>
      )}
    </DetailPanel>
  );
}
