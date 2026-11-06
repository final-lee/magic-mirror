import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "../../api/errors";
import { ConfirmField, ReversibleNote, useSheetFocus } from "../../iam/previewParts";
import { changeApi } from "./api";
import { canApply } from "./gate";
import * as t from "./text";
import type { DynamoChange, DynamoPreview, Target } from "./types";

type Pending = { change: DynamoChange; undoOf: string | null; preview: DynamoPreview };
export function useDynamoChange(target: Target) {
  const qc = useQueryClient();
  const [pending, setPending] = useState<Pending | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const begin = async (change: DynamoChange, extraWarnings: string[] = []) => {
    setError(""); setLoading(true);
    try { const preview = await changeApi.preview(target, change); setPending({ change, undoOf: null, preview: { ...preview, warnings:[...preview.warnings, ...extraWarnings] } }); }
    catch (e) { setError(errorMessage(e)); } finally { setLoading(false); }
  };
  const undo = async (id: string) => {
    setError(""); setLoading(true);
    try { const [change, preview] = await changeApi.undoPreview(target, id); setPending({ change, undoOf: id, preview }); }
    catch (e) { setError(errorMessage(e)); } finally { setLoading(false); }
  };
  const apply = async (typed: string) => {
    if (!pending) return;
    setError(""); setLoading(true);
    try {
      await changeApi.apply(target, pending.change, typed || null, pending.undoOf);
      setPending(null);
      await qc.invalidateQueries({ queryKey: ["dynamo"] });
    } catch (e) { setError(errorMessage(e)); setPending(null); }
    finally { setLoading(false); }
  };
  const dialog = pending && <Dialog key={`${pending.undoOf ?? "new"}-${pending.preview.title}`} pending={pending} loading={loading} apply={apply} cancel={() => setPending(null)} />;
  return { begin, undo, loading, error, dialog };
}
function Dialog({ pending, loading, apply, cancel }: { pending: Pending; loading: boolean; apply: (typed: string) => void; cancel: () => void }) {
  const [typed, setTyped] = useState("");
  const p = pending.preview;
  const { sheetRef, trapTab, cancelRef } = useSheetFocus(loading ? "applying" : "ready", cancel);
  const tone = pending.undoOf ? "tone-caution" : pending.change.kind === "deleteBackup" ? "tone-danger" : pending.change.kind === "createBackup" ? "tone-create" : ["restoreBackup", "restorePitr", "exportS3"].includes(pending.change.kind) ? "tone-primary" : "tone-warn";
  return <div className="modal"><div className="sheet wide cp" role="dialog" aria-modal="true" aria-label={t.PREVIEW} ref={sheetRef} onKeyDown={trapTab}>
    <div className="cp-body"><h3>{p.title}</h3><h4>{t.CALLS}</h4>{p.calls.map((c, i) => <div key={i}><code>{c.api}</code><pre>{JSON.stringify(c.params, null, 2)}</pre></div>)}
      {p.diff != null && <><h4>{t.DIFF}</h4><pre>{JSON.stringify(p.diff, null, 2)}</pre></>}
      {p.impact.length > 0 && <><h4>{t.IMPACT}</h4>{p.impact.map((s, i) => <p key={i}>{s}</p>)}</>}
      {p.warnings.length > 0 && <><h4>{t.WARNINGS}</h4>{p.warnings.map((s, i) => <p className="err" key={i}>{s}</p>)}</>}
      <ReversibleNote reversible={!!p.inverse || pending.change.kind === "createBackup"} />
      {p.blocked && <p className="err">{p.blocked}</p>}
      {p.confirmName && <ConfirmField required={p.confirmName} typed={typed} onTyped={setTyped} locked={loading} label={t.CONFIRM} />}
    </div><div className="cp-footer"><button type="button" className="btn tone-ghost" ref={cancelRef} disabled={loading} onClick={cancel}>{t.CANCEL}</button><button type="button" className={`btn ${tone}`} disabled={!canApply(p, typed, loading)} onClick={() => apply(typed)}>{t.APPLY}</button></div>
  </div></div>;
}
