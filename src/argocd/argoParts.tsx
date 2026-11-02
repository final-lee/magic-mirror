/** 상태 글자의 색 */
export type ArgoTone = "ok" | "warn" | "bad" | "dim";

const TONES: Record<string, ArgoTone> = {
  Synced: "ok",
  Healthy: "ok",
  Succeeded: "ok",
  UpToDate: "ok",
  OutOfSync: "warn",
  Progressing: "warn",
  Running: "warn",
  Degraded: "bad",
  Missing: "bad",
  Failed: "bad",
  Error: "bad",
};

/** 상태 이름의 색: 초록(정상), 노랑(진행·어긋남), 빨강(문제), 나머지는 흐림 */
export const argoTone = (status: string | null | undefined): ArgoTone => (status ? (TONES[status] ?? "dim") : "dim");

/** 상태 하나를 색 있는 알약으로. 값이 없으면 아무것도 그리지 않는다. */
export function ArgoBadge({ status, title }: { status: string | null | undefined; title?: string }) {
  if (!status) return null;
  return (
    <span className={`argo-badge argo-${argoTone(status)}`} title={title}>
      {status}
    </span>
  );
}

/** 40자 16진수 커밋 해시는 앞 7자만, 그 밖의 리비전(태그·차트 버전)은 그대로 */
export const shortRev = (rev: string) => (/^[0-9a-f]{40}$/i.test(rev) ? rev.slice(0, 7) : rev);
