import { draftItem, targetKey, type PgDraftItem } from "./draft";
import type { PgChange } from "./types";
import type { GridDraft } from "./useChangeMode";

const without = (privileges: string[], taken: string[]) => privileges.filter((p) => !taken.includes(p));

/**
 * 새 변경과 같은 대상·권한을 건드리는 담긴 변경에서 겹치는 권한을 뺀 변경. 겹치는 것이 없으면 null(그대로 둔다).
 * 권한이 남지 않으면 변경 자체가 없어지므로 빈 목록이 아니라 undefined를 돌려준다.
 */
function trimmed(queued: PgChange, change: PgChange): PgChange | null | undefined {
  if (queued.kind === "grant" && change.kind === "grant") {
    if (queued.database !== change.database || queued.grantee !== change.grantee) return null;
    let touched = false;
    const items = queued.items.flatMap((item) => {
      const taken = change.items.filter((c) => targetKey(c.target) === targetKey(item.target)).flatMap((c) => c.privileges);
      const left = without(item.privileges, taken);
      if (left.length !== item.privileges.length) touched = true;
      return left.length > 0 ? [{ ...item, privileges: left }] : [];
    });
    if (!touched) return null;
    return items.length > 0 ? { ...queued, items } : undefined;
  }
  if (queued.kind === "defaultPrivilege" && change.kind === "defaultPrivilege") {
    const same = queued.database === change.database && queued.creator === change.creator && queued.schema === change.schema && queued.objectType === change.objectType && queued.grantee === change.grantee;
    if (!same) return null;
    const left = without(queued.privileges, change.privileges);
    if (left.length === queued.privileges.length) return null;
    return left.length > 0 ? { ...queued, privileges: left } : undefined;
  }
  return null;
}

/**
 * 폼이 만든 변경을 장바구니에 담는다. 권한을 주고 빼는 변경(grant, defaultPrivilege)은 같은 대상의 같은 권한을 담은 변경이 장바구니에 둘 있지 않도록,
 * 이미 담긴 변경에서 겹치는 권한을 걷어 낸다(주는 쪽이든 빼는 쪽이든. 권한이 남지 않으면 그 변경을 거둔다). 담을 수 없는 변경이면 아무것도 하지 않는다.
 * 속성과 구성원은 장바구니가 스스로 자리에서 바꾸므로 그대로 넘긴다.
 */
export function putChange(draft: GridDraft, change: PgChange): void {
  const item = draftItem(change);
  if (!item) return;
  if (change.kind === "grant" || change.kind === "defaultPrivilege") {
    if (draft.items.some((d) => d.key === item.key && JSON.stringify(d.change) === JSON.stringify(change))) return;
    const rest: PgDraftItem[] = [];
    for (const queued of draft.items) {
      const next = trimmed(queued.change, change);
      if (next === null) continue;
      draft.remove(queued.key);
      const again = next ? draftItem(next) : null;
      if (again) rest.push(again);
    }
    draft.paint([...rest, item]);
    return;
  }
  draft.paint([item]);
}
