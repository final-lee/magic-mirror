import { PG_VIEW_LABEL, type PgView } from "./route";

// gap: 앞 항목과 묶음이 갈리는 곳에 여백을 둔다(점검 / 읽는 화면들 / 찾는 화면들). 모양은 IAM 메뉴(.iam-nav)를 그대로 쓴다.
const ITEMS: { view: PgView; icon: string; gap?: boolean }[] = [
  { view: "findings", icon: "🛡" },
  { view: "roles", icon: "👥", gap: true },
  { view: "privileges", icon: "🧩" },
  { view: "defaults", icon: "📜" },
  { view: "whoCan", icon: "🔎", gap: true },
  { view: "sessions", icon: "🔌" },
];

/** 항목 옆에 건수를 보여 줄 화면. 나머지는 건수가 없다. */
export type PgNavCounts = Partial<Record<PgView, number>>;

interface Props {
  view: PgView;
  counts: PgNavCounts;
  onSelect: (view: PgView) => void;
}

export function PgNav({ view, counts, onSelect }: Props) {
  return (
    <nav className="iam-nav" aria-label="PostgreSQL 메뉴">
      {ITEMS.map((item) => {
        const n = counts[item.view];
        const current = item.view === view;
        return (
          <button
            key={item.view}
            className={`iam-nav-item${current ? " on" : ""}${item.gap ? " gap" : ""}`}
            aria-current={current ? "page" : undefined}
            onClick={() => onSelect(item.view)}
          >
            <span className="iam-nav-ico" aria-hidden="true">
              {item.icon}
            </span>
            <span className="iam-nav-label">{PG_VIEW_LABEL[item.view]}</span>
            {n !== undefined && (
              <span className={`iam-nav-n${item.view === "findings" && n > 0 ? " alert" : ""}`} data-testid="nav-count">
                {n}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
