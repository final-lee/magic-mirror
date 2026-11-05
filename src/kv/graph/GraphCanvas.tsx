import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;
/** 맞춤은 작은 그림을 이보다 더 키우지 않는다 */
const MAX_FIT = 1.25;
const FIT_PAD = 16;
/** 이만큼(px) 넘게 끌었으면 끌기이지 누름이 아니다 */
const DRAG_SLOP = 4;
const clamp = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** 간선·화살표의 색 */
export type Tone = "dim" | "good" | "bad" | "warn" | "accent";
const TONES: Tone[] = ["dim", "good", "bad", "warn", "accent"];

const MarkerContext = createContext("kvg");
/** 이 캔버스 안에서 쓰는 화살표 머리의 url */
export const useArrow = (tone: Tone) => `url(#${useContext(MarkerContext)}-${tone})`;

interface EdgeProps {
  path: string;
  tone?: Tone;
  /** 선 굵기(기본 1.5) */
  width?: number;
  dashed?: boolean;
  dotted?: boolean;
  /** 곡선 가운데에 붙는 글 */
  label?: string;
  mid?: { x: number; y: number };
  title?: string;
  /** 선이 많아 겹칠 때 흐리게(0~1) */
  opacity?: number;
}

/** 화살표 간선. label이 있으면 가운데에 배경을 깐 글을 붙인다. */
export function GraphEdgeLine({ path, tone = "dim", width = 1.5, dashed, dotted, label, mid, title, opacity }: EdgeProps) {
  const arrow = useArrow(tone);
  const w = label ? label.length * 6.4 + 10 : 0;
  return (
    <g className={`kvg-edge kvg-tone-${tone}`} opacity={opacity}>
      <path d={path} strokeWidth={width} strokeDasharray={dashed ? "6 4" : dotted ? "2 4" : undefined} markerEnd={arrow}>
        {title && <title>{title}</title>}
      </path>
      {label && mid && (
        <g transform={`translate(${mid.x},${mid.y})`} className="kvg-edge-label">
          <rect x={-w / 2} y={-8} width={w} height={16} rx={8} />
          <text textAnchor="middle" y={4}>
            {label}
          </text>
        </g>
      )}
    </g>
  );
}

interface Props {
  /** 그림의 크기(좌표계). 맞춤이 이 크기를 화면에 맞춘다 */
  width: number;
  height: number;
  label: string;
  children: ReactNode;
  /** 툴바에서 확대·축소 단추 앞에 두는 것(창 고르기 …) */
  lead?: ReactNode;
  /** 툴바 오른쪽에 더하는 것(범례, 방향 …) */
  extra?: ReactNode;
  /** 캔버스의 가장 작은 높이(px). 기본 220 */
  minHeight?: number;
  /** 캔버스의 가장 큰 높이: 창 높이에 대한 비율. 기본 0.75 */
  maxHeight?: number;
  /** 부모(세로 flex)의 남은 자리를 모두 채운다. 높이를 그림에 맞추지 않는다 */
  fill?: boolean;
  className?: string;
}

/**
 * 그래프를 그리는 SVG 캔버스: 확대·축소(버튼·휠), 끌어서 옮기기, [맞춤](그림 전체를 화면에), [100%].
 * 색은 모두 CSS 변수(테마)로 칠하니 밝은 테마와 어두운 테마를 따라간다.
 * 높이는 그림을 캔버스 너비에 맞췄을 때의 높이를 따르되 minHeight와 창 높이 × maxHeight 사이로 둔다(fill이면 부모를 채운다).
 * 그림이나 캔버스의 크기가 바뀌면 다시 맞춘다. 다만 손으로 옮기거나 확대한 뒤에는 캔버스 크기가 바뀌어도 그대로 둔다.
 */
export function GraphCanvas({ width, height, label, children, lead, extra, minHeight = 220, maxHeight = 0.75, fill = false, className = "" }: Props) {
  const id = useId().replace(/:/g, "");
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [windowHeight, setWindowHeight] = useState(() => window.innerHeight);
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; moved: number } | null>(null);
  const moved = useRef(false);
  /** 손으로 옮기거나 확대했다(맞춤을 누를 때까지 저절로 다시 맞추지 않는다) */
  const touched = useRef(false);

  const fit = () => {
    touched.current = false;
    const el = frame.current;
    if (!el || el.clientWidth === 0 || el.clientHeight === 0 || width === 0 || height === 0) return;
    const zoom = clamp(Math.min(MAX_FIT, (el.clientWidth - FIT_PAD) / width, (el.clientHeight - FIT_PAD) / height));
    setView({ zoom, x: (el.clientWidth - width * zoom) / 2, y: (el.clientHeight - height * zoom) / 2 });
  };
  // 그림의 크기가 바뀌면 다시 맞춘다
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(fit, [width, height]);
  // 캔버스의 크기가 바뀌면(창 크기, 높이 조절) 손대지 않았을 때만 다시 맞춘다
  useLayoutEffect(() => {
    if (!touched.current) fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box.w, box.h]);

  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const measure = () => setBox((b) => (b.w === el.clientWidth && b.h === el.clientHeight ? b : { w: el.clientWidth, h: el.clientHeight }));
    const resize = () => setWindowHeight(window.innerHeight);
    measure();
    window.addEventListener("resize", resize);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, []);

  /** 그림을 캔버스 너비에 맞췄을 때의 높이(위아래 한계 안) */
  const frameHeight = () => {
    if (box.w === 0 || width === 0) return minHeight;
    const natural = height * Math.min(MAX_FIT, (box.w - FIT_PAD) / width) + FIT_PAD;
    return Math.round(Math.min(Math.max(minHeight, natural), Math.max(minHeight, windowHeight * maxHeight)));
  };

  // 휠은 확대·축소다. 화면이 같이 스크롤되지 않게 passive가 아닌 리스너로 붙인다
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      touched.current = true;
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      setView((v) => {
        const zoom = clamp(v.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
        // 마우스 아래 점이 그대로 있게 옮긴다
        return { zoom, x: px - ((px - v.x) / v.zoom) * zoom, y: py - ((py - v.y) / v.zoom) * zoom };
      });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  const zoomBy = (factor: number) => {
    touched.current = true;
    const el = frame.current;
    const cx = (el?.clientWidth ?? 0) / 2;
    const cy = (el?.clientHeight ?? 0) / 2;
    setView((v) => {
      const zoom = clamp(v.zoom * factor);
      return { zoom, x: cx - ((cx - v.x) / v.zoom) * zoom, y: cy - ((cy - v.y) / v.zoom) * zoom };
    });
  };

  const down = (e: MouseEvent) => {
    if (e.button !== 0) return;
    // 끄는 동안 둘레의 글이 선택되지 않게 한다
    e.preventDefault();
    drag.current = { x: e.clientX, y: e.clientY, moved: 0 };
    moved.current = false;
  };
  const move = (e: MouseEvent) => {
    const from = drag.current;
    if (!from) return;
    const dx = e.clientX - from.x;
    const dy = e.clientY - from.y;
    from.moved += Math.abs(dx) + Math.abs(dy);
    if (from.moved > DRAG_SLOP) moved.current = touched.current = true;
    drag.current = { ...from, x: e.clientX, y: e.clientY };
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  };
  const end = () => {
    drag.current = null;
  };

  return (
    <div className={`kvg${fill ? " fill" : ""} ${className}`}>
      <div className="kvg-bar">
        {lead}
        <button type="button" className="btn small" aria-label="확대" onClick={() => zoomBy(1.25)}>
          ＋
        </button>
        <button type="button" className="btn small" aria-label="축소" onClick={() => zoomBy(1 / 1.25)}>
          －
        </button>
        <button type="button" className="btn small" onClick={fit}>
          맞춤
        </button>
        <button
          type="button"
          className="btn small"
          onClick={() => {
            touched.current = true;
            setView({ zoom: 1, x: 0, y: 0 });
          }}
        >
          100%
        </button>
        <span className="dim kvg-zoom">{Math.round(view.zoom * 100)}%</span>
        {extra}
      </div>
      <div
        ref={frame}
        className="kvg-frame"
        style={fill ? { minHeight } : { height: frameHeight() }}
        onMouseDown={down}
        onMouseMove={move}
        onMouseUp={end}
        onMouseLeave={end}
        // 끌고 나서 손을 뗀 자리가 노드여도 누름으로 치지 않는다
        onClickCapture={(e) => {
          if (moved.current) {
            e.stopPropagation();
            moved.current = false;
          }
        }}
      >
        <svg role="img" aria-label={label} width="100%" height="100%">
          <defs>
            {TONES.map((tone) => (
              <marker key={tone} id={`${id}-${tone}`} className={`kvg-arrow kvg-tone-${tone}`} viewBox="0 0 8 8" refX="7" refY="4" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" />
              </marker>
            ))}
          </defs>
          <MarkerContext.Provider value={id}>
            <g transform={`translate(${view.x},${view.y}) scale(${view.zoom})`}>{children}</g>
          </MarkerContext.Provider>
        </svg>
      </div>
    </div>
  );
}
