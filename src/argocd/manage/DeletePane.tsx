import { useState } from "react";
import type { ArgoChange } from "../change/types";
import {
  MANAGE_DELETE_BACKGROUND, MANAGE_DELETE_BACKGROUND_NOTE, MANAGE_DELETE_FOREGROUND, MANAGE_DELETE_FOREGROUND_NOTE, MANAGE_DELETE_GO, MANAGE_DELETE_ORPHAN, MANAGE_DELETE_ORPHAN_NOTE,
  MANAGE_DELETE_PICK, MANAGE_DELETE_TITLE,
} from "./text";

type Delete = Extract<ArgoChange, { kind: "appDelete" }>;
type Mode = "foreground" | "background" | "orphan";

const MODES: { mode: Mode; label: string; note: string; change: Delete }[] = [
  { mode: "foreground", label: MANAGE_DELETE_FOREGROUND, note: MANAGE_DELETE_FOREGROUND_NOTE, change: { kind: "appDelete", cascade: true, propagationPolicy: "foreground" } },
  { mode: "background", label: MANAGE_DELETE_BACKGROUND, note: MANAGE_DELETE_BACKGROUND_NOTE, change: { kind: "appDelete", cascade: true, propagationPolicy: "background" } },
  { mode: "orphan", label: MANAGE_DELETE_ORPHAN, note: MANAGE_DELETE_ORPHAN_NOTE, change: { kind: "appDelete", cascade: false, propagationPolicy: null } },
];

/** 앱 삭제 방식(cascade) 고르기. 이름 직접 입력은 변경 미리 보기가 요구한다 */
export function DeletePane({ onPreview, disabled, disabledReason }: { onPreview: (change: Delete) => void; disabled?: boolean; disabledReason?: string }) {
  const [mode, setMode] = useState<Mode>("foreground");
  return (
    <div className="mg-form">
      <section className="k8s-sect" aria-label={MANAGE_DELETE_TITLE}>
        <h4>{MANAGE_DELETE_TITLE}</h4>
        <div role="radiogroup" aria-label={MANAGE_DELETE_PICK} className="mg-choices">
          {MODES.map((m) => (
            <label key={m.mode} className="mg-choice">
              <input type="radio" name="mg-delete" checked={mode === m.mode} onChange={() => setMode(m.mode)} />
              <span>
                <b>{m.label}</b>
                <span className="dim">{m.note}</span>
              </span>
            </label>
          ))}
        </div>
      </section>
      <div className="mg-foot">
        <button className="btn small tone-danger" disabled={disabled} title={disabled ? disabledReason : undefined} onClick={() => onPreview(MODES.find((m) => m.mode === mode)!.change)}>
          {MANAGE_DELETE_GO}
        </button>
      </div>
    </div>
  );
}
