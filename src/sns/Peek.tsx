import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage } from "../api/errors";
import type { AppError } from "../api/types";
import { ErrorState } from "../components/ErrorState";
import { ConfirmField, useSheetFocus } from "../iam/previewParts";
import { JsonView } from "./JsonView";
import { peekApi, usePeekSession, type PeekMessage, type PeekVerdict } from "./peekSession";
import type { SnsTopicRef } from "./targets";

const HOW = "받은 메시지는 30초 동안 다른 곳에서 안 보이고 수신 횟수가 1 올라요. 지우지 않고, 다 보거나 멈추면 바로 돌려놓아요.";

const STATUS_TEXT = {
  idle: "",
  starting: "엿보기를 시작하고 있어요",
  running: "받고 있어요",
  stopping: "멈추고 메시지를 돌려놓고 있어요",
  done: "끝났어요. 받은 메시지는 다시 보이게 돌려놓았어요",
  error: "엿보기가 멈췄어요",
} as const;

export const peekKey = (profile: string, region: string, arn: string) => ["sns", "peek", profile, region, arn] as const;

function parseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function MessageCard({ m }: { m: PeekMessage }) {
  const body = parseJson(m.body);
  const hasAttributes = m.attributes !== null && typeof m.attributes === "object" && Object.keys(m.attributes as object).length > 0;
  return (
    <article className="sns-peek-msg" aria-label={`메시지 ${m.snsMessageId ?? m.messageId}`}>
      <header className="sns-peek-msg-head">
        <span className="mono">{m.snsMessageId ?? m.messageId}</span>
        {m.timestamp && <span className="dim">{m.timestamp}</span>}
      </header>
      {m.failureLines.length > 0 && (
        <div className="sns-peek-failures">
          <p className="err">배달 실패 로그 {m.failureLines.length}줄</p>
          {m.failureLines.map((line, i) => {
            const parsed = parseJson(line);
            return parsed === undefined ? (
              <pre key={i} className="raw">
                {line}
              </pre>
            ) : (
              <JsonView key={i} value={parsed} label="배달 실패 로그" />
            );
          })}
        </div>
      )}
      {body === undefined ? (
        <pre className="raw sns-json" aria-label="본문">
          {m.body}
        </pre>
      ) : (
        <JsonView value={body} label="본문" />
      )}
      {hasAttributes && <JsonView value={m.attributes} label="메시지 속성" />}
    </article>
  );
}

/** 엿보기 시작 전 확인. 무엇이 바뀌는지 적고, 경고가 있으면 큐 이름을 입력해야 시작한다 */
function StartSheet({ verdict, onCancel, onStart }: { verdict: PeekVerdict; onCancel: () => void; onStart: (follow: boolean, confirmedName: string | null) => void }) {
  const [typed, setTyped] = useState("");
  const [follow, setFollow] = useState(false);
  const { sheetRef, trapTab, cancelRef } = useSheetFocus("ready", onCancel);
  const title = `${verdict.queueName} 엿보기`;
  const gated = verdict.warning !== null && typed !== verdict.queueName;
  return (
    <div className="modal">
      <div className="sheet cp" role="dialog" aria-modal="true" aria-label={title} ref={sheetRef} onKeyDown={trapTab}>
        <div className="cp-body">
          <h3>{title}</h3>
          <p>{HOW}</p>
          <ul className="sns-peek-calls mono dim">
            <li>sqs:ReceiveMessage (VisibilityTimeout 30, 최대 100개)</li>
            <li>sqs:ChangeMessageVisibilityBatch (0으로 돌려놓기)</li>
          </ul>
          {verdict.warning && <p className="cp-stale">{verdict.warning}</p>}
          {!verdict.dlq && (
            <label className="sns-peek-follow">
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> 계속 보기(20초씩 기다리며 새 메시지를 받아요)
            </label>
          )}
          {verdict.warning && <ConfirmField required={verdict.queueName} typed={typed} onTyped={setTyped} locked={false} />}
        </div>
        <div className="foot">
          <button ref={cancelRef} className="btn plain tone-ghost" onClick={onCancel}>
            취소
          </button>
          <button className="btn plain tone-primary" disabled={gated} title={gated ? "큐 이름을 입력하세요" : undefined} onClick={() => onStart(follow, verdict.warning ? typed : null)}>
            엿보기 시작
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 큐 엿보기: 이 주제의 DLQ와 소비자 없는 구독 큐에서만 메시지를 받아 보여 준다(임시 큐는 만들지 않는다).
 * 판정은 지표를 읽어서 하므로 저절로 다시 하지 않는다([다시 판정]).
 */
export function Peek({ target, focusQueue }: { target: SnsTopicRef; focusQueue?: string }) {
  const query = useQuery<PeekVerdict[], AppError>({
    queryKey: peekKey(target.profile, target.region, target.topicArn),
    queryFn: () => peekApi.eligibility(target.profile, target.region, target.topicArn),
    staleTime: Infinity,
    retry: false,
  });
  const { state, start, stop } = usePeekSession(target.profile, target.region, target.topicArn);
  const [confirming, setConfirming] = useState<PeekVerdict | null>(null);
  const busy = state.status === "starting" || state.status === "running" || state.status === "stopping";
  const peeking = query.data?.find((v) => v.queueArn === state.queueArn) ?? null;

  if (query.isError) return <ErrorState error={query.error} profile={target.profile} onRetry={() => void query.refetch()} />;

  return (
    <section className="center sns-pane" aria-label="큐 엿보기">
      <div className="sns-pane-head">
        <h2>큐 엿보기</h2>
        <div className="sns-pane-tools">
          <button className="btn small tone-refresh" disabled={query.isFetching || busy} title={query.isFetching ? "판정하고 있어요" : busy ? "엿보기가 진행 중이에요" : undefined} onClick={() => void query.refetch()}>
            다시 판정
          </button>
        </div>
      </div>
      <p className="dim">DLQ와 소비자가 없는 구독 큐만 엿볼 수 있어요. {HOW}</p>
      {!query.data ? (
        <div className="empty" role="status">
          엿볼 수 있는 큐를 판정하고 있어요
        </div>
      ) : query.data.length === 0 ? (
        <p className="dim">이 주제에 연결된 SQS 큐가 없어요</p>
      ) : (
        <table className="sns-table">
          <thead>
            <tr>
              <th className="nosort">큐</th>
              <th className="nosort">종류</th>
              <th className="nosort">판정</th>
              <th className="nosort" />
            </tr>
          </thead>
          <tbody>
            {query.data.map((v) => (
              <tr key={v.queueArn} className={v.queueArn === focusQueue ? "sns-peek-focus" : undefined}>
                <td className="mono">{v.queueName}</td>
                <td className="sns-nowrap">{v.dlq ? "DLQ" : "구독 큐"}</td>
                <td>{v.eligible ? (v.warning ? <span className="sns-peek-warn">{v.warning}</span> : "엿볼 수 있어요") : <span className="dim">{v.reason}</span>}</td>
                <td className="sns-nowrap">
                  <button
                    className="btn small tone-primary"
                    disabled={!v.eligible || busy}
                    title={!v.eligible ? (v.reason ?? undefined) : busy ? "다른 엿보기가 진행 중이에요" : undefined}
                    onClick={() => setConfirming(v)}
                  >
                    {v.dlq ? "DLQ 엿보기…" : "큐 엿보기…"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {state.status !== "idle" && (
        <div className="sns-peek-session" aria-label="엿보기 결과">
          <div className="sns-pane-head">
            <h3>{peeking?.queueName ?? state.queueArn}</h3>
            <span className="dim" role="status">
              {STATUS_TEXT[state.status]} · {state.messages.length}개
            </span>
            {busy && (
              <div className="sns-pane-tools">
                <button className="btn small tone-caution" disabled={state.status !== "running"} title={state.status === "starting" ? "엿보기를 시작하고 있어요" : state.status === "stopping" ? "멈추고 있어요" : undefined} onClick={() => void stop()}>
                  멈추기
                </button>
              </div>
            )}
          </div>
          {state.status === "error" && state.error != null && (
            <p className="err" role="alert">
              {errorMessage(state.error)}
            </p>
          )}
          {state.messages.length === 0 && !busy && state.status !== "error" && <p className="dim">받은 메시지가 없어요</p>}
          {state.messages.map((m) => (
            <MessageCard key={m.messageId} m={m} />
          ))}
        </div>
      )}

      {confirming && (
        <StartSheet
          verdict={confirming}
          onCancel={() => setConfirming(null)}
          onStart={(follow, confirmedName) => {
            const v = confirming;
            setConfirming(null);
            void start(v.queueArn, follow && !v.dlq, confirmedName).then(async (error) => {
              if (!error) return;
              const refreshed = await query.refetch();
              const fresh = refreshed.data?.find((item) => item.queueArn === v.queueArn);
              const warning = "warning" in error && typeof error.warning === "string" ? error.warning : "소비자 활동이 감지됐어요";
              setConfirming({ ...(fresh ?? v), warning });
            });
          }}
        />
      )}
    </section>
  );
}
