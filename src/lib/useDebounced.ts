import { useEffect, useState } from "react";

/**
 * value가 delay(ms) 동안 바뀌지 않으면 그 값을 돌려준다. 그 전에 또 바뀌면 처음부터 다시 기다리므로, 입력이 이어지는 동안은 이전 값 그대로다.
 * 처음 값은 기다리지 않고 바로 돌려준다.
 */
export function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}
