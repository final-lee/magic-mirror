// PostgreSQL 탭의 장바구니: 칸을 눌러 담은 변경을 들고 있다가 [미리보기]로 한 묶음(한 트랜잭션)으로 넘긴다.
import { useCallback, useRef, useState } from "react";
import {
  FULL_NOTICE,
  OTHER_DATABASE_NOTICE,
  OVERLAP_NOTICE,
  defaultsAddedNotice,
  draftDatabase,
  draftItem,
  putChangeItem,
  putItems,
  removeApplied as dropApplied,
  toggleItem,
  type DraftStep,
  type PgDraftItem,
} from "./draft";
import { targetKey } from "./targets";
import type { PgChange, PgOverview, PgRoleSummary, PgTarget } from "./types";

export type { PgDraftItem } from "./draft";

/** 장바구니 한 벌. 대상 하나의 것이라서 어느 대상인지 함께 든다 */
interface Tray {
  target: string;
  items: PgDraftItem[];
  notices: string[];
}

const emptyTray = (target: string): Tray => ({ target, items: [], notices: [] });

/** 같은 안내가 이미 떠 있지 않을 때만 더한다: 못 담은 칸이 여럿이어도, 되풀이해도 안내는 하나다 */
const notify = (notices: string[], text: string) => (notices.includes(text) ? notices : [...notices, text]);

/** 한 번의 조작이 남기는 안내. 담은 것을 먼저, 못 담은 까닭을 그다음에 알린다 */
function noticesAfter(current: string[], step: DraftStep, announceAdded: boolean): string[] {
  let notices = current;
  if (announceAdded && step.added > 0) notices = [...notices, defaultsAddedNotice(step.added)];
  if (step.overlap) notices = notify(notices, OVERLAP_NOTICE);
  if (step.elsewhere) notices = notify(notices, OTHER_DATABASE_NOTICE);
  if (step.full) notices = notify(notices, FULL_NOTICE);
  return notices;
}

type Step = (roles: PgRoleSummary[], items: PgDraftItem[]) => DraftStep;

/**
 * 장바구니 상태. PostgreSQL 탭(PgTab)이 들고 있어서 탭 안의 다른 화면을 보고 돌아와도 남고, 탭을 닫으면 사라진다.
 * - 대상마다 따로다. 다른 대상이 오면 비운다(렌더 중에: 효과로 하면 자식이 한 번은 이전 대상의 장바구니를 그린다).
 * - 규칙은 draft.ts에 있다: 같은 키는 한 줄, 속성은 역할마다 하나, 데이터베이스 하나, 50개까지. 담지 못한 것이 있으면 한 번씩 알린다.
 * - 개요(ov)는 속성이 역할의 지금 속성과 같은지 볼 때만 쓴다. 개요가 아직 없으면(연결하는 중) 아무것도 담지 않는다.
 *   개요를 다시 읽어도 장바구니를 손보지는 않는다: 이미 그 상태가 된 변경은 미리보기가 "이미 그 상태라 달라지는 게 없어요"로 알린다.
 */
export function usePgDraft(target: PgTarget, ov: PgOverview | undefined) {
  const key = targetKey(target);
  const [stored, setStored] = useState<Tray>(() => emptyTray(key));
  // 한 이벤트에서 여러 번 불러도 앞 호출의 결과 위에 쌓이도록, 상태와 같은 값을 ref에도 바로 반영한다.
  const trayRef = useRef(stored);
  const rolesRef = useRef(ov?.roles);
  rolesRef.current = ov?.roles;

  const tray = stored.target === key ? stored : emptyTray(key);
  if (tray !== stored) {
    trayRef.current = tray;
    setStored(tray);
  }

  const commit = useCallback((next: Tray) => {
    trayRef.current = next;
    setStored(next);
  }, []);

  /** 순수 조작 하나를 지금 장바구니에 적용한다 */
  const run = useCallback(
    (step: Step, announceAdded = false) => {
      const cur = trayRef.current;
      const roles = rolesRef.current;
      if (!roles) return;
      const result = step(roles, cur.items);
      const notices = noticesAfter(cur.notices, result, announceAdded);
      if (result.items !== cur.items || notices !== cur.notices) commit({ ...cur, items: result.items, notices });
    },
    [commit],
  );

  const toggle = useCallback((item: PgDraftItem) => run((roles, items) => toggleItem(items, item, roles)), [run]);

  const paint = useCallback((incoming: PgDraftItem[]) => run((roles, items) => putItems(items, incoming, roles)), [run]);

  /** 폼이 만든 변경 하나를 담는다. 같은 칸에 담긴 변경은 겹치는 권한을 걷어 내고 바뀐다(draft.ts putChangeItem) */
  const put = useCallback((change: PgChange) => run((roles, items) => putChangeItem(items, change, roles)), [run]);

  /** 경고가 담아 둔 변경(기본 권한도 담기)을 담는다. 장바구니에 담지 않는 변경은 건너뛰고, 몇 개를 담았는지 알린다 */
  const add = useCallback(
    (changes: PgChange[]) =>
      run(
        (roles, items) =>
          putItems(
            items,
            changes.flatMap((change) => draftItem(change) ?? []),
            roles,
          ),
        true,
      ),
    [run],
  );

  const remove = useCallback(
    (itemKey: string) => {
      const cur = trayRef.current;
      if (cur.items.some((d) => d.key === itemKey)) commit({ ...cur, items: cur.items.filter((d) => d.key !== itemKey) });
    },
    [commit],
  );

  const clear = useCallback(() => {
    const cur = trayRef.current;
    if (cur.items.length > 0) commit({ ...cur, items: [] });
  }, [commit]);

  /** 적용을 마친 변경을 장바구니에서 뺀다 */
  const removeApplied = useCallback(
    (applied: PgChange[]) => {
      const cur = trayRef.current;
      const items = dropApplied(cur.items, applied);
      if (items !== cur.items) commit({ ...cur, items });
    },
    [commit],
  );

  const dismissNotice = useCallback(
    (index: number) => {
      const cur = trayRef.current;
      if (index >= 0 && index < cur.notices.length) commit({ ...cur, notices: cur.notices.filter((_, i) => i !== index) });
    },
    [commit],
  );

  return { items: tray.items, notices: tray.notices, database: draftDatabase(tray.items), toggle, paint, put, add, remove, clear, removeApplied, dismissNotice };
}

export type PgDraft = ReturnType<typeof usePgDraft>;
