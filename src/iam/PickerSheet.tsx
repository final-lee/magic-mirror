import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useModal } from "./useModal";

export interface PickerOption {
  id: string;
  name: string;
  /** 이름 옆에 붙는 표시(범위, 배지) */
  meta?: ReactNode;
  /** 이름 아래 설명 */
  detail?: string | null;
  /** 있으면 고를 수 없다. 이유를 옆에 보여 준다 */
  disabledReason?: string;
}

interface Props {
  title: string;
  intro?: string;
  searchLabel: string;
  placeholder?: string;
  query: string;
  onQuery: (query: string) => void;
  options: PickerOption[];
  onPick: (id: string) => void;
  onClose: () => void;
  /** 목록 위에 보여 줄 상태(불러오는 중, 오류). 있으면 "없어요" 안내는 보이지 않는다 */
  status?: ReactNode;
  empty: string;
  footnote?: string;
}

/**
 * 정책·그룹·사용자 선택 창의 공통 틀: 검색 상자 + 고를 수 있는 목록 + 취소.
 * ↑/↓로 고를 수 있는 항목 사이를 옮기고 Enter로 고른다(고르는 것은 미리보기를 여는 일일 뿐 적용이 아니다).
 * Esc는 창을 닫고, Tab은 창 안에서만 돈다.
 */
export function PickerSheet({ title, intro, searchLabel, placeholder, query, onQuery, options, onPick, onClose, status, empty, footnote }: Props) {
  const listId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  // 순서가 아니라 id로 기억한다: 검색 결과가 바뀌어도 엉뚱한 항목이 강조되지 않는다
  const [activeId, setActiveId] = useState<string | null>(null);
  const { sheetRef, trapTab } = useModal(onClose);
  useEffect(() => searchRef.current?.focus(), []);

  const optionDomId = (i: number) => `${listId}-${i}`;
  const activeIndex = options.findIndex((o) => o.id === activeId);

  useEffect(() => {
    if (activeIndex >= 0) document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, listId]);

  const move = (dir: 1 | -1) => {
    let i = activeIndex;
    do i += dir;
    while (i >= 0 && i < options.length && options[i].disabledReason);
    if (i >= 0 && i < options.length) setActiveId(options[i].id); // 끝에서는 멈춘다
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = options[activeIndex];
      if (o && !o.disabledReason) onPick(o.id);
    }
  };

  return (
    <div className="modal">
      <div className="sheet wide pk" role="dialog" aria-modal="true" aria-label={title} ref={sheetRef} onKeyDown={trapTab}>
        <h3>{title}</h3>
        {intro && <p>{intro}</p>}
        <input
          ref={searchRef}
          type="search"
          className="iam-filter pk-search"
          aria-label={searchLabel}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            onQuery(e.target.value);
            setActiveId(null);
          }}
          onKeyDown={onKeyDown}
        />
        {status}
        {options.length === 0 ? (
          !status && <div className="empty small">{empty}</div>
        ) : (
          <ul className="pk-list" id={listId} role="listbox" aria-label={`${title} 목록`}>
            {options.map((o, i) => (
              // 마우스를 눌러도 검색 상자가 초점을 잃지 않게 mousedown은 막고, 고르는 일은 click에서 한다
              <li
                key={o.id}
                id={optionDomId(i)}
                role="option"
                aria-selected={o.id === activeId}
                aria-disabled={o.disabledReason ? true : undefined}
                className={`pk-opt${o.id === activeId ? " on" : ""}${o.disabledReason ? " off" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (!o.disabledReason) onPick(o.id);
                }}
              >
                <div className="pk-top">
                  <span className="pk-name">{o.name}</span>
                  {o.meta}
                  {o.disabledReason && <span className="pk-off">{o.disabledReason}</span>}
                </div>
                {o.detail && <div className="pk-detail dim">{o.detail}</div>}
              </li>
            ))}
          </ul>
        )}
        {footnote && <p className="pk-note">{footnote}</p>}
        <div className="foot">
          <button className="btn plain" onClick={onClose}>
            취소
          </button>
        </div>
      </div>
    </div>
  );
}
