import { useState } from "react";
import { changeTone } from "./change";
import { FilterImpact } from "./ChangeExtras";
import * as t from "./editText";
import { JsonEditPane } from "./JsonEditPane";
import { snsTabId, type SnsTopicRef } from "./targets";
import type { SnsFilterScope, SnsSubscription } from "./types";
import { useSnsChange } from "./useSnsChange";

/** 속성에 든 JSON 글을 편집기용으로 들여쓴다(JSON이 아니면 그대로) */
function pretty(text: string | undefined): string {
  if (!text) return "";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

interface Props {
  sub: SnsSubscription;
  target: SnsTopicRef;
}

/**
 * 필터 정책 편집: [편집](보조)이 같은 자리에서 편집기로 바뀌고, [미리 보기…](실행)가 변경 대화창을 연다.
 * 대화창에는 필터 시험 화면의 최근 표본을 지금 정책과 바꾼 정책으로 판정한 결과가 붙는다.
 */
export function FilterEdit({ sub, target }: Props) {
  const [editing, setEditing] = useState(false);
  const current: SnsFilterScope = sub.attributes.FilterPolicyScope === "MessageBody" ? "MessageBody" : "MessageAttributes";
  const [scope, setScope] = useState<SnsFilterScope>(current);
  const { start, dialog } = useSnsChange(target);
  const arn = sub.arn;
  if (!editing) {
    return (
      <>
        <button type="button" className="btn small tone-secondary" aria-label={t.EDIT_FILTER} disabled={arn === null} title={arn === null ? t.EDIT_WHY_PENDING : undefined} onClick={() => setEditing(true)}>
          {t.EDIT}
        </button>
        {dialog}
      </>
    );
  }
  return (
    <>
      <JsonEditPane
        label={t.FILTER_EDITOR}
        initial={pretty(sub.attributes.FilterPolicy)}
        allowEmpty
        emptyHint={t.EDITOR_EMPTY_HINT_FILTER}
        onCancel={() => setEditing(false)}
        onPreview={(text) =>
          arn !== null &&
          start(
            { kind: "filterPolicy", subscriptionArn: arn, filterPolicy: text, scope },
            {
              renderExtra: (plan) => <FilterImpact plan={plan} tabId={snsTabId(target)} current={{ policy: sub.attributes.FilterPolicy ?? null, scope: current }} />,
              onApplied: () => setEditing(false),
            },
          )
        }
      >
        <label className="field">
          {t.SUBSCRIBE_SCOPE}
          <select className="field-input" aria-label={t.SUBSCRIBE_SCOPE} value={scope} onChange={(e) => setScope(e.target.value as SnsFilterScope)}>
            {(["MessageAttributes", "MessageBody"] as const).map((s) => (
              <option key={s} value={s}>
                {t.SCOPE_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
      </JsonEditPane>
      {dialog}
    </>
  );
}

/** HTTP(S) 구독의 배달 정책 편집. [편집](보조) → 편집기 → [미리 보기…](실행) */
export function DeliveryEdit({ sub, target }: Props) {
  const [editing, setEditing] = useState(false);
  const { start, dialog } = useSnsChange(target);
  const http = sub.protocol === "http" || sub.protocol === "https";
  const arn = sub.arn;
  const off = !http ? t.EDIT_WHY_PROTOCOL : arn === null ? t.EDIT_WHY_PENDING : null;
  if (!editing) {
    return (
      <>
        <button type="button" className="btn small tone-secondary" aria-label={t.EDIT_DELIVERY} disabled={off !== null} title={off ?? undefined} onClick={() => setEditing(true)}>
          {t.EDIT}
        </button>
        {dialog}
      </>
    );
  }
  return (
    <>
      <p className="sns-note dim">{t.DELIVERY_NOTE}</p>
      <JsonEditPane
        label={t.DELIVERY_EDITOR}
        initial={pretty(sub.attributes.DeliveryPolicy)}
        allowEmpty
        emptyHint={t.EDITOR_EMPTY_HINT_DELIVERY}
        onCancel={() => setEditing(false)}
        onPreview={(text) => arn !== null && start({ kind: "subscriptionDeliveryPolicy", subscriptionArn: arn, deliveryPolicy: text }, { onApplied: () => setEditing(false) })}
      />
      {dialog}
    </>
  );
}

/** raw 전달 켜기/끄기. 같은 자리에서 라벨만 바뀌는 토글이라 한 색(노랑, `tone-warn`)이고, 눌러서 변경 대화창을 연다 */
export function RawToggle({ sub, target }: Props) {
  const { start, dialog } = useSnsChange(target);
  const supported = sub.protocol === "sqs" || sub.protocol === "http" || sub.protocol === "https";
  const arn = sub.arn;
  const off = !supported ? t.RAW_WHY_PROTOCOL : arn === null ? t.EDIT_WHY_PENDING : null;
  return (
    <>
      <button type="button" className={`btn small ${changeTone({ kind: "rawDelivery" })}`} disabled={off !== null} title={off ?? undefined} onClick={() => arn !== null && start({ kind: "rawDelivery", subscriptionArn: arn, enabled: !sub.raw })}>
        {sub.raw ? t.RAW_TURN_OFF : t.RAW_TURN_ON}
      </button>
      {dialog}
    </>
  );
}

/** 구독 해지. 없애기라 빨강(`tone-danger`)이고 줄의 맨 끝에 둔다 */
export function UnsubscribeButton({ sub, target, small = true }: Props & { small?: boolean }) {
  const { start, dialog } = useSnsChange(target);
  const arn = sub.arn;
  return (
    <>
      <button
        type="button"
        className={`btn${small ? " small" : ""} ${changeTone({ kind: "unsubscribe" })}`}
        disabled={arn === null}
        title={arn === null ? t.UNSUBSCRIBE_WHY_PENDING : undefined}
        onClick={(e) => {
          e.stopPropagation();
          if (arn !== null) start({ kind: "unsubscribe", subscriptionArn: arn });
        }}
      >
        {t.UNSUBSCRIBE_OPEN}
      </button>
      {dialog}
    </>
  );
}
