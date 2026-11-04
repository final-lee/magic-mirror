/** `:` 명령 기록. 앱을 껐다 켜도 남도록 브라우저 저장소에 둔다(최근 것이 앞) */

const KEY = "mm.k8s.goto-history";
export const HISTORY_MAX = 20;

export function loadHistory(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string").slice(0, HISTORY_MAX) : [];
  } catch {
    return [];
  }
}

/** 방금 실행한 명령을 맨 앞에 둔다. 같은 명령은 하나로 합친다 */
export function pushHistory(command: string): string[] {
  const text = command.trim().replace(/^:/, "").trim();
  if (!text) return loadHistory();
  const next = [text, ...loadHistory().filter((c) => c !== text)].slice(0, HISTORY_MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 저장소를 못 쓰면 이번 실행 동안만 기록이 없다. 이동 자체는 막지 않는다
  }
  return next;
}
