import { desktop } from "../../api/desktop";
import type { LinkRow } from "../types";

/** 서버가 설정한 deep link 버튼들. 누르면 브라우저로 연다. 링크가 없으면 empty(없으면 아무것도 그리지 않는다). */
export function LinkButtons({ links, label, empty }: { links: LinkRow[]; label: string; empty?: string }) {
  if (links.length === 0) return empty ? <p className="dim">{empty}</p> : null;
  return (
    <div className="argo-links" role="group" aria-label={label}>
      {links.map((l) => (
        <button key={l.url} className="btn small tone-nav" title={l.description ?? l.url} onClick={() => void desktop.openUrl(l.url)}>
          {l.title}
        </button>
      ))}
    </div>
  );
}
