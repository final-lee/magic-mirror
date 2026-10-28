import type { IamView } from "./route";

// gap: 앞 항목과 묶음이 갈리는 곳에 여백을 둔다(점검 / 목록들 / 도구들)
const ITEMS: { view: IamView; icon: string; label: string; gap?: boolean }[] = [
  { view: "findings", icon: "🛡", label: "점검" },
  { view: "users", icon: "👤", label: "사용자", gap: true },
  { view: "groups", icon: "👥", label: "그룹" },
  { view: "roles", icon: "🎭", label: "역할" },
  { view: "policies", icon: "📜", label: "정책" },
  { view: "assignments", icon: "🧩", label: "할당" },
  { view: "whoCan", icon: "🔎", label: "누가 할 수 있나", gap: true },
  { view: "log", icon: "🕘", label: "변경 기록" },
];

/** 항목 옆에 건수를 보여줄 화면. 나머지는 건수가 없다. */
export type NavCounts = Partial<Record<IamView, number>>;

interface Props {
  view: IamView;
  counts: NavCounts;
  onSelect: (view: IamView) => void;
}

export function IamNav({ view, counts, onSelect }: Props) {
  return (
    <nav className="iam-nav" aria-label="IAM 메뉴">
      {ITEMS.map((item) => {
        const n = counts[item.view];
        const current = item.view === view;
        return (
          <button key={item.view} className={`iam-nav-item${current ? " on" : ""}${item.gap ? " gap" : ""}`} aria-current={current ? "page" : undefined} onClick={() => onSelect(item.view)}>
            <span className="iam-nav-ico" aria-hidden="true">
              {item.icon}
            </span>
            <span className="iam-nav-label">{item.label}</span>
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
