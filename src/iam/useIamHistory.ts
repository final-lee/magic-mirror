import { useCallback, useState } from "react";
import { sameRoute, type IamRoute } from "./route";

const MAX_ENTRIES = 100;

interface History {
  stack: IamRoute[];
  index: number;
}

/**
 * IAM 탭의 뒤로/앞으로 기록. 같은 화면으로 이동하면 쌓지 않고, 뒤로 간 뒤 새로 이동하면 앞쪽 기록을 버린다.
 * `replace`는 현재 항목의 보던 상태(하위 탭, 열어 둔 칸)만 갱신해서 기록을 늘리지 않는다.
 */
export function useIamHistory(initial: IamRoute) {
  const [history, setHistory] = useState<History>({ stack: [initial], index: 0 });

  const navigate = useCallback((route: IamRoute) => {
    setHistory((h) => {
      if (sameRoute(h.stack[h.index], route)) return h;
      const stack = [...h.stack.slice(0, h.index + 1), route].slice(-MAX_ENTRIES);
      return { stack, index: stack.length - 1 };
    });
  }, []);

  const replace = useCallback((update: (current: IamRoute) => IamRoute) => {
    setHistory((h) => ({ ...h, stack: h.stack.map((r, i) => (i === h.index ? update(r) : r)) }));
  }, []);

  const back = useCallback(() => setHistory((h) => (h.index > 0 ? { ...h, index: h.index - 1 } : h)), []);
  const forward = useCallback(() => setHistory((h) => (h.index < h.stack.length - 1 ? { ...h, index: h.index + 1 } : h)), []);

  return {
    route: history.stack[history.index],
    canBack: history.index > 0,
    canForward: history.index < history.stack.length - 1,
    navigate,
    replace,
    back,
    forward,
  };
}
