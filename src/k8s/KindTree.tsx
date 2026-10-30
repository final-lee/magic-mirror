import type { KindCategory } from "./kinds";
import { sameKind } from "./kinds";
import { kindKey } from "./targets";
import { KIND_TREE_LABEL } from "./text";
import type { K8sKindRef } from "./types";

interface Props {
  categories: KindCategory[];
  selected: K8sKindRef;
  onSelect: (k: K8sKindRef) => void;
}

/** 워크로드 화면 왼쪽의 종류 트리. 내장 분류 뒤에 사용자 정의 리소스 그룹이 붙는다. */
export function KindTree({ categories, selected, onSelect }: Props) {
  return (
    <nav className="k8s-tree" aria-label={KIND_TREE_LABEL}>
      {categories.map((c) => (
        <div key={c.id} className="k8s-tree-group">
          <div className="k8s-tree-title">{c.label}</div>
          {c.kinds.map((k) => {
            const on = sameKind(k, selected);
            return (
              <button key={kindKey(k)} className={`k8s-tree-item${on ? " on" : ""}`} aria-current={on ? "page" : undefined} onClick={() => onSelect(k)}>
                {k.kind}
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
