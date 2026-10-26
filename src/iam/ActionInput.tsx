import { useEffect, useId, useMemo, useState } from "react";

export const MAX_SUGGESTIONS = 50;

/**
 * 입력한 글자가 들어 있는 작업을 찾는다(대소문자 무시). "s3:Get"처럼 앞부분이 맞는 작업이 먼저 나오고,
 * "getobj"처럼 중간만 맞는 작업이 그 뒤에 나온다. 각 묶음 안에서는 카탈로그 순서를 지킨다.
 */
export function matchActions(options: string[], query: string, limit = MAX_SUGGESTIONS): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const starts: string[] = [];
  const contains: string[] = [];
  for (const option of options) {
    const at = option.toLowerCase().indexOf(q);
    if (at === 0) starts.push(option);
    else if (at > 0 && contains.length < limit) contains.push(option);
    if (starts.length >= limit) break; // 앞부분이 맞는 작업만으로 가득 찼으면 더 볼 필요가 없다
  }
  return [...starts, ...contains].slice(0, limit);
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** 제안을 고르는 중이 아닐 때 Enter를 누르면 부른다(입력을 확정한다) */
  onSubmit: () => void;
  options: string[];
  label: string;
  placeholder?: string;
}

/**
 * 작업 이름 입력창과 자동 완성 목록. ↑/↓로 제안을 옮기고 Enter로 고르며, 고른 뒤 Enter를 한 번 더 누르면 onSubmit이다.
 * 제안은 최대 50개이고, 목록은 입력할 때만 열린다(초점만 옮겨서는 열리지 않는다).
 */
export function ActionInput({ value, onChange, onSubmit, options, label, placeholder }: Props) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const suggestions = useMemo(() => matchActions(options, value), [options, value]);
  const shown = open && suggestions.length > 0;
  const optionId = (i: number) => `${listId}-${i}`;

  // 키보드로 옮긴 제안이 목록 밖으로 나가지 않게 한다
  useEffect(() => {
    if (active >= 0) document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, listId]);

  const choose = (action: string) => {
    onChange(action);
    setOpen(false);
    setActive(-1);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (suggestions.length === 0) return;
      e.preventDefault();
      if (!shown) {
        setOpen(true);
        setActive(e.key === "ArrowDown" ? 0 : suggestions.length - 1);
      } else {
        setActive((a) => (e.key === "ArrowDown" ? Math.min(suggestions.length - 1, a + 1) : Math.max(0, a - 1)));
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown && active >= 0) choose(suggestions[active]);
      else {
        setOpen(false);
        onSubmit();
      }
    } else if (e.key === "Escape" && shown) {
      e.preventDefault();
      setOpen(false);
      setActive(-1);
    }
  };

  return (
    <div className="ac">
      <input
        type="text"
        className="iam-filter ac-input"
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={shown ? listId : undefined}
        aria-activedescendant={shown && active >= 0 ? optionId(active) : undefined}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
      />
      {shown && (
        <ul className="ac-list" id={listId} role="listbox" aria-label={`${label} 제안`}>
          {suggestions.map((action, i) => (
            // 마우스를 눌러도 입력창이 초점을 잃지 않도록 mousedown은 막고, 고르는 일은 click에서 한다
            <li
              key={action}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              className={`ac-opt mono${i === active ? " on" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(action)}
            >
              {action}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
