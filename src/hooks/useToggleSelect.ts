import { useEffect, useRef, type MouseEvent } from "react";

/** 이미 고른 행을 다시 눌렀을 때 해제를 미루는 시간. 그 안에 더블클릭(열기)이 오면 해제하지 않는다 */
export const DESELECT_DELAY_MS = 300;

/**
 * 한 행만 고르는 목록의 공통 선택 규칙: 고른 행을 다시 누르면 해제하고, 행·머리글 밖의 빈 곳을 눌러도 해제한다.
 * row는 행의 onClick, dblclick은 행의 onDoubleClick 앞에서 부르고, blank는 목록을 감싼 상자의 onClick에 단다.
 */
export function useToggleSelect(selectedId: string | null, onSelect: (id: string) => void, onClear: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);
  const row = (id: string, e: MouseEvent) => {
    cancel();
    if (id !== selectedId) {
      onSelect(id);
      return;
    }
    // 더블클릭의 두 번째 클릭은 무시하고, 첫 클릭의 해제는 잠깐 미뤄 열기와 겹치지 않게 한다
    if (e.detail > 1) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      onClear();
    }, DESELECT_DELAY_MS);
  };
  const blank = (e: MouseEvent) => {
    if ((e.target as Element).closest("thead, tbody tr")) return;
    cancel();
    if (selectedId !== null) onClear();
  };
  return { row, blank, dblclick: cancel };
}
