import { Fragment } from "react";
import { desktop } from "../api/desktop";
import type { DetailData } from "../lib/detail";

export function DetailPanel({ detail, onShowRaw }: { detail: DetailData | null; onShowRaw: () => void }) {
  if (!detail) {
    return (
      <aside className="detail">
        <div className="empty">리소스를 선택하세요</div>
      </aside>
    );
  }
  const tags = Object.entries(detail.tags);
  return (
    <aside className="detail">
      <h3>{detail.title}</h3>
      <div className="sub">{detail.subtitle}</div>
      <dl className="kv">
        {detail.rows.map((r) => (
          <Fragment key={r.label}>
            <dt>{r.label}</dt>
            <dd>{r.value}</dd>
          </Fragment>
        ))}
      </dl>
      {tags.length > 0 && (
        <>
          <div className="sect">Tags</div>
          <div>
            {tags.map(([k, v]) => (
              <span className="tag" key={k}>
                {k}={v}
              </span>
            ))}
          </div>
        </>
      )}
      {detail.copy && (
        <>
          <div className="sect">{detail.copy.label}</div>
          <div className="mono copyable">
            {detail.copy.value}{" "}
            <button className="link" onClick={() => void desktop.copy(detail.copy!.value)}>
              복사
            </button>
          </div>
        </>
      )}
      {detail.consoleUrl && (
        <button className="btn" onClick={() => void desktop.openUrl(detail.consoleUrl!)}>
          AWS 콘솔에서 열기 ↗
        </button>
      )}
      {detail.raw && (
        <button className="btn" onClick={onShowRaw}>
          원본 데이터 보기
        </button>
      )}
    </aside>
  );
}
