import { fuzzyFilter, fuzzyKeep, highlightIndices, matchToken, tokenize } from "./fuzzy";

const byName = (r: { name: string }) => [r.name];
const names = (rows: { name: string }[]) => rows.map((r) => r.name);

test("letters in order match, and word starts rank above letters inside words", () => {
  const rows = [{ name: "deploy-orders-api" }, { name: "billing" }, { name: "prod-orders-api" }];
  expect(names(fuzzyFilter(rows, "poa", byName))).toEqual(["prod-orders-api", "deploy-orders-api"]);
  expect(names(fuzzyFilter([{ name: "staging-web" }, { name: "web-1" }], "wb", byName))).toEqual(["web-1", "staging-web"]);
  expect(matchToken("getobj", "s3:GetObject")?.indices).toEqual([3, 4, 5, 6, 7, 8]);
});

test("letters scattered far apart do not match", () => {
  expect(matchToken("abc", "xxaxxxxxxbxxxxxxxc")).toBeNull();
  expect(matchToken("prod", "2026-10-30T11:00:00Z running t3.micro")).toBeNull();
  expect(matchToken("ab", "ba")).toBeNull();
});

test("every token must match some field, ignoring case", () => {
  const rows = [
    { name: "Web-Prod", tags: "team=core" },
    { name: "web-dev", tags: "team=core" },
    { name: "web-prod-2", tags: "team=data" },
  ];
  const fields = (r: (typeof rows)[number]) => [r.name, r.tags];
  expect(names(fuzzyFilter(rows, "WEB prod  core", fields))).toEqual(["Web-Prod"]);
});

test("an exact field outranks a longer one, and earlier fields outrank later ones", () => {
  expect(names(fuzzyFilter([{ name: "web-api" }, { name: "web" }], "web", byName))).toEqual(["web", "web-api"]);
  const rows = [
    { name: "x", id: "orders" },
    { name: "orders", id: "x" },
  ];
  expect(fuzzyFilter(rows, "orders", (r) => [r.name, r.id])).toEqual([rows[1], rows[0]]);
});

test("decomposed Hangul (macOS file names) matches a composed query", () => {
  const nfd = "주문-서비스".normalize("NFD");
  expect(names(fuzzyFilter([{ name: nfd }], "주문", byName))).toEqual([nfd]);
  expect(highlightIndices(tokenize("주문"), nfd)).toEqual([0, 1]);
});

test("an empty query keeps every row in order; fuzzyKeep keeps the original order of matches", () => {
  const rows = [{ name: "b-web" }, { name: "web" }, { name: "db" }];
  expect(fuzzyFilter(rows, "  ", byName)).toEqual(rows);
  expect(names(fuzzyKeep(rows, "web", byName))).toEqual(["b-web", "web"]);
});

test("highlight merges the positions of each token that matches the text", () => {
  expect(highlightIndices(tokenize("prod api"), "prod-orders-api")).toEqual([0, 1, 2, 3, 12, 13, 14]);
  expect(highlightIndices(tokenize("zzz"), "prod")).toEqual([]);
});
