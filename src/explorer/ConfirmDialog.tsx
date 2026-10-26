import { useState } from "react";

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
  const primary = actions.find((a) => a.primary) ?? actions[0];
  return (
    <div className="modal">
      <div
        className="sheet"
        role="dialog"
        aria-label={title}
        onKeyDown={(e) => {
          if (e.key === "Escape") onResult(null, text);
        }}
      >
        <h3>{title}</h3>
        {message && <p>{message}</p>}
        {details && details.length > 0 && (
          <ul className="details">
            {details.slice(0, MAX_DETAILS).map((d) => (
              <li key={d} className="mono">
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
          <button className="btn plain" onClick={() => onResult(null, text)}>
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
