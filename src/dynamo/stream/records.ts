import { fuzzyKeep } from "../../lib/fuzzy";
import { diffImages, type AttributeChange } from "../items/diff";
import type { StreamEvent, StreamImage, StreamRecord } from "./types";

/** 메모리에 두는 레코드 수. 넘으면 오래된 것부터 버린다 */
export const RECORD_LIMIT = 2000;

export const ALL_EVENTS: StreamEvent[] = ["INSERT", "MODIFY", "REMOVE"];

/** 새로 읽은 레코드를 도착 순서대로 뒤에 붙이고 가장 최근 `RECORD_LIMIT`개만 남긴다. 받은 배열은 바꾸지 않는다 */
export function appendRecords(current: StreamRecord[], incoming: StreamRecord[]): StreamRecord[] {
  return [...current, ...incoming].slice(-RECORD_LIMIT);
}

const json = (image: StreamImage | null) => (image === null ? null : JSON.stringify(image));

/** 고른 종류의 레코드 중 필터에 맞는 것, 최근 것부터 */
export function visibleRecords(records: StreamRecord[], kinds: readonly string[], filter: string): StreamRecord[] {
  const ofKind = records.filter((record) => kinds.includes(record.event));
  const matching = fuzzyKeep(ofKind, filter, (record) => [record.event, json(record.keys), json(record.oldImage), json(record.newImage)]);
  return matching.reverse();
}

/** 칩을 눌렀을 때의 종류 목록: 있으면 빼고 없으면 넣는다 */
export function toggleKind(kinds: readonly string[], kind: string): string[] {
  return kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind];
}

/** 이전·새 이미지를 속성 이름 순으로 맞댄다. 두 이미지가 모두 없으면(KEYS_ONLY) 빈 목록 */
export function attributeChanges(record: StreamRecord): AttributeChange[] {
  return diffImages(record.oldImage, record.newImage);
}
