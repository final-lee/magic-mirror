import { useCallback, useRef, useState, type FocusEvent } from "react";

/** 잡지 않은 지도에 마우스를 올리면 보이는 안내 */
export const MAP_GRAB_HINT = "눌러서 잡으면 휠로 확대·축소하고 끌어서 옮겨요";

export interface MapGrab<T extends HTMLElement> {
  /** 지도 틀 요소. 크기를 재는 데 쓴다 */
  element: { readonly current: T | null };
  /** 지금 잡혀 있다(틀이나 그 안의 것이 포커스를 가졌다) */
  active: boolean;
  /**
   * 틀의 mousedown·pointerdown에서 부른다. 잡혀 있지 않았으면 틀에 포커스를 주고 false를 돌려준다:
   * 그 누름은 잡기만 하고 끌기를 시작하지 않는다. 이미 잡혀 있었으면 true.
   */
  grab: () => boolean;
  /** 틀에 그대로 펼친다 */
  frameProps: {
    ref: (el: T | null) => void;
    tabIndex: 0;
    title: string | undefined;
    onFocus: () => void;
    onBlur: (e: FocusEvent<T>) => void;
  };
}

/**
 * 지도·그래프 틀의 마우스 상호작용을 잡은 동안만 받는다. 앱을 스크롤하다 지도 위를 지나도 휠이 확대로 빼앗기지 않게 한다.
 * - 틀을 한 번 누르면(또는 Tab으로 들어오면) 잡힌다. 틀 밖을 누르거나 Tab으로 나가 포커스를 잃으면 놓인다.
 * - 잡혀 있을 때만 `onWheel`을 부르고 화면 스크롤을 막는다. 놓여 있으면 휠은 둘레를 스크롤한다.
 * - 끌어서 옮기기는 쓰는 쪽이 `grab()`이 true일 때만 시작한다.
 * 휠 리스너는 화면 스크롤을 막을 수 있게 passive가 아닌 리스너로 틀에 직접 붙인다.
 */
export function useMapGrab<T extends HTMLElement = HTMLDivElement>(onWheel: (e: WheelEvent, el: T) => void): MapGrab<T> {
  const element = useRef<T | null>(null);
  const [active, setActive] = useState(false);
  const activeRef = useRef(false);
  const wheelRef = useRef(onWheel);
  wheelRef.current = onWheel;
  const detach = useRef<(() => void) | null>(null);

  const set = (next: boolean) => {
    activeRef.current = next;
    setActive(next);
  };

  const ref = useCallback((el: T | null) => {
    detach.current?.();
    detach.current = null;
    element.current = el;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!activeRef.current) return;
      e.preventDefault();
      wheelRef.current(e, el);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    detach.current = () => el.removeEventListener("wheel", wheel);
  }, []);

  return {
    element,
    active,
    grab: () => {
      if (activeRef.current) return true;
      element.current?.focus({ preventScroll: true });
      return false;
    },
    frameProps: {
      ref,
      tabIndex: 0,
      title: active ? undefined : MAP_GRAB_HINT,
      onFocus: () => set(true),
      // 포커스가 틀 안의 노드로 옮겨 가는 것은 놓는 것이 아니다
      onBlur: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) set(false);
      },
    },
  };
}
