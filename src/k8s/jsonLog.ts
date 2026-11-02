/** 한 줄 JSON 로그를 읽어 시각·레벨·메시지와 나머지 필드로 나눈다. 로그 탭의 "JSON 정리" 보기와 레벨 거르기가 쓴다. */

export type LogTone = "error" | "warn" | "info" | "debug";

export interface JsonLog {
  /** 보이는 시각(로컬 `MM-DD HH:mm:ss.SSS`). 시각으로 읽지 못하면 원래 값 그대로 */
  time: string | null;
  /** 원래 시각 값(마우스를 올리면 보인다) */
  timeRaw: string | null;
  level: string | null;
  tone: LogTone | null;
  message: string | null;
  /** 시각·레벨·메시지를 뺀 나머지(원래 순서) */
  fields: [string, unknown][];
  /** 줄 전체 */
  value: Record<string, unknown>;
}

// 흔한 로거(ECS, pino, bunyan, zap, logrus, structlog 등)의 이름. 앞의 것이 먼저다.
const TIME_KEYS = ["timestamp", "@timestamp", "time", "ts", "datetime", "date"];
const LEVEL_KEYS = ["log.level", "level", "severity", "lvl", "loglevel", "levelname"];
const MESSAGE_KEYS = ["message", "msg", "@message"];

/** `{`로 시작해 `}`로 끝나는 줄만 JSON으로 읽어 본다. 객체가 아니거나 깨졌으면 null(원래 줄로 보인다). */
export function parseJsonLog(line: string): JsonLog | null {
  const text = line.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const used = new Set<string>();
  const take = (keys: string[], ok: (v: unknown) => boolean) => {
    const key = keys.find((k) => k in obj && ok(obj[k]));
    if (key === undefined) return undefined;
    used.add(key);
    return obj[key];
  };
  const rawTime = take(TIME_KEYS, (v) => typeof v === "string" || typeof v === "number") as string | number | undefined;
  const rawLevel = take(LEVEL_KEYS, (v) => typeof v === "string" || typeof v === "number") as string | number | undefined;
  const message = take(MESSAGE_KEYS, (v) => typeof v === "string") as string | undefined;
  const level = rawLevel === undefined ? null : typeof rawLevel === "number" ? (PINO_LEVELS[rawLevel] ?? String(rawLevel)) : rawLevel;
  return {
    time: rawTime === undefined ? null : (formatTime(rawTime) ?? String(rawTime)),
    timeRaw: rawTime === undefined ? null : String(rawTime),
    level,
    tone: level === null ? null : toneOf(level),
    message: message ?? null,
    fields: Object.entries(obj).filter(([k]) => !used.has(k)),
    value: obj,
  };
}

/** pino·bunyan의 숫자 레벨 */
const PINO_LEVELS: Record<number, string> = { 10: "trace", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "fatal" };

function toneOf(level: string): LogTone | null {
  const l = level.toLowerCase();
  if (/^(fatal|panic|crit|critical|alert|emerg|emergency|err|error|severe)$/.test(l)) return "error";
  if (/^(warn|warning)$/.test(l)) return "warn";
  if (/^(info|information|notice)$/.test(l)) return "info";
  if (/^(debug|trace|verbose|fine|finer|finest)$/.test(l)) return "debug";
  return null;
}

/**
 * 줄의 레벨(레벨 거르기가 쓴다). JSON이면 레벨 필드로, 아니면 맨 앞의 레벨 낱말(`[WARNING] …`, `ERROR: …`)이나 logfmt의 `level=`로.
 * 본문 가운데의 낱말은 보지 않는다("no error found"가 오류가 되지 않게).
 */
export function lineTone(line: string): LogTone | null {
  const json = parseJsonLog(line);
  if (json) return json.tone;
  const word = /^\s*\[?([A-Za-z]+)\]?[\s:]/.exec(line)?.[1] ?? /(?:^|\s)level=("?)(\w+)\1(?:\s|$)/i.exec(line)?.[2];
  return word === undefined ? null : toneOf(word);
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** ISO 글이나 epoch 숫자(초·밀리초·마이크로초·나노초)를 로컬 시각으로. 시각이 아니면 null */
export function formatTime(raw: string | number): string | null {
  let ms: number;
  if (typeof raw === "number") {
    const abs = Math.abs(raw);
    // 초 단위 소수(zap)는 곱하면 .775999…가 되기도 해 밀리초로 반올림한다
    ms = Math.round(abs < 1e11 ? raw * 1000 : abs < 1e14 ? raw : abs < 1e17 ? raw / 1e3 : raw / 1e6);
  } else {
    // 날짜가 들어 있는 글만(숫자 몇 개나 낱말은 Date가 엉뚱하게 읽는다)
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(raw)) return null;
    ms = Date.parse(raw);
  }
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** 오류를 담은 필드(error.message, err, exception, stack 등). 접어 둔 줄에서도 메시지 옆에 보인다. */
export function isErrorField(key: string): boolean {
  return /^(error|err|exception|exc|stack|stacktrace|stack_trace)([._]|$)/i.test(key);
}

/** 한 줄 안에 `key=value`로 보일 값. 공백 없는 글은 따옴표 없이, 나머지는 JSON으로 */
export function inlineValue(v: unknown): string {
  if (typeof v === "string") return v !== "" && !/[\s"=]/.test(v) ? v : JSON.stringify(v);
  return JSON.stringify(v) ?? String(v);
}
