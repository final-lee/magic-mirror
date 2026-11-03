import type { InfiniteData } from "@tanstack/react-query";
import { applyWatchEvent, emptyQuery, labelSelectorOf, matchesQuery } from "./wfQuery";
import { page, row } from "./shellFixtures";
import type { WfPage } from "./types";

test("레이블 칩: 키가 다르면 AND, 같은 키의 값은 OR, 키만 있으면 존재 조건", () => {
  expect(labelSelectorOf([])).toBeNull();
  expect(
    labelSelectorOf([
      { key: "team", value: "a" },
      { key: "team", value: "b" },
      { key: "env", value: "prod" },
      { key: "tier", value: null },
    ]),
  ).toBe("team in (a,b),env=prod,tier");
  expect(
    labelSelectorOf([
      { key: "team", value: "a" },
      { key: "team", value: null },
    ]),
  ).toBe("team");
});

test("목록 조건: 네임스페이스·선택자·이름·날짜·phase를 모두 지킨다", () => {
  const r = row("etl-daily", "Succeeded", { labels: { team: "a" }, createdAt: "2026-01-02T00:00:00Z", finishedAt: "2026-01-02T01:00:00Z" });
  const q = {
    ...emptyQuery("test"),
    labelSelector: "team in (a,b)",
    name: { mode: "prefix" as const, value: "etl" },
    createdAfter: "2026-01-01T00:00:00Z",
    finishedBefore: "2026-01-03T00:00:00Z",
    phases: ["Succeeded"],
  };
  expect(matchesQuery(r, q)).toBe(true);
  expect(matchesQuery(r, { ...q, namespace: "other" })).toBe(false);
  expect(matchesQuery(r, { ...q, labelSelector: "team=b" })).toBe(false);
  expect(matchesQuery(r, { ...q, name: { mode: "exact", value: "etl" } })).toBe(false);
  expect(matchesQuery(r, { ...q, name: { mode: "contains", value: "daily" } })).toBe(true);
  expect(matchesQuery(r, { ...q, createdAfter: "2026-01-03T00:00:00Z" })).toBe(false);
  expect(matchesQuery(row("running", "Running", { namespace: "test" }), { ...emptyQuery("test"), finishedBefore: "2026-01-03T00:00:00Z" })).toBe(false);
  expect(matchesQuery(r, { ...q, phases: ["Failed"] })).toBe(false);
});

test("감시 이벤트: 있던 행은 제자리에서 바꾸고, 새 행은 첫 페이지 앞에, 조건에서 벗어난 행과 삭제는 뺀다", () => {
  const data: InfiniteData<WfPage> = { pageParams: [null, "t"], pages: [page([row("a", "Running"), row("b", "Running")], "t"), page([row("c", "Running")])] };
  const q = { ...emptyQuery("test"), phases: ["Running"] };
  const names = (d: InfiniteData<WfPage>) => d.pages.map((p) => p.rows.map((r) => `${r.name}:${r.phase}`));
  const progressed = applyWatchEvent(data, { type: "upsert", row: row("c", "Running", { message: "m" }) }, q);
  expect(progressed.pages[1].rows[0].message).toBe("m");
  expect(names(applyWatchEvent(data, { type: "upsert", row: row("new", "Running") }, q))[0]).toEqual(["new:Running", "a:Running", "b:Running"]);
  expect(names(applyWatchEvent(data, { type: "upsert", row: row("b", "Succeeded") }, q))[0]).toEqual(["a:Running"]);
  expect(names(applyWatchEvent(data, { type: "upsert", row: row("other", "Succeeded") }, q))[0]).toEqual(["a:Running", "b:Running"]);
  expect(names(applyWatchEvent(data, { type: "delete", uid: "c", namespace: "test", name: "c" }, q))[1]).toEqual([]);
});
