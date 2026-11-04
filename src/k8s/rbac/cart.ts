import { useCallback, useSyncExternalStore } from "react";
import { targetKey } from "../targets";
import type { K8sChange, K8sTarget } from "../types";
import { CART_MAX } from "./types";

// 장바구니는 대상(클러스터)마다 하나다. 화면(권한 표, 바인딩 상세, 신원)을 오가도 남도록 React 밖의 저장소에 둔다.
const carts = new Map<string, K8sChange[]>();
const listeners = new Set<() => void>();
const EMPTY: K8sChange[] = [];

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

function store(key: string, next: K8sChange[]) {
  if (next.length === 0) carts.delete(key);
  else carts.set(key, next);
  listeners.forEach((listener) => listener());
}

const same = (a: K8sChange, b: K8sChange) => JSON.stringify(a) === JSON.stringify(b);

export type CartResult = "added" | "duplicate" | "full";

/** 변경 하나를 담는다. 같은 변경이 이미 있거나 가득 차면 담지 않는다. */
export function cartAdd(target: K8sTarget, change: K8sChange): CartResult {
  const key = targetKey(target);
  const current = carts.get(key) ?? EMPTY;
  if (current.some((c) => same(c, change))) return "duplicate";
  if (current.length >= CART_MAX) return "full";
  store(key, [...current, change]);
  return "added";
}

export function cartRemove(target: K8sTarget, index: number) {
  const key = targetKey(target);
  const current = carts.get(key) ?? EMPTY;
  store(key, current.filter((_, i) => i !== index));
}

/** 적용을 마친 변경들을 장바구니에서 뺀다(같은 변경 하나당 하나) */
export function cartRemoveApplied(target: K8sTarget, applied: K8sChange[]) {
  const key = targetKey(target);
  let rest = carts.get(key) ?? EMPTY;
  for (const change of applied) {
    const at = rest.findIndex((c) => same(c, change));
    if (at >= 0) rest = rest.filter((_, i) => i !== at);
  }
  store(key, rest);
}

export const cartClear = (target: K8sTarget) => store(targetKey(target), []);

/** 시험에서 장바구니를 모두 비운다 */
export function resetCarts() {
  carts.clear();
  listeners.forEach((listener) => listener());
}

export interface Cart {
  changes: K8sChange[];
  add: (change: K8sChange) => CartResult;
  remove: (index: number) => void;
  clear: () => void;
  has: (change: K8sChange) => boolean;
}

export function useCart(target: K8sTarget): Cart {
  const key = targetKey(target);
  const changes = useSyncExternalStore(subscribe, () => carts.get(key) ?? EMPTY);
  const add = useCallback((change: K8sChange) => cartAdd(target, change), [target]);
  const remove = useCallback((index: number) => cartRemove(target, index), [target]);
  const clear = useCallback(() => cartClear(target), [target]);
  return { changes, add, remove, clear, has: (change) => changes.some((c) => same(c, change)) };
}
