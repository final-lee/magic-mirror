import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../api/errors";
import { PreviewFooter } from "../iam/PreviewFooter";
import { ConfirmField, ReversibleNote, useSheetFocus } from "../iam/previewParts";
import type { Gated } from "../iam/useIamChange";
import type { PreviewWarning } from "../iam/types";
import { usePendingFlow } from "../iam/useApplyFlow";
import { k8sApi } from "./api";
import { changeTone } from "./changeTone";
import { DrainPlanView } from "./DrainPlanView";
import { EffectView } from "./rbac/EffectView";
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
    if (p.preview.conflicts.length > 0) return;
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
    /** 충돌한 apply를 force로 다시 미리보기 한다. 강제 적용은 이름 입력을 받는다 */
    force: () => {
      const p = flow.pendingRef.current;
      if (p && p.phase === "ready" && p.change.type === "apply") void load({ ...p.change, force: true }, p.undoOf);
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
  /** 충돌한 apply를 강제로 다시 미리보기 한다. 주지 않으면 버튼을 그리지 않는다 */
  force?: () => void;
}

/** 다시 받은 미리보기는 확인 입력을 비우고 새 창으로 연다. */
export function ChangeDialog(props: DialogProps) {
  return <Sheet key={props.pending.rev} {...props} />;
}

/** 적용 가능 여부를 가리는 경고. 필드 충돌이 남아 있으면 막힘 경고를 더한다. */
export function gatedOf(preview: K8sPreview): Gated {
  const warnings: PreviewWarning[] = preview.warnings.map((message) => ({ level: "warn", message }));
  if (preview.conflicts.length > 0) warnings.push({ level: "block", message: t.CHANGE_CONFLICT_BLOCK });
  return { confirmText: preview.confirmName, warnings };
}

interface BodyProps {
  preview: K8sPreview;
  typed: string;
  onTyped: (typed: string) => void;
  locked: boolean;
  /** 충돌이 있을 때 강제로 다시 미리보기 하는 버튼. 주지 않으면 그리지 않는다 */
  onForce?: () => void;
  /** 여러 변경 미리보기 안에서는 실효 권한 영향의 목록을 접는다 */
  compactEffect?: boolean;
}

/** 미리보기 하나의 내용: 호출, 필드 차이, 충돌, 영향, 경고, 되돌릴 수 있는지, 확인 입력. 하나짜리와 여러 문서 미리보기가 함께 쓴다. */
export function PreviewBody({ preview, typed, onTyped, locked, onForce, compactEffect }: BodyProps) {
  return (
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
      {preview.conflicts.length > 0 && (
        <>
          <h4>{t.CHANGE_CONFLICTS}</h4>
          <table className="k8s-table">
            <thead><tr><th>{t.CHANGE_CONFLICT_FIELD}</th><th>{t.CHANGE_CONFLICT_MANAGER}</th></tr></thead>
            <tbody>
              {preview.conflicts.map((conflict, i) => (
                <tr key={i}><td><code>{conflict.field}</code></td><td>{conflict.manager}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="err">{t.CHANGE_CONFLICT_BLOCK}</p>
          {onForce && (
            <>
              <p className="dim">{t.CHANGE_FORCE_NOTE}</p>
              <button className="btn plain tone-primary" onClick={onForce}>{t.CHANGE_FORCE}</button>
            </>
          )}
        </>
      )}
      <h4>{t.CHANGE_DIFF}</h4>
      <table className="k8s-table">
        <thead><tr><th>{t.CHANGE_PATH}</th><th>{t.CHANGE_BEFORE}</th><th>{t.CHANGE_AFTER}</th></tr></thead>
        <tbody>
          {preview.diff.map((diff, i) => (
            <tr key={i}>
              <td><code>{diff.path || t.CHANGE_WHOLE_OBJECT}</code></td>
              <td><pre>{JSON.stringify(diff.before, null, 2)}</pre></td>
              <td><pre>{JSON.stringify(diff.after, null, 2)}</pre></td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4>{t.CHANGE_IMPACT}</h4>
      {preview.impact.map((impact, i) => <p key={i}>{impact}</p>)}
      {preview.drain && <DrainPlanView plan={preview.drain} />}
      {preview.effect && <EffectView effect={preview.effect} compact={compactEffect} />}
      <h4>{t.CHANGE_WARNINGS}</h4>
      {preview.warnings.map((warning, i) => <p className="err" key={i}>{warning}</p>)}
      <ReversibleNote reversible={preview.reversible} />
      {preview.confirmName && (
        <ConfirmField required={preview.confirmName} typed={typed} onTyped={onTyped}
          locked={locked} label={t.CHANGE_CONFIRM} />
      )}
    </>
  );
}

/** 호출과 필드 차이, 영향, 경고와 확인 입력을 보여 준다. */
function Sheet({ pending: p, apply, retry, cancel, force }: DialogProps) {
  const [typed, setTyped] = useState("");
  const { sheetRef, trapTab, cancelRef, retryRef } = useSheetFocus(p.phase, cancel);
  const preview = p.preview;
  const gated = preview ? gatedOf(preview) : null;
  return (
    <div className="modal">
      <div className="sheet wide cp" role="dialog" aria-modal="true"
        aria-label={p.undoOf ? t.CHANGE_UNDO_PREVIEW : t.CHANGE_PREVIEW} ref={sheetRef} onKeyDown={trapTab}>
        <div className="cp-body">
          <h3>{p.undoOf ? t.CHANGE_UNDO_PREVIEW : t.CHANGE_PREVIEW}</h3>
          {p.phase === "loading" && <p>{t.CHANGE_LOADING}</p>}
          {preview && (
            <PreviewBody preview={preview} typed={typed} onTyped={setTyped} locked={p.phase === "applying"} onForce={p.phase === "ready" ? force : undefined} />
          )}
        </div>
        <PreviewFooter gated={gated} phase={p.phase} error={p.error} stale={p.stale} typed={typed}
          applyTone={changeTone([{ change: p.change, undoOf: p.undoOf }])}
          cancelRef={cancelRef} retryRef={retryRef} onApply={apply} onRetry={retry} onCancel={cancel} />
      </div>
    </div>
  );
}
