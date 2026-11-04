import { STATUS_HINT } from "./text";

/** 상태의 색 갈래: 정상, 지난 리비전·삭제됨(흐림), 실패, 끝나지 않은 작업 */
export type StatusTone = "ok" | "muted" | "bad" | "warn";

export function statusTone(status: string): StatusTone {
  if (status === "deployed") return "ok";
  if (status === "superseded" || status === "uninstalled") return "muted";
  if (status === "failed" || status === "unknown") return "bad";
  return "warn";
}

/** helm 릴리스 상태 배지. 마우스를 올리면 뜻이 보인다 */
export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`helm-status ${statusTone(status)}`} title={STATUS_HINT[status] ?? status}>
      {status || "?"}
    </span>
  );
}
