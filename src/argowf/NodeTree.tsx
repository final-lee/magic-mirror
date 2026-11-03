import { useState, type ReactNode } from "react";
import type { WfDetail, WfNode } from "./types";

/**
 * [실패 단계로]가 고를 Pod: 실패한 Pod 중 가장 먼저 끝난 것. 다만 재시도해서 결국 성공한 시도(성공한 Retry 노드 바로 아래의 시도,
 * 또는 그 시도 안에 든 Pod)는 지금 실패의 원인이 아니라 뺀다. DAG에서 `children`은 다음 작업으로 가는 흐름이라 포함 관계는
 * `boundaryId`(감싼 템플릿)로 거슬러 올라간다. 뺀 뒤 남는 것이 없으면 아무 실패 Pod나 고른다.
 */
export function failedPod(nodes: WfNode[]): WfNode | undefined {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const succeededRetryChildren = new Set(nodes.filter((n) => n.type === "Retry" && n.phase === "Succeeded").flatMap((n) => n.children));
  const recovered = (node: WfNode): boolean => {
    const seen = new Set<string>();
    for (let at: WfNode | undefined = node; at && !seen.has(at.id); at = at.boundaryId ? byId.get(at.boundaryId) : undefined) {
      seen.add(at.id);
      if (succeededRetryChildren.has(at.id)) return true;
    }
    return false;
  };
  const failures = nodes.filter((node) => node.type === "Pod" && ["Failed", "Error"].includes(node.phase));
  const relevant = failures.filter((node) => !recovered(node));
  return (relevant.length ? relevant : failures).sort((a, b) => (Date.parse(a.finishedAt ?? "") || Infinity) - (Date.parse(b.finishedAt ?? "") || Infinity))[0];
}

/** 부모-자식 들여쓰기 트리 + 같은 줄의 타임라인 막대. 노드 상세는 고른 노드를 받는 쪽(NodeDetail)이 그린다 */
export function NodeTree({ detail, selected, onSelect }: { detail: WfDetail; selected: string | null; onSelect(id: string): void }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const nodes = new Map(detail.nodes.map((node) => [node.id, node]));
  const parents = new Map<string, WfNode[]>();
  for (const node of detail.nodes) for (const id of node.children) parents.set(id, [...(parents.get(id) ?? []), node]);
  const roots = detail.nodes.filter((node) => !parents.has(node.id));
  const start = Date.parse(detail.row.startedAt ?? "") || Date.now();
  const end = Date.parse(detail.row.finishedAt ?? "") || Date.now();
  const span = Math.max(1, end - start);
  const seen = new Set<string>();
  const draw = (node: WfNode, depth: number, parentId: string | null): ReactNode => {
    if (seen.has(node.id)) return null;
    seen.add(node.id);
    const from = Date.parse(node.startedAt ?? "") || start;
    const to = Date.parse(node.finishedAt ?? "") || end;
    const otherParents = (parents.get(node.id) ?? []).filter((p) => p.id !== parentId);
    return (
      <div key={node.id}>
        <div className={`argowf-node${selected === node.id ? " selected" : ""}`} style={{ paddingLeft: depth * 18 }}>
          {node.children.length > 0 ? (
            <button
              className="argowf-node-toggle"
              aria-label={`${node.displayName} 접기`}
              onClick={() =>
                setCollapsed((old) => {
                  const next = new Set(old);
                  if (next.has(node.id)) next.delete(node.id);
                  else next.add(node.id);
                  return next;
                })
              }
            >
              {collapsed.has(node.id) ? "▸" : "▾"}
            </button>
          ) : (
            <span className="argowf-node-toggle">·</span>
          )}
          <button className="argowf-node-name" aria-pressed={selected === node.id} onClick={() => onSelect(node.id)}>
            <span className={`argowf-phase ${node.phase}`}>●</span> {node.displayName} <small>{node.type}</small>
            {otherParents.length > 0 && <small> ← {otherParents.map((p) => p.displayName).join(", ")}</small>}
          </button>
          <div className="argowf-timeline">
            <span
              style={{
                left: `${Math.max(0, Math.min(100, ((from - start) / span) * 100))}%`,
                width: `${Math.max(1, Math.min(100, ((to - from) / span) * 100))}%`,
              }}
            />
          </div>
        </div>
        {!collapsed.has(node.id) &&
          node.children.map((id) => {
            const child = nodes.get(id);
            return child ? draw(child, depth + 1, node.id) : null;
          })}
      </div>
    );
  };
  return <div>{roots.map((root) => draw(root, 0, null))}</div>;
}
