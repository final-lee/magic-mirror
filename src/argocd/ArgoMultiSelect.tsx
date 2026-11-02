import { useEffect, useRef, useState } from "react";
import { ARGO_PICK_CLEAR, argoPickButton } from "./text";

export interface PickOption {
  value: string;
  text: string;
  /** 다른 조건에 맞는 앱 수 */
  count: number;
}

interface Props {
  label: string;
  options: PickOption[];
  picked: Set<string>;
  onToggle: (value: string) => void;
  onClear: () => void;
}

/** 여러 개를 고르는 작은 목록. 단추("클러스터: 전체"/"클러스터: 2개")를 누르면 체크 목록이 뜬다. 바깥을 누르거나 Escape로 닫는다. */
export function ArgoMultiSelect({ label, options, picked, onToggle, onClear }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);

  return (
    <div
      className="argo-ms"
      ref={root}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      <button ref={button} className={`argo-ms-btn${picked.size > 0 ? " on" : ""}`} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {argoPickButton(label, picked.size)} <span className="argo-ms-caret">▾</span>
      </button>
      {open && (
        <div className="argo-ms-pop" role="group" aria-label={label}>
          {picked.size > 0 && (
            <button className="argo-ms-clear" onClick={onClear}>
              {ARGO_PICK_CLEAR}
            </button>
          )}
          {options.map((o) => (
            <label key={o.value} className="argo-ms-opt">
              <input type="checkbox" checked={picked.has(o.value)} onChange={() => onToggle(o.value)} />
              <span className="argo-ms-text" title={o.text}>
                {o.text}
              </span>
              <span className="k8s-lvl-n">{o.count.toLocaleString("ko-KR")}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
