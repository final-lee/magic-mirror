import { useState } from "react";
import { PreviewFooter } from "../../iam/PreviewFooter";
import { CallList, ConfirmField, useSheetFocus, WarningList } from "../../iam/previewParts";
import * as t from "./text";
import { sqsChangeTone } from "./tone";
import type { PendingSqsChange } from "./useSqsChange";

interface Props {
  pending: PendingSqsChange;
  onApply: (typed: string) => void;
  onRetry: () => void;
  onCancel: () => void;
}

export function SqsChangeDialog(props: Props) {
  return <Sheet key={props.pending.rev} {...props} />;
}

function Sheet({ pending, onApply, onRetry, onCancel }: Props) {
  const [typed, setTyped] = useState("");
  const { preview, phase, error, stale } = pending;
  const { sheetRef, trapTab, cancelRef, retryRef } = useSheetFocus(phase, onCancel);
  const gated = preview ? { confirmText: preview.confirmName, warnings: preview.warnings } : null;

  return (
    <div className="modal">
      <div className="sheet wide cp" role="dialog" aria-modal="true" aria-label={t.PREVIEW_TITLE} ref={sheetRef} onKeyDown={trapTab}>
        <div className="cp-body">
          <h3>{preview?.title ?? t.CHANGE_PREVIEW}</h3>
          {phase === "loading" && <p>{t.LOADING_PREVIEW}</p>}
          {preview && (
            <>
              <WarningList warnings={preview.warnings} />
              {preview.impact.length > 0 && (
                <>
                  <h4>{t.IMPACT}</h4>
                  <ul>{preview.impact.map((impact, i) => <li key={i}>{impact}</li>)}</ul>
                </>
              )}
              {preview.calls.length > 0 && <><h4>{t.CALLS}</h4><CallList calls={preview.calls} /></>}
              {preview.diff.map((diff, i) => (
                <div key={i}>
                  <h4>{diff.label}</h4>
                  <table className="k8s-table sqs-change-diff">
                    <thead><tr><th>{t.BEFORE}</th><th>{t.AFTER}</th></tr></thead>
                    <tbody><tr><td><pre>{diff.before}</pre></td><td><pre>{diff.after}</pre></td></tr></tbody>
                  </table>
                </div>
              ))}
              {preview.confirmName && <ConfirmField required={preview.confirmName} typed={typed} onTyped={setTyped} locked={phase === "applying"} />}
            </>
          )}
        </div>
        <PreviewFooter
          gated={gated} phase={phase} error={error} stale={stale} typed={typed}
          cancelRef={cancelRef} retryRef={retryRef} onApply={onApply} onRetry={onRetry}
          onCancel={onCancel} applyTone={sqsChangeTone(pending.change)}
        />
      </div>
    </div>
  );
}
