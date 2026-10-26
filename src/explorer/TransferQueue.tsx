import { errorMessage } from "../api/errors";
import type { TransferItem } from "./useTransfers";

const name = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

export function TransferQueue({ items, onRetry, onClear }: { items: TransferItem[]; onRetry: (id: string) => void; onClear: () => void }) {
  if (items.length === 0) return null;
  const active = items.filter((i) => i.event.status === "queued" || i.event.status === "running").length;
  const failed = items.filter((i) => i.event.status === "failed").length;
  return (
    <div className="queue">
      <div className="queue-head">
        <span>
          전송 {items.length}개 · 진행 {active} · 실패 {failed}
        </span>
        <button className="link" onClick={onClear}>
          완료 항목 지우기
        </button>
      </div>
      <ul>
        {items.map(({ request: r, event: e }) => {
          const pct = e.total ? Math.floor((e.transferred / e.total) * 100) : null;
          return (
            <li key={r.id} className={`qitem ${e.status}`}>
              <span>{r.direction === "upload" ? "⬆" : "⬇"}</span>
              <span className="qname mono">{name(r.direction === "upload" ? r.key : r.localPath)}</span>
              {e.status === "queued" && <span className="dim">대기</span>}
              {e.status === "running" &&
                (pct !== null ? (
                  <>
                    <span className="bar">
                      <i style={{ width: `${pct}%` }} />
                    </span>
                    <span>{pct}%</span>
                  </>
                ) : (
                  <span className="dim">전송 중…</span>
                ))}
              {e.status === "done" && <span className="ok">완료</span>}
              {e.status === "failed" && (
                <>
                  <span className="err">{e.error ? errorMessage(e.error) : "실패"}</span>
                  <button className="link" onClick={() => onRetry(r.id)}>
                    재시도
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
