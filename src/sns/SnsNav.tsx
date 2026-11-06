import { SNS_NAV, SNS_VIEW_ICON, SNS_VIEW_LABEL, snsNavView, type SnsView } from "./route";
import { NAV_LABEL } from "./text";

interface Props {
  view: SnsView;
  onSelect: (view: SnsView) => void;
}

// 모양은 IAM 메뉴(.iam-nav)를 그대로 쓴다. gap: 앞 항목과 묶음이 갈리는 곳에 여백을 둔다.
export function SnsNav({ view, onSelect }: Props) {
  const on = snsNavView(view);
  return (
    <nav className="iam-nav sns-nav" aria-label={NAV_LABEL}>
      {SNS_NAV.map((item) => {
        const current = item.view === on;
        return (
          <button key={item.view} className={`iam-nav-item${current ? " on" : ""}${item.gap ? " gap" : ""}`} aria-current={current ? "page" : undefined} onClick={() => onSelect(item.view)}>
            <span className="iam-nav-ico" aria-hidden="true">
              {SNS_VIEW_ICON[item.view]}
            </span>
            <span className="iam-nav-label">{SNS_VIEW_LABEL[item.view]}</span>
          </button>
        );
      })}
    </nav>
  );
}
