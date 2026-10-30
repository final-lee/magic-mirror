import type { AppError } from "../api/types";
import { k8sApi } from "./api";
import type { K8sRow, K8sWatchMessage } from "./types";

export interface WatchSnapshot {
  rows: K8sRow[];
  status: "loading" | "ready" | "error";
  error: AppError | null;
  /** dropTarget이 비운 상태. 구독자는 다시 구독해야 채워진다. */
  dropped?: boolean;
}

type Listener = (s: WatchSnapshot) => void;
type Start = (onMessage: (m: K8sWatchMessage) => void) => Promise<number>;

/** 마지막 구독자가 떠난 뒤 감시를 유지하는 시간. 화면을 오가며 다시 열 때 처음부터 읽지 않게 한다. */
export const LINGER_MS = 30_000;

interface Entry {
  rows: Map<string, K8sRow>;
  snapshot: WatchSnapshot;
  listeners: Set<Listener>;
  id: number | null;
  unwatchOnId: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  dead: boolean;
}

const entries = new Map<string, Entry>();
/** 대상별 세대. dropTarget이 올린다: 훅이 이 값으로 다시 구독할 때를 안다. */
const generations = new Map<string, number>();
const DROPPED: WatchSnapshot = { rows: [], status: "loading", error: null, dropped: true };

const LOADING: WatchSnapshot = { rows: [], status: "loading", error: null };

function publish(e: Entry, next: WatchSnapshot) {
  e.snapshot = next;
  for (const l of [...e.listeners]) l(next);
}

function rowsOf(e: Entry): K8sRow[] {
  return [...e.rows.values()];
}

function onMessage(e: Entry, m: K8sWatchMessage) {
  if (e.dead) return;
  const prev = e.snapshot;
  if (m.type === "reset") {
    e.rows = new Map(m.rows.map((r) => [r.uid, r]));
    publish(e, { rows: rowsOf(e), status: "ready", error: null });
  } else if (m.type === "changes") {
    if (m.upserts.length === 0 && m.deletes.length === 0) return;
    for (const r of m.upserts) e.rows.set(r.uid, r);
    for (const uid of m.deletes) e.rows.delete(uid);
    publish(e, { ...prev, rows: rowsOf(e) });
  } else if (m.fatal) {
    // 치명적이면 감시가 멈춘 것이다. 지금까지의 행은 낡았을 수 있어 비운다.
    e.rows = new Map();
    publish(e, { rows: [], status: "error", error: m.error });
  } else {
    // 일시적인 오류: 행과 상태는 그대로 두고 오류만 알린다.
    publish(e, { ...prev, error: m.error });
  }
}

function release(key: string, e: Entry) {
  e.dead = true;
  if (entries.get(key) === e) entries.delete(key);
  if (e.timer) clearTimeout(e.timer);
  e.timer = null;
}

function unwatch(id: number) {
  k8sApi.unwatch(id).catch((err) => console.error("감시를 멈추지 못했어요", err));
}

export const watchRegistry = {
  /** 같은 key의 구독자는 감시 하나를 나눠 쓴다. 현재 상태를 곧바로 받고, 돌려받은 함수로 구독을 끝낸다. */
  subscribe(key: string, start: Start, listener: Listener): () => void {
    let e = entries.get(key);
    if (e) {
      if (e.timer) {
        clearTimeout(e.timer);
        e.timer = null;
      }
    } else {
      const entry: Entry = { rows: new Map(), snapshot: LOADING, listeners: new Set(), id: null, unwatchOnId: false, timer: null, dead: false };
      e = entry;
      entries.set(key, entry);
      start((m) => onMessage(entry, m)).then(
        (id) => {
          if (entry.unwatchOnId) unwatch(id);
          else if (!entry.dead) entry.id = id;
          else unwatch(id);
        },
        (error: AppError) => {
          if (!entry.dead) publish(entry, { rows: [], status: "error", error });
        },
      );
    }
    const entry = e;
    entry.listeners.add(listener);
    listener(entry.snapshot);
    return () => {
      if (!entry.listeners.delete(listener) || entry.dead || entry.listeners.size > 0) return;
      entry.timer = setTimeout(() => {
        release(key, entry);
        if (entry.id !== null) unwatch(entry.id);
        else entry.unwatchOnId = true; // start가 아직 안 끝났다: id를 받는 대로 멈춘다
      }, LINGER_MS);
    };
  },

  /** 대상의 지금 세대 */
  generation: (targetKey: string) => generations.get(targetKey) ?? 0,

  /** 대상의 감시를 모두 버린다(모든 context의 것). 백엔드의 k8s_close가 이미 멈췄으므로 unwatch는 부르지 않는다. */
  dropTarget(targetKey: string) {
    generations.set(targetKey, (generations.get(targetKey) ?? 0) + 1);
    for (const [key, e] of [...entries]) {
      if (!key.startsWith(`${targetKey}|`)) continue;
      release(key, e);
      e.rows = new Map();
      // 구독자는 비어 있는 로딩 상태를 받는다(다시 연결하면 새 구독으로 채워진다).
      for (const l of [...e.listeners]) l(DROPPED);
    }
  },
};
