import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "../../api/errors";
import { ConfirmField, ReversibleNote, useSheetFocus } from "../../iam/previewParts";
import { applyItemResults } from "../items/writes";
import { changeApi } from "./api";
import { canApply } from "./gate";
import * as t from "./text";
import type { DynamoChange, DynamoPreview, ItemResult, Target } from "./types";

export type DynamoChangeFlow = {
  begin: (change: DynamoChange, extraWarnings?: string[]) => Promise<void>;
  undo: (id: string) => Promise<void>;
  loading: boolean;
  error: string;
  dialog: ReactNode;
};

type Pending = {
  change: DynamoChange;
  undoOf: string | null;
  preview: DynamoPreview;
};

export function useDynamoChange(target: Target): DynamoChangeFlow {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Pending | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<ItemResult[]>([]);

  const begin = async (change: DynamoChange, extraWarnings: string[] = []) => {
    setError("");
    setResults([]);
    setLoading(true);
    try {
      const preview = await changeApi.preview(target, change);
      setPending({
        change,
        undoOf: null,
        preview: { ...preview, warnings: [...preview.warnings, ...extraWarnings] },
      });
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  const undo = async (id: string) => {
    setError("");
    setLoading(true);
    try {
      const [change, preview] = await changeApi.undoPreview(target, id);
      setPending({ change, undoOf: id, preview });
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  const apply = async (typed: string) => {
    if (!pending) return;
    setError("");
    setLoading(true);
    try {
      const outcome = await changeApi.apply(target, pending.change, typed || null, pending.undoOf);
      if (outcome.results) {
        applyItemResults(target, pending.change, outcome.results);
        setResults(outcome.results.filter(result => !result.ok));
      }
      setPending(null);
      await queryClient.invalidateQueries({ queryKey: ["dynamo"] });
    } catch (error) {
      setError(errorMessage(error));
      setPending(null);
    } finally {
      setLoading(false);
    }
  };

  const dialog = <>{pending && <Dialog
    key={`${pending.undoOf ?? "new"}-${pending.preview.title}`}
    pending={pending}
    loading={loading}
    apply={apply}
    cancel={() => setPending(null)}
  />}{results.length > 0 && <div className="modal"><div className="sheet wide cp" role="dialog" aria-label="아이템 변경 결과">
    <h3>변경하지 못한 아이템</h3>
    {results.map((result, index) => <div key={index}><p className="err">{result.error}</p>
      <h4>읽은 아이템</h4><pre>{JSON.stringify(result.item, null, 2)}</pre>
      <h4>현재 아이템</h4><pre>{JSON.stringify(result.latest, null, 2)}</pre></div>)}
    <button className="btn tone-secondary" onClick={() => setResults([])}>닫기</button>
  </div></div>}</>;
  return { begin, undo, loading, error, dialog };
}

function actionTone(pending: Pending) {
  if (pending.undoOf) return "tone-caution";
  if (pending.change.kind === "deleteBackup") return "tone-danger";
  if (pending.change.kind === "deleteItems") return "tone-danger";
  if (pending.change.kind === "putItem" || pending.change.kind === "updateItem" || pending.change.kind === "moveItem") return "tone-primary";
  if (pending.change.kind === "createBackup") return "tone-create";
  if (["restoreBackup", "restorePitr", "exportS3"].includes(pending.change.kind)) return "tone-primary";
  return "tone-warn";
}

function Dialog({ pending, loading, apply, cancel }: {
  pending: Pending;
  loading: boolean;
  apply: (typed: string) => void;
  cancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const preview = pending.preview;
  const { sheetRef, trapTab, cancelRef } = useSheetFocus(loading ? "applying" : "ready", cancel);

  return <div className="modal">
    <div className="sheet wide cp" role="dialog" aria-modal="true" aria-label={t.PREVIEW} ref={sheetRef} onKeyDown={trapTab}>
      <div className="cp-body">
        <h3>{preview.title}</h3>
        <h4>{t.CALLS}</h4>
        {preview.calls.map((call, index) => <div key={index}><code>{call.api}</code><pre>{JSON.stringify(call.params, null, 2)}</pre></div>)}
        {preview.diff != null && <><h4>{t.DIFF}</h4><pre>{JSON.stringify(preview.diff, null, 2)}</pre></>}
        {preview.impact.length > 0 && <><h4>{t.IMPACT}</h4>{preview.impact.map((impact, index) => <p key={index}>{impact}</p>)}</>}
        {preview.warnings.length > 0 && <><h4>{t.WARNINGS}</h4>{preview.warnings.map((warning, index) => <p className="err" key={index}>{warning}</p>)}</>}
        <ReversibleNote reversible={!!preview.inverse || pending.change.kind === "createBackup"} />
        {preview.blocked && <p className="err">{preview.blocked}</p>}
        {preview.confirmName && <ConfirmField required={preview.confirmName} typed={typed} onTyped={setTyped} locked={loading} label={t.CONFIRM} />}
      </div>
      <div className="cp-footer">
        <button type="button" className="btn tone-ghost" ref={cancelRef} disabled={loading} onClick={cancel}>{t.CANCEL}</button>
        <button type="button" className={`btn ${actionTone(pending)}`} disabled={!canApply(preview, typed, loading)} onClick={() => apply(typed)}>{t.APPLY}</button>
      </div>
    </div>
  </div>;
}
