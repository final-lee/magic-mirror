import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { completions, parseGoto, type Completion, type Goto, type GotoContext } from "./goto";
import { loadHistory, pushHistory } from "./history";
import {
  GOTO_CLOSE, GOTO_COMPLETIONS_LABEL, GOTO_EMPTY, GOTO_HINT, GOTO_HISTORY_LABEL, GOTO_LABEL, GOTO_PLACEHOLDER,
} from "./text";

interface Props {
  ctx: GotoContext;
  /** 이동을 실행한다 */
  onGo: (goto: Goto) => void;
  /** 닫는다. went는 이동을 마치고 닫는 경우(커서를 새 화면 목록으로 옮긴다) */
  onClose: (went: boolean) => void;
}

/**
 * `:` 명령 줄(k9s). 종류 이름·별칭, 메뉴 이름, `ns <이름>`을 적으면 퍼지로 맞는 후보를 보이고,
 * Tab으로 후보를 채우고 Enter로 이동한다. ↑↓는 최근 명령, Esc는 닫기.
 */
export function GotoBar({ ctx, onGo, onClose }: Props) {
  const [typed, setTyped] = useState("");
  // Tab으로 고른 후보(없으면 null). 후보 목록은 직접 친 글자(typed)로 정하므로 Tab을 눌러도 목록이 바뀌지 않는다
  const [pick, setPick] = useState<number | null>(null);
  const [history] = useState(loadHistory);
  // ↑↓로 보고 있는 기록 위치(없으면 null)와 그때 치고 있던 글자
  const [at, setAt] = useState<number | null>(null);
  const draft = useRef("");
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => input.current?.focus(), []);

  const list = useMemo(() => completions(typed, ctx), [typed, ctx]);
  const shown = pick !== null && list[pick] ? list[pick].text : typed;
  const showHistory = typed.trim() === "" && history.length > 0;

  const run = (text: string, selected?: Goto) => {
    const parsed = selected ? { ok: true as const, goto: selected } : parseGoto(text, ctx);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    pushHistory(selected?.type === "kind" && selected.kind.group ? `${selected.kind.plural}.${selected.kind.group}` : text);
    onGo(parsed.goto);
    onClose(true);
  };

  const edit = (text: string) => {
    setTyped(text);
    setPick(null);
    setAt(null);
    setError(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose(false);
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(shown, pick === null ? undefined : list[pick]?.goto);
    } else if (e.key === "Tab") {
      e.preventDefault();
      if (list.length === 0) return;
      const step = e.shiftKey ? -1 : 1;
      setPick((p) => (p === null ? (step === 1 ? 0 : list.length - 1) : (p + step + list.length) % list.length));
      setError(null);
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      if (history.length === 0 || (e.key === "ArrowDown" && at === null)) return;
      const next = e.key === "ArrowUp" ? (at === null ? 0 : Math.min(at + 1, history.length - 1)) : at === null ? null : at - 1;
      if (at === null) draft.current = shown;
      if (next === null || next < 0) {
        setTyped(draft.current);
        setAt(null);
      } else {
        setTyped(history[next]);
        setAt(next);
      }
      setPick(null);
      setError(null);
    }
  };

  const choose = (c: Completion) => run(c.text, c.goto);

  return (
    <div
      className="k8s-goto"
      ref={bar}
      onBlur={(e) => {
        // 바깥을 누르거나 다른 곳으로 커서가 가면 닫는다
        if (!bar.current?.contains(e.relatedTarget as Node | null)) onClose(false);
      }}
    >
      <div className="k8s-goto-line">
        <span className="k8s-goto-prompt" aria-hidden="true">:</span>
        <input
          ref={input}
          className="k8s-goto-input mono"
          aria-label={GOTO_LABEL}
          aria-autocomplete="list"
          aria-expanded={list.length > 0}
          placeholder={GOTO_PLACEHOLDER}
          autoComplete="off"
          spellCheck={false}
          value={shown}
          onChange={(e) => edit(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <span className="k8s-goto-hint dim">{GOTO_HINT}</span>
        <button className="icon" aria-label={GOTO_CLOSE} title={GOTO_CLOSE} onMouseDown={(e) => e.preventDefault()} onClick={() => onClose(false)}>
          ✕
        </button>
      </div>
      {error && <p className="err k8s-goto-error" role="alert">{error}</p>}
      {showHistory ? (
        <ul className="k8s-goto-list" aria-label={GOTO_HISTORY_LABEL}>
          {history.slice(0, 8).map((h) => (
            <li key={h} className="k8s-goto-item" onMouseDown={(e) => e.preventDefault()} onClick={() => run(h)}>
              <span className="mono">{h}</span>
              <span className="dim">{GOTO_HISTORY_LABEL}</span>
            </li>
          ))}
        </ul>
      ) : list.length > 0 ? (
        <ul className="k8s-goto-list" role="listbox" aria-label={GOTO_COMPLETIONS_LABEL}>
          {list.map((c, i) => (
            <li
              key={`${c.group}/${c.text}/${c.goto?.type === "kind" ? c.goto.kind.group : ""}`}
              role="option"
              aria-selected={pick === i}
              className={`k8s-goto-item${pick === i ? " on" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(c)}
            >
              <span className="mono">{c.title}</span>
              <span className="dim">{c.hint}</span>
              <span className="k8s-chip dim">{c.group}</span>
            </li>
          ))}
        </ul>
      ) : (
        typed.trim() !== "" && <p className="dim k8s-goto-error">{GOTO_EMPTY}</p>
      )}
    </div>
  );
}
