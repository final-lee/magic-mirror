import { useId, useMemo, useState } from "react";
import { fuzzyFilter } from "../lib/fuzzy";
import { type LabelOption, type LabelPick, parsePick, pickText } from "./argoFilter";
import { ARGO_LABEL_FILTER, ARGO_LABEL_PLACEHOLDER, ARGO_LABEL_SUGGESTIONS, argoLabelRemove } from "./text";

/** 한 번에 보여 줄 후보 수(preview 앱의 slug처럼 값이 많은 키도 있다) */
const MAX_SUGGESTIONS = 50;

interface Props {
  /** 데이터에 있는 `key`·`key=value` 후보와 개수 */
  options: LabelOption[];
  picks: LabelPick[];
  onAdd: (pick: LabelPick) => void;
  onRemove: (pick: LabelPick) => void;
}

const same = (a: LabelPick, b: LabelPick) => a.key === b.key && a.value === b.value;

/**
 * 레이블 거르기: `key=value`(또는 키만)를 입력하면 후보가 뜨고, Enter나 후보 클릭으로 칩을 더한다.
 * 같은 키의 칩은 OR, 키가 다르면 AND. 비어 있을 때는 키 후보만 보여 준다.
 */
export function ArgoLabelFilter({ options, picks, onAdd, onRemove }: Props) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();

  const q = text.trim().toLowerCase();
  const suggestions = useMemo(() => {
    const open = options.filter((o) => !picks.some((p) => same(p, o.pick)));
    // 입력이 없으면 키 후보만, 있으면 퍼지로 맞는 후보를 잘 맞는 순서로
    return (q === "" ? open.filter((o) => o.pick.value === null) : fuzzyFilter(open, q, (o) => [o.text])).slice(0, MAX_SUGGESTIONS);
  }, [options, picks, q]);

  const add = (pick: LabelPick | null) => {
    if (pick && !picks.some((p) => same(p, pick))) onAdd(pick);
    setText("");
    setActive(-1);
  };

  return (
    <div className="argo-labels" role="group" aria-label={ARGO_LABEL_FILTER}>
      {picks.map((p) => (
        <span key={pickText(p)} className="argo-lchip">
          {pickText(p)}
          <button aria-label={argoLabelRemove(pickText(p))} onClick={() => onRemove(p)}>
            ×
          </button>
        </span>
      ))}
      <div className="argo-labels-in">
        <input
          role="combobox"
          aria-label={ARGO_LABEL_FILTER}
          aria-expanded={open && suggestions.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          placeholder={ARGO_LABEL_PLACEHOLDER}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setActive(-1);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              // 고른 후보가 없으면 입력과 똑같은 후보, 그다음 첫 후보, 후보가 없을 때만 입력 그대로
              const exact = suggestions.find((o) => o.text.toLowerCase() === q);
              const pick = active >= 0 ? suggestions[active] : q === "" ? undefined : (exact ?? suggestions[0]);
              add(pick ? pick.pick : parsePick(text));
            } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setOpen(true);
              const n = suggestions.length;
              if (n > 0) setActive((a) => (e.key === "ArrowDown" ? (a + 1) % n : (a <= 0 ? n : a) - 1));
            } else if (e.key === "Escape" && open) {
              e.stopPropagation();
              setOpen(false);
              setActive(-1);
            }
          }}
        />
        {open && suggestions.length > 0 && (
          // 마우스를 눌러도 입력칸의 포커스(와 목록)가 사라지지 않게 한다
          <ul id={listId} className="argo-labels-pop" role="listbox" aria-label={ARGO_LABEL_SUGGESTIONS} onMouseDown={(e) => e.preventDefault()}>
            {suggestions.map((o, i) => (
              <li key={o.text} id={`${listId}-${i}`} role="option" aria-selected={i === active} className={i === active || (active < 0 && q !== "" && i === 0) ? "on" : undefined} onClick={() => add(o.pick)}>
                <span className="argo-ms-text">{o.text}</span>
                <span className="k8s-lvl-n">{o.count.toLocaleString("ko-KR")}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
