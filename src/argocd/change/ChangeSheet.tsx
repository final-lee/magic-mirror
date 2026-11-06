import { useEffect, useState } from "react";
import { errorMessage } from "../../api/errors";
import { useModal } from "../../iam/useModal";
import { TextDiffView } from "../../explorer/TextDiffView";
import type { ArgoChange, ArgoPreview, ArgoTarget } from "./types";
import { useArgoChange } from "./useArgoChange";
import { CHANGE_APPLY, CHANGE_CALLS, CHANGE_CANCEL, CHANGE_CONFIRM, CHANGE_DIFF, CHANGE_IMPACT, CHANGE_LOADING, CHANGE_PREVIEW, CHANGE_WARNINGS } from "./text";
import { changeTone } from "../ops/tone";
export function ChangeSheet({ url, target, change, onClose, onDone }: { url: string; target: ArgoTarget; change: ArgoChange; onClose: () => void; onDone: (message: string) => void }) {
  const flow = useArgoChange(url);
  const [preview, setPreview] = useState<ArgoPreview | null>(null);
  const [name, setName] = useState("");
  const { sheetRef, trapTab } = useModal(onClose);
  useEffect(() => { sheetRef.current?.focus(); }, [sheetRef]);
  useEffect(() => { let active = true; void flow.preview(target, change).then((p) => { if (active) setPreview(p); }).catch(() => {}); return () => { active = false; }; }, [url, target, change]);
  return <div className="modal" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}><div className="sheet argo-change-sheet" role="dialog" aria-modal="true" aria-label={CHANGE_PREVIEW} ref={sheetRef} tabIndex={-1} onKeyDown={trapTab}>
    <h3>{preview?.title ?? CHANGE_PREVIEW}</h3>
    {!preview && !flow.error && <p>{CHANGE_LOADING}</p>}
    {flow.error !== null && <p className="err" role="alert">{errorMessage(flow.error)}</p>}
    {preview && <>
      {preview.impact.length > 0 && <section><h4>{CHANGE_IMPACT}</h4><ul>{preview.impact.map((s,i) => <li key={i}>{s}</li>)}</ul></section>}
      {preview.warnings.length > 0 && <section><h4>{CHANGE_WARNINGS}</h4><ul>{preview.warnings.map((s,i) => <li key={i}>{s}</li>)}</ul></section>}
      {preview.blocked && <p className="err" role="alert">{preview.blocked}</p>}
      {preview.diff && <section><h4>{CHANGE_DIFF}</h4><TextDiffView rows={preview.diff.rows} /></section>}
      <details><summary>{CHANGE_CALLS}</summary>{preview.calls.map((c,i) => <div key={i}><div className="mono">{c.verb} {c.path}</div>{c.body !== null && <pre className="mono">{JSON.stringify(c.body, null, 2)}</pre>}</div>)}</details>
      {preview.confirmName && <label>{CHANGE_CONFIRM}: <span className="mono">{preview.confirmName}</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>}
    </>}
    <div className="foot"><button className="btn plain tone-ghost" onClick={onClose}>{CHANGE_CANCEL}</button><button className={`btn plain ${changeTone(change)}`} disabled={!preview || !!preview.blocked || flow.pending || (!!preview.confirmName && name !== preview.confirmName)} onClick={() => { if (preview) void flow.apply(target,change,preview,name || null).then((r) => onDone(r.message)).catch(() => {}); }}>{CHANGE_APPLY}</button></div>
  </div></div>;
}
