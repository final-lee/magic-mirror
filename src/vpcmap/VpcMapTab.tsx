import { useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent } from "react";
import { errorMessage } from "../api/errors";
import { DetailPanel } from "../components/DetailPanel";
import { ErrorState } from "../components/ErrorState";
import { vpcApi } from "./api";
import { defaultRouteTargets, gatewayDetail, gatewayMatchesTarget, peeringDetail, resourceNodeDetail, subnetDetail } from "./detail";
import { layoutTopology, type ChipLayout, type Layout, type SubnetLayout, type TileLayout } from "./layout";
import { C, CHIP_BADGE_COLOR, KIND_BADGE, stateColor, TIER_COLOR } from "./palette";
import { topologyKey, useVpcTopology } from "./queries";
import { svgToPng } from "./toPng";
import type { VpcTopology } from "./types";

interface Props {
  profile: string;
  region: string;
  vpcId: string;
  name: string;
  active: boolean;
}

type Selection = { kind: "subnet" | "resource" | "chip"; id: string } | null;
interface View {
  k: number;
  x: number;
  y: number;
}

const MIN_K = 0.3;
const MAX_K = 3;
const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k));
const FONT = "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif";
const MONO = "ui-monospace, Menlo, monospace";
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function VpcMapTab({ profile, region, vpcId, name, active }: Props) {
  const qc = useQueryClient();
  const q = useVpcTopology(profile, region, vpcId);
  const topo = q.data;
  const layout = useMemo(() => (topo ? layoutTopology(topo) : null), [topo]);

  const [selection, setSelection] = useState<Selection>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [view, setView] = useState<View>({ k: 1, x: 0, y: 0 });
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const activeRef = useRef(active);
  activeRef.current = active;
  const fitted = useRef(false);
  const moved = useRef(false);

  const fit = useCallback(() => {
    if (!layout) return false;
    const el = boxRef.current;
    const cw = el?.clientWidth ?? 0;
    const ch = el?.clientHeight ?? 0;
    if (!cw || !ch) {
      setView({ k: 1, x: 0, y: 0 });
      return false;
    }
    const k = clampK(Math.min(cw / layout.width, ch / layout.height, 1));
    setView({ k, x: (cw - layout.width * k) / 2, y: Math.max(0, (ch - layout.height * k) / 2) });
    return true;
  }, [layout]);

  useLayoutEffect(() => {
    if (!layout || fitted.current || !active) return;
    fitted.current = fit();
  }, [layout, active, fit]);

  const zoomAt = useCallback((factor: number, px: number, py: number) => {
    setView((v) => {
      const k = clampK(v.k * factor);
      const r = k / v.k;
      return { k, x: px - (px - v.x) * r, y: py - (py - v.y) * r };
    });
  }, []);
  const zoomCenter = (factor: number) => {
    const el = boxRef.current;
    zoomAt(factor, (el?.clientWidth ?? 0) / 2, (el?.clientHeight ?? 0) / 2);
  };

  // 휠 확대/축소 (passive: false 리스너가 필요하다)
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!activeRef.current) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0018), e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt, !!layout]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!active) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setSelection(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    moved.current = false;
    const sx = e.clientX;
    const sy = e.clientY;
    const start = viewRef.current;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!moved.current && Math.hypot(dx, dy) < 4) return;
      moved.current = true;
      setView({ ...start, x: start.x + dx, y: start.y + dy });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onBackgroundClick = () => {
    if (!moved.current) setSelection(null);
    moved.current = false;
  };

  const savePng = async () => {
    if (!svgRef.current || !layout || !topo) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const bytes = await svgToPng(svgRef.current, layout.width, layout.height);
      const saved = await vpcApi.savePng(`${topo.vpc.name || topo.vpc.id}-network.png`, bytes);
      if (saved) setSaveMsg({ ok: true, text: "저장했어요" });
    } catch (e) {
      setSaveMsg({ ok: false, text: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };
  useEffect(() => {
    if (!saveMsg?.ok) return;
    const t = setTimeout(() => setSaveMsg(null), 2500);
    return () => clearTimeout(t);
  }, [saveMsg]);

  const refresh = () => void qc.invalidateQueries({ queryKey: topologyKey(profile, region, vpcId) });

  // ── 선택에서 파생되는 값 ──
  const selectedSubnet = topo && selection?.kind === "subnet" ? (topo.subnets.find((s) => s.id === selection.id) ?? null) : null;
  const routeTargets = useMemo(() => (topo ? defaultRouteTargets(topo, selectedSubnet) : []), [topo, selectedSubnet]);
  const detail = useMemo(() => {
    if (!topo || !selection) return null;
    if (selection.kind === "subnet") {
      const s = topo.subnets.find((x) => x.id === selection.id);
      return s ? subnetDetail(topo, s) : null;
    }
    if (selection.kind === "resource") {
      const r = topo.resources.find((x) => x.id === selection.id);
      return r ? resourceNodeDetail(r) : null;
    }
    const g = topo.gateways.find((x) => x.id === selection.id);
    if (g) return gatewayDetail(g);
    const p = topo.peerings.find((x) => x.id === selection.id);
    return p ? peeringDetail(p) : null;
  }, [topo, selection]);
  const focusId = selection?.kind === "resource" ? selection.id : hoverId;

  const title = topo ? topo.vpc.name || topo.vpc.id : name;

  return (
    <>
      <div className="vpcmap">
        <div className="vm-toolbar">
          <span className="vm-title" title={vpcId}>
            {title}
          </span>
          <span className="vm-zoom">
            <button className="btn small" onClick={fit} disabled={!layout}>
              맞춤
            </button>
            <button className="btn small" onClick={() => layout && zoomAt(1 / viewRef.current.k, (boxRef.current?.clientWidth ?? 0) / 2, (boxRef.current?.clientHeight ?? 0) / 2)} disabled={!layout}>
              100%
            </button>
            <button className="btn small" aria-label="축소" onClick={() => zoomCenter(1 / 1.25)} disabled={!layout}>
              −
            </button>
            <button className="btn small" aria-label="확대" onClick={() => zoomCenter(1.25)} disabled={!layout}>
              +
            </button>
            <span className="vm-pct" data-testid="vpc-zoom">
              {Math.round(view.k * 100)}%
            </span>
          </span>
          <span className="sp">
            {saveMsg && <span className={saveMsg.ok ? "ok" : "err"}>{saveMsg.text}</span>}
            <button className="btn small" onClick={refresh} disabled={q.isFetching}>
              {q.isFetching ? "불러오는 중…" : "새로고침"}
            </button>
            <button className="btn small" onClick={() => void savePng()} disabled={!layout || saving}>
              PNG로 저장
            </button>
          </span>
        </div>
        {q.isError && q.data && <ErrorState compact error={q.error} profile={profile} onRetry={refresh} />}
        {topo && topo.warnings.length > 0 && (
          <ul className="vm-warnings" aria-label="경고">
            {topo.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
        {q.isError && !q.data ? (
          <ErrorState error={q.error} profile={profile} onRetry={refresh} />
        ) : !topo || !layout ? (
          <div className="empty">구조도를 불러오는 중…</div>
        ) : (
          <div className="vm-canvas" ref={boxRef} onPointerDown={onPointerDown} onClick={onBackgroundClick} data-testid="vpc-canvas">
            <svg ref={svgRef} width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" role="group" aria-label={`${title} 네트워크 구조도`} style={{ display: "block" }}>
              <g data-viewport transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
                <Diagram
                  topo={topo}
                  layout={layout}
                  selection={selection}
                  focusId={focusId}
                  routeTargets={routeTargets}
                  onSelect={setSelection}
                  onHover={setHoverId}
                />
              </g>
            </svg>
          </div>
        )}
      </div>
      <DetailPanel detail={detail} onShowRaw={() => {}} />
    </>
  );
}

interface DiagramProps {
  topo: VpcTopology;
  layout: Layout;
  selection: Selection;
  focusId: string | null;
  routeTargets: string[];
  onSelect: (s: Selection) => void;
  onHover: (id: string | null) => void;
}

function Diagram({ topo, layout, selection, focusId, routeTargets, onSelect, onHover }: DiagramProps) {
  const { vpc } = layout;
  return (
    <g fontFamily={FONT}>
      <rect x={0} y={0} width={layout.width} height={layout.height} fill={C.bg} />
      <rect x={vpc.x} y={vpc.y} width={vpc.w} height={vpc.h} rx={10} fill={C.vpcFill} stroke={C.vpc} strokeWidth={2} />
      <text x={vpc.x + 20} y={vpc.y + 26} fontSize={15} fontWeight={700} fill={C.text}>
        {topo.vpc.name || topo.vpc.id}
        {topo.vpc.isDefault ? "  (default)" : ""}
      </text>
      <text x={vpc.x + 20} y={vpc.y + 42} fontSize={11} fill={C.dim} fontFamily={MONO}>
        {topo.vpc.cidrs.join(", ")} · {topo.vpc.id}
      </text>

      {layout.lanes.map((l) => (
        <g key={l.tier}>
          <rect x={l.x} y={l.y} width={l.w} height={l.h} rx={8} fill={TIER_COLOR[l.tier].lane} stroke={TIER_COLOR[l.tier].stroke} strokeOpacity={0.35} strokeDasharray="4 4" />
          <text x={l.x + 14} y={l.y + l.h / 2 + 4} fontSize={13} fontWeight={700} fill={TIER_COLOR[l.tier].text}>
            {l.label}
          </text>
        </g>
      ))}
      {layout.azHeaders.map((a) => (
        <text key={a.az} x={a.x + a.w / 2} y={a.y + 20} fontSize={12} fontWeight={600} textAnchor="middle" fill={C.dim}>
          {a.az}
        </text>
      ))}

      {layout.subnets.map((s) => (
        <SubnetBox key={s.subnet.id} s={s} selected={selection?.kind === "subnet" && selection.id === s.subnet.id} onSelect={onSelect} />
      ))}
      {layout.subnets.flatMap((s) =>
        s.tiles.map((t) => (
          <Tile
            key={t.key}
            t={t}
            selected={!!t.resource && selection?.kind === "resource" && selection.id === t.resource.id}
            focused={!!t.resource && focusId === t.resource.id}
            routeTarget={!!t.resource && routeTargets.includes(t.resource.id)}
            onSelect={onSelect}
            onHover={onHover}
          />
        )),
      )}

      {layout.band && (
        <g>
          <rect x={layout.band.x} y={layout.band.y} width={layout.band.w} height={layout.band.h} rx={8} fill="#ffffff06" stroke={C.tileLine} strokeDasharray="4 4" strokeOpacity={0.6} />
          <text x={layout.band.x + 14} y={layout.band.y + 19} fontSize={12} fontWeight={700} fill={C.dim}>
            외부 연결
          </text>
        </g>
      )}
      <g aria-hidden="true">
        <rect x={layout.legend.x} y={layout.legend.y} width={layout.legend.w} height={layout.legend.h} rx={6} fill={C.tile} fillOpacity={0.8} stroke={C.tileLine} />
        {layout.legend.items.map((it) => (
          <g key={it.key}>
            <rect x={it.x} y={layout.legend.y + layout.legend.h / 2 - 6} width={12} height={12} rx={3} fill={it.key === "route" ? C.route : TIER_COLOR[it.key].stroke} />
            <text x={it.textX} y={layout.legend.y + layout.legend.h / 2 + 4} fontSize={11} fill={C.dim}>
              {it.label}
            </text>
          </g>
        ))}
      </g>
      {layout.chips.map((c) => (
        <Chip
          key={c.key}
          c={c}
          selected={selection?.kind === "chip" && selection.id === c.id}
          routeTarget={c.gateway ? routeTargets.some((t) => gatewayMatchesTarget(c.gateway!, t)) : !!c.peering && routeTargets.includes(c.peering.id)}
          onSelect={onSelect}
        />
      ))}
    </g>
  );
}

const activate = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    e.stopPropagation();
    fn();
  }
};

const SubnetBox = memo(function SubnetBox({ s, selected, onSelect }: { s: SubnetLayout; selected: boolean; onSelect: (s: Selection) => void }) {
  const col = TIER_COLOR[s.subnet.tier];
  const select = () => onSelect({ kind: "subnet", id: s.subnet.id });
  return (
    <g
      className={`vm-subnet${selected ? " selected" : ""}`}
      data-id={s.subnet.id}
      role="button"
      tabIndex={0}
      aria-label={`서브넷 ${s.subnet.name || s.subnet.id}`}
      aria-pressed={selected}
      style={{ cursor: "pointer", outline: "none" }}
      onClick={(e) => {
        e.stopPropagation();
        select();
      }}
      onKeyDown={activate(select)}
    >
      <title>{`${s.subnet.name || s.subnet.id}\n${s.subnet.cidr}`}</title>
      <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={8} fill={col.fill} stroke={selected ? C.accent : col.stroke} strokeWidth={selected ? 2.5 : 1.5} />
      <text x={s.x + 12} y={s.y + 20} fontSize={12} fontWeight={700} fill={C.text}>
        {short(s.subnet.name || s.subnet.id, 30)}
      </text>
      <text x={s.x + 12} y={s.y + 36} fontSize={10.5} fill={C.dim} fontFamily={MONO}>
        {s.subnet.cidr}
        {s.subnet.availableIps !== null ? `  ·  남은 IP ${s.subnet.availableIps}` : ""}
      </text>
    </g>
  );
});

const Tile = memo(function Tile({ t, selected, focused, routeTarget, onSelect, onHover }: {
  t: TileLayout;
  selected: boolean;
  focused: boolean;
  routeTarget: boolean;
  onSelect: (s: Selection) => void;
  onHover: (id: string | null) => void;
}) {
  const r = t.resource;
  if (!r) {
    // "+N" 타일: 클릭은 서브넷 선택으로 넘긴다
    return (
      <g pointerEvents="none">
        <rect x={t.x} y={t.y} width={t.w} height={t.h} rx={6} fill="none" stroke={C.tileLine} strokeDasharray="3 3" />
        <text x={t.x + t.w / 2} y={t.y + t.h / 2 + 5} fontSize={14} fontWeight={700} textAnchor="middle" fill={C.dim}>
          +{t.overflow}
        </text>
      </g>
    );
  }
  const badge = KIND_BADGE[r.kind];
  const select = () => onSelect({ kind: "resource", id: r.id });
  const label = r.name || r.id;
  const stroke = routeTarget ? C.route : selected ? C.accent : focused ? "#ffffff" : C.tileLine;
  return (
    <g
      className={`vm-tile${selected ? " selected" : ""}${focused ? " focused" : ""}${routeTarget ? " route-target" : ""}`}
      data-id={r.id}
      role="button"
      tabIndex={0}
      aria-label={`${badge.label} ${label}`}
      aria-pressed={selected}
      style={{ cursor: "pointer", outline: "none" }}
      onClick={(e) => {
        e.stopPropagation();
        select();
      }}
      onKeyDown={activate(select)}
      onMouseEnter={() => onHover(r.id)}
      onMouseLeave={() => onHover(null)}
    >
      <title>{`${label}\n${r.id} · ${r.state}`}</title>
      {routeTarget && <rect x={t.x - 3} y={t.y - 3} width={t.w + 6} height={t.h + 6} rx={9} fill="none" stroke={C.route} strokeOpacity={0.35} strokeWidth={4} />}
      <rect x={t.x} y={t.y} width={t.w} height={t.h} rx={6} fill={C.tile} stroke={stroke} strokeWidth={routeTarget || selected || focused ? 2 : 1} />
      <rect x={t.x + 10} y={t.y + 8} width={t.w - 20} height={24} rx={5} fill={badge.color} />
      <text x={t.x + t.w / 2} y={t.y + 24} fontSize={r.kind === "lambda" ? 15 : 10.5} fontWeight={700} textAnchor="middle" fill="#fff">
        {badge.label}
      </text>
      <circle cx={t.x + t.w - 8} cy={t.y + 8} r={3.5} fill={stateColor(r.state)} />
      <text x={t.x + t.w / 2} y={t.y + 50} fontSize={9.5} textAnchor="middle" fill={C.text}>
        {short(label, 9)}
      </text>
    </g>
  );
});

function Chip({ c, selected, routeTarget, onSelect }: { c: ChipLayout; selected: boolean; routeTarget: boolean; onSelect: (s: Selection) => void }) {
  const select = () => onSelect({ kind: "chip", id: c.id });
  const color = CHIP_BADGE_COLOR[c.badge] ?? "#666";
  const bw = c.badge.length * 7 + 12;
  return (
    <g
      className={`vm-chip${selected ? " selected" : ""}${routeTarget ? " route-target" : ""}`}
      data-id={c.id}
      role="button"
      tabIndex={0}
      aria-label={`${c.badge} ${c.text}`}
      aria-pressed={selected}
      style={{ cursor: "pointer", outline: "none" }}
      onClick={(e) => {
        e.stopPropagation();
        select();
      }}
      onKeyDown={activate(select)}
    >
      <title>{c.id}</title>
      {routeTarget && <rect x={c.x - 3} y={c.y - 3} width={c.w + 6} height={c.h + 6} rx={c.h / 2 + 3} fill="none" stroke={C.route} strokeOpacity={0.35} strokeWidth={4} />}
      <rect x={c.x} y={c.y} width={c.w} height={c.h} rx={c.h / 2} fill={C.tile} stroke={routeTarget ? C.route : selected ? C.accent : color} strokeWidth={routeTarget || selected ? 2 : 1.25} />
      <rect x={c.x + 5} y={c.y + 5} width={bw} height={c.h - 10} rx={(c.h - 10) / 2} fill={color} />
      <text x={c.x + 5 + bw / 2} y={c.y + 19} fontSize={9.5} fontWeight={700} textAnchor="middle" fill="#fff">
        {c.badge}
      </text>
      <text x={c.x + 5 + bw + 6} y={c.y + 19} fontSize={11} fill={C.text}>
        {c.text}
      </text>
    </g>
  );
}
