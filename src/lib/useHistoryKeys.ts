import { useEffect, type RefObject } from "react";
import { onMouseNav } from "../explorer/api";
import { useCommand } from "../keymap/registry";

const hasOpenDialog = () => !!document.querySelector(".modal");

/**
 * ⌘[ / ⌘](`tab.back` / `tab.forward`)와 마우스 뒤로/앞으로 버튼으로 탭의 기록을 걷는다(IAM 탭과 PostgreSQL 탭이 함께 쓴다).
 * host는 탭의 뿌리 상자: 보이는 탭에서만 키에 반응한다. 확인 창이 떠 있거나 글자를 입력하는 중이면 키가 이 처리기까지 오지 않는다(keybindings.ts의 when).
 * 마우스 버튼은 키맵이 모르는 입력이라 active(보이는 탭)로 직접 따지고, 확인 창이 떠 있으면 건드리지 않는다.
 */
export function useHistoryKeys(host: RefObject<HTMLElement>, active: boolean, back: () => void, forward: () => void) {
  useCommand("tab.back", back, { host });
  useCommand("tab.forward", forward, { host });

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
