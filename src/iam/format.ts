const pad = (n: number) => String(n).padStart(2, "0");

/** ISO 시각을 로컬 날짜(YYYY-MM-DD)로. 값이 없으면 빈 문자열, 파싱할 수 없으면 입력을 그대로 돌려준다. */
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** ISO 시각을 로컬 날짜와 시각(YYYY-MM-DD HH:mm)으로. 값이 없으면 빈 문자열, 파싱할 수 없으면 입력을 그대로 돌려준다. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${formatDay(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const DAY_MS = 86_400_000;

/** "오늘", "6일 전", "3개월 전", "2년 전" */
export function formatAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  if (t > now) return "방금";
  const days = Math.floor((now - t) / DAY_MS);
  if (days === 0) return "오늘";
  if (days < 30) return `${days}일 전`;
  if (days < 365) return `${Math.floor(days / 30)}개월 전`;
  return `${Math.floor(days / 365)}년 전`;
}
