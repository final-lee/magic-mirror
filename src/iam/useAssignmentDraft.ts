// 할당 표의 장바구니: 칸을 눌러 담은 변경을 들고 있다가, 개요를 다시 불러오면 이미 끝난 변경을 빼고 알린다.
import { useCallback, useRef, useState } from "react";
import {
  MAX_DRAFT,
  matchChanges,
  normalizeDraft,
  paintCells,
  removeApplied as dropApplied,
  toggleCell,
  type AssignmentTab,
  type DraftItem,
} from "./assignments";
import type { IamChange, IamOverview, PrincipalSummary } from "./types";

const FULL_NOTICE = `한 번에 ${MAX_DRAFT}개까지 담을 수 있어요`;

/** 장바구니 한 벌. 프로필 하나의 것이라서 어느 프로필인지 함께 들고, 마지막으로 정리한 개요도 같이 둔다 */
interface Tray {
  profile: string;
  /** 이 장바구니를 마지막으로 정리한 개요. 다른 개요가 오면 다시 정리한다 */
  ov: IamOverview | undefined;
  items: DraftItem[];
  notices: string[];
}

const emptyTray = (profile: string, ov: IamOverview | undefined): Tray => ({ profile, ov, items: [], notices: [] });

/**
 * 지금의 프로필과 개요에 맞춘 장바구니. 렌더마다 부르고, 바뀐 것이 없으면 받은 것을 그대로 돌려준다.
 * - 다른 프로필의 것이면 비운다.
 * - 새 개요가 왔으면 이미 끝난 변경과 대상이 없어진 변경을 빼고 알린다. 개요가 아직 없으면(불러오는 중) 건드리지 않는다.
 */
function settle(tray: Tray, profile: string, ov: IamOverview | undefined): Tray {
  if (tray.profile !== profile) return emptyTray(profile, ov);
  if (!ov || ov === tray.ov) return tray;
  const { draft, notices } = normalizeDraft(ov, tray.items);
  return { ...tray, ov, items: draft, notices: notices.length > 0 ? [...tray.notices, ...notices] : tray.notices };
}

type Step = (ov: IamOverview, items: DraftItem[]) => { draft: DraftItem[]; full: boolean };

/**
 * 장바구니 상태. IAM 탭이 들고 있어서 IAM 안의 다른 화면을 보고 돌아와도 남는다.
 * ov는 불러오는 중에는 undefined일 수 있고, 그동안은 담지도 정리하지도 않는다.
 * 같은 개요는 같은 객체여야 한다(react-query의 data처럼). 값이 같아도 새 객체는 새 개요로 센다: 장바구니를 다시 정리하느라 한 번 더 그린다.
 * 부모가 렌더마다 값이 같은 새 객체를 넘기면 부모가 그릴 때마다 그 한 번이 들 뿐이다. 하지만 이 훅을 부르는 컴포넌트 안에서 개요를 만들어 넘기면
 * 두 번째 렌더부터는 정리하느라 다시 그릴 때마다 또 새 개요라서 렌더가 끝나지 않는다. IamTab은 overview.data를 그대로 넘긴다.
 */
export function useAssignmentDraft(profile: string, ov: IamOverview | undefined) {
  const [stored, setStored] = useState<Tray>(() => emptyTray(profile, ov));
  // 한 이벤트에서 여러 번 불러도 앞 호출의 결과 위에 쌓이도록, 상태와 같은 값을 ref에도 바로 반영한다.
  const trayRef = useRef(stored);
  const ovRef = useRef(ov);
  ovRef.current = ov;

  // 프로필과 개요에 맞추는 일은 effect가 아니라 렌더 중에 한다. effect로 하면 자식이 한 번은 낡은 장바구니를 그린다.
  // 특히 IamTab은 프로필이 바뀌어도 다시 만들어지지 않으므로, effect에서는 옛 프로필의 항목이
  // 새 프로필의 개요로 정리되며 "찾을 수 없어서 뺐어요"가 뜬다.
  const tray = settle(stored, profile, ov);
  if (tray !== stored) {
    trayRef.current = tray;
    setStored(tray);
  }

  const commit = useCallback((next: Tray) => {
    trayRef.current = next;
    setStored(next);
  }, []);

  /** 순수 함수 하나를 지금 장바구니에 적용한다. 꽉 차서 못 담은 것이 있으면 이미 떠 있는 같은 안내가 없을 때만 알린다 */
  const run = useCallback(
    (step: Step) => {
      const cur = trayRef.current;
      const current = ovRef.current;
      if (!current) return;
      const { draft, full } = step(current, cur.items);
      const notices = full && !cur.notices.includes(FULL_NOTICE) ? [...cur.notices, FULL_NOTICE] : cur.notices;
      if (draft !== cur.items || notices !== cur.notices) commit({ ...cur, items: draft, notices });
    },
    [commit],
  );

  const toggle = useCallback(
    (tab: AssignmentTab, row: PrincipalSummary, column: string) => run((o, items) => toggleCell(items, o, tab, row, column)),
    [run],
  );

  const paint = useCallback(
    (tab: AssignmentTab, cells: { row: PrincipalSummary; column: string }[], want: boolean) => run((o, items) => paintCells(items, o, tab, cells, want)),
    [run],
  );

  const match = useCallback(
    (tab: AssignmentTab, target: PrincipalSummary, add: string[], remove: string[]) => run((o, items) => matchChanges(items, o, tab, target, add, remove)),
    [run],
  );

  const remove = useCallback(
    (key: string) => {
      const cur = trayRef.current;
      if (cur.items.some((d) => d.key === key)) commit({ ...cur, items: cur.items.filter((d) => d.key !== key) });
    },
    [commit],
  );

  const clear = useCallback(() => {
    const cur = trayRef.current;
    if (cur.items.length > 0) commit({ ...cur, items: [] });
  }, [commit]);

  /** 적용을 마친 변경을 장바구니에서 뺀다 */
  const removeApplied = useCallback(
    (applied: IamChange[]) => {
      const cur = trayRef.current;
      const items = dropApplied(cur.items, applied);
      if (items.length !== cur.items.length) commit({ ...cur, items });
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

  return { items: tray.items, notices: tray.notices, toggle, paint, match, remove, clear, removeApplied, dismissNotice };
}
