import { takeFocus, usePaintDrag as usePaintDragOverCells } from "../lib/usePaintDrag";
import { isEditable, isShown, type AssignmentTab, type Column } from "./assignments";
import type { IamOverview, PrincipalSummary } from "./types";
import type { useAssignmentDraft } from "./useAssignmentDraft";

export { takeFocus };

type Draft = Pick<ReturnType<typeof useAssignmentDraft>, "items" | "paint">;

interface Options {
  overview: IamOverview;
  tab: AssignmentTab;
  rows: PrincipalSummary[];
  columns: Column[];
  draft: Draft;
  /** 끌어서 칠하지 않은 누름(click)이 하는 일: 토글하거나, 그룹으로만 받은 칸이면 어디서 받는지 알려 준다 */
  press: (r: number, c: number, trigger: HTMLElement) => void;
  /** 칸을 누르는 순간 */
  onStart: () => void;
}

/**
 * 할당 표의 끌어서 칠하기. 상태 기계는 lib/usePaintDrag의 것이고, 여기서는 IAM이 정하는 것만 준다:
 * 행은 주체(ARN), 열은 정책이나 그룹(id)이고, 그룹으로만 받은 칸과 잠긴 행은 칠하지 않으며(isEditable),
 * 처음 칸이 지금 붙어 보이면 떼는 쪽으로, 아니면 붙이는 쪽으로 칠한다(isShown).
 */
export function usePaintDrag({ overview, tab, rows, columns, draft, press, onStart }: Options) {
  return usePaintDragOverCells<PrincipalSummary, Column>({
    rows,
    columns,
    rowId: (row) => row.arn,
    columnId: (column) => column.id,
    editable: (row, column) => isEditable(overview, tab, row, column.id),
    wanted: (row, column) => !isShown(draft.items, overview, tab, row, column.id),
    paint: (cells, want) =>
      draft.paint(
        tab,
        cells.map(({ row, column }) => ({ row, column: column.id })),
        want,
      ),
    press,
    onStart,
  });
}
