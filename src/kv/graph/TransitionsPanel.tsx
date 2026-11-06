import { useMemo, useState } from "react";
import { STATE_LABEL } from "../bull";
import { formatCount } from "../format";
import { KvError } from "../KvError";
import { useKvBullTransitions } from "../queries";
import * as t from "../text";
import type { KvBullCounts, KvTarget } from "../types";
import { GraphCanvas, GraphEdgeLine } from "../../components/graph/GraphCanvas";
import { layoutDag } from "../../components/graph/layout";
import { buildTransitions, edgeWidth, TRANSITION_NODES, windowNotes } from "./transitions";

/** 고를 수 있는 구간(분) */
export const WINDOWS: { minutes: number; label: string }[] = [
  { minutes: 15, label: "15분" },
  { minutes: 60, label: "1시간" },
  { minutes: 360, label: "6시간" },
];
const NODE_W = 128;
const NODE_H = 52;

interface Props {
  target: KvTarget;
  prefix: string;
  name: string;
  /** 큐의 지금 상태별 수(노드에 보인다) */
  counts: KvBullCounts;
}

/**
 * 상태 전이: 큐의 events 스트림에서 센 (이전 상태 → 새 상태) 쌍을 상태 그림으로 보인다. 노드는 상태와 지금 작업 수, 간선은 구간 안에서 옮겨 간 횟수(굵기와 글).
 * 정체(stalled)는 처리 중 → 대기의 빨간 간선, 재시도 소진은 실패 노드의 배지다. 이벤트를 읽는 일이라 구간을 바꾸거나 [다시 읽기]를 누를 때만 읽는다.
 */
export function TransitionsPanel({ target, prefix, name, counts }: Props) {
  const [minutes, setMinutes] = useState(60);
  const q = useKvBullTransitions(target, prefix, name, minutes);
  const data = q.data;
  const model = useMemo(() => (data ? buildTransitions(data) : null), [data]);
  const layout = useMemo(
    () =>
      layoutDag(
        TRANSITION_NODES.map((n) => ({ id: n.id, w: NODE_W, h: NODE_H, layer: n.layer })),
        (model?.edges ?? []).map((e) => ({ id: e.id, from: e.from, to: e.to })),
        { direction: "LR", gapMain: 96, gapCross: 14 },
      ),
    [model],
  );
  const placed = new Map(layout.nodes.map((n) => [n.id, n]));
  const max = Math.max(0, ...(model?.edges.map((e) => e.count) ?? []));
  const notes = data ? windowNotes(data) : [];

  const controls = (
    <>
      <div className="kv-seg" role="group" aria-label={t.TRANSITIONS_WINDOW}>
        {WINDOWS.map((w) => (
          <button key={w.minutes} type="button" className={`kv-seg-btn${minutes === w.minutes ? " on" : ""}`} aria-pressed={minutes === w.minutes} onClick={() => setMinutes(w.minutes)}>
            {w.label}
          </button>
        ))}
      </div>
      <button type="button" className="btn small tone-refresh" disabled={q.isFetching} onClick={() => void q.refetch()}>
        {q.isFetching ? t.READING : t.REREAD}
      </button>
      {data && <span className="dim">{t.TRANSITIONS_EVENTS(formatCount(data.events), formatCount(model?.moves ?? 0))}</span>}
    </>
  );

  return (
    <div className="kv-transitions" role="group" aria-label={t.TRANSITIONS_TITLE}>
      <h4 className="kv-section">{t.TRANSITIONS_TITLE}</h4>
      {!data ? (
        <>
          <div className="kvg-bar">{controls}</div>
          {q.isError ? <KvError error={q.error} target={target} /> : <div className="empty small">{t.LOADING}</div>}
        </>
      ) : (
        <>
          {q.isError && <KvError compact error={q.error} target={target} />}
          {/* 창 고르기·다시 읽기·확대 단추·알림을 한 줄에 둔다 */}
          <GraphCanvas
            width={layout.width}
            height={layout.height}
            label={t.TRANSITIONS_TITLE}
            minHeight={200}
            lead={controls}
            extra={notes.map((n) => (
              <span key={n!.kind} className={`kvg-note${n!.kind === "empty" ? "" : " warn"}`} role="note">
                {n!.kind === "trimmed" ? t.TRANSITIONS_TRIMMED(n!.minutes) : n!.kind === "truncated" ? t.TRANSITIONS_TRUNCATED(formatCount(n!.events)) : t.TRANSITIONS_EMPTY}
              </span>
            ))}
          >
            {layout.edges.map((e) => {
              const edge = model!.edges.find((x) => x.id === e.id)!;
              const from = TRANSITION_NODES.find((n) => n.id === edge.from)!.label;
              const to = TRANSITION_NODES.find((n) => n.id === edge.to)!.label;
              return (
                <GraphEdgeLine
                  key={e.id}
                  path={e.path}
                  mid={e.mid}
                  tone={edge.tone === "dim" ? "dim" : edge.tone}
                  width={edgeWidth(edge.count, max)}
                  dashed={edge.stalled}
                  label={`${edge.stalled ? "정체 " : ""}${formatCount(edge.count)}`}
                  title={`${from} → ${to} · ${formatCount(edge.count)}회`}
                />
              );
            })}
            {TRANSITION_NODES.map((n) => {
              const p = placed.get(n.id)!;
              const badges = model?.badges[n.id] ?? [];
              const current = n.count === null ? null : counts[n.count];
              const tone = n.id === "failed" ? "bad" : n.id === "completed" ? "good" : n.id === "active" ? "accent" : "plain";
              return (
                <g key={n.id} transform={`translate(${p.x},${p.y})`} className={`kvg-node ${tone}`} role="group" aria-label={`${n.label}${current === null ? "" : ` ${current}`}`}>
                  <rect width={NODE_W} height={NODE_H} rx={8} />
                  <text x={10} y={20}>
                    {n.label}
                  </text>
                  <text x={10} y={38} className="sub num">
                    {current === null ? t.TRANSITIONS_NEW_SUB : t.TRANSITIONS_NOW(formatCount(current), STATE_LABEL[n.count!])}
                  </text>
                  {badges.map((b, i) => {
                    const label = `${b.label} ${formatCount(b.count)}`;
                    const w = label.length * 7 + 12;
                    return (
                      <g key={b.label} className={`kvg-badge ${b.tone}`} transform={`translate(${NODE_W - w + 4},${-9 - i * 18})`} role="note" aria-label={label}>
                        <rect width={w} height={16} rx={8} />
                        <text x={w / 2} y={11.5} textAnchor="middle">
                          {label}
                        </text>
                      </g>
                    );
                  })}
                </g>
              );
            })}
          </GraphCanvas>
          {model!.other.length > 0 && (
            <p className="kvg-note">
              {t.TRANSITIONS_OTHER} {model!.other.map((o) => `${o.event} ${formatCount(o.count)}`).join(" · ")}
            </p>
          )}
        </>
      )}
    </div>
  );
}
