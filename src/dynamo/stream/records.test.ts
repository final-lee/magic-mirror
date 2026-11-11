import { describe, expect, it } from "vitest";
import { ALL_EVENTS, appendRecords, attributeChanges, RECORD_LIMIT, toggleKind, visibleRecords } from "./records";
import type { StreamRecord } from "./types";

function record(id: number | string, over: Partial<StreamRecord> = {}): StreamRecord {
  return { id: String(id), event: "INSERT", time: null, keys: null, size: null, oldImage: null, newImage: null, ...over };
}

const ids = (records: StreamRecord[]) => records.map((r) => r.id);

describe("레코드 버퍼", () => {
  it("가장 최근 2,000개만 도착 순서대로 남기고 오래된 것부터 버린다", () => {
    const prior = Array.from({ length: RECORD_LIMIT - 1 }, (_, i) => record(i));
    const result = appendRecords(prior, [record(RECORD_LIMIT - 1), record(RECORD_LIMIT)]);

    expect(result).toHaveLength(RECORD_LIMIT);
    expect(result[0].id).toBe("1");
    expect(result[RECORD_LIMIT - 1].id).toBe(String(RECORD_LIMIT));
    expect(prior).toHaveLength(RECORD_LIMIT - 1);
  });

  it("한 번에 상한보다 많이 와도 마지막 2,000개만 남는다", () => {
    const burst = Array.from({ length: RECORD_LIMIT + 5 }, (_, i) => record(i));
    const result = appendRecords([record("old")], burst);

    expect(result).toHaveLength(RECORD_LIMIT);
    expect(result[0].id).toBe("5");
  });

  it("상한 아래에서는 아무것도 버리지 않는다", () => {
    expect(ids(appendRecords([record(1)], [record(2), record(3)]))).toEqual(["1", "2", "3"]);
  });
});

describe("보이는 레코드", () => {
  const records = [
    record(1, { event: "INSERT", keys: { pk: { S: "order#1" } } }),
    record(2, { event: "MODIFY", keys: { pk: { S: "order#2" } }, newImage: { status: { S: "SHIPPED" } } }),
    record(3, { event: "REMOVE", keys: { pk: { S: "user#9" } }, oldImage: { name: { S: "kim" } } }),
  ];

  it("최근 것이 위에 온다", () => {
    expect(ids(visibleRecords(records, ALL_EVENTS, ""))).toEqual(["3", "2", "1"]);
  });

  it("고른 종류만 보이고 하나도 안 고르면 아무것도 안 보인다", () => {
    expect(ids(visibleRecords(records, ["MODIFY", "REMOVE"], ""))).toEqual(["3", "2"]);
    expect(visibleRecords(records, [], "")).toEqual([]);
  });

  it("필터는 키와 이미지 값에서 찾고 종류 선택과 함께 걸린다", () => {
    expect(ids(visibleRecords(records, ALL_EVENTS, "order"))).toEqual(["2", "1"]);
    expect(ids(visibleRecords(records, ALL_EVENTS, "shipped"))).toEqual(["2"]);
    expect(ids(visibleRecords(records, ALL_EVENTS, "kim"))).toEqual(["3"]);
    expect(ids(visibleRecords(records, ["INSERT"], "order"))).toEqual(["1"]);
  });

  it("없는 이미지(null)는 글자로 찾히지 않는다", () => {
    expect(visibleRecords(records, ALL_EVENTS, "null")).toEqual([]);
  });

  it("받은 배열의 순서를 바꾸지 않는다", () => {
    visibleRecords(records, ALL_EVENTS, "");
    expect(ids(records)).toEqual(["1", "2", "3"]);
  });
});

describe("종류 칩", () => {
  it("눌린 종류는 빼고 안 눌린 종류는 넣는다", () => {
    expect(toggleKind(ALL_EVENTS, "MODIFY")).toEqual(["INSERT", "REMOVE"]);
    expect(toggleKind(["INSERT"], "REMOVE")).toEqual(["INSERT", "REMOVE"]);
  });

  it("받은 목록을 바꾸지 않는다", () => {
    const kinds = ["INSERT"];
    toggleKind(kinds, "REMOVE");
    expect(kinds).toEqual(["INSERT"]);
  });
});

describe("이미지 비교", () => {
  const after = (name: string, value: string) => ({ [name]: { S: value } });

  it("속성 이름순으로 맞대고 값이 다른 것만 바뀐 것으로 본다", () => {
    const changes = attributeChanges(record(1, { event: "MODIFY", oldImage: { ...after("status", "NEW"), ...after("id", "1") }, newImage: { ...after("status", "PAID"), ...after("id", "1") } }));

    expect(changes.map((c) => [c.name, c.changed])).toEqual([
      ["id", false],
      ["status", true],
    ]);
    expect(changes[1].before).toEqual({ S: "NEW" });
    expect(changes[1].after).toEqual({ S: "PAID" });
  });

  it("추가된 속성은 이전 값이 없고, 지워진 속성은 새 값이 없다", () => {
    const changes = attributeChanges(record(1, { event: "MODIFY", oldImage: after("gone", "x"), newImage: after("added", "y") }));

    expect(changes).toEqual([
      { name: "added", before: undefined, after: { S: "y" }, changed: true },
      { name: "gone", before: { S: "x" }, after: undefined, changed: true },
    ]);
  });

  it("추가는 새 이미지만, 삭제는 이전 이미지만 보인다", () => {
    expect(attributeChanges(record(1, { newImage: after("a", "1") })).map((c) => [c.name, c.before, c.after])).toEqual([["a", undefined, { S: "1" }]]);
    expect(attributeChanges(record(2, { event: "REMOVE", oldImage: after("a", "1") })).map((c) => [c.name, c.before, c.after])).toEqual([["a", { S: "1" }, undefined]]);
  });

  it("이미지가 없으면(KEYS_ONLY) 비교할 것이 없다", () => {
    expect(attributeChanges(record(1, { keys: { pk: { S: "1" } } }))).toEqual([]);
  });
});
