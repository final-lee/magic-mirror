import { prefixSegments, s3EntryToRow } from "./s3";

test("prefixSegments splits nested prefix", () => {
  expect(prefixSegments("")).toEqual([]);
  expect(prefixSegments("images/products/")).toEqual([
    { label: "images", prefix: "images/" },
    { label: "products", prefix: "images/products/" },
  ]);
});

test("s3EntryToRow marks folders and keeps raw size", () => {
  const folder = s3EntryToRow({ name: "images", key: "images/", isFolder: true, size: null, lastModified: null, storageClass: null });
  expect(folder.id).toBe("images/");
  expect(folder.values.name).toBe("📁 images");
  expect(folder.values.kind).toBe("Folder");
  const obj = s3EntryToRow({ name: "a.txt", key: "a.txt", isFolder: false, size: 10, lastModified: "2026-01-01T00:00:00Z", storageClass: null });
  expect(obj.values.name).toBe("📄 a.txt");
  expect(obj.values.size).toBe("10");
  expect(obj.name).toBe("a.txt");
});
