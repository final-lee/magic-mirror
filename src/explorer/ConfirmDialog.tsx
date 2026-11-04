import { useEffect, useRef, useState } from "react";
import { useModal } from "../iam/useModal";

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
  const cancelRef = useRef<HTMLButtonElement>(null);
  const latest = useRef({ text, onResult });
  latest.current = { text, onResult };
  // Esc는 겹친 창 중 맨 위 하나만 닫고(취소), Tab은 창 안을 돈다
  const { sheetRef, trapTab } = useModal(() => latest.current.onResult(null, latest.current.text));

  useEffect(() => {
    if (!input) cancelRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
