import type { Attribute, Item } from "./types";
import { fromPlain } from "./value";

function canonicalNumber(text: string): string | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) return null;
  let digits = `${match[2]}${match[3] ?? ""}`.replace(/^0+/, "");
  if (!digits) return "0";
  let exponent = Number(match[4] ?? 0) - (match[3]?.length ?? 0);
  while (digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    exponent += 1;
  }
  return `${match[1]}${digits}e${exponent}`;
}

export function plainEditable(attribute: Attribute): boolean {
  const entries = Object.entries(attribute);
  if (entries.length !== 1) return false;
  const [tag, value] = entries[0];
  if (["B", "BS", "SS", "NS"].includes(tag)) return false;
  if (tag === "N") {
    const text = String(value);
    const number = Number(text);
    const digits = text.split(/[eE]/)[0].replace(/[^0-9]/g, "").replace(/^0+/, "").length;
    return Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER && digits <= 15
      && canonicalNumber(text) !== null && canonicalNumber(text) === canonicalNumber(String(number));
  }
  if (tag === "M") return !!value && typeof value === "object" && Object.values(value).every(child => plainEditable(child as Attribute));
  if (tag === "L") return Array.isArray(value) && value.every(child => plainEditable(child));
  return ["S", "BOOL", "NULL"].includes(tag);
}

export function itemPlainEditable(item: Item): boolean {
  return Object.values(item).every(plainEditable);
}

function validatePlainNumbers(text: string): void {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
      continue;
    }
    if (character !== "-" && !/[0-9]/.test(character)) continue;
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index));
    if (!match) continue;
    if (!plainEditable({ N: match[0] })) throw new Error("안전하게 표현할 수 없는 숫자는 DynamoDB JSON으로 입력해 주세요.");
    index += match[0].length - 1;
  }
}

export function parseItem(text: string, plain: boolean): Item {
  if (plain) validatePlainNumbers(text);
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("아이템은 JSON 객체여야 해요.");
  if (!plain) return value as Item;
  return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, fromPlain(child)]));
}
