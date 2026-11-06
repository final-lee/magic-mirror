import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Resource } from "../api/types";
import { useMapGrab } from "../lib/useMapGrab";
import { layoutDeviceMap, type MapEdge, type MapGroup, type MapNode } from "./deviceMapLayout";
import type { Device } from "./devicesApi";
import * as text from "./devicesText";
import type { TsPeer } from "./types";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
const truncate = (label: string, max: number) => (label.length > max ? `${label.slice(0, max - 1)}…` : label);

/** (cx, cy) 화면 점이 확대 뒤에도 같은 지도 점을 가리키게 이동량을 고친다 */
function zoomAround(view: { zoom: number; x: number; y: number }, factor: number, cx: number, cy: number) {
  const zoom = clampZoom(view.zoom * factor);
  const scale = zoom / view.zoom;
  return { zoom, x: cx - (cx - view.x) * scale, y: cy - (cy - view.y) * scale };
}

interface Props {
  devices: Device[];
  peers: TsPeer[];
  self: TsPeer | null;
  vpcs?: Resource[];
  /** 표로 돌아가 이 이름으로 검색한다 */
  onShowTable(name: string): void;
}

/**
 * 기기 지도: 왼쪽에 이 Mac과 연결 경로(직접·릴레이 지역), 가운데에 줄 맞춘 기기 묶음(첫 태그, 없으면 소유자),
 * 오른쪽에 서브넷 경로·exit node와 VPC. 연결 경로에 올리면 그 경로로 붙은 기기만 또렷하게, 기기에 올리면 그 기기의 선을 강조한다.
 * 확대·축소(버튼·휠)와 끌기는 Argo Workflows 그래프와 같다. 처음 열 때와 거르기로 지도 크기가 바뀔 때 화면에 맞춘다.
 */
export function DeviceMap({ devices, peers, self, vpcs, onShowTable }: Props) {
  const graph = useMemo(() => layoutDeviceMap({ devices, peers, self, vpcs }), [devices, peers, self, vpcs]);
  const [selected, setSelected] = useState<string | null>(null);
  // 강조할 기기: 기기 하나(그 기기에 올림) 또는 연결 경로의 기기들(경로 노드에 올림)
  const [hover, setHover] = useState<{ ids: ReadonlySet<string>; path: boolean } | null>(null);
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  // 누른 자리. 거의 움직이지 않고 뗐으면 끌기가 아니라 누르기로 본다(빈 곳 누르기는 상세를 닫는다).
  // 잡지 않았던 지도를 누른 것이면 null: 그 누름은 잡기만 하고 상세를 닫지 않는다
  const pressed = useRef<{ x: number; y: number } | null>(null);

  // 상세가 열려 있으면 Esc로 닫는다. 위에 대화 상자가 떠 있으면 그 창이 먼저다
  useEffect(() => {
    if (!selected) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector(".modal")) return;
      setSelected(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selected]);

  // 휠은 마우스 자리를 중심으로 확대·축소한다. 눌러서 잡은 동안만 받는다(놓여 있으면 휠은 화면을 스크롤한다)
  const map = useMapGrab((event, el) => {
    const box = el.getBoundingClientRect();
    setView((v) => zoomAround(v, event.deltaY < 0 ? 1.1 : 1 / 1.1, event.clientX - box.left, event.clientY - box.top));
  });
  const frame = map.element;

  const fit = useCallback(() => {
    const el = frame.current;
    if (!el || !el.clientWidth || !el.clientHeight) return;
    const zoom = clampZoom(Math.min(el.clientWidth / graph.width, el.clientHeight / graph.height));
    setView({ zoom, x: Math.max(0, (el.clientWidth - graph.width * zoom) / 2), y: 0 });
  }, [frame, graph.width, graph.height]);
  useLayoutEffect(fit, [fit]);

  // 버튼은 보이는 화면의 가운데를 중심으로
  const zoomBy = (factor: number) => {
    const el = frame.current;
    setView((v) => zoomAround(v, factor, (el?.clientWidth ?? 0) / 2, (el?.clientHeight ?? 0) / 2));
  };
  const moveTo = (x: number, y: number) => {
    const from = drag.current;
    if (!from) return;
    drag.current = { x, y };
    setView((v) => ({ ...v, x: v.x + x - from.x, y: v.y + y - from.y }));
  };

  const positions = new Map<string, MapNode | MapGroup>([...graph.nodes, ...graph.groups].map((item) => [item.id, item]));
  const chosen = graph.nodes.find((node) => node.device?.id === selected) ?? null;

  return (
    <div className="ts-device-map">
      <div className="argowf-graph-bar">
        <button className="btn small tone-secondary" aria-label={text.MAP_ZOOM_IN} onClick={() => zoomBy(1.25)}>＋</button>
        <button className="btn small tone-secondary" aria-label={text.MAP_ZOOM_OUT} onClick={() => zoomBy(1 / 1.25)}>－</button>
        <button className="btn small tone-secondary" onClick={fit}>{text.MAP_FIT}</button>
        <span className="dim">{Math.round(view.zoom * 100)}%</span>
      </div>
      <div
        {...map.frameProps}
        className={`argowf-graph-frame${map.active ? " grabbed" : ""}`}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          // 끌기를 글자 고르기로 시작하지 않게 한다(이미 골라진 글자가 있으면 지운다)
          e.preventDefault();
          window.getSelection()?.removeAllRanges();
          // 잡지 않았던 지도를 누르면 잡기만 한다
          if (!map.grab()) {
            pressed.current = null;
            return;
          }
          drag.current = { x: e.clientX, y: e.clientY };
          pressed.current = { x: e.clientX, y: e.clientY };
        }}
        onMouseMove={(e) => moveTo(e.clientX, e.clientY)}
        onMouseUp={() => { drag.current = null; }}
        onMouseLeave={() => { drag.current = null; }}
        onClick={(e) => {
          const start = pressed.current;
          const still = !!start && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4;
          const onChip = e.target instanceof Element && e.target.closest(".ts-map-chip") !== null;
          if (still && !onChip) setSelected(null);
        }}
      >
        <svg width="100%" height="100%" aria-label={text.MAP}>
          <g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
            {graph.edges.map((edge) => (
              <EdgePath key={edge.id} edge={edge} positions={positions} highlighted={!!hover && edge.deviceIds.some((id) => hover.ids.has(id))} />
            ))}
            {graph.groups.map((group) => (
              <g key={group.id} className="ts-map-group">
                <rect x={group.x} y={group.y} width={group.width} height={group.height} rx="8" />
                <text x={group.x + 12} y={group.y + 23}>{group.name} ({group.devices.length})</text>
              </g>
            ))}
            {graph.nodes.map((node) =>
              node.kind === "device" ? (
                <DeviceChip
                  key={node.id}
                  node={node}
                  dimmed={!!hover?.path && !hover.ids.has(node.device!.id)}
                  selected={selected === node.device!.id}
                  onHover={(id) => setHover(id ? { ids: new Set([id]), path: false } : null)}
                  onSelect={(id) => setSelected((current) => (current === id ? null : id))}
                />
              ) : (
                <g
                  key={node.id}
                  className={`ts-map-node${node.deviceIds ? " ts-map-path" : ""}`}
                  onMouseEnter={node.deviceIds ? () => setHover({ ids: new Set(node.deviceIds), path: true }) : undefined}
                  onMouseLeave={node.deviceIds ? () => setHover(null) : undefined}
                >
                  <rect x={node.x} y={node.y} width={node.width} height={node.height} rx="6" />
                  <text x={node.x + 10} y={node.y + node.height / 2 + 4}>
                    {truncate(node.label, 22)}
                    {node.count ? ` (${node.count})` : ""}
                  </text>
                  <title>{node.label}</title>
                </g>
              ),
            )}
          </g>
        </svg>
      </div>
      {chosen?.device && (
        <DeviceDetails device={chosen.device} peer={chosen.peer} onShowTable={onShowTable} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function EdgePath({ edge, positions, highlighted }: { edge: MapEdge; positions: Map<string, MapNode | MapGroup>; highlighted: boolean }) {
  const from = positions.get(edge.from);
  const to = positions.get(edge.to);
  if (!from || !to) return null;
  const x1 = from.x + from.width;
  const y1 = from.y + from.height / 2;
  const x2 = to.x;
  const y2 = to.y + Math.min(to.height / 2, 24);
  const mid = (x1 + x2) / 2;
  return (
    <g className={highlighted ? "ts-map-highlight" : undefined}>
      <path
        className="ts-map-edge"
        d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
        strokeWidth={edge.count ? Math.min(6, 1 + Math.sqrt(edge.count)) : 1.4}
        strokeDasharray={edge.pending ? "5 4" : undefined}
      />
    </g>
  );
}

function DeviceChip({ node, dimmed, selected, onHover, onSelect }: {
  node: MapNode; dimmed: boolean; selected: boolean; onHover(id: string | null): void; onSelect(id: string): void;
}) {
  const device = node.device!;
  const status = node.peer ? (node.peer.online ? "online" : "offline") : "unknown";
  const findings = device.findings?.length ?? 0;
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={device.name}
      aria-pressed={selected}
      className={`ts-map-chip${status === "offline" ? " offline" : ""}${dimmed ? " dimmed" : ""}${selected ? " selected" : ""}`}
      onMouseEnter={() => onHover(device.id)}
      onMouseLeave={() => onHover(null)}
      onClick={() => onSelect(device.id)}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onSelect(device.id);
      }}
    >
      <title>{device.name}</title>
      <rect x={node.x} y={node.y} width={node.width} height={node.height} rx="5" />
      <circle className={status} cx={node.x + 11} cy={node.y + node.height / 2} r="4" />
      <text x={node.x + 21} y={node.y + node.height / 2 + 4}>{truncate(node.label, 16)}</text>
      {findings > 0 && (
        <g className="ts-map-badge">
          <rect x={node.x + node.width - 24} y={node.y + 6} width="19" height="17" rx="8" />
          <text x={node.x + node.width - 14.5} y={node.y + 18} textAnchor="middle">{findings}</text>
        </g>
      )}
    </g>
  );
}

function DeviceDetails({ device, peer, onShowTable, onClose }: {
  device: Device; peer: TsPeer | undefined; onShowTable(name: string): void; onClose(): void;
}) {
  const status = peer ? (peer.online ? text.ONLINE : text.OFFLINE) : text.MAP_UNKNOWN;
  const connection = peer?.online ? (peer.curAddr ? text.DIRECT : text.relay(peer.relay)) : text.NONE;
  return (
    <section className="awc-panel" aria-label={text.MAP_DETAILS}>
      <div className="ts-panel-head">
        <h3>{device.hostname || device.name}</h3>
        <div className="awc-acts">
          <button className="btn small tone-secondary" onClick={() => onShowTable(device.hostname || device.name)}>{text.MAP_SHOW_TABLE}</button>
          <button className="btn small tone-ghost" aria-label={text.CLOSE} onClick={onClose}>✕</button>
        </div>
      </div>
      <dl className="kv">
        <dt>{text.NAME}</dt><dd>{device.name}</dd>
        <dt>{text.OS}</dt><dd>{device.os || text.NONE}</dd>
        <dt>{text.ADDRESS}</dt><dd>{device.addresses?.join(", ") || text.NONE}</dd>
        <dt>{text.TAGS}</dt><dd>{device.tags?.join(", ") || text.NONE}</dd>
        <dt>{text.OWNER}</dt><dd>{device.user || text.NONE}</dd>
        <dt>{text.STATUS}</dt><dd>{status} · {text.CONNECTION}: {connection}</dd>
        <dt>{text.FINDING}</dt>
        <dd>
          {device.findings?.length
            ? device.findings.map((finding) => <span className="sec-chip sev-medium" key={finding}>{text.FINDINGS[finding] || finding}</span>)
            : text.NONE}
        </dd>
        <dt>{text.ADVERTISED}</dt><dd>{device.advertisedRoutes?.join(", ") || text.NONE}</dd>
        <dt>{text.MAP_APPROVED}</dt><dd>{device.enabledRoutes?.join(", ") || text.NONE}</dd>
      </dl>
    </section>
  );
}
