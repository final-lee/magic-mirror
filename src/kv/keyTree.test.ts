import { name } from "./fixtures";
import { buildKeyTree, flattenTree, type FolderNode, type LeafNode } from "./keyTree";
import type { KvKeyRow } from "./types";

const row = (text: string, base64: string | null = null): KvKeyRow => ({ name: { text, base64 }, type: "string", ttlMs: null });
const folder = (n: unknown) => n as FolderNode;
const leaf = (n: unknown) => n as LeafNode;

test("groups keys into folders by the delimiter, with the number of keys below each folder", () => {
  const tree = buildKeyTree([row("session:2026:a"), row("session:2026:b"), row("session:2025:c"), row("cache:x")], ":");
  expect(tree.map((n) => [n.kind, folder(n).label, folder(n).count])).toEqual([
    ["folder", "cache", 1],
    ["folder", "session", 3],
  ]);
  const session = folder(tree[1]);
  expect(session.path).toBe("session:");
  expect(session.children.map((c) => [folder(c).label, folder(c).count, folder(c).path])).toEqual([
    ["2025", 1, "session:2025:"],
    ["2026", 2, "session:2026:"],
  ]);
  expect(folder(session.children[1]).children.map((c) => leaf(c).label)).toEqual(["a", "b"]);
});

test("folders come before keys, each sorted by name with numbers by value", () => {
  const tree = buildKeyTree([row("zeta"), row("a:1"), row("item10"), row("item9"), row("b:1")], ":");
  expect(tree.map((n) => (n.kind === "folder" ? `${n.label}/` : n.label))).toEqual(["a/", "b/", "item9", "item10", "zeta"]);
});

test("an empty delimiter gives a flat list", () => {
  const tree = buildKeyTree([row("a:b"), row("a:c")], "");
  expect(tree.map((n) => n.kind)).toEqual(["key", "key"]);
  expect(leaf(tree[0]).label).toBe("a:b");
});

test("a key named like a folder shows next to it", () => {
  const tree = buildKeyTree([row("a"), row("a:b")], ":");
  expect(tree.map((n) => n.kind)).toEqual(["folder", "key"]);
  expect(leaf(tree[1]).label).toBe("a");
});

test("a key ending with the delimiter sits in its folder with an empty label", () => {
  const tree = buildKeyTree([row("a:")], ":");
  expect(folder(tree[0]).children.map((c) => leaf(c).label)).toEqual([""]);
});

test("keys whose names are not UTF-8 keep their exact address", () => {
  const tree = buildKeyTree([row("bin:\ufffd", "YmluOv8=")], ":");
  const key = leaf(folder(tree[0]).children[0]);
  expect(key.row.name.base64).toBe("YmluOv8=");
  expect(key.id).toBe("b:YmluOv8=");
});

test("flattenTree follows only the folders that are open, or all of them", () => {
  const tree = buildKeyTree([row("a:b:c"), row("a:d"), row("e")], ":");
  const labels = (rows: ReturnType<typeof flattenTree>) => rows.map((r) => `${r.depth}${r.node.kind === "folder" ? r.node.label + "/" : r.node.label}`);
  expect(labels(flattenTree(tree, new Set()))).toEqual(["0a/", "0e"]);
  expect(labels(flattenTree(tree, new Set(["a:"])))).toEqual(["0a/", "1b/", "1d", "0e"]);
  expect(labels(flattenTree(tree, "all"))).toEqual(["0a/", "1b/", "2c", "1d", "0e"]);
});

test("the key id of a text name differs from a binary name with the same letters", () => {
  const a = buildKeyTree([{ name: name("x"), type: "string", ttlMs: null }], ":");
  const b = buildKeyTree([row("x", "eA==")], ":");
  expect(leaf(a[0]).id).not.toBe(leaf(b[0]).id);
});
