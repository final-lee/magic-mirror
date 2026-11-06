import { useState } from "react";
import { errorMessage } from "../api/errors";
import { GraphCanvas, GraphEdgeLine } from "../components/graph/GraphCanvas";
import { layoutDag, type LayoutEdge, type LayoutNode } from "../components/graph/layout";
import { endpointLabel } from "./format";
import { useSnsDiagnosis, useSnsPublishers } from "./queries";
import type { SnsTopicRef } from "./targets";
import type { SnsPublisher, SnsTopic, TopicHourMetrics } from "./types";

type Node = LayoutNode & { label: string; detail: string; subscription?: string };
type Edge = LayoutEdge & { label?: string; dashed?: boolean };

export function flowGraph(topic: SnsTopic, publishers: SnsPublisher[], metrics?: TopicHourMetrics) {
  const nodes: Node[] = [{ id: "topic", label: topic.name, detail: "SNS 주제", layer: 1, w: 190, h: 44 }];
  const edges: Edge[] = [];
  publishers.forEach((publisher, i) => {
    const id = `publisher:${i}`;
    nodes.push({ id, label: publisher.name, detail: publisher.configured ? publisher.kind : "정책상 발행할 수 있음", layer: 0, w: 190, h: 44 });
    edges.push({ id: `pub:${i}`, from: id, to: "topic", dashed: !publisher.configured, label: metrics?.published != null ? `발행 ${metrics.published}` : undefined });
  });
  topic.subscriptions.forEach((sub, i) => {
    const sid = `subscription:${i}`, eid = `endpoint:${i}`;
    nodes.push({ id: sid, label: `구독 ${i + 1}`, detail: sub.state, layer: 2, w: 190, h: 44 });
    nodes.push({ id: eid, label: endpointLabel(sub, topic).name, detail: sub.protocol, subscription: sub.key, layer: 3, w: 190, h: 44 });
    const traffic = [metrics?.delivered != null ? `배달 ${metrics.delivered}` : "", metrics?.failed != null ? `실패 ${metrics.failed}` : ""].filter(Boolean).join(" · ");
    edges.push({ id: `sub:${i}`, from: "topic", to: sid, label: traffic || undefined });
    edges.push({ id: `endpoint-edge:${i}`, from: sid, to: eid, label: [sub.filter || sub.attributes.FilterPolicy ? "필터" : "", sub.raw ? "raw" : ""].filter(Boolean).join(" · ") || undefined });
    if (sub.dlqArn) {
      const did = `dlq:${i}`;
      nodes.push({ id: did, label: sub.dlqArn.split(":").pop() ?? sub.dlqArn, detail: "DLQ", layer: 4, w: 190, h: 44 });
      edges.push({ id: `dlq-edge:${i}`, from: eid, to: did });
    }
  });
  return { nodes, edges, layout: layoutDag(nodes, edges, { direction: "LR", gapMain: 110, gapCross: 14 }) };
}

export function Flow({ topic, target, onOpen }: { topic: SnsTopic; target: SnsTopicRef; onOpen: (key: string) => void }) {
  const [deep, setDeep] = useState(false);
  const base = useSnsPublishers(target, false);
  const scan = useSnsPublishers(target, deep);
  const diagnosis = useSnsDiagnosis(target);
  const data = deep ? scan.data ?? base.data : base.data;
  const graph = flowGraph(topic, data?.publishers ?? [], diagnosis.data?.metrics);
  const edgeOf = new Map(graph.edges.map(e => [e.id, e]));
  const nodeOf = new Map(graph.nodes.map(n => [n.id, n]));
  return <section className="center sns-screen" aria-label="흐름 지도">
    <h2>흐름 지도</h2>
    <p>실선: 설정상 발행 · 점선: 정책상 발행할 수 있음. 지표는 지난 1시간 주제 전체 합계예요.</p>
    <button className="btn tone-refresh" disabled={scan.isFetching} onClick={() => { if (deep) void scan.refetch(); else setDeep(true); }}>더 찾기</button>{" "}
    {deep && scan.isFetching && <span role="status">버킷과 함수를 찾는 중이에요…</span>}
    {data?.scanned && <span>버킷 {data.scanned.buckets}개 · 함수 {data.scanned.functions}개 확인</span>}
    {(base.error || (deep && scan.error)) && <p role="alert">{errorMessage((deep && scan.error) || base.error)}</p>}
    {data?.errors.map((error, i) => <p role="alert" key={i}>{errorMessage(error)}</p>)}
    <GraphCanvas width={graph.layout.width} height={graph.layout.height} label="SNS 흐름 지도" minHeight={320}>
      {graph.layout.edges.map(e => { const edge = edgeOf.get(e.id)!; return <GraphEdgeLine key={e.id} path={e.path} mid={e.mid} dashed={edge.dashed} label={edge.label} tone="accent" />; })}
      {graph.layout.nodes.map(p => { const node = nodeOf.get(p.id)!; return <g key={p.id} transform={`translate(${p.x},${p.y})`} className={`kvg-node${p.id === "topic" ? " accent" : ""}`} role={node.subscription ? "button" : "group"} tabIndex={node.subscription ? 0 : undefined} aria-label={`${node.label} ${node.detail}`} onClick={node.subscription ? () => onOpen(node.subscription!) : undefined} onKeyDown={node.subscription ? e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(node.subscription!); } } : undefined}><rect width={p.w} height={p.h} rx={7} /><text x={10} y={18}>{node.label.length > 25 ? `${node.label.slice(0, 24)}…` : node.label}</text><text x={10} y={34} className="sub">{node.detail}</text><title>{node.label}</title></g>; })}
    </GraphCanvas>
    <p>SDK로 직접 발행하는 주체는 CloudTrail 데이터 이벤트 없이는 찾을 수 없어요. 다른 발행자가 있을 수 있어요.</p>
  </section>;
}
