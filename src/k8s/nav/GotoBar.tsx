import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { completions, opensNamespacePicker, parseGoto, pickingNamespace, type Completion, type Goto, type GotoContext } from "./goto";
import { loadHistory, pushHistory } from "./history";
import {
  GOTO_CLOSE, GOTO_COMPLETIONS_LABEL, GOTO_EMPTY, GOTO_HINT, GOTO_HISTORY_LABEL, GOTO_LABEL, GOTO_PLACEHOLDER, gotoNamespaceHint, gotoNamespaceLabel,
} from "./text";

/** 빈 줄에 보이는 최근 명령 수 */
const HISTORY_SHOWN = 8;

interface Props {
  ctx: GotoContext;
  /** 이동을 실행한다 */
  onGo: (goto: Goto) => void;
  /** 닫는다. went는 이동을 마치고 닫는 경우(커서를 새 화면 목록으로 옮긴다) */
  onClose: (went: boolean) => void;
}

/**
 * `:` 명령 줄(k9s). 종류 이름·별칭, 메뉴 이름, `ns <이름>`을 적으면 퍼지로 맞는 후보를 보이고,
 * ↑↓·Tab으로 후보를 고르고 Enter로 이동한다. 빈 줄에서는 최근 명령 목록을 같은 키로 고른다.
 * 네임스페이스 있는 종류의 목록을 보는 중이면 `ns`가 그 목록의 네임스페이스 고르기가 된다(종류 목록으로 가지 않는다).
 * ⌃P·⌃N은 치는 중에도 최근 명령을 하나씩 불러오고, Esc는 닫는다.
 */
export function GotoBar({ ctx, onGo, onClose }: Props) {
  const [typed, setTyped] = useState("");
  // ↑↓·Tab으로 고른 줄(없으면 null). 빈 줄이면 최근 명령, 아니면 후보 목록의 위치다.
  // 후보 목록은 직접 친 글자(typed)로 정하므로 골라도 목록이 바뀌지 않는다
  const [pick, setPick] = useState<number | null>(null);
  const [history] = useState(loadHistory);
  // ⌃P·⌃N으로 보고 있는 기록 위치(없으면 null)와 그때 치고 있던 글자
  const [at, setAt] = useState<number | null>(null);
  const draft = useRef("");
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => input.current?.focus(), []);

  const list = useMemo(() => completions(typed, ctx), [typed, ctx]);
  const recent = history.slice(0, HISTORY_SHOWN);
  const showHistory = typed.trim() === "" && recent.length > 0;
  const count = showHistory ? recent.length : list.length;
  const picked = pick === null ? null : showHistory ? recent[pick] ?? null : list[pick]?.text ?? null;
  const shown = picked ?? typed;
  const nsKind = pickingNamespace(typed, ctx) ? ctx.current?.kind ?? null : null;

  // 고른 줄이 목록 밖에 있으면 보이게 스크롤한다(네임스페이스 후보는 길다)
  useEffect(() => {
    bar.current?.querySelector(".k8s-goto-item.on")?.scrollIntoView?.({ block: "nearest" });
  }, [pick]);

  const run = (text: string, selected?: Goto) => {
    if (!selected && opensNamespacePicker(text, ctx)) {
      // 이동하지 않고 네임스페이스 고르기로: 입력을 `ns `로 채워 후보를 그대로 보인다
      edit(`${text.trim().replace(/^:/, "").trim()} `);
      return;
    }
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

  // 보이는 목록(최근 명령 또는 후보)에서 고른 줄을 옮긴다. 양 끝에서는 반대쪽 끝으로 돈다
  const move = (step: 1 | -1) => {
    if (count === 0) return;
    setPick((p) => (p === null ? (step === 1 ? 0 : count - 1) : (p + step + count) % count));
    setAt(null);
    setError(null);
  };

  // ⌃P는 더 오래된 명령, ⌃N은 더 최근 명령. 가장 최근에서 ⌃N이면 치던 글자로 돌아온다
  const recall = (older: boolean) => {
    if (history.length === 0 || (!older && at === null)) return;
    const next = older ? (at === null ? 0 : Math.min(at + 1, history.length - 1)) : at === null ? null : at - 1;
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
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const plain = !e.metaKey && !e.altKey && !e.ctrlKey;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose(false);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (showHistory) run(shown);
      else run(shown, pick === null ? undefined : list[pick]?.goto);
    } else if (e.key === "Tab" || ((e.key === "ArrowDown" || e.key === "ArrowUp") && plain)) {
      e.preventDefault();
      move(e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey) ? -1 : 1);
    } else if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "p" || e.key === "n")) {
      e.preventDefault();
      recall(e.key === "p");
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
        <span className="k8s-goto-hint dim">{nsKind ? gotoNamespaceHint(nsKind.kind) : GOTO_HINT}</span>
        <button className="icon" aria-label={GOTO_CLOSE} title={GOTO_CLOSE} onMouseDown={(e) => e.preventDefault()} onClick={() => onClose(false)}>
          ✕
        </button>
      </div>
      {error && <p className="err k8s-goto-error" role="alert">{error}</p>}
      {showHistory ? (
        <ul className="k8s-goto-list" role="listbox" aria-label={GOTO_HISTORY_LABEL}>
          {recent.map((h, i) => (
            <li
              key={h}
              role="option"
              aria-selected={pick === i}
              className={`k8s-goto-item${pick === i ? " on" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run(h)}
            >
              <span className="mono">{h}</span>
              <span className="dim">{GOTO_HISTORY_LABEL}</span>
            </li>
          ))}
        </ul>
      ) : list.length > 0 ? (
        <ul className="k8s-goto-list" role="listbox" aria-label={nsKind ? gotoNamespaceLabel(nsKind.kind) : GOTO_COMPLETIONS_LABEL}>
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
