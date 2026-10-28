// 변경 기록 화면(IAM, PostgreSQL)이 함께 쓰는 조각: 묶음 머리 밑으로 모으는 배치, 묶음의 키, 되돌리기 준비의 바쁨·오류.
// 기록의 모양과 되돌릴 수 있는지는 화면마다 다르다. 여기에는 그와 상관없는 규칙만 둔다.
import { useRef, useState } from "react";

/** 표에 그릴 줄: 묶음 머리, 또는 기록 하나(묶음 안에 있는지) */
export type LogLine<E> = { kind: "batch"; batchId: string; entries: E[] } | { kind: "entry"; entry: E; inBatch: boolean };

/**
 * 같은 묶음의 기록을 그 묶음에서 가장 최근 기록의 자리에 모아 머리 밑에 둔다. 다른 기록이 사이에 끼어 있었어도 한 덩어리다.
 * 그 밖의 순서는 받은 그대로(최신순)다.
 */
export function arrange<E extends { batchId?: string }>(entries: E[]): LogLine<E>[] {
  const groups = new Map<string, E[]>();
  for (const e of entries) {
    if (!e.batchId) continue;
    const members = groups.get(e.batchId);
    if (members) members.push(e);
    else groups.set(e.batchId, [e]);
  }
  const lines: LogLine<E>[] = [];
  const placed = new Set<string>();
  for (const e of entries) {
    if (!e.batchId) {
      lines.push({ kind: "entry", entry: e, inBatch: false });
    } else if (!placed.has(e.batchId)) {
      placed.add(e.batchId);
      const members = groups.get(e.batchId) ?? [];
      lines.push({ kind: "batch", batchId: e.batchId, entries: members });
      for (const member of members) lines.push({ kind: "entry", entry: member, inBatch: true });
    }
  }
  return lines;
}

/** 묶음의 바쁨·오류 키. 기록 id와 겹치지 않는다 */
export const batchKey = (batchId: string) => `batch:${batchId}`;

/**
 * 되돌리기 준비(역변경을 받아 변경 흐름으로 넘기는 일)의 바쁨과 오류.
 * key는 바쁨·오류를 붙일 자리(기록 id 또는 묶음 키)이고, 준비는 한 번에 하나만 돌린다: 돌고 있는 동안 온 요청은 무시한다.
 * 같은 key를 다시 준비하면 앞의 오류는 지운다. 오류는 던져진 그대로 담는다(화면이 글로 바꾸거나 그대로 보여 준다).
 */
export function usePrepare() {
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, unknown>>({});
  const inFlight = useRef(false);

  const prepare = async (key: string, task: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(key);
    setErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== key)));
    try {
      await task();
    } catch (e) {
      setErrors((prev) => ({ ...prev, [key]: e }));
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  return { busy, errors, prepare };
}
