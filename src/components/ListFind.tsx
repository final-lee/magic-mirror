import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { keyLabel } from "../keymap/keys";
import { useCommand } from "../keymap/registry";

/** 목록 안 찾기(⌘F)의 상태. 목록마다 하나씩 갖는다 */
export interface ListFindState {
  open: boolean;
  query: string;
  setQuery: (q: string) => void;
  /** 줄을 열고 커서를 둔다. 이미 열려 있으면 글자를 모두 고른다 */
  openFind: () => void;
  /** 검색어를 지우고 줄을 닫고, 커서를 목록으로 돌린다 */
  close: () => void;
  inputRef: RefObject<HTMLInputElement>;
  host: RefObject<HTMLElement>;
}

/** 목록 상자 안에서 커서를 받을 첫 곳(표의 tabIndex=0 상자 등) */
function focusList(host: HTMLElement | null) {
  const candidates = Array.from(host?.querySelectorAll<HTMLElement>('[tabindex="0"]') ?? []);
  candidates.find((el) => !el.closest(".list-find"))?.focus();
}

/**
 * ⌘F를 이 목록에 연결한다. host는 목록을 감싼 상자(보이는 탭 안의, 포커스·마지막으로 누른 목록이 ⌘F를 받는다).
 * enabled가 false면(목록이 아직 없음 등) 이 목록은 ⌘F를 받지 않는다.
 */
export function useListFind(host: RefObject<HTMLElement>, options: { enabled?: boolean } = {}): ListFindState {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const wantFocus = useRef(false);
  const openFind = useCallback(() => {
    wantFocus.current = true;
    setOpen(true);
    // 이미 열려 있으면 다시 그리지 않으므로 여기서 바로 고른다
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const close = useCallback(() => {
    setQuery("");
    setOpen(false);
    focusList(host.current);
  }, [host]);
  useEffect(() => {
    if (open && wantFocus.current) {
      wantFocus.current = false;
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [open]);
  useCommand("list.find", openFind, { host, enabled: options.enabled ?? true });
  return { open, query, setQuery, openFind, close, inputRef, host };
}

/** 목록 안쪽 위에 붙는 찾기 줄. 열려 있을 때만 보인다 */
export function ListFind({ find, placeholder = "이 목록에서 찾기", count }: {
  find: ListFindState;
  placeholder?: string;
  /** 맞는 항목 수. 주면 줄 오른쪽에 보인다 */
  count?: number;
}) {
  if (!find.open) return null;
  return (
    <div className="list-find" role="search">
      <span className="list-find-icon" aria-hidden="true">⌕</span>
      <input
        ref={find.inputRef}
        aria-label="목록에서 찾기"
        placeholder={placeholder}
        title="글자 일부만 순서대로 쳐도 찾아요(poa → prod-orders-api). 공백으로 나누면 모두 맞는 것만 보여요"
        value={find.query}
        onChange={(e) => find.setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            find.close();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            focusList(find.host.current);
          }
        }}
      />
      {count !== undefined && find.query && <span className="list-find-count dim">{`${count}개`}</span>}
      <button className="icon" aria-label="찾기 닫기" title={`찾기 닫기 (${keyLabel("escape")})`} onClick={find.close}>
        ✕
      </button>
    </div>
  );
}
