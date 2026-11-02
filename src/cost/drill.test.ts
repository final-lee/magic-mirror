import { canDrill, drill, filtersOf, ROOT, up, type DrillState } from "./drill";

const RDS = { key: "Amazon Relational Database Service", label: "Amazon Relational Database Service" };

test("service drills into usage types with a SERVICE filter, and usage types go no further", () => {
  const s = drill(ROOT, RDS);
  expect(s.group).toEqual({ kind: "usageType" });
  expect(filtersOf(s)).toEqual([{ dimension: "SERVICE", value: RDS.key }]);
  expect(canDrill(s)).toBe(false);
  expect(drill(s, { key: "APN2-InstanceUsage:db.t4g.medium", label: "x" })).toBe(s);
});

test("region and tag values drill into services", () => {
  const byRegion = drill({ group: { kind: "region" }, crumbs: [] }, { key: "ap-northeast-2", label: "ap-northeast-2" });
  expect(byRegion.group).toEqual({ kind: "service" });
  expect(filtersOf(byRegion)).toEqual([{ dimension: "REGION", value: "ap-northeast-2" }]);

  const byTag = drill({ group: { kind: "tag", key: "team" }, crumbs: [] }, { key: "team$a$b", label: "a$b" });
  expect(byTag.group).toEqual({ kind: "service" });
  expect(filtersOf(byTag)).toEqual([{ tag: "team", value: "a$b" }]);
});

test("the untagged row filters on an empty tag value (cost without the tag)", () => {
  const s = drill({ group: { kind: "tag", key: "team" }, crumbs: [] }, { key: "team$", label: "(태그 없음)" });
  expect(filtersOf(s)).toEqual([{ tag: "team", value: "" }]);
});

test("a grouping whose dimension is already filtered does not drill (the AND would be empty)", () => {
  const s: DrillState = { ...drill(ROOT, RDS), group: { kind: "service" } };
  expect(canDrill(s)).toBe(false);
  expect(canDrill({ ...s, group: { kind: "region" } })).toBe(true);
  const tagged = drill({ group: { kind: "tag", key: "team" }, crumbs: [] }, { key: "team$api", label: "api" });
  expect(canDrill({ ...tagged, group: { kind: "tag", key: "team" } })).toBe(false);
  expect(canDrill({ ...tagged, group: { kind: "tag", key: "env" } })).toBe(true);
});

test("going up to a crumb keeps the filters before it and restores the grouping shown there", () => {
  const regionLevel = drill({ group: { kind: "region" }, crumbs: [] }, { key: "us-east-1", label: "us-east-1" });
  const deep = drill(regionLevel, RDS);
  expect(deep.group).toEqual({ kind: "usageType" });
  expect(up(deep, 1)).toEqual(regionLevel);
  expect(up(deep, 0)).toEqual({ group: { kind: "region" }, crumbs: [] });
  expect(up(deep, 2)).toBe(deep);
});
