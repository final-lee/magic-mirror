import { useEffect, useRef, useState } from "react";
import { useSettings } from "../api/queries";
import type { K8sLaneWidths } from "../api/types";
import { RESIZE_LANE } from "./text";

export type Lane = "nav" | "tree" | "detail";

/** 마우스로 줄일 수 있는 한계. 상세는 CSS의 min-width와 같다. */
export const LANE_LIMITS: Record<Lane, { min: number; max: number }> = {
  nav: { min: 120, max: 400 },
  tree: { min: 120, max: 480 },
  detail: { min: 360, max: 1400 },
};

const clamp = (lane: Lane, w: number) => Math.round(Math.min(LANE_LIMITS[lane].max, Math.max(LANE_LIMITS[lane].min, w)));

/**
 * 레인 너비. 끄는 동안은 화면에만 반영하고, 놓을 때 설정에 저장한다.
 * 저장한 값이 없으면 undefined(CSS 기본값).
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
  /** 손잡이 앞(왼쪽) 레인이면 오른쪽으로 끌 때 넓어지고, 뒤(오른쪽) 레인이면 좁아진다 */
  side: "before" | "after";
  onResize: (lane: Lane, width: number) => void;
  onCommit: (lane: Lane, width: number) => void;
}

/** 두 레인 사이의 세로 손잡이. 끌거나 ←/→ 키로 옆 레인의 너비를 바꾼다. */
export function LaneResizer({ lane, side, onResize, onCommit }: ResizerProps) {
  const handle = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x: number; width: number } | null>(null);
  const last = useRef(0);
  const sign = side === "before" ? 1 : -1;
  /** 옆 레인의 지금 너비(저장 값이 없으면 CSS가 정한 너비) */
  const current = () => {
    const el = (side === "before" ? handle.current?.previousElementSibling : handle.current?.nextElementSibling) as HTMLElement | null | undefined;
    return el?.getBoundingClientRect().width ?? 0;
  };
  useEffect(() => {
    if (!drag) return;
    const move = (e: MouseEvent) => {
      last.current = drag.width + (e.clientX - drag.x) * sign;
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
  }, [drag, lane, sign, onResize, onCommit]);

  return (
    <div
      ref={handle}
      className={`k8s-resizer${drag ? " on" : ""}`}
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
        onCommit(lane, current() + (e.key === "ArrowRight" ? 16 : -16) * sign);
      }}
    />
  );
}
