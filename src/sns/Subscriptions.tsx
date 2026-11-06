import { useMemo, useRef, useState } from "react";
import { errorMessage } from "../api/errors";
import { Highlight } from "../components/Highlight";
import { ListFind, useListFind } from "../components/ListFind";
import { fuzzyKeep, tokenize } from "../lib/fuzzy";
import { diagnosisBadge, diagnosisStatus } from "./Diagnosis";
import { useSnsDiagnosis } from "./queries";
import type { SnsTopicRef } from "./targets";
import { dlqName, endpointLabel, STATE_LABEL } from "./format";
import * as t from "./text";
import type { SnsSubscription, SnsSubscriptionState, SnsTopic } from "./types";

const PROTOCOL_ICON: Record<string, string> = { sqs: "📥", lambda: "λ", http: "🌐", https: "🌐", email: "✉️", "email-json": "✉️", sms: "💬", application: "📱", firehose: "🔥" };

/** 값마다 몇 개인지 센다(처음 나온 순서) */
function countBy<T extends string>(items: SnsSubscription[], pick: (s: SnsSubscription) => T): [T, number][] {
  const counts = new Map<T, number>();
  for (const s of items) {
    const key = pick(s);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts];
}

const toggled = <T,>(set: ReadonlySet<T>, value: T): Set<T> => {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
};

interface Row {
  sub: SnsSubscription;
  label: { name: string; where: string | null };
  filter: string | null;
  dlq: string | null;
}

/**
 * 구독 표: 프로토콜 · 엔드포인트 · 상태 · 필터 요약 · Raw · DLQ. 프로토콜·상태 칩은 같은 묶음 안에서는 하나라도, 묶음끼리는 모두 맞아야 한다.
 * ⌘F는 엔드포인트·프로토콜·상태·필터 요약·DLQ를 퍼지로 찾는다. 행을 누르면 구독 상세로 간다.
 */
export function Subscriptions({ topic, target, active, onOpen }: { topic: SnsTopic; target: SnsTopicRef; active: boolean; onOpen: (key: string) => void }) {
  const box = useRef<HTMLElement>(null);
  const diagnosis = useSnsDiagnosis(target);
  const find = useListFind(box, { enabled: active });
  const [protocols, setProtocols] = useState<ReadonlySet<string>>(new Set());
  const [states, setStates] = useState<ReadonlySet<SnsSubscriptionState>>(new Set());
  const all = topic.subscriptions;
  const rows = useMemo<Row[]>(() => all.map((sub) => ({ sub, label: endpointLabel(sub, topic), filter: sub.summary, dlq: dlqName(sub) })), [all, topic]);
  const listed = useMemo(() => {
    const chipped = rows.filter((r) => (protocols.size === 0 || protocols.has(r.sub.protocol)) && (states.size === 0 || states.has(r.sub.state)));
    return fuzzyKeep(chipped, find.query, (r) => [r.label.name, r.sub.endpoint, r.sub.protocol, STATE_LABEL[r.sub.state], r.filter, r.dlq, r.label.where]);
  }, [rows, protocols, states, find.query]);
  const tokens = useMemo(() => tokenize(find.query), [find.query]);

  return (
    <section className="center sns-screen" ref={box} aria-label={t.SUBS_LABEL}>
      <div className="sns-bar">
        <div className="kv-chips" role="group" aria-label={t.PROTOCOL_CHIPS}>
          {countBy(all, (s) => s.protocol).map(([protocol, n]) => (
            <button key={protocol} type="button" className={`kv-chip${protocols.has(protocol) ? " on" : ""}`} aria-pressed={protocols.has(protocol)} onClick={() => setProtocols((p) => toggled(p, protocol))}>
              {`${PROTOCOL_ICON[protocol] ?? "•"} ${protocol} ${n}`}
            </button>
          ))}
        </div>
        <div className="kv-chips" role="group" aria-label={t.STATE_CHIPS}>
          {countBy(all, (s) => s.state).map(([state, n]) => (
            <button key={state} type="button" className={`kv-chip${states.has(state) ? " on" : ""}`} aria-pressed={states.has(state)} onClick={() => setStates((s) => toggled(s, state))}>
              {`${STATE_LABEL[state]} ${n}`}
            </button>
          ))}
        </div>
      </div>
      <ListFind find={find} count={listed.length} />
      {listed.length === 0 ? (
        <div className="empty small">{all.length === 0 ? t.SUBS_EMPTY : t.SUBS_NO_MATCH}</div>
      ) : (
        <div className="sns-scroll">
          <table className="sns-table" aria-label={t.SUBS_LABEL}>
            <thead>
              <tr>
                {Object.values(t.SUBS_COLS).map((c) => (
                  <th key={c} scope="col" className="nosort">
                    {c}
                  </th>
                ))}
                <th scope="col" className="nosort">진단</th>
              </tr>
            </thead>
            <tbody>
              {listed.map(({ sub, label, filter, dlq }) => (
                <tr key={sub.key} className="sns-row" onClick={() => onOpen(sub.key)}>
                  <td className="sns-nowrap">
                    <span aria-hidden="true">{PROTOCOL_ICON[sub.protocol] ?? "•"}</span> {sub.protocol}
                  </td>
                  <td>
                    <button type="button" className="link sns-endpoint">
                      <Highlight text={label.name} tokens={tokens} />
                    </button>
                    {label.where && <span className="dim sns-where">{label.where}</span>}
                  </td>
                  <td className="sns-nowrap">
                    <span className={`sns-state ${sub.state}`}>{STATE_LABEL[sub.state]}</span>
                    {sub.error && (
                      <span className="sns-warn" role="img" aria-label={t.ROW_ERROR} title={`${t.ROW_ERROR}: ${errorMessage(sub.error)}`}>
                        !
                      </span>
                    )}
                  </td>
                  <td className={filter ? "mono" : "dim"}>{filter ? <Highlight text={filter} tokens={tokens} /> : t.FILTER_NONE}</td>
                  <td className={sub.raw ? undefined : "dim"}>{sub.raw ? t.RAW_ON : t.RAW_OFF}</td>
                  <td className={dlq ? "mono" : "dim"}>{dlq ? <Highlight text={dlq} tokens={tokens} /> : t.DLQ_NONE}</td>
                  <td>{(() => {
                    const item = diagnosis.data?.subscriptions.find((d) => d.subscription === sub.key);
                    if (!item) return <span className="dim" title={diagnosis.isError ? "진단을 읽지 못했어요" : "진단을 읽고 있어요"}>–</span>;
                    const [mark, label] = diagnosisBadge(item.checks);
                    return <span className={`tailscale-check-${diagnosisStatus(item.checks)}`} title={item.verdict}>{mark} {label}</span>;
                  })()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
