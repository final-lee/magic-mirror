import { NAV_EVENTS, NAV_LABEL, NAV_MY_PERMISSIONS, NAV_OVERVIEW, NAV_WORKLOADS } from "./text";

export type K8sView = "overview" | "workloads" | "events" | "myRules";

// 모양은 IAM·PG 메뉴(.iam-nav)를 그대로 쓴다. 이후 단계가 접근, 보안 점검 등을 더한다.
const ITEMS: { view: K8sView; icon: string; label: string; gap?: boolean }[] = [
  { view: "overview", icon: "📊", label: NAV_OVERVIEW },
  { view: "workloads", icon: "📦", label: NAV_WORKLOADS },
  { view: "events", icon: "🔔", label: NAV_EVENTS },
  { view: "myRules", icon: "🔑", label: NAV_MY_PERMISSIONS, gap: true },
];

export function K8sNav({ view, onSelect }: { view: K8sView; onSelect: (v: K8sView) => void }) {
  return (
    <nav className="iam-nav" aria-label={NAV_LABEL}>
      {ITEMS.map((item) => {
        const current = item.view === view;
        return (
          <button key={item.view} className={`iam-nav-item${current ? " on" : ""}${item.gap ? " gap" : ""}`} aria-current={current ? "page" : undefined} onClick={() => onSelect(item.view)}>
            <span className="iam-nav-ico" aria-hidden="true">{item.icon}</span>
            <span className="iam-nav-label">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
