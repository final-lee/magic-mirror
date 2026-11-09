import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { errorMessage } from "../../api/errors";
import { CodeEditor } from "../../components/CodeEditor";
import { ListFind, useListFind } from "../../components/ListFind";
import { formatDateTime } from "../../iam/format";
import { JsonTree } from "../../kv/JsonTree";
import { fuzzyKeep } from "../../lib/fuzzy";
import { sqsApi } from "../api";
import { sqsKeys } from "../queries";
import type { SqsItemResult, SqsMessage, SqsPeek, SqsQueue } from "../types";
import { SqsChangeDialog } from "../change/SqsChangeDialog";
import { useSqsChange } from "../change/useSqsChange";
import { fieldValue, groupByField, parseJson, remainingMessages, unwrapBody } from "./envelope";
import * as t from "./text";

interface Props {
  profile: string;
  region: string;
  queue: SqsQueue;
  queues: SqsQueue[];
  active: boolean;
}

export function Messages(props: Props) {
  return <Viewer key={`${props.profile}:${props.region}:${props.queue.url}`} {...props} />;
}

function Viewer({ profile, region, queue, queues, active }: Props) {
  const [peek, setPeek] = useState<SqsPeek | null>(null);
  const session = useRef<SqsPeek | null>(null);
  const [now, setNow] = useState(Date.now());
  const [receive, setReceive] = useState(false);
  const [max, setMax] = useState("50");
  const [hold, setHold] = useState("60");
  const [selected, setSelected] = useState<string[]>([]);
  const [detail, setDetail] = useState<string | null>(null);
  const [results, setResults] = useState<SqsItemResult[]>([]);
  const [form, setForm] = useState<"resend" | "edit" | null>(null);
  const [destination, setDestination] = useState("");
  const [edited, setEdited] = useState("");
  const [groupPath, setGroupPath] = useState("");
  const [group, setGroup] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const find = useListFind(host, { enabled: active });
  useEffect(() => { setForm(null); }, [selected]);
  const possible = useQuery({
    queryKey: sqsKeys.peekable(profile, region, queue.url),
    queryFn: () => sqsApi.peekable(profile, region, queue.url),
    enabled: active,
  });
  const flow = useSqsChange(profile, region, queue.url, (change, result) => {
    if (change.kind === "receive" && result.peek) {
      session.current = result.peek;
      setPeek(result.peek);
      setNow(Date.now());
      setReceive(false);
      setSelected([]);
      setDetail(null);
      setResults([]);
    } else if (change.kind === "resend" || change.kind === "deleteMessages") {
      setResults(result.items);
      setSelected([]);
      setForm(null);
      setPeek((old) => {
        if (!old) return old;
        const next = { ...old, messages: remainingMessages(old.messages, result.items) };
        session.current = next;
        return next;
      });
    }
  });

  // 큐가 바뀌거나 탭이 닫혀도 남은 영수증을 바로 놓아줘요.
  useEffect(() => () => {
    const old = session.current;
    session.current = null;
    if (old) void sqsApi.release(profile, old.peekId).catch(() => {});
  }, [profile]);
  useEffect(() => {
    if (!peek) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [peek]);

  const expired = !!peek && now >= peek.expiresAt;
  const remaining = peek ? Math.max(0, Math.ceil((peek.expiresAt - now) / 1000)) : 0;
  const grouped = (peek?.messages ?? []).filter((m) => group === null || fieldValue(m.body, groupPath) === group);
  const rows = fuzzyKeep(grouped, find.query, (m) => [m.messageId, m.body, ...Object.values(m.attributes), ...m.messageAttributes.map((a) => `${a.name} ${a.value}`)]);
  const chosen = peek?.messages.filter((m) => selected.includes(m.messageId)) ?? [];
  const current = peek?.messages.find((m) => m.messageId === detail);
  const validReceive = /^\d+$/.test(max) && Number(max) >= 1 && Number(max) <= 500 && /^\d+$/.test(hold) && Number(hold) >= 10 && Number(hold) <= 600;

  const release = async () => {
    if (!session.current) return;
    try {
      await sqsApi.release(profile, session.current.peekId);
      session.current = null;
      setPeek(null);
      setSelected([]);
      setDetail(null);
      setError(null);
    } catch (e) { setError(errorMessage(e)); }
  };
  const save = async () => {
    try {
      const text = (peek?.messages ?? []).map((m) => JSON.stringify(m)).join("\n") + "\n";
      const path = await sqsApi.saveJsonl(`${queue.name}-messages.jsonl`, text);
      if (path) setSaved(path);
    } catch (e) { setError(errorMessage(e)); }
  };
  const startResend = (mode: "resend" | "edit") => {
    const source = chosen.length && chosen.every((m) => m.attributes.DeadLetterQueueSourceArn === chosen[0].attributes.DeadLetterQueueSourceArn)
      ? chosen[0].attributes.DeadLetterQueueSourceArn : undefined;
    const sourceQueue = queues.find((q) => q.arn === source) ?? (queue.sources.length === 1 ? queues.find((q) => q.arn === queue.sources[0]) : undefined);
    setDestination(sourceQueue?.url ?? "");
    setEdited(chosen[0]?.body ?? "");
    setForm(mode);
  };

  return (
    <div className="sqs-msg-view" ref={host}>
      <p className="notice">{t.RECEIVE_WARNING}</p>
      <div className="sqs-msg-toolbar">
        <button className="btn tone-primary" disabled={!possible.data?.allowed || !!peek}
          title={peek ? t.RELEASE_FIRST : possible.data?.reason ?? (possible.isLoading ? t.CHECKING : undefined)}
          onClick={() => setReceive(true)}>{t.RECEIVE}</button>
        {peek && (
          <>
            <span>{expired ? t.EXPIRED : t.REMAINING(remaining)}</span>
            <button className="btn tone-secondary" disabled={!peek.messages.length} onClick={() => void save()}>{t.SAVE}</button>
            <button className="btn tone-ghost-danger" onClick={() => void release()}>{t.RELEASE}</button>
          </>
        )}
      </div>
      {possible.data && !possible.data.allowed && <p className="notice" role="status">{possible.data.reason}</p>}
      {possible.isError && <p className="err" role="alert">{errorMessage(possible.error)}</p>}
      {error && <p className="err" role="alert">{error}</p>}
      {saved && <p className="notice" role="status">{t.SAVED(saved)}</p>}
      {flow.notice && <p className="notice" role="status">{flow.notice}</p>}
      {receive && !flow.pending && (
        <ReceiveForm max={max} hold={hold} valid={validReceive} onMax={setMax} onHold={setHold}
          onCancel={() => setReceive(false)} onPreview={() => flow.start({ kind: "receive", max: Number(max), holdSecs: Number(hold) })} />
      )}
      {peek && (
        <div className={expired ? "sqs-msg-expired" : undefined}>
          <ListFind find={find} count={rows.length} />
          <GroupFilter messages={peek.messages} path={groupPath} selected={group} onPath={(path) => { setGroupPath(path); setGroup(null); }} onSelect={setGroup} />
          <MessageTable rows={rows} fifo={queue.fifo} expired={expired} selected={selected} open={detail} onSelected={setSelected} onDetail={setDetail} />
          {!rows.length && <p>{t.EMPTY}</p>}
          <div className="sqs-msg-toolbar">
            <button className="btn tone-primary" disabled={expired || !chosen.length} onClick={() => startResend("resend")}>{t.RESEND}</button>
            <button className="btn tone-primary" disabled={expired || chosen.length !== 1} onClick={() => startResend("edit")}>{t.EDIT_RESEND}</button>
            <button className="btn tone-danger" disabled={expired || !chosen.length}
              onClick={() => flow.start({ kind: "deleteMessages", peekId: peek.peekId, messageIds: selected })}>{t.DELETE(chosen.length)}</button>
          </div>
          {form && (
            <ResendForm mode={form} queues={queues.filter((q) => q.url !== queue.url)} destination={destination} edited={edited}
              messageId={chosen[0]?.messageId} expired={expired} onDestination={setDestination} onEdited={setEdited} onCancel={() => setForm(null)}
              onPreview={() => flow.start({ kind: "resend", peekId: peek.peekId, messageIds: selected, destinationUrl: destination,
                edits: form === "edit" && chosen[0] ? { [chosen[0].messageId]: edited } : {} })} />
          )}
          {current && <MessageDetail key={current.messageId} message={current} />}
        </div>
      )}
      {results.length > 0 && (
        <section className="sqs-msg-results"><h3>{t.RESULTS}</h3>
          <table className="k8s-table"><tbody>{results.map((r) => <tr key={r.id}><td className="mono">{r.id}</td><td>{r.ok ? t.DONE : r.error ?? t.FAILED}</td></tr>)}</tbody></table>
        </section>
      )}
      {flow.pending && <SqsChangeDialog pending={flow.pending} onApply={flow.apply} onRetry={flow.retryPreview} onCancel={flow.cancel} />}
    </div>
  );
}

function ReceiveForm({ max, hold, valid, onMax, onHold, onCancel, onPreview }: {
  max: string; hold: string; valid: boolean; onMax: (value: string) => void; onHold: (value: string) => void; onCancel: () => void; onPreview: () => void;
}) {
  return (
    <div className="sqs-msg-form">
      <label>{t.COUNT}<input type="number" min="1" max="500" value={max} onChange={(e) => onMax(e.target.value)} /></label>
      <label>{t.HOLD}<input type="number" min="10" max="600" value={hold} onChange={(e) => onHold(e.target.value)} /></label>
      <button className="btn tone-ghost" onClick={onCancel}>{t.CANCEL}</button>
      <button className="btn tone-primary" disabled={!valid} title={!valid ? t.INVALID_RECEIVE : undefined} onClick={onPreview}>{t.PREVIEW}</button>
    </div>
  );
}

function GroupFilter({ messages, path, selected, onPath, onSelect }: {
  messages: SqsMessage[]; path: string; selected: string | null; onPath: (path: string) => void; onSelect: (value: string | null) => void;
}) {
  return (
    <>
      <div className="sqs-msg-toolbar">
        <label>{t.GROUP}<input value={path} placeholder={t.GROUP_PLACEHOLDER} onChange={(e) => onPath(e.target.value)} /></label>
        {selected !== null && <button className="btn tone-secondary" onClick={() => onSelect(null)}>{t.CLEAR_FILTER}</button>}
      </div>
      {path.trim() && (
        <div className="sqs-msg-groups">
          {groupByField(messages, path).map((g) => (
            <button key={g.value} className="btn tone-secondary" aria-pressed={selected === g.value} onClick={() => onSelect(g.value)}>{g.value} ({g.count})</button>
          ))}
        </div>
      )}
    </>
  );
}

function MessageTable({ rows, fifo, expired, selected, open, onSelected, onDetail }: {
  rows: SqsMessage[]; fifo: boolean; expired: boolean; selected: string[]; open: string | null;
  onSelected: React.Dispatch<React.SetStateAction<string[]>>; onDetail: (id: string) => void;
}) {
  return (
    <div className="sqs-msg-table">
      <table className="k8s-table" tabIndex={0}>
        <thead><tr>
          <th><input type="checkbox" aria-label={t.SELECT_ALL} disabled={expired || !rows.length}
            checked={rows.length > 0 && rows.every((m) => selected.includes(m.messageId))}
            onChange={(e) => onSelected((old) => e.target.checked ? [...new Set([...old, ...rows.map((m) => m.messageId)])] : old.filter((id) => !rows.some((m) => m.messageId === id)))} /></th>
          <th>{t.SENT}</th>{fifo && <th>{t.GROUP_ID}</th>}<th>{t.RECEIVES}</th><th>{t.SIZE}</th><th>{t.FIRST_LINE}</th>
        </tr></thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.messageId} className={m.messageId === open ? "selected" : undefined} onClick={() => onDetail(m.messageId)}>
              <td><input type="checkbox" aria-label={t.SELECT_MESSAGE(m.messageId)} disabled={expired} checked={selected.includes(m.messageId)}
                onClick={(e) => e.stopPropagation()} onChange={(e) => onSelected((old) => e.target.checked ? [...old, m.messageId] : old.filter((id) => id !== m.messageId))} /></td>
              <td>{m.attributes.SentTimestamp ? formatDateTime(new Date(Number(m.attributes.SentTimestamp)).toISOString()) : t.DASH}</td>
              {fifo && <td>{m.attributes.MessageGroupId ?? t.DASH}</td>}
              <td>{m.attributes.ApproximateReceiveCount ?? t.DASH}</td>
              <td>{m.size.toLocaleString("ko-KR")} B</td>
              <td><button className="sqs-msg-body mono" onClick={() => onDetail(m.messageId)}>{m.body.split("\n")[0] || t.EMPTY_BODY}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResendForm({ mode, queues, destination, edited, messageId, expired, onDestination, onEdited, onCancel, onPreview }: {
  mode: "resend" | "edit"; queues: SqsQueue[]; destination: string; edited: string; messageId?: string; expired: boolean;
  onDestination: (value: string) => void; onEdited: (value: string) => void; onCancel: () => void; onPreview: () => void;
}) {
  return (
    <div className="sqs-msg-form">
      <label>{t.DESTINATION}
        <select value={destination} onChange={(e) => onDestination(e.target.value)}>
          <option value="">{t.PICK_DESTINATION}</option>
          {queues.map((q) => <option key={q.url} value={q.url}>{q.name}</option>)}
        </select>
      </label>
      {mode === "edit" && <CodeEditor key={messageId} value={edited} onChange={onEdited} language="text" label={t.EDIT_BODY} />}
      <button className="btn tone-ghost" onClick={onCancel}>{t.CANCEL}</button>
      <button className="btn tone-primary" disabled={!destination || expired} onClick={onPreview}>{t.PREVIEW}</button>
    </div>
  );
}

function MessageDetail({ message }: { message: SqsMessage }) {
  const [unwrapped, setUnwrapped] = useState(false);
  const [decoded, setDecoded] = useState<{ text: string; layers: string[] } | null>(null);
  useEffect(() => {
    let alive = true;
    void unwrapBody(message.body).then((value) => { if (alive) setDecoded(value); });
    return () => { alive = false; };
  }, [message.body]);
  const text = unwrapped ? decoded?.text ?? message.body : message.body;
  const json = parseJson(text);
  return (
    <section className="sqs-msg-detail">
      <h3>{t.MESSAGE(message.messageId)}</h3>
      <div className="sqs-msg-toolbar">
        <button className="btn tone-secondary" aria-pressed={!unwrapped} onClick={() => setUnwrapped(false)}>{t.ORIGINAL}</button>
        <button className="btn tone-secondary" aria-pressed={unwrapped} onClick={() => setUnwrapped(true)}>{t.UNWRAP}</button>
        {unwrapped && <span>{decoded?.layers.length ? decoded.layers.join(" → ") : t.NO_ENVELOPE}</span>}
      </div>
      {json !== undefined ? <JsonTree key={text} value={json} /> : <pre>{text}</pre>}
      <h4>{t.SYSTEM_ATTRIBUTES}</h4>
      <table className="k8s-table"><tbody>{Object.entries(message.attributes).map(([key, value]) => <tr key={key}><th>{key}</th><td>{value}</td></tr>)}</tbody></table>
      <h4>{t.MESSAGE_ATTRIBUTES}</h4>
      {message.messageAttributes.length ? (
        <table className="k8s-table"><tbody>{message.messageAttributes.map((a) => <tr key={a.name}><th>{a.name}</th><td>{a.dataType}</td><td>{a.value}</td></tr>)}</tbody></table>
      ) : <p>{t.NO_ATTRIBUTES}</p>}
    </section>
  );
}
