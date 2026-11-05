import { KV_VIEW_LABEL, type KvView } from "./route";
import { NAV_ICON, NAV_LABEL } from "./text";

// gap: 앞 항목과 묶음이 갈리는 곳에 여백을 둔다(키·Bull / 서버 상태를 보는 화면들 / 큰 키). 모양은 IAM 메뉴(.iam-nav)를 그대로 쓴다.
const ITEMS: { view: KvView; gap?: boolean }[] = [{ view: "keys" }, { view: "bull" }, { view: "overview", gap: true }, { view: "slowlog" }, { view: "clients" }, { view: "bigkeys", gap: true }];

interface Props {
  view: KvView;
  /** 꺼진 화면과 그 이유(서버리스는 Slow log·클라이언트). 이유는 메뉴 아래에도 글로 보인다 */
  disabled: Partial<Record<KvView, string>>;
  onSelect: (view: KvView) => void;
}

export function KvNav({ view, disabled, onSelect }: Props) {
  const reasons = ITEMS.flatMap((item) => (disabled[item.view] ? [disabled[item.view]!] : []));
  return (
    <nav className="iam-nav kv-nav" aria-label={NAV_LABEL}>
      {ITEMS.map((item) => {
        const current = item.view === view;
        const reason = disabled[item.view];
        return (
          <button
            key={item.view}
            className={`iam-nav-item${current ? " on" : ""}${item.gap ? " gap" : ""}`}
            aria-current={current ? "page" : undefined}
            disabled={!!reason}
            title={reason}
            aria-description={reason}
            onClick={() => onSelect(item.view)}
          >
            <span className="iam-nav-ico" aria-hidden="true">
              {NAV_ICON[item.view]}
            </span>
            <span className="iam-nav-label">{KV_VIEW_LABEL[item.view]}</span>
          </button>
        );
      })}
      {reasons.map((reason) => (
        <p key={reason} className="kv-nav-reason" role="note">
          {reason}
        </p>
      ))}
    </nav>
  );
}
