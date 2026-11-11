import { useState } from "react";
import { changeTone } from "./change";
import * as t from "./editText";
import { JsonEditPane } from "./JsonEditPane";
import { LoggingForm } from "./LoggingForm";
import type { SnsTopicRef } from "./targets";
import type { DeliveryLogging, SnsTopic } from "./types";
import { useSnsChange } from "./useSnsChange";

/** 프로토콜 하나의 배달 상태 로깅 설정 창 */
export function LoggingEdit({ target, logging }: { target: SnsTopicRef; logging: DeliveryLogging }) {
  const [form, setForm] = useState(false);
  const { start, dialog } = useSnsChange(target);
  return (
    <>
      <button type="button" className={`btn small ${changeTone({ kind: "deliveryLogging" })}`} aria-label={`${logging.protocol} 배달 상태 로깅 설정…`} onClick={() => setForm(true)}>
        로깅 설정…
      </button>
      {form && (
        <LoggingForm
          target={target}
          logging={logging}
          onClose={() => setForm(false)}
          onPreview={(request) => {
            setForm(false);
            start(request);
          }}
        />
      )}
      {dialog}
    </>
  );
}

/** 속성에 든 JSON 글을 편집기용으로 들여쓴다(JSON이 아니면 그대로) */
function pretty(text: string | undefined): string {
  if (!text) return "";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** 주제의 HTTP(S) 배달 정책(`DeliveryPolicy`) 편집. [편집](보조) → 편집기 → [미리 보기…](실행) */
export function TopicDeliveryEdit({ target, topic }: { target: SnsTopicRef; topic: SnsTopic }) {
  const [editing, setEditing] = useState(false);
  const { start, dialog } = useSnsChange(target);
  if (!editing) {
    return (
      <div className="sns-edit-slot">
        <button type="button" className="btn small tone-secondary" aria-label={t.EDIT_DELIVERY} onClick={() => setEditing(true)}>
          {t.EDIT}
        </button>
        {dialog}
      </div>
    );
  }
  return (
    <>
      <p className="sns-note dim">{t.DELIVERY_NOTE}</p>
      <JsonEditPane
        label={t.DELIVERY_EDITOR}
        initial={pretty(topic.attributes.DeliveryPolicy)}
        allowEmpty
        emptyHint={t.EDITOR_EMPTY_HINT_DELIVERY}
        onCancel={() => setEditing(false)}
        onPreview={(text) => start({ kind: "topicDeliveryPolicy", topicArn: target.topicArn, deliveryPolicy: text }, { onApplied: () => setEditing(false) })}
      />
      {dialog}
    </>
  );
}
