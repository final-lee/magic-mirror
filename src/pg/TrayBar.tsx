import { useEffect, useState } from "react";
import type { PgDraftItem } from "./draft";
import type { PgDraft } from "./usePgDraft";
import type { usePgBatch } from "./usePgBatch";

type Draft = Pick<PgDraft, "items" | "database" | "remove" | "clear" | "removeApplied">;

interface Props {
  draft: Draft;
  /** 탭이 보여 주는 데이터베이스. 담긴 변경에 데이터베이스가 없을 때(구성원·속성 변경뿐) 묶음을 이 데이터베이스에서 연다 */
  database: string;
  /** 묶음 흐름을 시작한다(usePgBatch의 start). 적용에 성공하면 적용한 변경이 장바구니에서 빠진다 */
  start: ReturnType<typeof usePgBatch>["start"];
}

/** 장바구니 요약: 변경 N개 · 첫 변경 (외 N-1개) */
const summaryOf = (items: PgDraftItem[]) => (items.length === 1 ? `변경 1개 · ${items[0].label}` : `변경 ${items.length}개 · ${items[0].label} 외 ${items.length - 1}개`);

/**
 * 장바구니 막대: 담긴 변경의 요약, [모두 취소], [미리보기]. 요약을 누르면 변경 목록이 펴지고, 줄마다 ×로 하나씩 뺄 수 있다.
 * 마크업과 클래스는 할당 표의 장바구니(asg-tray)와 같다.
 * [미리보기]는 담긴 변경을 담긴 순서대로 묶음으로 연다. 묶음은 데이터베이스 하나에서 한 트랜잭션으로 돈다:
 * 담긴 변경에 데이터베이스가 있으면 그 데이터베이스, 없으면 탭이 보여 주는 데이터베이스다. 적용에 성공하면 적용한 변경만 장바구니에서 빠진다.
 */
export function TrayBar({ draft, database, start }: Props) {
  const [expanded, setExpanded] = useState(false);
  const { items } = draft;

  // 장바구니가 비면 목록은 접힌 채로 돌아온다
  useEffect(() => {
    if (items.length === 0) setExpanded(false);
  }, [items.length]);

  if (items.length === 0) return null;
  return (
    <div className="asg-tray">
      {expanded && (
        <ul className="asg-tray-list" aria-label="담긴 변경">
          {items.map((d) => (
            <li key={d.key}>
              <span>{d.label}</span>
              <button className="icon" aria-label={`${d.label} 취소`} onClick={() => draft.remove(d.key)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="asg-tray-bar">
        <button className="asg-tray-toggle" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
          <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
          <span>{summaryOf(items)}</span>
        </button>
        <button className="btn small" onClick={draft.clear}>
          모두 취소
        </button>
        <button
          className="btn small primary"
          onClick={() =>
            start(
              draft.database ?? database,
              items.map((d) => d.change),
              { onApplied: draft.removeApplied },
            )
          }
        >
          미리보기
        </button>
      </div>
    </div>
  );
}
