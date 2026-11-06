import { useMemo, useState } from "react";
import { useResources } from "../api/queries";
import type { ServiceInfo } from "../api/types";
import { CodeEditor } from "../components/CodeEditor";
import { changeTone } from "./change";
import { dlqMustBeFifo, SQS_QUEUES, SQS_SERVICE } from "./dlq";
import * as t from "./editText";
import { FormSheet } from "./FormSheet";
import { jsonProblem } from "./JsonEditPane";
import { arnScope, type SnsTopicRef } from "./targets";
import type { SnsChangeRequest, SnsFilterScope, SnsSubscribeProtocol, SnsTopic } from "./types";

const LAMBDA_SERVICE: ServiceInfo = { id: "lambda", name: "Lambda", global: false, types: [] };
const LAMBDA_FUNCTIONS = "functions";

export const SUBSCRIBE_PROTOCOLS: SnsSubscribeProtocol[] = ["sqs", "lambda", "https", "http", "email", "email-json"];
const RAW_PROTOCOLS: SnsSubscribeProtocol[] = ["sqs", "http", "https"];
const DLQ_PROTOCOLS: SnsSubscribeProtocol[] = ["sqs", "lambda", "http", "https"];

interface Props {
  target: SnsTopicRef;
  topic: SnsTopic;
  /** [미리 보기…]: 입력으로 변경 대화창을 연다 */
  onPreview: (request: SnsChangeRequest) => void;
  onClose: () => void;
}

/**
 * 구독 만들기 입력: 프로토콜, 엔드포인트(SQS 큐·Lambda 함수는 이 리전의 목록에서 고르고, 다른 계정·리전은 ARN을 직접 넣는다),
 * 속성(필터 정책·범위, raw 전달, DLQ). 고르는 것만 하고 아무것도 바꾸지 않는다: [미리 보기…]가 변경 대화창으로 이어진다.
 */
export function SubscribeForm({ target, topic, onPreview, onClose }: Props) {
  const [protocol, setProtocol] = useState<SnsSubscribeProtocol>("sqs");
  const [picked, setPicked] = useState("");
  const [typed, setTyped] = useState("");
  const [filter, setFilter] = useState("");
  const [scope, setScope] = useState<SnsFilterScope>("MessageAttributes");
  const [raw, setRaw] = useState(false);
  const [dlq, setDlq] = useState("");
  const queues = useResources(target.profile, target.region, SQS_SERVICE, SQS_QUEUES);
  const functions = useResources(target.profile, target.region, LAMBDA_SERVICE, LAMBDA_FUNCTIONS, protocol === "lambda");
  const listed = protocol === "sqs" ? queues : protocol === "lambda" ? functions : null;
  const own = useMemo(() => (listed?.data?.items ?? []).filter((r) => r.arn).map((r) => ({ arn: r.arn!, name: r.name })), [listed?.data]);
  // 이 주제의 DLQ는 주제와 같은 종류(FIFO 주제는 FIFO 큐)여야 하고, 같은 계정·리전이어야 한다
  const dlqChoices = useMemo(
    () => (queues.data?.items ?? []).filter((r) => r.arn && arnScope(r.arn).account === topic.account && arnScope(r.arn).region === topic.region && r.arn.endsWith(".fifo") === dlqMustBeFifo(topic)).map((r) => ({ arn: r.arn!, name: r.name })),
    [queues.data, topic],
  );

  const listedProtocol = protocol === "sqs" || protocol === "lambda";
  const endpoint = (listedProtocol ? (typed.trim() !== "" ? typed.trim() : picked) : typed.trim()).trim();
  const rawOk = RAW_PROTOCOLS.includes(protocol);
  const dlqOk = DLQ_PROTOCOLS.includes(protocol);
  const filterState = jsonProblem(filter);
  const foreign = listedProtocol && endpoint !== "" && !own.some((o) => o.arn === endpoint);

  const blocked = endpoint === "" ? t.SUBSCRIBE_NEED_ENDPOINT : filterState.kind === "bad" ? t.SUBSCRIBE_BAD_FILTER(filterState.message) : null;

  const changeProtocol = (next: SnsSubscribeProtocol) => {
    setProtocol(next);
    setPicked("");
    setTyped("");
    if (!RAW_PROTOCOLS.includes(next)) setRaw(false);
    if (!DLQ_PROTOCOLS.includes(next)) setDlq("");
  };

  const preview = () =>
    onPreview({
      kind: "subscribe",
      topicArn: target.topicArn,
      protocol,
      endpoint,
      filterPolicy: filterState.kind === "ok" ? filter : null,
      filterPolicyScope: filterState.kind === "ok" ? scope : null,
      rawMessageDelivery: rawOk && raw,
      dlqArn: dlqOk && dlq !== "" ? dlq : null,
    });

  const freeLabel = protocol === "email" || protocol === "email-json" ? t.SUBSCRIBE_EMAIL : t.SUBSCRIBE_URL;

  return (
    <FormSheet title={t.SUBSCRIBE_TITLE} tone={changeTone({ kind: "subscribe" })} onPreview={preview} onClose={onClose} blocked={blocked}>
      <label className="field">
        {t.SUBSCRIBE_PROTOCOL}
        <select className="field-input" aria-label={t.SUBSCRIBE_PROTOCOL} value={protocol} onChange={(e) => changeProtocol(e.target.value as SnsSubscribeProtocol)}>
          {SUBSCRIBE_PROTOCOLS.map((p) => (
            <option key={p} value={p}>
              {t.PROTOCOL_LABEL[p]}
            </option>
          ))}
        </select>
      </label>

      {listedProtocol ? (
        <>
          <label className="field">
            {t.SUBSCRIBE_PICK}
            <select className="field-input" aria-label={t.SUBSCRIBE_PICK} value={picked} disabled={typed.trim() !== ""} onChange={(e) => setPicked(e.target.value)}>
              <option value="">{listed?.data ? t.SUBSCRIBE_PICK_NONE : t.SUBSCRIBE_LOADING}</option>
              {own.map((o) => (
                <option key={o.arn} value={o.arn}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {t.SUBSCRIBE_ARN_OTHER}
            <input className="field-input mono" aria-label={t.SUBSCRIBE_ARN_OTHER} value={typed} placeholder={protocol === "sqs" ? "arn:aws:sqs:…" : "arn:aws:lambda:…"} onChange={(e) => setTyped(e.target.value)} />
          </label>
          {foreign && <p className="sns-note dim">{t.SUBSCRIBE_OTHER_NOTE}</p>}
        </>
      ) : (
        <label className="field">
          {freeLabel}
          <input className="field-input mono" aria-label={freeLabel} value={typed} placeholder={protocol === "https" ? "https://…" : protocol === "http" ? "http://…" : "name@example.com"} onChange={(e) => setTyped(e.target.value)} />
        </label>
      )}
      {(protocol === "email" || protocol === "email-json" || protocol === "http" || protocol === "https") && <p className="sns-note dim">{t.SUBSCRIBE_PENDING}</p>}

      <div className="field">
        {t.SUBSCRIBE_FILTER}
        <CodeEditor value="" onChange={setFilter} label={t.SUBSCRIBE_FILTER} language="json" minHeight="80px" />
      </div>
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

      <label className="sns-check" title={rawOk ? undefined : t.SUBSCRIBE_RAW_OFF}>
        <input type="checkbox" checked={raw} disabled={!rawOk} onChange={(e) => setRaw(e.target.checked)} /> {t.SUBSCRIBE_RAW}
      </label>

      <label className="field">
        {t.SUBSCRIBE_DLQ}
        <select className="field-input" aria-label={t.SUBSCRIBE_DLQ} value={dlq} disabled={!dlqOk} title={dlqOk ? undefined : t.SUBSCRIBE_DLQ_OFF} onChange={(e) => setDlq(e.target.value)}>
          <option value="">{t.SUBSCRIBE_DLQ_NONE}</option>
          {dlqChoices.filter((q) => q.arn !== endpoint).map((q) => (
            <option key={q.arn} value={q.arn}>
              {q.name}
            </option>
          ))}
        </select>
      </label>
      {dlqOk && <p className="sns-note dim">{t.SUBSCRIBE_DLQ_RULE(topic.fifo)}</p>}
    </FormSheet>
  );
}
