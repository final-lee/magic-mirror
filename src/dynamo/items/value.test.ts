import { describe, expect, it } from "vitest";
import { fromPlain, itemSize, keyText, orderedNames, plainItem, plainText, plainValue, valueSize } from "./value";

describe("DynamoDB values", () => {
  it("keeps unsafe numbers and binary or set representations without losing data", () => {
    expect(plainItem({
      n: { N: "9007199254740993" }, decimal: { N: "1.50" }, binary: { B: "YWJj" },
      strings: { SS: ["a", "b"] }, numbers: { NS: ["1", "9007199254740993"] },
      binaries: { BS: ["YQ==", "Yg=="] }, nested: { M: { list: { L: [{ BOOL: true }] } } },
    })).toEqual({
      n: "9007199254740993", decimal: 1.5, binary: "YWJj", strings: ["a", "b"],
      numbers: ["1", "9007199254740993"], binaries: ["YQ==", "Yg=="], nested: { list: [true] },
    });
    expect(plainValue({ N: "1.234567890123456789" })).toBe("1.234567890123456789");
  });

  it("converts ordinary JSON recursively without inventing set or binary types", () => {
    expect(fromPlain({ text: "YWJj", items: [true, null, 2] })).toEqual({
      M: { text: { S: "YWJj" }, items: { L: [{ BOOL: true }, { NULL: true }, { N: "2" }] } },
    });
  });

  it("counts UTF-8, binary, sets, and nested container overhead", () => {
    expect(itemSize({ "키": { S: "가" } })).toBe(6);
    expect(valueSize({ B: "YWJj" })).toBe(3);
    expect(valueSize({ SS: ["a", "가"] })).toBe(4);
    expect(valueSize({ BS: ["YQ==", "YWI="] })).toBe(3);
    expect(valueSize({ L: [{ S: "x" }] })).toBe(5);
    expect(valueSize({ M: { a: { BOOL: true } } })).toBe(6);
    expect(valueSize({ N: "1e20" })).toBe(valueSize({ N: "1" }));
  });
});

describe("item display helpers", () => {
  it("shows keys as plain name=value pairs", () => {
    expect(keyText({ PK: { S: "SMOKE#1" }, SK: { S: "META" } })).toBe("PK=SMOKE#1 · SK=META");
  });

  it("writes maps and lists as plain JSON but scalars as their value", () => {
    expect(plainText({ S: "x" })).toBe("x");
    expect(plainText({ N: "2" })).toBe("2");
    expect(plainText({ M: { a: { N: "1" } } })).toBe('{"a":1}');
  });

  it("orders key attributes first and the rest alphabetically", () => {
    const item = { type: { S: "a" }, SK: { S: "b" }, email: { S: "c" }, PK: { S: "d" } };
    expect(orderedNames(item, ["PK", "SK"])).toEqual(["PK", "SK", "email", "type"]);
  });
});
