import { useEffect } from "react";
import { onMouseNav } from "../explorer/api";

const hasOpenDialog = () => !!document.querySelector(".modal");

/**
 * ⌘[ / ⌘]와 마우스 뒤로/앞으로 버튼으로 탭의 기록을 걷는다(IAM 탭과 PostgreSQL 탭이 함께 쓴다).
 * 보이는 탭(active)에서만 반응한다. 확인 창이 떠 있으면 둘 다, 글자를 입력하는 중이면 ⌘[ ⌘]를 건드리지 않는다.
 */
export function useHistoryKeys(active: boolean, back: () => void, forward: () => void) {
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey || (e.key !== "[" && e.key !== "]")) return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (hasOpenDialog() || tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      if (e.key === "[") back();
      else forward();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, back, forward]);

  // 마우스 뒤로/앞으로 버튼. WKWebView는 3·4번 버튼을 DOM으로 넘기지 않아서 네이티브 "mouse-nav" 이벤트로 받는다.
  useEffect(() => {
    if (!active) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    onMouseNav((dir) => {
      if (hasOpenDialog()) return;
      if (dir === "back") back();
      else forward();
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [active, back, forward]);
}
