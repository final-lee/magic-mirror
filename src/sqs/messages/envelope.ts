import type { SqsItemResult, SqsMessage } from "../types";
import { MISSING } from "./text";

export function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** JSON 봉투 한 겹을 풀어요. S3는 레코드의 이벤트 정보를 그대로 보여 줘요. */
export function unwrapJson(value: unknown): { kind: string; value: unknown } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (obj.Type === "Notification" && typeof obj.Message === "string") return { kind: "SNS", value: parseJson(obj.Message) ?? obj.Message };
  if ("detail-type" in obj && "detail" in obj) return { kind: "EventBridge", value: obj.detail };
  if (Array.isArray(obj.Records) && obj.Records.some((r: unknown) => !!r && typeof r === "object" && "s3" in r)) return { kind: "S3", value: obj.Records };
  return null;
}

export function base64Bytes(text: string): Uint8Array | null {
  const clean = text.trim();
  if (clean.length < 4 || clean.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(clean)) return null;
  try { return Uint8Array.from(atob(clean), c => c.charCodeAt(0)); } catch { return null; }
}
export function isGzip(bytes: Uint8Array): boolean { return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b; }

export async function unwrapBody(body: string): Promise<{ text: string; layers: string[] }> {
  let text = body;
  const layers: string[] = [];
  for (let i = 0; i < 8; i++) {
    const json = parseJson(text);
    const envelope = unwrapJson(json);
    if (envelope) {
      layers.push(envelope.kind);
      text = typeof envelope.value === "string" ? envelope.value : JSON.stringify(envelope.value, null, 2);
      if (envelope.kind === "S3") break;
      continue;
    }
    const bytes = base64Bytes(text);
    if (!bytes) break;
    try {
      let decoded: string;
      if (isGzip(bytes)) {
        if (typeof DecompressionStream === "undefined") break;
        const stream = new Response(new Uint8Array(bytes)).body!.pipeThrough(new DecompressionStream("gzip"));
        decoded = await new Response(stream).text();
        layers.push("base64", "gzip");
      } else {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (/[\u0000-\u0008\u000e-\u001f]/.test(decoded)) break;
        layers.push("base64");
      }
      text = decoded;
    } catch { break; }
  }
  return { text, layers };
}

export function fieldValue(body: string, path: string): string {
  let value: unknown = parseJson(body);
  for (const part of path.split(".").filter(Boolean)) {
    if (value === null || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, part)) return MISSING;
    value = (value as Record<string, unknown>)[part];
  }
  if (value === undefined) return MISSING;
  return typeof value === "string" ? value : JSON.stringify(value);
}
export function groupByField(messages: SqsMessage[], path: string): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const key = fieldValue(message.body, path);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}
export function remainingMessages(messages: SqsMessage[], items: SqsItemResult[]): SqsMessage[] {
  const succeeded = new Set(items.filter(item => item.ok).map(item => item.id));
  return messages.filter(message => !succeeded.has(message.messageId));
}
