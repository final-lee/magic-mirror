import { localEntryToRow, parentPrefix, refKey, refLabel, refName } from "./rows";

test("localEntryToRow marks folders and keeps raw size", () => {
  const dir = localEntryToRow({ name: "src", path: "/p/src", isDir: true, size: null, modified: null });
  expect(dir.id).toBe("/p/src");
  expect(dir.values.name).toBe("📁 src");
  expect(dir.values.kind).toBe("Folder");
  const file = localEntryToRow({ name: "a.txt", path: "/p/a.txt", isDir: false, size: 12, modified: "2026-01-01T00:00:00Z" });
  expect(file.values.size).toBe("12");
  expect(file.name).toBe("a.txt");
});

test("refKey, refName, refLabel", () => {
  const l = { source: "local" as const, path: "/Users/me/web/index.html" };
  const s = { source: "s3" as const, bucket: "assets", region: "ap-northeast-2", key: "web/index.html" };
  expect(refKey(l)).toBe("local:/Users/me/web/index.html");
  expect(refKey(s)).toBe("s3:assets/web/index.html");
  expect(refName(l)).toBe("index.html");
  expect(refName(s)).toBe("index.html");
  expect(refLabel(s)).toBe("s3://assets/web/index.html");
  expect(refLabel(l)).toBe("/Users/me/web/index.html");
});

test("parentPrefix", () => {
  expect(parentPrefix("a/b/")).toBe("a/");
  expect(parentPrefix("a/x.txt")).toBe("a/");
  expect(parentPrefix("x.txt")).toBe("");
});
