import { useEffect, useRef, useState } from "react";

export interface DialogAction {
  label: string;
  value: string;
  primary?: boolean;
  danger?: boolean;
}

interface Props {
  title: string;
  message?: string;
  details?: string[];
  input?: { label: string; initial: string };
  error?: string | null;
  actions: DialogAction[];
  onResult: (value: string | null, text: string) => void;
}

const MAX_DETAILS = 10;

export function ConfirmDialog({ title, message, details, input, error, actions, onResult }: Props) {
  const [text, setText] = useState(input?.initial ?? "");
  const primary = actions.find((a) => a.primary) ?? actions.find((a) => !a.danger);
  const sheetRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const latest = useRef({ text, onResult });
  latest.current = { text, onResult };

  useEffect(() => {
    if (!input) cancelRef.current?.focus();
    const onDocKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") latest.current.onResult(null, latest.current.text);
    };
    document.addEventListener("keydown", onDocKey);
    return () => document.removeEventListener("keydown", onDocKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const nodes = Array.from(sheetRef.current?.querySelectorAll<HTMLElement>("input, button:not([disabled])") ?? []);
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !sheetRef.current?.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !sheetRef.current?.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="modal">
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} ref={sheetRef} onKeyDown={trapTab}>
        <h3>{title}</h3>
        {message && <p>{message}</p>}
        {details && details.length > 0 && (
          <ul className="details">
            {details.slice(0, MAX_DETAILS).map((d, i) => (
              <li key={i} className="mono">
                {d}
              </li>
            ))}
            {details.length > MAX_DETAILS && <li>외 {details.length - MAX_DETAILS}개</li>}
          </ul>
        )}
        {input && (
          <label className="field">
            <span>{input.label}</span>
            <input
              aria-label={input.label}
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && primary) onResult(primary.value, text);
              }}
            />
          </label>
        )}
        {error && <p className="err">{error}</p>}
        <div className="foot">
          <button ref={cancelRef} className="btn plain" onClick={() => onResult(null, text)}>
            취소
          </button>
          {actions.map((a) => (
            <button
              key={a.value}
              className={`btn ${a.primary ? "primary" : ""} ${a.danger ? "danger" : ""}`}
              onClick={() => onResult(a.value, text)}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
