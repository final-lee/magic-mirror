import { CHANGE_LOG, NAV_ALL, NAV_BOOKMARKS_LABEL, NAV_EVENTS, NAV_FORWARDS, NAV_LABEL, NAV_MY_PERMISSIONS, NAV_OVERVIEW, bookmarkRemove } from "./text";
import { useReorder } from "./useReorder";

/** 북마크 화면은 `bookmark:<그룹>/<복수형>` */
export type K8sView = "overview" | "workloads" | "events" | "forwards" | "myRules" | "changeLog" | `bookmark:${string}`;

export interface NavBookmark {
  /** bookmarkKey */
  key: string;
  label: string;
  /** 마우스를 올리면 보이는 설명(그룹·버전, 없는 종류면 그 이유) */
  title: string;
  /** 이 클러스터에 없는 종류라 열 수 없다 */
  missing: boolean;
}

// 모양은 IAM·PG 메뉴(.iam-nav)를 그대로 쓴다. 이후 단계가 접근, 보안 점검 등을 더한다.
const ITEMS: { view: K8sView; icon: string; label: string; gap?: boolean }[] = [
  { view: "overview", icon: "📊", label: NAV_OVERVIEW },
  { view: "workloads", icon: "📦", label: NAV_ALL },
  { view: "events", icon: "🔔", label: NAV_EVENTS },
  { view: "forwards", icon: "🔌", label: NAV_FORWARDS },
  { view: "myRules", icon: "🔑", label: NAV_MY_PERMISSIONS, gap: true },
  { view: "changeLog", icon: "📋", label: CHANGE_LOG },
];

interface Props {
  view: K8sView;
  onSelect: (v: K8sView) => void;
  /** 북마크한 순서대로. 개요 위에 보인다. */
  bookmarks: NavBookmark[];
  onMoveBookmark: (from: number, to: number) => void;
  onRemoveBookmark: (key: string) => void;
  /** 끌어서 바꾼 너비(px). 없으면 CSS 기본값 */
  width?: number;
}

export function K8sNav({ view, onSelect, bookmarks, onMoveBookmark, onRemoveBookmark, width }: Props) {
  const reorder = useReorder(bookmarks.length, onMoveBookmark);
  return (
    <nav className="iam-nav" aria-label={NAV_LABEL} style={width ? { width } : undefined}>
      {bookmarks.length > 0 && (
        <div className="k8s-bms" role="group" aria-label={NAV_BOOKMARKS_LABEL}>
          {reorder.preview.map((i) => {
            const b = bookmarks[i];
            const v: K8sView = `bookmark:${b.key}`;
            const current = v === view;
            return (
              <div key={b.key} className={`k8s-bm${reorder.dragged === i ? " dragging" : ""}`} {...reorder.itemProps(i)}>
                <button
                  className={`iam-nav-item${current ? " on" : ""}`}
                  aria-current={current ? "page" : undefined}
                  disabled={b.missing}
                  title={b.title}
                  onClick={() => {
                    if (!reorder.consumeClick()) onSelect(v);
                  }}
                >
                  <span className="iam-nav-ico" aria-hidden="true">★</span>
                  <span className="iam-nav-label">{b.label}</span>
                </button>
                <button className="k8s-bm-x" aria-label={bookmarkRemove(b.label)} title={bookmarkRemove(b.label)} onMouseDown={(e) => e.stopPropagation()} onClick={() => onRemoveBookmark(b.key)}>
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}
      {ITEMS.map((item, i) => {
        const current = item.view === view;
        const gap = item.gap || (i === 0 && bookmarks.length > 0);
        return (
          <button key={item.view} className={`iam-nav-item${current ? " on" : ""}${gap ? " gap" : ""}`} aria-current={current ? "page" : undefined} onClick={() => onSelect(item.view)}>
            <span className="iam-nav-ico" aria-hidden="true">{item.icon}</span>
            <span className="iam-nav-label">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
