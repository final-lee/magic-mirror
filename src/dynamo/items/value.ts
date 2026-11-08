import type { Attribute, Item } from "./types";

const bytes = (value: string) => new TextEncoder().encode(value).length;

export function plainValue(value: Attribute): unknown {
  const [tag, content] = Object.entries(value)[0] ?? [];
  switch (tag) {
    case "NULL": return null;
    case "N": {
      const text = String(content);
      const number = Number(text);
      const digits = text.split(/[eE]/)[0].replace(/[^0-9]/g, "").replace(/^0+/, "").length;
      return Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER && digits <= 15 ? number : text;
    }
    case "M": return Object.fromEntries(Object.entries(content as Item).map(([name, child]) => [name, plainValue(child)]));
    case "L": return (content as Attribute[]).map(plainValue);
    default: return content;
  }
}

export function plainItem(item: Item): Record<string, unknown> {
  return Object.fromEntries(Object.entries(item).map(([name, value]) => [name, plainValue(value)]));
}

export function fromPlain(value: unknown): Attribute {
  if (value === null) return { NULL: true };
  if (typeof value === "boolean") return { BOOL: value };
  if (typeof value === "string") return { S: value };
  if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) return { N: String(value) };
  if (Array.isArray(value)) return { L: value.map(fromPlain) };
  if (typeof value === "object") return { M: Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, child]) => [name, fromPlain(child)])) };
  throw new Error("JSON으로 표현할 수 없는 값이에요");
}

function binarySize(value: string): number {
  try { return atob(value).length; } catch { return 0; }
}

export function valueSize(attribute: Attribute): number {
  const [tag, value] = Object.entries(attribute)[0] ?? [];
  switch (tag) {
    case "S": return bytes(String(value));
    case "B": return binarySize(String(value));
    case "N": {
      const digits = String(value).split(/[eE]/)[0].replace(/[^0-9]/g, "").replace(/^0+|0+$/g, "").length;
      return Math.ceil(digits / 2) + 1;
    }
    case "BOOL": case "NULL": return 1;
    case "SS": return (value as string[]).reduce((size, item) => size + bytes(item), 0);
    case "BS": return (value as string[]).reduce((size, item) => size + binarySize(item), 0);
    case "NS": return (value as string[]).reduce((size, item) => size + valueSize({ N: item }), 0);
    case "L": return 3 + (value as Attribute[]).reduce((size, item) => size + 1 + valueSize(item), 0);
    case "M": return 3 + Object.entries(value as Item).reduce((size, [name, item]) => size + 1 + bytes(name) + valueSize(item), 0);
    default: return 0;
  }
}

export function itemSize(item: Item): number {
  return Object.entries(item).reduce((size, [name, value]) => size + bytes(name) + valueSize(value), 0);
}

export function summary(value: Attribute): string {
  const [tag, content] = Object.entries(value)[0] ?? [];
  if (tag === "M") return `{${Object.keys(content as object).length}}`;
  if (tag === "L") return `[${(content as unknown[]).length}]`;
  return typeof content === "string" ? content : JSON.stringify(content);
}

/** 속성 값 하나를 한 줄 글로. 맵·리스트는 일반 JSON으로 펼친다(`summary`의 `{3}` 같은 요약은 표 칸에서만 쓴다) */
export function plainText(value: Attribute): string {
  const [tag] = Object.keys(value);
  if (tag === "M" || tag === "L") return JSON.stringify(plainValue(value));
  return summary(value);
}

/** 키 속성을 `PK=SMOKE#1 · SK=META`처럼 값만 보이게 */
export function keyText(keys: Item): string {
  return Object.entries(keys).map(([name, value]) => `${name}=${summary(value)}`).join(" · ");
}

/** 속성을 이름 순으로: 키 속성을 먼저(주어진 순서), 나머지는 이름 순 */
export function orderedNames(item: Item, keyNames: string[]): string[] {
  const keys = keyNames.filter(name => name in item);
  const rest = Object.keys(item).filter(name => !keyNames.includes(name)).sort((a, b) => a.localeCompare(b));
  return [...keys, ...rest];
}
