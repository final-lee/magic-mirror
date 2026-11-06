import type { ReactNode } from "react";
import { CLOSE, DETAIL_LABEL } from "./text";

interface Props {
  /** 머리의 굵은 글(종류) */
  title: string;
  /** 머리의 이름(네임스페이스/이름) */
  subtitle: string;
  /** 3열 목록 너비 중 덮는 비율(%) */
  widthPct: number;
  onClose: () => void;
  /** 오른쪽 위 도구 줄의 버튼들 */
  toolbar?: ReactNode;
  children: ReactNode;
}

/** 네트워크 화면의 오른쪽 상세: 목록 위에 떠서 오른쪽부터 widthPct%를 덮는다(EKS 상세와 같은 틀) */
export function NetDetail({ title, subtitle, widthPct, onClose, toolbar, children }: Props) {
  return (
    <aside className="k8s-detail" aria-label={DETAIL_LABEL} style={{ width: `${widthPct}%` }}>
      <div className="k8s-detail-head">
        <b>{title}</b>
        <span className="mono k8s-wrap">{subtitle}</span>
        <button className="icon k8s-push tone-ghost" aria-label={CLOSE} title={CLOSE} onClick={onClose}>
          ✕
        </button>
      </div>
      {toolbar && <div className="k8s-actions k8s-toolbar">{toolbar}</div>}
      <div className="k8s-detail-body">{children}</div>
    </aside>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="k8s-sect" aria-label={title}>
      <h4>{title}</h4>
      {children}
    </section>
  );
}
