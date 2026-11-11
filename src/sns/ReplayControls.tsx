import { useState } from "react";
import { changeTone } from "./change";
import { SnsChangeDialog } from "./SnsChangeDialog";
import type { SnsTopicRef } from "./targets";
import type { SnsChangeRequest, SnsSubscription, SnsTopic } from "./types";

export function replayError(start: string, end: string, beginning: string | null, now = Date.now()): string | null {
  const first = Date.parse(start);
  const last = end ? Date.parse(end) : null;
  const earliest = beginning ? Date.parse(beginning) : NaN;
  if (!Number.isFinite(first) || !Number.isFinite(earliest) || (last !== null && !Number.isFinite(last))) return "올바른 시각과 아카이브 시작 시각이 필요해요";
  if (first < earliest) return "시작 시각이 아카이브 시작보다 빨라요";
  if (first > now || (last !== null && last > now)) return "미래 시각은 사용할 수 없어요";
  if (last !== null && first >= last) return "끝 시각은 시작보다 늦어야 해요";
  return null;
}

export function ReplayControls({ topic, sub, target }: { topic: SnsTopic; sub: SnsSubscription; target: SnsTopicRef }) {
  const [editing, setEditing] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [request, setRequest] = useState<SnsChangeRequest | null>(null);
  if (!topic.fifo || topic.overview.archiveRetentionDays === null || !sub.arn) return null;
  const arn = sub.arn;
  let previousEnd: string | null = null;
  try { const policy = JSON.parse(sub.attributes.ReplayPolicy || "{}"); if (typeof policy.EndingPoint === "string" && Number.isFinite(Date.parse(policy.EndingPoint))) previousEnd = policy.EndingPoint; } catch { /* 읽을 수 없는 정책은 이어 받을 수 없다 */ }
  const error = replayError(start, end, topic.overview.beginningArchiveTime);
  return <section className="sns-section" aria-label="다시 보내기">
    <h4 className="sns-heading">다시 보내기</h4>
    <p className="sns-note">아카이브 시작: {topic.overview.beginningArchiveTime ? new Date(topic.overview.beginningArchiveTime).toLocaleString() : "알 수 없음"} · 현재까지 (현지 시각)</p>
    {sub.attributes.ReplayStatus && <p role="status">다시 보내기 상태: {sub.attributes.ReplayStatus}</p>}
    {!editing && <button className="btn small tone-primary" onClick={() => setEditing(true)}>다시 보내기…</button>}
    {previousEnd && <button className="btn small tone-primary" onClick={() => setRequest({ kind: "replay", subscriptionArn: arn, start: previousEnd! })}>이어 받기</button>}
    {editing && <div>
      <label>시작 시각 <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></label>{" "}
      <label>끝 시각 (선택) <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
      {error && <p className="sns-note" role="status">{error}</p>}
      <button className="btn small tone-ghost" onClick={() => setEditing(false)}>취소</button>{" "}
      <button className="btn small tone-primary" disabled={error !== null} title={error ?? undefined} onClick={() => setRequest({ kind: "replay", subscriptionArn: arn, start: new Date(start).toISOString(), ...(end ? { end: new Date(end).toISOString() } : {}) })}>미리 보기…</button>
    </div>}
    {request && <SnsChangeDialog profile={target.profile} region={target.region} request={request} onClose={() => setRequest(null)} />}
  </section>;
}

export function ArchiveEditor({ topic, target }: { topic: SnsTopic; target: SnsTopicRef }) {
  const [editing, setEditing] = useState(false);
  const [enabled, setEnabled] = useState(topic.overview.archiveRetentionDays !== null);
  const [days, setDays] = useState(String(topic.overview.archiveRetentionDays ?? 30));
  const [request, setRequest] = useState<SnsChangeRequest | null>(null);
  const number = Number(days);
  const valid = !enabled || (days.trim() !== "" && Number.isInteger(number) && number >= 1 && number <= 365);
  return <>
    {!editing ? <button className="btn small tone-secondary" onClick={() => { setEnabled(topic.overview.archiveRetentionDays !== null); setDays(String(topic.overview.archiveRetentionDays ?? 30)); setEditing(true); }}>편집</button> : <div>
      <label><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> 아카이브 켜기</label>{" "}
      {enabled && <label>보존 기간 (1~365일) <input type="number" min={1} max={365} step={1} value={days} onChange={(e) => setDays(e.target.value)} /></label>}
      {!enabled && <p className="sns-note">끄면 보관된 메시지가 모두 삭제돼요</p>}
      <button className="btn small tone-ghost" onClick={() => setEditing(false)}>취소</button>{" "}
      <button className={`btn small ${changeTone({ kind: "archivePolicy", retentionDays: enabled ? number : null })}`} disabled={!valid} title={valid ? undefined : "보존 기간은 1~365일이어야 해요"} onClick={() => setRequest({ kind: "archivePolicy", topicArn: topic.arn, retentionDays: enabled ? number : null })}>미리 보기…</button>
    </div>}
    {request && <SnsChangeDialog profile={target.profile} region={target.region} request={request} onClose={() => setRequest(null)} />}
  </>;
}
