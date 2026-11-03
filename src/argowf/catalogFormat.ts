/** 지금(now)에서 본 상대 시각: "5분 전", "3시간 후". 값이 없거나 읽을 수 없으면 빈 글 */
export function relTime(iso: string | null, now: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return "";
  const diff = t - now;
  const s = Math.floor(Math.abs(diff) / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const text = s < 60 ? `${s}초` : m < 60 ? `${m}분` : h < 48 ? `${h}시간` : `${Math.floor(h / 24)}일`;
  return `${text} ${diff >= 0 ? "후" : "전"}`;
}

/** 길이(밀리초)를 두 단위까지: "45초", "3분 12초", "2시간 5분", "1일 3시간" */
export function spanText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 ${s % 60}초`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 ${m % 60}분`;
  return `${Math.floor(h / 24)}일 ${h % 24}시간`;
}

/** 걸린 시간. 끝나지 않았으면 지금까지. 시작하지 않았으면 빈 글 */
export function durationText(startedAt: string | null, finishedAt: string | null, now: number): string {
  const start = startedAt ? Date.parse(startedAt) : NaN;
  if (Number.isNaN(start)) return "";
  const end = finishedAt ? Date.parse(finishedAt) : now;
  return spanText((Number.isNaN(end) ? now : end) - start);
}
