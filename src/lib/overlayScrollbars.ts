/**
 * 겹쳐 보이는 스크롤바. 네이티브 막대는 CSS로 숨겨(자리를 차지하지 않는다) 두고, 어떤 요소든 스크롤하면 그 요소 가장자리에
 * 얇은 손잡이를 잠깐 띄운다. 손잡이를 끌어 스크롤할 수도 있다. 마우스를 연결해 macOS가 늘 막대를 보이는 설정이어도 같다.
 *
 * 요소마다 막대를 붙이지 않고 문서에 하나만 둔다: 스크롤 이벤트를 캡처 단계에서 받아(스크롤은 거품이 일지 않는다) 방금 움직인 요소의 것만 그린다.
 */

/** 스크롤이 멈춘 뒤 손잡이를 감추기까지 */
const HIDE_AFTER_MS = 900;
/** 손잡이의 최소 길이(px) */
const MIN_THUMB = 28;
/** 가장자리에서 띄우는 간격(px) */
const INSET = 2;
const THICK = 6;

type Axis = "v" | "h";

interface Geometry {
  /** 화면에 보이는 영역(요소면 테두리 안쪽, 문서면 창) */
  top: number;
  left: number;
  width: number;
  height: number;
  scroll: number;
  max: number;
  size: number;
  track: number;
  thumb: number;
}

const isDoc = (el: Element) => el === document.scrollingElement || el === document.documentElement || el === document.body;

/** 이 축으로 사용자가 스크롤할 수 있는 요소인가(overflow hidden인 요소를 코드가 움직인 것은 막대를 띄우지 않는다) */
function scrollable(el: Element, axis: Axis): boolean {
  const max = axis === "v" ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
  if (max <= 1) return false;
  if (isDoc(el)) return true;
  const style = getComputedStyle(el);
  const overflow = axis === "v" ? style.overflowY : style.overflowX;
  return overflow === "auto" || overflow === "scroll";
}

function geometry(el: Element, axis: Axis): Geometry {
  const doc = isDoc(el);
  const rect = doc ? { top: 0, left: 0 } : el.getBoundingClientRect();
  // 테두리 안쪽(clientTop·clientLeft)부터 보이는 영역
  const top = rect.top + (doc ? 0 : el.clientTop);
  const left = rect.left + (doc ? 0 : el.clientLeft);
  const width = doc ? window.innerWidth : el.clientWidth;
  const height = doc ? window.innerHeight : el.clientHeight;
  const size = axis === "v" ? height : width;
  const content = axis === "v" ? el.scrollHeight : el.scrollWidth;
  const scroll = axis === "v" ? el.scrollTop : el.scrollLeft;
  const max = Math.max(1, content - size);
  const track = size - INSET * 2;
  const thumb = Math.max(MIN_THUMB, Math.min(track, (size / content) * track));
  return { top, left, width, height, scroll, max, size, track, thumb };
}

/** 문서에 손잡이 둘(세로·가로)을 붙이고 스크롤을 따라 그린다. 떼어 내는 함수를 돌려준다. */
export function installOverlayScrollbars(doc: Document = document): () => void {
  const thumbs: Record<Axis, HTMLDivElement> = { v: doc.createElement("div"), h: doc.createElement("div") };
  const target: Record<Axis, Element | null> = { v: null, h: null };
  const timers: Record<Axis, number | undefined> = { v: undefined, h: undefined };
  let drag: { axis: Axis; el: Element; start: number; from: number; ratio: number } | null = null;
  let hovering: Axis | null = null;
  /** 요소마다 지난 스크롤 위치: 방금 움직인 축의 손잡이만 띄운다(처음엔 0에서 시작한 것으로 본다) */
  const last = new WeakMap<Element, { top: number; left: number }>();

  for (const axis of ["v", "h"] as const) {
    const t = thumbs[axis];
    t.className = `ovs-thumb ${axis}`;
    t.setAttribute("aria-hidden", "true");
    t.addEventListener("pointerenter", () => {
      hovering = axis;
      window.clearTimeout(timers[axis]);
    });
    t.addEventListener("pointerleave", () => {
      hovering = null;
      if (!drag) hideLater(axis);
    });
    t.addEventListener("pointerdown", (e) => {
      const el = target[axis];
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      const g = geometry(el, axis);
      drag = { axis, el, start: axis === "v" ? e.clientY : e.clientX, from: g.scroll, ratio: g.max / Math.max(1, g.track - g.thumb) };
      t.classList.add("drag");
      doc.body.classList.add("ovs-dragging");
      t.setPointerCapture?.(e.pointerId);
    });
    t.addEventListener("pointermove", (e) => {
      if (!drag || drag.axis !== axis) return;
      const delta = (axis === "v" ? e.clientY : e.clientX) - drag.start;
      const next = drag.from + delta * drag.ratio;
      if (axis === "v") drag.el.scrollTop = next;
      else drag.el.scrollLeft = next;
    });
    const end = (e: PointerEvent) => {
      if (!drag || drag.axis !== axis) return;
      t.releasePointerCapture?.(e.pointerId);
      drag = null;
      t.classList.remove("drag");
      doc.body.classList.remove("ovs-dragging");
      if (hovering !== axis) hideLater(axis);
    };
    t.addEventListener("pointerup", end);
    t.addEventListener("pointercancel", end);
    doc.body.appendChild(t);
  }

  function hideLater(axis: Axis) {
    window.clearTimeout(timers[axis]);
    timers[axis] = window.setTimeout(() => {
      if (drag?.axis === axis || hovering === axis) return;
      thumbs[axis].classList.remove("on");
    }, HIDE_AFTER_MS);
  }

  function draw(el: Element, axis: Axis) {
    const g = geometry(el, axis);
    const t = thumbs[axis];
    const along = INSET + (g.scroll / g.max) * (g.track - g.thumb);
    if (axis === "v") {
      t.style.top = `${g.top + along}px`;
      t.style.left = `${g.left + g.width - THICK - INSET}px`;
      t.style.height = `${g.thumb}px`;
    } else {
      t.style.left = `${g.left + along}px`;
      t.style.top = `${g.top + g.height - THICK - INSET}px`;
      t.style.width = `${g.thumb}px`;
    }
    t.classList.add("on");
    target[axis] = el;
    hideLater(axis);
  }

  const onScroll = (e: Event) => {
    const raw = e.target;
    const el = raw instanceof Element ? raw : doc.scrollingElement;
    if (!el) return;
    // 끄는 중에는 끄는 요소만 그린다(다른 요소가 덩달아 움직여도 손잡이가 튀지 않게)
    const prev = last.get(el) ?? { top: 0, left: 0 };
    for (const axis of ["v", "h"] as const) {
      if (drag && drag.axis === axis && drag.el !== el) continue;
      const moved = axis === "v" ? el.scrollTop !== prev.top : el.scrollLeft !== prev.left;
      if (moved && scrollable(el, axis)) draw(el, axis);
    }
    last.set(el, { top: el.scrollTop, left: el.scrollLeft });
  };

  doc.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => {
    doc.removeEventListener("scroll", onScroll, { capture: true });
    for (const axis of ["v", "h"] as const) {
      window.clearTimeout(timers[axis]);
      thumbs[axis].remove();
    }
  };
}
