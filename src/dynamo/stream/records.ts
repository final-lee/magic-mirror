import type { StreamRecord } from "./types";

export const RECORD_LIMIT = 2000;
export function appendRecords(current: StreamRecord[], incoming: StreamRecord[]): StreamRecord[] {
  return [...current, ...incoming].slice(-RECORD_LIMIT);
}
