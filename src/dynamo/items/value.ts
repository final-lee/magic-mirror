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
