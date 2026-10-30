/** 밀리코어를 kubectl처럼: 1코어 밑은 m, 위는 코어 수(소수 한 자리) */
export function formatCpu(milli: number): string {
  if (milli < 1000) return `${milli}m`.replace(/^0m$/, "0");
  const cores = milli / 1000;
  return Number.isInteger(cores) ? `${cores}` : cores.toFixed(1);
}

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];

export function formatBytes(n: number): string {
  let v = n;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const shown = Number.isInteger(v) ? `${v}` : v.toFixed(1);
  return `${shown} ${UNITS[i]}`;
}

export function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "–";
}

/** kubectl의 AGE처럼 짧게: 초, 분, 시간(48시간까지), 일 */
export function age(iso: string | null, now: number): string {
  if (!iso) return "";
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
