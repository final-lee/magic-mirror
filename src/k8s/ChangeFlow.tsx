import { useState } from "react";
import { errorMessage } from "../api/errors";
import { PreviewFooter } from "../iam/PreviewFooter";
import { ConfirmField, useSheetFocus } from "../iam/previewParts";
import { usePendingFlow } from "../iam/useApplyFlow";
import { k8sApi } from "./api";
import * as t from "./text";
import type { K8sChange, K8sPreview, K8sTarget } from "./types";

type Pending = { change: K8sChange; undoOf: string | null; preview: K8sPreview | null; phase: "loading" | "ready" | "applying"; error: { kind: "preview" | "apply"; message: string } | null; stale: boolean; rev: number };

export function useK8sChange(target: K8sTarget, ssoProfile: string, onDone: () => void) {
  const flow = usePendingFlow<Pending, () => void>(JSON.stringify(target));
  const load = async (change: K8sChange, undoOf: string | null) => {
    const rev = ++flow.seq.current;
    flow.commit({ change, undoOf, preview: null, phase: "loading", error: null, stale: false, rev });
    try {
      const preview = await k8sApi.preview(target, change, ssoProfile);
      if (flow.seq.current === rev) flow.commit({ change, undoOf, preview, phase: "ready", error: null, stale: false, rev });
    } catch (e) {
      if (flow.seq.current === rev) flow.commit({ change, undoOf, preview: null, phase: "ready", error: { kind: "preview", message: errorMessage(e) }, stale: false, rev });
    }
  };
  const apply = async (typed: string) => {
    const p = flow.pendingRef.current;
    if (!p?.preview || p.phase !== "ready" || p.stale || flow.inFlight.current || (p.preview.confirmName && typed !== p.preview.confirmName)) return;
    flow.inFlight.current = true;
    flow.commit({ ...p, phase: "applying", error: null });
    try {
      await k8sApi.apply(target, p.change, p.preview.confirmName ? typed : null, p.undoOf, ssoProfile);
      flow.commit(null);
      if (flow.alive.current) onDone();
    } catch (e) {
      flow.commit({ ...p, phase: "ready", error: { kind: "apply", message: errorMessage(e) }, stale: true });
    } finally { flow.inFlight.current = false; }
  };
  return { pending: flow.pending, start: (change: K8sChange, undoOf: string | null = null) => void load(change, undoOf), retry: () => { const p = flow.pendingRef.current; if (p) void load(p.change, p.undoOf); }, apply, cancel: flow.cancel };
}

export function ChangeDialog({ pending, apply, retry, cancel }: { pending: Pending; apply: (typed: string) => void; retry: () => void; cancel: () => void }) {
  return <Sheet key={pending.rev} pending={pending} apply={apply} retry={retry} cancel={cancel} />;
}
function Sheet({ pending: p, apply, retry, cancel }: { pending: Pending; apply: (typed: string) => void; retry: () => void; cancel: () => void }) {
  const [typed, setTyped] = useState("");
  const { sheetRef, trapTab, cancelRef, retryRef } = useSheetFocus(p.phase, cancel);
  const preview = p.preview;
  const gated = preview ? { confirmText: preview.confirmName, warnings: preview.warnings.map((message) => ({ level: "warn" as const, message })) } : null;
  return <div className="modal"><div className="sheet wide cp" role="dialog" aria-modal="true" aria-label={p.undoOf ? t.CHANGE_UNDO_PREVIEW : t.CHANGE_PREVIEW} ref={sheetRef} onKeyDown={trapTab}>
    <div className="cp-body"><h3>{p.undoOf ? t.CHANGE_UNDO_PREVIEW : t.CHANGE_PREVIEW}</h3>
      {p.phase === "loading" && <p>{t.CHANGE_LOADING}</p>}
      {preview && <><h4>{t.CHANGE_CALLS}</h4>{preview.calls.map((c, i) => <div key={i}><code>{c.verb} {c.path}</code>{c.body != null && <details><summary>{t.CHANGE_BODY}</summary><pre>{JSON.stringify(c.body, null, 2)}</pre></details>}</div>)}
        <h4>{t.CHANGE_DIFF}</h4>{preview.diff.map((d, i) => <div key={i}><code>{d.path}</code><pre>{JSON.stringify(d.before)} → {JSON.stringify(d.after)}</pre></div>)}
        <h4>{t.CHANGE_IMPACT}</h4>{preview.impact.map((s, i) => <p key={i}>{s}</p>)}<h4>{t.CHANGE_WARNINGS}</h4>{preview.warnings.map((s, i) => <p className="err" key={i}>{s}</p>)}
        {preview.confirmName && <ConfirmField required={preview.confirmName} typed={typed} onTyped={setTyped} locked={p.phase === "applying"} label={t.CHANGE_CONFIRM} />}</>}
    </div><PreviewFooter gated={gated} phase={p.phase} error={p.error} stale={p.stale} typed={typed} cancelRef={cancelRef} retryRef={retryRef} onApply={apply} onRetry={retry} onCancel={cancel} />
  </div></div>;
}
