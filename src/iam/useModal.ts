import { useEffect, useRef, type KeyboardEvent } from "react";

const FOCUSABLE = 'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 창이 겹쳐 있어도 Esc는 보이는 창 중 맨 위 창 하나에만 듣게 한다.
 * 다른 탭에 가려진([hidden]) 탭 안의 창은 DOM에 남아 있어도 Esc를 받지 않고, 보이는 창을 가리지도 않는다.
 */
function isTopmost(el: HTMLElement | null): boolean {
  const modal = el?.closest(".modal");
  if (!modal || modal.closest("[hidden]")) return false;
  const visible = Array.from(document.querySelectorAll(".modal")).filter((m) => !m.closest("[hidden]"));
  return visible[visible.length - 1] === modal;
}

/**
 * IAM 대화 상자가 함께 쓰는 키 처리(ConfirmDialog와 같은 규칙).
 * Esc는 onEscape를 부르고, Tab은 창 밖으로 나가지 않고 창 안을 돈다. 처음 초점은 쓰는 쪽이 정한다.
 */
export function useModal(onEscape: () => void) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const latest = useRef(onEscape);
  latest.current = onEscape;

  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && isTopmost(sheetRef.current)) latest.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const trapTab = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const nodes = Array.from(sheetRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    const inside = !!sheetRef.current?.contains(active);
    if (e.shiftKey && (active === first || !inside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !inside)) {
      e.preventDefault();
      first.focus();
    }
  };

  return { sheetRef, trapTab };
}
