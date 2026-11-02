import type { KindCategory } from "./kinds";
import { bookmarkKey, sameKind } from "./kinds";
import { kindKey } from "./targets";
import { KIND_TREE_LABEL, bookmarkAdd, bookmarkRemove } from "./text";
import type { K8sKindRef } from "./types";

interface Props {
  categories: KindCategory[];
  selected: K8sKindRef;
  onSelect: (k: K8sKindRef) => void;
  /** 북마크한 종류의 bookmarkKey */
  bookmarked: Set<string>;
  onToggleBookmark: (k: K8sKindRef) => void;
  /** 끌어서 바꾼 너비(px). 없으면 CSS 기본값 */
  width?: number;
}

/** All 화면 왼쪽의 종류 트리. 내장 분류 뒤에 사용자 정의 리소스 그룹이 붙는다. 별로 북마크한다. */
export function KindTree({ categories, selected, onSelect, bookmarked, onToggleBookmark, width }: Props) {
  return (
    <nav className="k8s-tree" aria-label={KIND_TREE_LABEL} style={width ? { width } : undefined}>
      {categories.map((c) => (
        <div key={c.id} className="k8s-tree-group">
          <div className="k8s-tree-title">{c.label}</div>
          {c.kinds.map((k) => {
            const on = sameKind(k, selected);
            const marked = bookmarked.has(bookmarkKey(k));
            const label = marked ? bookmarkRemove(k.kind) : bookmarkAdd(k.kind);
            return (
              <div key={kindKey(k)} className={`k8s-tree-row${marked ? " marked" : ""}`}>
                <button className={`k8s-tree-item${on ? " on" : ""}`} aria-current={on ? "page" : undefined} onClick={() => onSelect(k)}>
                  {k.kind}
                </button>
                <button className="k8s-star" aria-label={label} title={label} aria-pressed={marked} onClick={() => onToggleBookmark(k)}>
                  {marked ? "★" : "☆"}
                </button>
              </div>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
