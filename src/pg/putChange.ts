import { draftItem } from "./draft";
import type { PgChange } from "./types";
import type { GridDraft } from "./useChangeMode";

/**
 * 폼이 만든 변경을 장바구니에 담는다. 같은 칸에 담긴 변경이 있으면 새 변경으로 바꾼다
 * (주기와 빼기는 같은 칸이라서 그냥 담으면 먼저 담은 것이 남는다). 담을 수 없는 변경이면 아무것도 하지 않는다.
 * 속성과 구성원은 장바구니가 스스로 자리에서 바꾸므로 그대로 넘긴다.
 */
export function putChange(draft: GridDraft, change: PgChange): void {
  const item = draftItem(change);
  if (!item) return;
  if (change.kind === "grant" || change.kind === "defaultPrivilege") {
    const queued = draft.items.find((d) => d.key === item.key);
    if (queued && JSON.stringify(queued.change) === JSON.stringify(change)) return;
    if (queued) draft.remove(item.key);
  }
  draft.paint([item]);
}
