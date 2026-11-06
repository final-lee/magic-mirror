import type { Attribute, Item } from "./types";
const bytes = (s: string) => new TextEncoder().encode(s).length;
export function plainValue(value: Attribute): unknown {
 const [tag, v] = Object.entries(value)[0] ?? [];
 switch (tag) {
  case "NULL": return null;
  case "N": { const text=String(v), n=Number(text), digits=text.split(/[eE]/)[0].replace(/[^0-9]/g,"").replace(/^0+/,"").length; return Number.isFinite(n) && Math.abs(n)<=Number.MAX_SAFE_INTEGER && digits<=15 ? n : text; }
  case "M": return Object.fromEntries(Object.entries(v as Item).map(([k, x]) => [k, plainValue(x)]));
  case "L": return (v as Attribute[]).map(plainValue);
  default: return v;
 }
}
export function plainItem(item: Item): Record<string, unknown> { return Object.fromEntries(Object.entries(item).map(([k,v])=>[k,plainValue(v)])); }
export function fromPlain(value: unknown): Attribute {
 if (value === null) return { NULL: true };
 if (typeof value === "boolean") return { BOOL: value };
 if (typeof value === "string") return { S: value };
 if (typeof value === "number" && Number.isFinite(value)) return { N: String(value) };
 if (Array.isArray(value)) return { L: value.map(fromPlain) };
 if (typeof value === "object") return { M: Object.fromEntries(Object.entries(value as Record<string,unknown>).map(([k,v])=>[k,fromPlain(v)])) };
 throw new Error("JSON으로 표현할 수 없는 값이에요");
}
const binarySize = (s: string) => { try { return atob(s).length; } catch { return 0; } };
export function valueSize(a: Attribute): number {
 const [tag,v]=Object.entries(a)[0] ?? [];
 switch(tag) {
  case "S": return bytes(String(v)); case "B": return binarySize(String(v));
  case "N": { const digits=String(v).replace(/[^0-9]/g, "").replace(/^0+|0+$/g, "").length; return Math.ceil(digits/2)+1; }
  case "BOOL": case "NULL": return 1;
  case "SS": return (v as string[]).reduce((n,s)=>n+bytes(s),0);
  case "BS": return (v as string[]).reduce((n,s)=>n+binarySize(s),0);
  case "NS": return (v as string[]).reduce((n,s)=>n+valueSize({N:s}),0);
  case "L": return 3+(v as Attribute[]).reduce((n,x)=>n+1+valueSize(x),0);
  case "M": return 3+Object.entries(v as Item).reduce((n,[k,x])=>n+1+bytes(k)+valueSize(x),0);
  default: return 0;
 }
}
export function itemSize(item: Item): number { return Object.entries(item).reduce((n,[k,v])=>n+bytes(k)+valueSize(v),0); }
export function summary(v: Attribute): string { const [tag,x]=Object.entries(v)[0] ?? []; if(tag==="M") return `{${Object.keys(x as object).length}}`; if(tag==="L") return `[${(x as unknown[]).length}]`; return typeof x === "string" ? x : JSON.stringify(x); }
