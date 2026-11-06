import { useSyncExternalStore } from "react";
import type { Item, QueryPrefill, ReadRequest } from "./types";

interface Snapshot {
  items: Item[];
  prefill: QueryPrefill | null;
  serial: number;
  scanKey: Item | null;
  scanStarted: boolean;
  history: ReadRequest[];
}

const empty: Snapshot = { items: [], prefill: null, serial: 0, scanKey: null, scanStarted: false, history: [] };
const stores = new Map<string, Snapshot>();
const listeners = new Set<() => void>();

export function tableStoreKey(profile: string, region: string, table: string): string {
  return JSON.stringify([profile, region, table]);
}

export function updateItems(key: string, update: Partial<Snapshot>): void {
  stores.set(key, { ...(stores.get(key) ?? empty), ...update });
  listeners.forEach(listener => listener());
}

export function currentItems(key: string): Item[] {
  return (stores.get(key) ?? empty).items;
}

export function openQuery(key: string, prefill: QueryPrefill): void {
  const current = stores.get(key) ?? empty;
  updateItems(key, { prefill, serial: current.serial + 1 });
}

export function useItems(key: string): Snapshot {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => listeners.delete(listener); },
    () => stores.get(key) ?? empty,
    () => empty,
  );
}
