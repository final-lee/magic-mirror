import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useSettings } from "../api/queries";
import type { K8sLaneWidths } from "../api/types";
import { RESIZE_LANE } from "./text";

/** nav: 1열 메뉴(px), tree: 2열 종류(px), detailPct: 4열 상세가 3열 목록을 덮는 너비(%) */
export type Lane = "nav" | "tree" | "detailPct";

export const LANE_LIMITS: Record<Lane, { min: number; max: number }> = {
  nav: { min: 120, max: 400 },
  tree: { min: 120, max: 480 },
  detailPct: { min: 30, max: 95 },
};
/** 상세는 처음에 목록 너비의 70%를 덮는다 */
export const DETAIL_PCT = 70;

const clamp = (lane: Lane, w: number) => Math.round(Math.min(LANE_LIMITS[lane].max, Math.max(LANE_LIMITS[lane].min, w)));

/**
 * 레인 너비. 끄는 동안은 화면에만 반영하고, 놓을 때 설정에 저장한다.
 * 저장한 값이 없으면 undefined(기본값).
 */
export function useLaneWidths() {
  const { settings, update } = useSettings();
  const saved = settings?.k8sLaneWidths ?? {};
  const [live, setLive] = useState<Partial<Record<Lane, number>>>({});
  const width = (lane: Lane): number | undefined => live[lane] ?? saved[lane] ?? undefined;
  const resize = (lane: Lane, w: number) => setLive((l) => ({ ...l, [lane]: clamp(lane, w) }));
  const commit = (lane: Lane, w: number) => {
    const next: K8sLaneWidths = { ...saved, [lane]: clamp(lane, w) };
    update({ k8sLaneWidths: next });
    setLive((l) => {
      const rest = { ...l };
      delete rest[lane];
      return rest;
    });
  };
  return { width, resize, commit };
}

interface ResizerProps {
  lane: Lane;
  onResize: (lane: Lane, width: number) => void;
  onCommit: (lane: Lane, width: number) => void;
  style?: CSSProperties;
}

/**
 * 세로 손잡이. 끌거나 ←/→ 키로 너비를 바꾼다.
 * nav·tree: 바로 앞(왼쪽) 레인의 px 너비. detailPct: 부모(목록 칸)의 오른쪽 끝에서 손잡이까지가 목록 너비의 몇 %인지.
 */
export function LaneResizer({ lane, onResize, onCommit, style }: ResizerProps) {
  const handle = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x: number; width: number } | null>(null);
  const last = useRef(0);
  const pct = lane === "detailPct";
  /** 지금 값(저장 값이 없으면 화면이 정한 너비) */
  const current = () => {
    const h = handle.current;
    if (!h) return 0;
    if (pct) {
      const pane = h.parentElement?.getBoundingClientRect();
      const self = h.getBoundingClientRect();
      return pane && pane.width > 0 ? ((pane.right - (self.left + self.width / 2)) / pane.width) * 100 : DETAIL_PCT;
    }
    return (h.previousElementSibling as HTMLElement | null)?.getBoundingClientRect().width ?? 0;
  };
  useEffect(() => {
    if (!drag) return;
    const move = (e: MouseEvent) => {
      const pane = pct ? handle.current?.parentElement?.getBoundingClientRect() : undefined;
      last.current = pane && pane.width > 0 ? ((pane.right - e.clientX) / pane.width) * 100 : drag.width + (e.clientX - drag.x);
      onResize(lane, last.current);
    };
    const up = () => {
      setDrag(null);
      onCommit(lane, last.current);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [drag, lane, pct, onResize, onCommit]);

  return (
    <div
      ref={handle}
      className={`k8s-resizer${pct ? " k8s-detail-resizer" : ""}${drag ? " on" : ""}`}
      style={style}
      role="separator"
      aria-orientation="vertical"
      aria-label={RESIZE_LANE}
      tabIndex={0}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        last.current = current();
        setDrag({ x: e.clientX, width: last.current });
      }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        // 손잡이를 왼쪽으로 옮기는 키: 메뉴·종류는 좁아지고, 상세는 넓어진다
        const step = pct ? 5 : 16;
        const left = e.key === "ArrowLeft";
        onCommit(lane, current() + (pct ? (left ? step : -step) : left ? -step : step));
      }}
    />
  );
}
