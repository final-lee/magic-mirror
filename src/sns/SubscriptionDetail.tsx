import { useState, type ReactNode } from "react";
import { errorMessage } from "../api/errors";
import { RawModal } from "../components/RawModal";
import { dlqName, endpointLabel, parseJsonText, STATE_LABEL } from "./format";
import { JsonView } from "./JsonView";
import { resourceJumpOf, type ResourceJump } from "./targets";
import * as t from "./text";
import type { SnsSubscription, SnsTopic } from "./types";
import { ReplayControls } from "./ReplayControls";
import { DeliveryEdit, FilterEdit, RawToggle, UnsubscribeButton } from "./SubscriptionEdits";
import { changeTone } from "./change";
import { DlqPicker } from "./DlqPicker";
import { useSnsChange } from "./useSnsChange";
import type { SnsTopicRef } from "./targets";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="sns-section" aria-label={title}>
      <h4 className="sns-heading">{title}</h4>
      {children}
    </section>
  );
}

function targetSentence(sub: SnsSubscription): string | null {
  const target = sub.target;
  if (!target) return null;
  return target.kind === "sqs" ? t.SQS_TARGET(target.fifo, target.kmsKey) : t.LAMBDA_TARGET;
}

/**
 * 구독 상세: 속성 전부, 필터 정책 JSON(칠해서), DLQ, 배달 정책, 엔드포인트의 리소스 브라우저 행으로 가는 버튼.
 * 확인 대기 구독은 속성을 읽을 수 없어서 그 이유를 적는다.
 */
export function SubscriptionDetail({ topic, subscriptionKey, onBack, onOpenResource, snsTarget }: { topic: SnsTopic; subscriptionKey: string; onBack: () => void; onOpenResource?: (jump: ResourceJump) => void; snsTarget?: SnsTopicRef }) {
  const [showRaw, setShowRaw] = useState(false);
  const sub = topic.subscriptions.find((s) => s.key === subscriptionKey);
  if (!sub) {
    return (
      <section className="center sns-pane" aria-label={t.SUB_LABEL}>
        <div className="empty small">{t.SUB_MISSING}</div>
        <div className="sns-pane-head">
          <button className="btn small tone-nav" onClick={onBack}>
            {t.SUB_BACK}
          </button>
        </div>
      </section>
    );
  }

  const label = endpointLabel(sub, topic);
  const attributes = Object.entries(sub.attributes).sort(([a], [b]) => a.localeCompare(b));
  const hasAttributes = attributes.length > 0;
  const summary = sub.summary;
  const dlq = dlqName(sub);
  const delivery = parseJsonText(sub.attributes.DeliveryPolicy);
  const target = sub.target;
  const resourceKind = sub.protocol === "sqs" || sub.protocol === "lambda" ? sub.protocol : null;
  // SQS 행의 ID는 큐 URL이라 엔드포인트를 읽지 못해 URL을 모르면 행을 가리킬 수 없다
  const resolved = target !== null && !(target.kind === "sqs" && !target.url);
  const jump = resolved ? resourceJumpOf(target, topic.account) : null;
  const jumpOff = !resolved ? t.OPEN_RESOURCE_UNRESOLVED : !jump ? t.OPEN_RESOURCE_OTHER_ACCOUNT : null;

  return (
    <section className="center sns-pane" aria-label={t.SUB_LABEL}>
      <div className="sns-pane-head">
        <span className="sns-ident">
          <span className="iam-chip">{sub.protocol}</span>
          <b className="mono">{label.name}</b>
          {label.where && <span className="dim">{label.where}</span>}
          <span className={`sns-state ${sub.state}`}>{STATE_LABEL[sub.state]}</span>
        </span>
        <span className="sns-pane-tools">
          {resourceKind && (
            <button className="btn small tone-nav" disabled={jumpOff !== null} title={jumpOff ?? undefined} onClick={() => jump && onOpenResource?.(jump)}>
              {t.OPEN_RESOURCE[resourceKind]}
            </button>
          )}
          {hasAttributes && (
            <button className="btn small tone-secondary" onClick={() => setShowRaw(true)}>
              {t.SHOW_RAW}
            </button>
          )}
          {snsTarget && <UnsubscribeButton sub={sub} target={snsTarget} />}
        </span>
      </div>

      {sub.state === "pending" && (
        <p className="sns-note" role="note">
          {t.PENDING_NOTE}
        </p>
      )}
      {sub.state === "unknown" && (
        <p className="sns-note" role="note">
          {t.UNKNOWN_NOTE}
        </p>
      )}
      {sub.error && (
        <p className="sns-note sns-error" role="note">
          {errorMessage(sub.error)}
        </p>
      )}
      {snsTarget && <ReplayControls topic={topic} sub={sub} target={snsTarget} />}

      <Section title={t.SECTION_ENDPOINT}>
        <dl className="sns-values">
          <div><dt>주소</dt><dd className="mono">{sub.endpoint}</dd></div>
          {targetSentence(sub) && <div><dt>유형</dt><dd>{targetSentence(sub)}</dd></div>}
          {target?.error && <div><dt>읽기 오류</dt><dd className="sns-error">{`${t.TARGET_ERROR}: ${errorMessage(target.error)}`}</dd></div>}
          {target?.kind === "sqs" && target.kmsKey && <div><dt>KMS 키</dt><dd className="mono">{target.kmsKey}</dd></div>}
        </dl>
      </Section>

      {hasAttributes && (
        <>
          <Section title={t.SECTION_FILTER}>
            {sub.filter === null ? (
              <p className="sns-note">{t.FILTER_NONE_SENTENCE}</p>
            ) : (
              <>
                <p className="sns-note">
                  <span className="iam-chip">{t.FILTER_SCOPE[sub.filter.scope]}</span> <span className="mono">{summary}</span>
                </p>
                <JsonView value={sub.filter.policy} label={t.SECTION_FILTER} />
              </>
            )}
            {snsTarget && (
              <div className="sns-edit-slot">
                <FilterEdit sub={sub} target={snsTarget} />
              </div>
            )}
          </Section>

          <Section title={t.SECTION_DLQ}>
            {sub.dlqArn === null ? (
              <p className="sns-note">{t.DLQ_SENTENCE_NONE}</p>
            ) : (
              <dl className="sns-values">
                <div><dt>큐</dt><dd className="mono">{dlq}</dd></div>
                <div><dt>ARN</dt><dd className="mono">{sub.dlqArn}</dd></div>
              </dl>
            )}
            {snsTarget && <DlqReplacement target={snsTarget} topic={topic} sub={sub} />}
          </Section>

          <Section title={t.SECTION_DELIVERY}>
            <p className="sns-note">{t.RAW_SENTENCE(sub.raw)}</p>
            {delivery !== null && <JsonView value={delivery} label={t.SECTION_DELIVERY} />}
            {snsTarget && (
              <div className="sns-edit-slot">
                <RawToggle sub={sub} target={snsTarget} />
                <DeliveryEdit sub={sub} target={snsTarget} />
              </div>
            )}
          </Section>
        </>
      )}

      {hasAttributes && (
        <Section title={t.SECTION_ATTRIBUTES}>
          <table className="sns-table" aria-label={t.SECTION_ATTRIBUTES}>
            <thead>
              <tr>
                <th scope="col" className="nosort">
                  {t.ATTRIBUTE_COLS.key}
                </th>
                <th scope="col" className="nosort">
                  {t.ATTRIBUTE_COLS.value}
                </th>
              </tr>
            </thead>
            <tbody>
              {attributes.map(([key, value]) => (
                <tr key={key}>
                  <td className="mono sns-nowrap">{key}</td>
                  <td className="mono">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
      {showRaw && <RawModal title={label.name} text={JSON.stringify(sub.attributes, null, 2)} onClose={() => setShowRaw(false)} />}
    </section>
  );
}

function DlqReplacement({ target, topic, sub }: { target: SnsTopicRef; topic: SnsTopic; sub: SnsSubscription }) {
  const [picking, setPicking] = useState(false);
  const change = useSnsChange(target);
  return <>
    <button className={`btn small ${changeTone({ kind: "addDlq" })}`} disabled={!sub.arn} title={!sub.arn ? "확인 대기 중인 구독은 바꿀 수 없어요" : undefined} onClick={() => setPicking(true)}>DLQ 바꾸기…</button>
    {picking && <DlqPicker target={target} topic={topic} subscription={sub} onClose={() => setPicking(false)} onPick={(dlqArn) => {
      setPicking(false);
      if (sub.arn) change.start({ kind: "addDlq", subscriptionArn: sub.arn, dlqArn });
    }} />}
    {change.dialog}
  </>;
}
