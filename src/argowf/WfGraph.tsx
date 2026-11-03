import { useEffect, useMemo, useRef, useState } from "react";
import { layoutGraph, NODE_H, NODE_W, type GraphDirection } from "./graphLayout";
import type { WfNode } from "./types";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
const text = (s: string, max = 24) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** 집합에 값을 넣고 뺀 새 집합 */
const flip = <T,>(set: ReadonlySet<T>, value: T): Set<T> => {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
};

/**
 * 노드 그래프: `children` 흐름(Steps·DAG)을 층으로 놓은 SVG. 확대·축소(버튼·휠)와 끌기, 가로/세로, phase·종류 거르기,
 * StepGroup·TaskGroup 접기, 아티팩트 노드 보이기. 노드를 누르면 onSelect.
 */
export function WfGraph({ nodes, selected, onSelect }: { nodes: WfNode[]; selected: string | null; onSelect(id: string): void }) {
  const [direction, setDirection] = useState<GraphDirection>("LR");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [hiddenPhases, setHiddenPhases] = useState<ReadonlySet<string>>(new Set());
  const [hiddenTypes, setHiddenTypes] = useState<ReadonlySet<string>>(new Set());
  const [showArtifacts, setShowArtifacts] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const graph = useMemo(
    () => layoutGraph(nodes, { direction, collapsed, hiddenPhases, hiddenTypes, showArtifacts }),
    [nodes, direction, collapsed, hiddenPhases, hiddenTypes, showArtifacts],
  );
  const phases = useMemo(() => [...new Set(nodes.map((n) => n.phase))].sort(), [nodes]);
  const types = useMemo(() => [...new Set(nodes.map((n) => n.type))].sort(), [nodes]);
  const hasArtifacts = nodes.some((n) => n.artifacts.length > 0);

  // 휠은 확대·축소다. 화면이 같이 스크롤되지 않게 passive가 아닌 리스너로 붙인다
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom((z) => clampZoom(z * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  return (
    <div className="argowf-graph">
      <div className="argowf-graph-bar">
        <button className="btn small" aria-pressed={direction === "LR"} onClick={() => setDirection("LR")}>
          가로
        </button>
        <button className="btn small" aria-pressed={direction === "TB"} onClick={() => setDirection("TB")}>
          세로
        </button>
        <button className="btn small" aria-label="확대" onClick={() => setZoom((z) => clampZoom(z * 1.25))}>
          ＋
        </button>
        <button className="btn small" aria-label="축소" onClick={() => setZoom((z) => clampZoom(z / 1.25))}>
          －
        </button>
        <button
          className="btn small"
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
        >
          원래 크기
        </button>
        <span className="dim">{Math.round(zoom * 100)}%</span>
        {hasArtifacts && (
          <label>
            <input type="checkbox" checked={showArtifacts} onChange={(e) => setShowArtifacts(e.target.checked)} /> 아티팩트
          </label>
        )}
      </div>
      <div className="argowf-graph-bar" role="group" aria-label="그래프 거르기">
        <span className="dim">상태</span>
        {phases.map((phase) => (
          <label key={phase || "none"}>
            <input type="checkbox" checked={!hiddenPhases.has(phase)} onChange={() => setHiddenPhases((old) => flip(old, phase))} /> {phase || "(없음)"}
          </label>
        ))}
        <span className="dim">종류</span>
        {types.map((type) => (
          <label key={type}>
            <input type="checkbox" checked={!hiddenTypes.has(type)} onChange={() => setHiddenTypes((old) => flip(old, type))} /> {type}
          </label>
        ))}
      </div>
      <div
        ref={frame}
        className="argowf-graph-frame"
        onMouseDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY };
        }}
        onMouseMove={(e) => {
          const from = drag.current;
          if (!from) return;
          drag.current = { x: e.clientX, y: e.clientY };
          setPan((p) => ({ x: p.x + e.clientX - from.x, y: p.y + e.clientY - from.y }));
        }}
        onMouseUp={() => {
          drag.current = null;
        }}
        onMouseLeave={() => {
          drag.current = null;
        }}
      >
        <svg role="img" aria-label="Workflow 그래프" width="100%" height="100%">
          <defs>
            <marker id="argowf-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="var(--tone-8e8e93)" />
            </marker>
          </defs>
          <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
            {graph.edges.map((edge) => (
              <path key={edge.id} d={edge.path} className="argowf-edge" markerEnd="url(#argowf-arrow)" />
            ))}
            {graph.nodes.map((node) => (
              <g
                key={node.id}
                data-node-id={node.id}
                transform={`translate(${node.x},${node.y})`}
                className={`argowf-gnode ${node.artifact ? "artifact" : `phase-${node.phase || "none"}`}${selected === node.nodeId && !node.artifact ? " selected" : ""}`}
              >
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={node.artifact ? 14 : 6}
                  role="button"
                  tabIndex={0}
                  aria-label={node.label}
                  aria-pressed={selected === node.nodeId}
                  onClick={() => onSelect(node.nodeId)}
                  onKeyDown={(e) => e.key === "Enter" && onSelect(node.nodeId)}
                />
                <text x={10} y={15} className="argowf-gname">
                  {text(node.label)}
                </text>
                <text x={10} y={29} className="argowf-gtype">
                  {node.artifact
                    ? `${node.artifact.direction === "input" ? "입력" : "출력"} 아티팩트`
                    : node.collapsed
                      ? `${node.type} · ${node.hidden}개 접힘`
                      : node.type}
                </text>
                {node.collapsible && (
                  <g
                    role="button"
                    tabIndex={0}
                    aria-label={`${node.label} ${node.collapsed ? "펼치기" : "접기"}`}
                    className="argowf-gtoggle"
                    transform={`translate(${NODE_W - 16},${NODE_H / 2})`}
                    onClick={() => setCollapsed((old) => flip(old, node.id))}
                    onKeyDown={(e) => e.key === "Enter" && setCollapsed((old) => flip(old, node.id))}
                  >
                    <circle r={8} />
                    <text textAnchor="middle" dy="4">
                      {node.collapsed ? "+" : "−"}
                    </text>
                  </g>
                )}
                <title>{`${node.label} · ${node.type}${node.phase ? ` · ${node.phase}` : ""}`}</title>
              </g>
            ))}
          </g>
        </svg>
        {graph.nodes.length === 0 && <div className="empty">보여 줄 노드가 없어요</div>}
      </div>
    </div>
  );
}
