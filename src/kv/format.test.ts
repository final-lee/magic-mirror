import { binary, bytes } from "./fixtures";
import { bytesPreview, decodeBase64, formatDuration, formatMicros, formatScore, formatTtl, formatTtlShort, hexRows, parseJsonDocument } from "./format";

test("durations use the two biggest units", () => {
  expect(formatDuration(5)).toBe("5초");
  expect(formatDuration(90)).toBe("1분");
  expect(formatDuration(3 * 3600 + 120)).toBe("3시간 2분");
  expect(formatDuration(2 * 86_400 + 5 * 3600 + 59)).toBe("2일 5시간");
  expect(formatDuration(86_400)).toBe("1일");
});

test("the short TTL of a key row", () => {
  expect(formatTtlShort(null)).toBe("");
  expect(formatTtlShort(30_000)).toBe("30초");
  expect(formatTtlShort(90_000)).toBe("1분");
  expect(formatTtlShort(7_200_000)).toBe("2시간");
  expect(formatTtlShort(3 * 86_400_000)).toBe("3일");
});

test("the TTL of a value says when it expires, or that it never does", () => {
  expect(formatTtl(null, 0)).toBe("만료 없음");
  const read = new Date(2026, 10, 5, 12, 0, 0).getTime();
  expect(formatTtl(2 * 3600_000 + 13 * 60_000, read)).toBe("2시간 13분 뒤 (2026-11-05 14:13 만료)");
});

test("slowlog durations", () => {
  expect(formatMicros(820)).toBe("820µs");
  expect(formatMicros(12_300)).toBe("12.3ms");
  expect(formatMicros(1_200_000)).toBe("1.20s");
});

test("scores keep their fraction but not float noise", () => {
  expect(formatScore(3)).toBe("3");
  expect(formatScore(0.1 + 0.2)).toBe("0.3");
});

test("a hex dump has 16 bytes per row with offset and ascii", () => {
  const rows = hexRows(new TextEncoder().encode("Hello, Valkey! \x00\x01more"));
  expect(rows[0]).toEqual({ offset: "00000000", hex: "48 65 6c 6c 6f 2c 20 56 61 6c 6b 65 79 21 20 00", ascii: "Hello, Valkey! ." });
  expect(rows[1]).toEqual({ offset: "00000010", hex: "01 6d 6f 72 65", ascii: ".more" });
});

test("a hex dump stops at the limit", () => {
  expect(hexRows(new Uint8Array(100), 32)).toHaveLength(2);
});

test("base64 decodes to the exact bytes", () => {
  expect([...decodeBase64(binary(0, 255, 16).base64)]).toEqual([0, 255, 16]);
});

test("a value cell shows text as is and binary as the first bytes", () => {
  expect(bytesPreview(bytes("hi"))).toEqual({ text: "hi", binary: false });
  const long = binary(...Array.from({ length: 20 }, (_, i) => i + 200));
  const p = bytesPreview(long);
  expect(p.binary).toBe(true);
  expect(p.text.endsWith(" …")).toBe(true);
  expect(bytesPreview(binary(1, 2)).text).toBe("01 02");
});

test("only objects and arrays count as a JSON document", () => {
  expect(parseJsonDocument('{"a":1}')).toEqual({ a: 1 });
  expect(parseJsonDocument(' [1,2]')).toEqual([1, 2]);
  expect(parseJsonDocument("123")).toBeUndefined();
  expect(parseJsonDocument('"text"')).toBeUndefined();
  expect(parseJsonDocument("{broken")).toBeUndefined();
});
