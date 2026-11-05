import type { KvKeyView, KvValue } from "./types";

/**
 * 쪽마다 받은 키 값을 하나로 잇는다. 해시·리스트·셋·정렬 셋·스트림은 항목을 이어 붙이고,
 * 그 밖의 타입(문자열, JSON, 그 외)은 첫 쪽이 전부다. 쪽 사이에 타입이 바뀌었으면(그 사이 키가 바뀐 것) 마지막 쪽만 쓴다.
 */
export function mergeValue(pages: readonly KvKeyView[]): KvValue {
  const first = pages[0].value;
  const same = pages.every((p) => p.value.type === first.type);
  if (!same) return pages[pages.length - 1].value;
  switch (first.type) {
    case "hash":
      return { type: "hash", entries: pages.flatMap((p) => (p.value.type === "hash" ? p.value.entries : [])) };
    case "list":
      return { type: "list", start: first.start, items: pages.flatMap((p) => (p.value.type === "list" ? p.value.items : [])) };
    case "set":
      return { type: "set", members: pages.flatMap((p) => (p.value.type === "set" ? p.value.members : [])) };
    case "zset":
      return { type: "zset", start: first.start, members: pages.flatMap((p) => (p.value.type === "zset" ? p.value.members : [])) };
    case "stream":
      return { type: "stream", summary: first.summary, entries: pages.flatMap((p) => (p.value.type === "stream" ? p.value.entries : [])) };
    default:
      return first;
  }
}

/** 지금까지 읽은 항목 수. 항목이 없는 타입은 null */
export function loadedCount(value: KvValue): number | null {
  switch (value.type) {
    case "hash":
      return value.entries.length;
    case "list":
      return value.items.length;
    case "set":
    case "zset":
      return value.members.length;
    case "stream":
      return value.entries.length;
    default:
      return null;
  }
}
