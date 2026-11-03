import { Fragment, type ReactNode } from "react";
import { desktop } from "../api/desktop";
import type { DetailData } from "../lib/detail";

/**
 * 오른쪽 상세 팝업. 고른 것이 있을 때만 목록 위에 떠서 오른쪽부터 70%를 덮는다(EKS·ArgoCD 상세와 같은 비율).
 * 단추는 모두 오른쪽 위 도구 모음에 둔다(actions: 서비스별 단추, 그 뒤에 콘솔·원본 데이터, 맨 끝에 닫기).
 * children: 기본 값 목록 바로 아래에 붙는 서비스별 요약(예: EKS 클러스터 사용량)
 */
export function DetailPanel({ detail, onShowRaw, onClose, actions, children }: {
  detail: DetailData | null; onShowRaw: () => void; onClose: () => void; actions?: ReactNode; children?: ReactNode;
}) {
  if (!detail) return null;
  const tags = Object.entries(detail.tags);
  return (
    <aside className="detail" aria-label="상세">
      <div className="detail-head">
        <h3>{detail.title}</h3>
        <div className="detail-tools">
          {actions}
          {detail.consoleUrl && (
            <button className="btn small tone-nav" onClick={() => void desktop.openUrl(detail.consoleUrl!)}>
              AWS 콘솔에서 열기 ↗
            </button>
          )}
          {detail.raw && (
            <button className="btn small tone-secondary" onClick={onShowRaw}>
              원본 데이터 보기
            </button>
          )}
          <button className="icon" aria-label="닫기" title="닫기" onClick={onClose}>
            ✕
          </button>
        </div>
      </div>
      <div className="sub">{detail.subtitle}</div>
      <dl className="kv">
        {detail.rows.map((r) => (
          <Fragment key={r.label}>
            <dt>{r.label}</dt>
            <dd>{r.value}</dd>
          </Fragment>
        ))}
      </dl>
      {children}
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
    </aside>
  );
}
