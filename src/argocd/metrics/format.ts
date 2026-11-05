/** 걸린 시간을 한국어로 짧게: 45초, 3분 20초, 2시간 5분, 3일 4시간. 값이 없으면 대시 */
export function duration(ms: number | null): string {
  if (ms === null) return "—";
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}초`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return total % 60 === 0 ? `${minutes}분` : `${minutes}분 ${total % 60}초`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}시간` : `${hours}시간 ${minutes % 60}분`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}일` : `${days}일 ${hours % 24}시간`;
}

/** 0~1 비율을 퍼센트로. 10% 밑은 소수 한 자리. 값이 없으면 대시 */
export function ratio(value: number | null): string {
  if (value === null) return "—";
  const pct = value * 100;
  return `${pct < 10 && pct > 0 ? pct.toFixed(1) : Math.round(pct)}%`;
}

/** 초 단위 지연을 읽기 쉽게: 0.25초는 250ms */
export function seconds(value: number | null): string {
  if (value === null) return "—";
  return value < 1 ? `${Math.round(value * 1000)}ms` : `${value < 10 ? value.toFixed(2) : value.toFixed(1)}초`;
}

/** 하루 평균 배포 수 */
export function perDay(value: number | null): string {
  if (value === null) return "—";
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}

export const localTime = (ms: number) => new Date(ms).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
