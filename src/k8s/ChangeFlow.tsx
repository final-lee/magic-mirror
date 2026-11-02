import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../api/errors";
import { PreviewFooter } from "../iam/PreviewFooter";
import { ConfirmField, useSheetFocus } from "../iam/previewParts";
import { usePendingFlow } from "../iam/useApplyFlow";
import { k8sApi } from "./api";
import { DrainPlanView } from "./DrainPlanView";
import { reduceDrain, startRun, type DrainRun } from "./drain";
import * as t from "./text";
import type { K8sChange, K8sDrainMessage, K8sPreview, K8sTarget } from "./types";

type Pending = {
  change: K8sChange;
  undoOf: string | null;
  preview: K8sPreview | null;
  phase: "loading" | "ready" | "applying";
  error: { kind: "preview" | "apply"; message: string } | null;
  stale: boolean;
  rev: number;
};

/**
 * 미리보기와 적용을 한 흐름으로 묶고 실패하면 다시 확인하도록 막는다.
 * drain은 적용이 끝나지 않는 흐름이라 진행(`drain`)을 채널 메시지로 받아 두고, `onDrained`는 끝 메시지에서 한 번 부른다.
 */
export function useK8sChange(target: K8sTarget, ssoProfile: string, onDone: (change: K8sChange) => void, onDrained: () => void = () => {}) {
  const flow = usePendingFlow<Pending, () => void>(JSON.stringify(target));
  const run = useRef<DrainRun | null>(null);
  const [drain, show] = useState<DrainRun | null>(null);
  const setRun = (next: DrainRun | null) => {
    run.current = next;
    show(next);
  };
  const onMessage = (message: K8sDrainMessage) => {
    if (!run.current) return;
    setRun(reduceDrain(run.current, message));
    if (message.type === "finished") onDrained();
  };
  const drainNode = async (node: string, typed: string) => {
    setRun(startRun(node));
    try {
      const id = await k8sApi.drain(target, node, typed, ssoProfile, onMessage);
      if (run.current) setRun({ ...run.current, id });
    } catch (error) {
      setRun(null);
      throw error;
    }
  };
  const stopDrain = () => {
    const current = run.current;
    if (current?.id == null || current.finished || current.stopping) return;
    setRun({ ...current, stopping: true });
    void k8sApi.unwatch(current.id);
  };
  // 화면을 떠나면 하던 drain은 지금 Eviction까지만 하고 멈추게 한다
  useEffect(() => () => {
    const current = run.current;
    if (current?.id != null && !current.finished) void k8sApi.unwatch(current.id);
  }, []);
  const load = async (change: K8sChange, undoOf: string | null) => {
    const rev = ++flow.seq.current;
    flow.commit({ change, undoOf, preview: null, phase: "loading", error: null, stale: false, rev });
    try {
      const preview = await k8sApi.preview(target, change, ssoProfile);
      if (flow.seq.current === rev) {
        flow.commit({ change, undoOf, preview, phase: "ready", error: null, stale: false, rev });
      }
    } catch (error) {
      if (flow.seq.current === rev) {
        flow.commit({ change, undoOf, preview: null, phase: "ready", error: { kind: "preview", message: errorMessage(error) }, stale: false, rev });
      }
    }
  };
  const apply = async (typed: string) => {
    const p = flow.pendingRef.current;
    if (!p?.preview || p.phase !== "ready" || p.stale || flow.inFlight.current) return;
    if (p.preview.confirmName && typed !== p.preview.confirmName) return;
    flow.inFlight.current = true;
    flow.commit({ ...p, phase: "applying", error: null });
    try {
      if (p.change.type === "drain") {
        await drainNode(p.change.name, typed);
        flow.commit(null);
      } else {
        await k8sApi.apply(target, p.change, p.preview.confirmName ? typed : null, p.undoOf, ssoProfile);
        flow.commit(null);
        if (flow.alive.current) onDone(p.change);
      }
    } catch (error) {
      flow.commit({ ...p, phase: "ready", error: { kind: "apply", message: errorMessage(error) }, stale: true });
    } finally {
      flow.inFlight.current = false;
    }
  };
  return {
    pending: flow.pending,
    start: (change: K8sChange, undoOf: string | null = null) => void load(change, undoOf),
    retry: () => {
      const p = flow.pendingRef.current;
      if (p) void load(p.change, p.undoOf);
    },
    apply,
    cancel: flow.cancel,
    /** 진행 중이거나 끝난 drain. `k8s_drain`이 받아들여진 뒤에만 있다 */
    drain: drain?.id != null ? drain : null,
    stopDrain,
    closeDrain: () => setRun(null),
  };
}

interface DialogProps {
  pending: Pending;
  apply: (typed: string) => void;
  retry: () => void;
  cancel: () => void;
}

/** 다시 받은 미리보기는 확인 입력을 비우고 새 창으로 연다. */
export function ChangeDialog(props: DialogProps) {
  return <Sheet key={props.pending.rev} {...props} />;
}

/** 호출과 필드 차이, 영향, 경고와 확인 입력을 보여 준다. */
function Sheet({ pending: p, apply, retry, cancel }: DialogProps) {
  const [typed, setTyped] = useState("");
  const { sheetRef, trapTab, cancelRef, retryRef } = useSheetFocus(p.phase, cancel);
  const preview = p.preview;
  const gated = preview ? {
    confirmText: preview.confirmName,
    warnings: preview.warnings.map((message) => ({ level: "warn" as const, message })),
  } : null;
  return (
    <div className="modal">
      <div className="sheet wide cp" role="dialog" aria-modal="true"
        aria-label={p.undoOf ? t.CHANGE_UNDO_PREVIEW : t.CHANGE_PREVIEW} ref={sheetRef} onKeyDown={trapTab}>
        <div className="cp-body">
          <h3>{p.undoOf ? t.CHANGE_UNDO_PREVIEW : t.CHANGE_PREVIEW}</h3>
          {p.phase === "loading" && <p>{t.CHANGE_LOADING}</p>}
          {preview && (
            <>
              <h4>{t.CHANGE_CALLS}</h4>
              {preview.calls.map((call, i) => (
                <div key={i}>
                  <code>{call.verb} {call.path}</code>
                  {call.body != null && (
                    <details><summary>{t.CHANGE_BODY}</summary><pre>{JSON.stringify(call.body, null, 2)}</pre></details>
                  )}
                </div>
              ))}
              <h4>{t.CHANGE_DIFF}</h4>
              <table className="k8s-table">
                <thead><tr><th>{t.CHANGE_PATH}</th><th>{t.CHANGE_BEFORE}</th><th>{t.CHANGE_AFTER}</th></tr></thead>
                <tbody>
                  {preview.diff.map((diff, i) => (
                    <tr key={i}>
                      <td><code>{diff.path}</code></td>
                      <td><pre>{JSON.stringify(diff.before, null, 2)}</pre></td>
                      <td><pre>{JSON.stringify(diff.after, null, 2)}</pre></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h4>{t.CHANGE_IMPACT}</h4>
              {preview.impact.map((impact, i) => <p key={i}>{impact}</p>)}
              {preview.drain && <DrainPlanView plan={preview.drain} />}
              <h4>{t.CHANGE_WARNINGS}</h4>
              {preview.warnings.map((warning, i) => <p className="err" key={i}>{warning}</p>)}
              {preview.confirmName && (
                <ConfirmField required={preview.confirmName} typed={typed} onTyped={setTyped}
                  locked={p.phase === "applying"} label={t.CHANGE_CONFIRM} />
              )}
            </>
          )}
        </div>
        <PreviewFooter gated={gated} phase={p.phase} error={p.error} stale={p.stale} typed={typed}
          cancelRef={cancelRef} retryRef={retryRef} onApply={apply} onRetry={retry} onCancel={cancel} />
      </div>
    </div>
  );
}
