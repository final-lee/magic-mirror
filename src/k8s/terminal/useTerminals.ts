import { useCallback, useRef, useState } from "react";
import { terminalTitle } from "./text";

export interface TerminalTab {
  id: number;
  title: string;
  /** 확인을 거친 플러그인 명령. null이면 로그인 셸 */
  command: string | null;
  /** 이 탭의 명령 실행권은 한 번만 소비한다. */
  launch?: { claimed: boolean };
}

interface State {
  tabs: TerminalTab[];
  active: number | null;
}

/** 한 EKS 탭 안의 터미널 목록. 번호는 닫아도 다시 쓰지 않는다. */
export function useTerminals() {
  const [state, setState] = useState<State>({ tabs: [], active: null });
  const next = useRef(0);
  const shells = useRef(0);

  /** 새 터미널을 열고 그 탭을 보인다. 제목을 주지 않으면 "터미널 N" */
  const open = useCallback((command: string | null = null, title?: string) => {
    const id = ++next.current;
    const label = title ?? terminalTitle(++shells.current);
    setState((s) => ({ tabs: [...s.tabs, { id, title: label, command, launch: { claimed: false } }], active: id }));
    return id;
  }, []);

  const close = useCallback((id: number) => {
    setState((s) => {
      const index = s.tabs.findIndex((tab) => tab.id === id);
      const tabs = s.tabs.filter((tab) => tab.id !== id);
      // 보던 탭을 닫으면 이웃 탭으로 옮긴다
      const active = s.active === id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : s.active;
      return { tabs, active };
    });
  }, []);

  const select = useCallback((id: number) => setState((s) => ({ ...s, active: id })), []);

  return { tabs: state.tabs, active: state.active, open, close, select };
}
