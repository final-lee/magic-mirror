import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Highlight } from "../components/Highlight";
import { useModal } from "../iam/useModal";
import { fuzzyRank, tokenize } from "../lib/fuzzy";
import { COMMANDS, KEYBINDINGS } from "./keybindings";
import { keyLabel } from "./keys";
import { canRun } from "./registry";

export const COMMAND_PALETTE_TITLE = "명령 팔레트";

/** 명령에 묶인 키(디스패처가 처리하는 것만) */
export function commandKeys(command: string): string[] {
  return KEYBINDINGS.filter((b) => b.command === command && b.handler === "registry").map((b) => keyLabel(b.key));
}

/**
 * ⇧⌘P: 지금 실행할 수 있는 명령을 이름으로 찾아 실행한다(VS Code의 명령 팔레트). 오른쪽에 단축키를 보인다.
 * onRun은 팔레트를 닫은 뒤 명령을 실행한다(명령이 연 화면이 팔레트 뒤에 가리지 않게).
 */
export function CommandPalette({ onRun, onClose }: { onRun: (command: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const { sheetRef, trapTab } = useModal(onClose);
  useEffect(() => inputRef.current?.focus(), []);

  // 열 때 한 번: 이 화면에서 처리할 곳이 있는 명령만
  const available = useMemo(
    () => Object.entries(COMMANDS).filter(([id]) => id !== "app.commandPalette" && canRun(id)).map(([id, info]) => ({ id, title: info.title })),
    [],
  );
  const tokens = tokenize(query);
  const shown = tokens.length === 0 ? available : fuzzyRank(available, query, (c) => [c.title, c.id]).map((r) => r.item);
  const active = shown[Math.min(activeIndex, shown.length - 1)];

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, Math.min(shown.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active) onRun(active.id);
    }
  };

  return (
    <div className="modal">
      <div className="sheet wide pk palette" role="dialog" aria-modal="true" aria-label={COMMAND_PALETTE_TITLE} ref={sheetRef} onKeyDown={trapTab}>
        <input
          ref={inputRef}
          type="search"
          className="iam-filter pk-search"
          aria-label={COMMAND_PALETTE_TITLE}
          aria-controls={listId}
          placeholder="명령 이름으로 찾기"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onKeyDown}
        />
        {shown.length === 0 ? (
          <div className="empty small">맞는 명령이 없어요</div>
        ) : (
          <ul className="pk-list" id={listId} role="listbox" aria-label={`${COMMAND_PALETTE_TITLE} 결과`}>
            {shown.map((c, i) => (
              <li
                key={c.id}
                role="option"
                aria-selected={c === active}
                className={`pk-opt${c === active ? " on" : ""}`}
                onMouseDown={(ev) => ev.preventDefault()}
                onMouseMove={() => setActiveIndex(i)}
                onClick={() => onRun(c.id)}
              >
                <div className="pk-top">
                  <span className="pk-name">
                    <Highlight text={c.title} tokens={tokens} />
                  </span>
                  <span className="cmd-keys">
                    {commandKeys(c.id).map((k) => <kbd key={k}>{k}</kbd>)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
