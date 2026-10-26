import { compareTargets, nextSelection } from "./selection";
import type { LocalEntry } from "./types";
import type { S3Entry } from "../api/types";

const order = ["a", "b", "c", "d"];

test("plain click selects one", () => {
  expect(nextSelection({ selected: ["a", "b"], anchor: "a" }, "c", order, { meta: false, shift: false })).toEqual({
    selected: ["c"],
    anchor: "c",
  });
});

test("meta click toggles", () => {
  const s1 = nextSelection({ selected: ["a"], anchor: "a" }, "c", order, { meta: true, shift: false });
  expect(s1.selected).toEqual(["a", "c"]);
  const s2 = nextSelection(s1, "a", order, { meta: true, shift: false });
  expect(s2.selected).toEqual(["c"]);
});

test("shift click selects range from anchor in display order", () => {
  expect(nextSelection({ selected: ["b"], anchor: "b" }, "d", order, { meta: false, shift: true }).selected).toEqual([
    "b",
    "c",
    "d",
  ]);
  expect(nextSelection({ selected: ["c"], anchor: "c" }, "a", order, { meta: false, shift: true }).selected).toEqual([
    "a",
    "b",
    "c",
  ]);
});

const lf = (path: string, isDir = false): LocalEntry => ({ name: path.split("/").pop()!, path, isDir, size: 1, modified: null });
const sf = (key: string, isFolder = false): S3Entry => ({
  name: key,
  key,
  isFolder,
  size: 1,
  lastModified: null,
  storageClass: null,
});
const loc = { bucket: "b", region: "r", prefix: "" };

test("compare: one file in each pane wins", () => {
  expect(compareTargets({ local: [lf("/a.txt")], s3: [sf("a.txt")], s3Location: loc, focused: "s3" })).toEqual([
    { source: "local", path: "/a.txt" },
    { source: "s3", bucket: "b", region: "r", key: "a.txt" },
  ]);
});

test("compare: two files in the focused pane", () => {
  expect(compareTargets({ local: [lf("/a"), lf("/b")], s3: [], s3Location: loc, focused: "local" })).toEqual([
    { source: "local", path: "/a" },
    { source: "local", path: "/b" },
  ]);
  expect(compareTargets({ local: [], s3: [sf("x"), sf("y")], s3Location: loc, focused: "s3" })?.[1]).toEqual({
    source: "s3",
    bucket: "b",
    region: "r",
    key: "y",
  });
});

test("compare: folders or wrong counts give null", () => {
  expect(compareTargets({ local: [lf("/d", true)], s3: [sf("a")], s3Location: loc, focused: "s3" })).toBeNull();
  expect(compareTargets({ local: [lf("/a")], s3: [], s3Location: loc, focused: "local" })).toBeNull();
  expect(compareTargets({ local: [lf("/a")], s3: [sf("x")], s3Location: null, focused: "s3" })).toBeNull();
});

test("shift with clicked id or anchor missing from order falls back to plain click", () => {
  expect(nextSelection({ selected: ["a"], anchor: "a" }, "zzz", order, { meta: false, shift: true })).toEqual({
    selected: ["zzz"],
    anchor: "zzz",
  });
  expect(nextSelection({ selected: ["x"], anchor: "x" }, "c", order, { meta: false, shift: true })).toEqual({
    selected: ["c"],
    anchor: "c",
  });
});
