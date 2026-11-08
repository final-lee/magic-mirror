import { useState } from "react";
import { CodeEditor } from "../components/CodeEditor";
import * as t from "./editText";
import { FormSheet } from "./FormSheet";
import type { SnsChangeRequest, SnsPublishAttribute, SnsPublishAttributeType, SnsTopic } from "./types";

const TYPES: SnsPublishAttributeType[] = ["String", "String.Array", "Number"];
const emptyAttribute = (): SnsPublishAttribute => ({ name: "", dataType: "String", value: "" });

interface Props {
  topic: SnsTopic;
  onPreview: (request: SnsChangeRequest) => void;
  onClose: () => void;
}

/** 메시지 속성 행이 모두 이름·값을 가졌는가(빈 행은 무시하되 반만 채운 행은 막는다) */
const attributeProblem = (attrs: SnsPublishAttribute[]) => attrs.some((a) => (a.name.trim() === "") !== (a.value.trim() === ""));

/** MessageStructure=json 메시지: 문자열 `default` 키가 있는 JSON 객체 */
export function structureOk(message: string): boolean {
  try {
    const value = JSON.parse(message) as unknown;
    return typeof value === "object" && value !== null && typeof (value as { default?: unknown }).default === "string";
  } catch {
    return false;
  }
}

/**
 * 시험 발행 입력: 메시지(여러 줄 편집기), 제목, MessageStructure=json, 메시지 속성, FIFO 주제의 그룹 ID·중복 제거 ID.
 * FIFO는 그룹 ID가 필요하고, 내용 기반 중복 제거가 꺼져 있으면 중복 제거 ID도 필요하다. 고르는 것만 하고 아무것도 보내지 않는다.
 */
export function PublishForm({ topic, onPreview, onClose }: Props) {
  const [message, setMessage] = useState("");
  const [subject, setSubject] = useState("");
  const [structure, setStructure] = useState(false);
  const [attributes, setAttributes] = useState<SnsPublishAttribute[]>([]);
  const [group, setGroup] = useState("");
  const [dedup, setDedup] = useState("");
  const fifo = topic.fifo;
  const auto = topic.overview.contentBasedDeduplication;

  const update = (index: number, patch: Partial<SnsPublishAttribute>) => setAttributes((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const blocked =
    message.trim() === ""
      ? t.PUBLISH_NEED_MESSAGE
      : structure && !structureOk(message)
        ? t.PUBLISH_BAD_STRUCTURE
        : attributeProblem(attributes)
          ? t.PUBLISH_BAD_ATTR
          : fifo && group.trim() === ""
            ? t.PUBLISH_NEED_GROUP
            : fifo && !auto && dedup.trim() === ""
              ? t.PUBLISH_NEED_DEDUP
              : null;

  const preview = () =>
    onPreview({
      kind: "publish",
      topicArn: topic.arn,
      message,
      subject: subject.trim() === "" ? null : subject.trim(),
      messageStructureJson: structure,
      attributes: attributes.filter((a) => a.name.trim() !== "").map((a) => ({ ...a, name: a.name.trim() })),
      messageGroupId: fifo && group.trim() !== "" ? group.trim() : null,
      deduplicationId: fifo && dedup.trim() !== "" ? dedup.trim() : null,
    });

  return (
    <FormSheet title={t.PUBLISH_TITLE} onPreview={preview} onClose={onClose} blocked={blocked}>
      <div className="field">
        {t.PUBLISH_MESSAGE}
        <CodeEditor value="" onChange={setMessage} label={t.PUBLISH_MESSAGE} language="text" minHeight="110px" />
      </div>
      <label className="field">
        {t.PUBLISH_SUBJECT}
        <input className="field-input" aria-label={t.PUBLISH_SUBJECT} value={subject} onChange={(e) => setSubject(e.target.value)} />
      </label>
      <label className="sns-check">
        <input type="checkbox" checked={structure} onChange={(e) => setStructure(e.target.checked)} /> {t.PUBLISH_STRUCTURE}
      </label>
      {structure && <p className="sns-note dim">{t.PUBLISH_STRUCTURE_NOTE}</p>}

      {fifo && (
        <>
          <label className="field">
            {t.PUBLISH_GROUP}
            <input className="field-input mono" aria-label={t.PUBLISH_GROUP} value={group} onChange={(e) => setGroup(e.target.value)} />
          </label>
          <label className="field">
            {t.PUBLISH_DEDUP}
            <input className="field-input mono" aria-label={t.PUBLISH_DEDUP} value={dedup} onChange={(e) => setDedup(e.target.value)} />
            <span className="dim">{auto ? t.PUBLISH_DEDUP_AUTO : t.PUBLISH_DEDUP_NEEDED}</span>
          </label>
        </>
      )}

      <div className="field">
        {t.PUBLISH_ATTRIBUTES}
        {attributes.map((a, i) => (
          <div key={i} className="sns-attr-row">
            <input className="field-input" aria-label={`속성 이름 ${i + 1}`} placeholder="이름" value={a.name} onChange={(e) => update(i, { name: e.target.value })} />
            <select className="field-input" aria-label={`속성 타입 ${i + 1}`} value={a.dataType} onChange={(e) => update(i, { dataType: e.target.value as SnsPublishAttributeType })}>
              {TYPES.map((type) => (
                <option key={type}>{type}</option>
              ))}
            </select>
            <input className="field-input" aria-label={`속성 값 ${i + 1}`} placeholder="값" value={a.value} onChange={(e) => update(i, { value: e.target.value })} />
            <button type="button" className="btn small tone-secondary" onClick={() => setAttributes((rows) => rows.filter((_, n) => n !== i))}>
              {t.PUBLISH_ATTR_REMOVE}
            </button>
          </div>
        ))}
        <div>
          <button type="button" className="btn small tone-secondary" disabled={attributes.length >= 10} title={attributes.length >= 10 ? "속성은 최대 10개까지 추가할 수 있어요" : undefined} onClick={() => setAttributes((rows) => [...rows, emptyAttribute()])}>
            {t.PUBLISH_ATTR_ADD}
          </button>
        </div>
      </div>
      <p className="sns-note dim">{t.PUBLISH_LOG_NOTE}</p>
    </FormSheet>
  );
}
