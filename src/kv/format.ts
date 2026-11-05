import { formatDateTime } from "../iam/format";
import type { KvBytes } from "./types";

const pad = (n: number) => String(n).padStart(2, "0");

/** 1,234 */
export const formatCount = (n: number) => n.toLocaleString("ko-KR");

/** 초를 "3일 4시간", "2시간 13분", "45분", "12초"처럼 가장 큰 두 단위까지 */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}일 ${h}시간` : `${d}일`;
  if (h > 0) return m > 0 ? `${h}시간 ${m}분` : `${h}시간`;
  if (m > 0) return `${m}분`;
  return `${s}초`;
}

/** 키 행의 TTL. 만료가 없으면 빈 글(줄표) */
export function formatTtlShort(ttlMs: number | null): string {
  if (ttlMs === null) return "";
  const s = Math.max(0, Math.ceil(ttlMs / 1000));
  if (s < 60) return `${s}초`;
  if (s < 3600) return `${Math.floor(s / 60)}분`;
  if (s < 86_400) return `${Math.floor(s / 3600)}시간`;
  return `${Math.floor(s / 86_400)}일`;
}

/** 값 상세의 TTL: "2시간 13분 뒤(2026-11-05 14:03 만료)". readAt은 읽은 시각(ms)이다. */
export function formatTtl(ttlMs: number | null, readAt: number): string {
  if (ttlMs === null) return "만료 없음";
  const when = formatDateTime(new Date(readAt + ttlMs).toISOString());
  return `${formatDuration(Math.ceil(ttlMs / 1000))} 뒤 (${when} 만료)`;
}

/** 마이크로초를 "820µs", "12.3ms", "1.20s"로 */
export function formatMicros(micros: number): string {
  if (micros < 1000) return `${micros}µs`;
  if (micros < 1_000_000) return `${(micros / 1000).toFixed(1)}ms`;
  return `${(micros / 1_000_000).toFixed(2)}s`;
}

/** 유닉스 초를 로컬 "YYYY-MM-DD HH:mm:ss"로 */
export function formatUnix(seconds: number): string {
  const d = new Date(seconds * 1000);
  if (Number.isNaN(d.getTime())) return "";
  return `${formatDateTime(d.toISOString())}:${pad(d.getSeconds())}`;
}

/** 비율(0~1)을 "93.4%"로 */
export const formatPercent = (ratio: number) => `${(ratio * 100).toFixed(1)}%`;

/** 숫자 점수. 정수는 그대로, 소수는 필요한 만큼만 */
export const formatScore = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(12))));

/** base64를 바이트로 */
export function decodeBase64(base64: string): Uint8Array {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 16진수 보기 한 줄 */
export interface HexRow {
  offset: string;
  hex: string;
  ascii: string;
}

/** 16진수 보기로 보이는 바이트 수의 한도. 1MiB 전부를 그리면 화면이 멈춘다(복사는 전부 한다) */
export const HEX_LIMIT = 64 * 1024;

/** 바이트를 16개씩 끊은 16진수 보기(offset, hex, ascii). 한도를 넘는 뒤쪽은 자른다. */
export function hexRows(bytes: Uint8Array, limit = HEX_LIMIT): HexRow[] {
  const rows: HexRow[] = [];
  const end = Math.min(bytes.length, limit);
  for (let at = 0; at < end; at += 16) {
    const chunk = bytes.subarray(at, Math.min(at + 16, end));
    const hex = Array.from(chunk, (b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = Array.from(chunk, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
    rows.push({ offset: at.toString(16).padStart(8, "0"), hex, ascii });
  }
  return rows;
}

/** 바이트 한 값을 한 줄로 보이는 글. UTF-8이 아니면 앞 16바이트의 16진수와 크기 */
export function bytesPreview(b: KvBytes): { text: string; binary: boolean } {
  if (b.text !== null) return { text: b.text, binary: false };
  const head = hexRows(decodeBase64(b.base64), 16)[0]?.hex ?? "";
  return { text: `${head}${b.bytes > 16 ? " …" : ""}`, binary: true };
}

/** JSON으로 읽히는 객체·배열이면 그 값. 숫자·글 하나 같은 값은 글로 보는 것이 낫다. */
export function parseJsonDocument(text: string): unknown | undefined {
  const t = text.trimStart();
  if (t[0] !== "{" && t[0] !== "[") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
