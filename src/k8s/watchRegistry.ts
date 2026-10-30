import type { AppError } from "../api/types";
import { reportSsoExpired } from "../api/invoke";
import { k8sApi } from "./api";
import type { K8sRow, K8sWatchMessage } from "./types";

export interface WatchSnapshot {
  rows: K8sRow[];
  status: "loading" | "ready" | "error";
  error: AppError | null;
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
  /** 이 감시가 쓰는 exec 프로필: SSO 만료를 알릴 때 쓴다 */
  ssoProfile: string | null;
  /** 이번 오류 구간에서 SSO 만료를 이미 알렸는지. reset/changes가 오면 새 구간이다. */
  ssoReported: boolean;
}

const entries = new Map<string, Entry>();

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
    e.ssoReported = false;
    e.rows = new Map(m.rows.map((r) => [r.uid, r]));
    publish(e, { rows: rowsOf(e), status: "ready", error: null });
  } else if (m.type === "changes") {
    // 감시가 다시 이어졌다는 뜻이라 변화가 없어도 오류는 지운다.
    e.ssoReported = false;
    if (m.upserts.length === 0 && m.deletes.length === 0 && prev.error === null) return;
    for (const r of m.upserts) e.rows.set(r.uid, r);
    for (const uid of m.deletes) e.rows.delete(uid);
    publish(e, { ...prev, rows: rowsOf(e), error: null });
  } else if (m.fatal) {
    // 치명적이면 감시가 멈춘 것이다. 지금까지의 행은 낡았을 수 있어 비운다.
    e.rows = new Map();
    publish(e, { rows: [], status: "error", error: m.error });
  } else {
    // 일시적인 오류: 행과 상태는 그대로 두고 오류만 알린다.
    if (m.error.kind === "ssoExpired" && e.ssoProfile !== null && !e.ssoReported) {
      e.ssoReported = true;
      reportSsoExpired(e.ssoProfile);
    }
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
  subscribe(key: string, start: Start, listener: Listener, ssoProfile: string | null = null): () => void {
    let e = entries.get(key);
    if (e) {
      if (e.timer) {
        clearTimeout(e.timer);
        e.timer = null;
      }
    } else {
      const entry: Entry = { rows: new Map(), snapshot: LOADING, listeners: new Set(), id: null, unwatchOnId: false, timer: null, dead: false, ssoProfile, ssoReported: false };
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

  /** 대상의 감시를 모두 버린다(모든 context의 것). 백엔드의 k8s_close가 이미 멈췄으므로 unwatch는 부르지 않는다. */
  dropTarget(targetKey: string) {
    for (const [key, e] of [...entries]) {
      if (!key.startsWith(`${targetKey}|`)) continue;
      release(key, e);
      e.rows = new Map();
      // 구독자는 비어 있는 로딩 상태를 받는다. 다시 구독하지는 않는다: 세션이 다시 열리면 호출한 쪽이 sessionEpoch를 바꿔 새로 구독한다.
      for (const l of [...e.listeners]) l(LOADING);
    }
  },
};
