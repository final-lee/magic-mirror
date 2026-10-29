import { draftKey } from "./draft";
import { putChange } from "./putChange";
import type { PgChange } from "./types";
import type { GridDraft } from "./useChangeMode";

interface Props {
  draft: GridDraft;
  /** 이 버튼이 담는 뺄 변경. 없으면 누를 수 없다(뺄 수 없는 권한) */
  change: PgChange | null;
  label: string;
  disabled?: boolean;
  title?: string;
}

/** 담아 둔 뺄 변경이 있으면 눌린 모양이고, 다시 누르면 거둔다. 아니면 누를 때 뺄 변경을 담는다(같은 칸의 다른 변경은 바뀐다) */
export function RevokeButton({ draft, change, label, disabled, title }: Props) {
  const key = change ? draftKey(change) : null;
  const queued = key === null ? undefined : draft.items.find((d) => d.key === key);
  const pressed = !!queued && "add" in queued.change && !queued.change.add;
  return (
    <button
      type="button"
      className={`link pg-revoke${pressed ? " on" : ""}`}
      aria-pressed={disabled ? undefined : pressed}
      disabled={disabled || !change}
      title={title}
      onClick={() => {
        if (!change || key === null) return;
        if (pressed) draft.remove(key);
        else putChange(draft, change);
      }}
    >
      {label}
    </button>
  );
}
