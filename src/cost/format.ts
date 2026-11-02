// 비용 탭의 표시용 글자 만들기. 금액 계산은 백엔드가 소수로 끝냈고, 여기서는 보여 주기·정렬·막대 높이에만 수로 바꾼다.
import type { DateRange } from "./types";

/** 소수 문자열 → 수. 읽을 수 없으면 0 */
export function amount(s: string | null | undefined): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

const money = new Map<string, Intl.NumberFormat | null>();

function moneyFormat(unit: string, signed: boolean): Intl.NumberFormat | null {
  const key = `${unit}|${signed}`;
  if (!money.has(key)) {
    try {
      money.set(key, new Intl.NumberFormat("en-US", { style: "currency", currency: unit, minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: signed ? "exceptZero" : "auto" }));
    } catch {
      // 통화 코드가 아닌 단위: 수와 단위를 따로 적는다
      money.set(key, null);
    }
  }
  return money.get(key)!;
}

function plain(n: number, unit: string, signed: boolean): string {
  const s = n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: signed ? "exceptZero" : "auto" });
  return `${s} ${unit}`;
}

/** "$1,234.56". 통화 코드가 아니면 "1,234.56 단위" */
export function formatMoney(value: string | number, unit: string): string {
  const n = typeof value === "number" ? value : amount(value);
  return moneyFormat(unit, false)?.format(n) ?? plain(n, unit, false);
}

/** 증감액: "+$12.30", "-$4.00", "$0.00" */
export function formatDelta(value: string, unit: string): string {
  const n = amount(value);
  return moneyFormat(unit, true)?.format(n) ?? plain(n, unit, true);
}

/** 증감률: "+12.3%", "-4.0%", 없으면 "—" */
export function formatPct(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return "—";
  return `${p.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: "exceptZero" })}%`;
}

/** 비중: "12.3%" */
export function formatShare(p: number): string {
  return `${p.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

/** 받은 지 얼마나 됐는지: "방금 받은 데이터", "12분 전 데이터", "3시간 전 데이터" */
export function dataAge(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const minutes = Math.floor((now - t) / 60_000);
  if (minutes < 1) return "방금 받은 데이터";
  if (minutes < 60) return `${minutes}분 전 데이터`;
  return `${Math.floor(minutes / 60)}시간 전 데이터`;
}

interface Ymd {
  y: number;
  m: number;
  d: number;
}

function parseYmd(s: string): Ymd | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
}

function prevDay(p: Ymd): Ymd {
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d - 1));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** `[start, end)`를 사람이 읽는 마지막 날 포함 범위로: "10월 1일 ~ 10월 29일". 해가 다르면 해를 붙인다 */
export function rangeLabel(range: DateRange): string {
  const a = parseYmd(range.start);
  const e = parseYmd(range.end);
  if (!a || !e) return `${range.start} ~ ${range.end}`;
  const b = prevDay(e);
  const withYear = a.y !== b.y;
  const day = (p: Ymd) => `${withYear ? `${p.y}년 ` : ""}${p.m}월 ${p.d}일`;
  if (a.y === b.y && a.m === b.m && a.d === b.d) return day(a);
  return `${day(a)} ~ ${day(b)}`;
}

/** 막대 아래 눈금: 일별은 "29", 월별은 "10월" */
export function bucketTick(start: string, granularity: "daily" | "monthly"): string {
  const p = parseYmd(start);
  if (!p) return start;
  return granularity === "daily" ? String(p.d) : `${p.m}월`;
}

/** 툴팁 제목: 일별은 "10월 29일", 월별은 "2026년 10월" */
export function bucketTitle(start: string, granularity: "daily" | "monthly"): string {
  const p = parseYmd(start);
  if (!p) return start;
  return granularity === "daily" ? `${p.m}월 ${p.d}일` : `${p.y}년 ${p.m}월`;
}
