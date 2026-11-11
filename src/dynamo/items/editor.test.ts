import { describe, expect, it } from "vitest";
import { itemPlainEditable, parseItem } from "./editor";

describe("일반 JSON 편집", () => {
  it("중첩된 일반 타입을 변환해요", () => {
    const item = { nested: { M: { list: { L: [{ N: "12" }, { BOOL: true }] } } } };
    expect(itemPlainEditable(item)).toBe(true);
    expect(parseItem('{"nested":{"list":[12,true]}}', true)).toEqual(item);
  });

  it("집합, 바이너리와 정밀도를 잃는 수는 전환하지 않아요", () => {
    expect(itemPlainEditable({ value: { SS: ["x"] } })).toBe(false);
    expect(itemPlainEditable({ nested: { L: [{ B: "YQ==" }] } })).toBe(false);
    expect(itemPlainEditable({ value: { N: "9007199254740993" } })).toBe(false);
    expect(itemPlainEditable({ value: { N: "1.234567890123456789" } })).toBe(false);
    expect(itemPlainEditable({ value: { N: "1e-400" } })).toBe(false);
    expect(() => parseItem('{"value":0.12345678901234567}', true)).toThrow();
    expect(parseItem('{"text":"9007199254740993"}', true)).toEqual({ text: { S: "9007199254740993" } });
  });
});
