import { errorMessage } from "../api/errors";
import { usePendingFlow } from "../iam/useApplyFlow";
import { useSheetFocus } from "../iam/previewParts";
import { applyGate } from "../iam/useIamChange";
import { k8sApi } from "./api";
import { gatedOf, PreviewBody } from "./ChangeFlow";
import * as t from "./text";
import type { K8sChange, K8sPreview, K8sTarget } from "./types";

export interface BatchEntry {
  change: K8sChange;
  /** 되돌리기 미리보기면 되돌릴 변경의 기록 번호 */
  undoOf: string | null;
}

export interface BatchItem extends BatchEntry {
  preview: K8sPreview | null;
  /** 미리보기를 받지 못한 이유 */
  error: string | null;
  loading: boolean;
  /** 입력해 둔 확인 이름 */
  typed: string;
  status: "pending" | "applied" | "failed" | "skipped";
  logId: string | null;
  applyError: string | null;
}

export interface Batch {
  rev: number;
  undo: boolean;
  items: BatchItem[];
  /** ready: 확인을 기다림 · applying: 적용 중 · stopped: 실패로 멈춤 · finished: 모두 적용함 */
  phase: "ready" | "applying" | "stopped" | "finished";
  notice: string | null;
}

/** 이번에 적용할 문서: 아직 적용하지 않은 첫 문서부터 미리보기가 정상인 문서까지 */
export function applicableItems(items: BatchItem[]): number[] {
  const run: number[] = [];
  for (const [index, item] of items.entries()) {
    if (item.status === "applied") continue;
    if (item.status !== "pending" || item.loading || !item.preview || item.preview.conflicts.length > 0) break;
    run.push(index);
  }
  return run;
}

/** 확인 이름이 필요한 문서는 그 이름을 입력했는지, 막힘 경고가 없는지 */
const confirmed = (item: BatchItem) => !!item.preview && applyGate(gatedOf(item.preview), item.typed).ok;

const entryOf = (entry: BatchEntry): BatchItem => ({
  ...entry,
  preview: null,
  error: null,
  loading: true,
  typed: "",
  status: "pending",
  logId: null,
  applyError: null,
});

/** 문서별 미리보기 창이 쓰는 동작 */
export interface BatchApi {
  /** 문서마다 미리보기를 받고 창을 연다. undo면 되돌리기 미리보기다 */
  start: (entries: BatchEntry[], undo?: boolean, notice?: string | null) => void;
  apply: () => void;
  undoApplied: () => void;
  cancel: () => void;
  retry: (index: number) => void;
  force: (index: number) => void;
  typed: (index: number, text: string) => void;
}

/**
 * 문서 여러 개를 문서마다 미리보기하고 순서대로 적용한다. 첫 실패에서 멈추고(나머지는 건너뜀), 이미 적용한 것은 되돌리기를 제안한다.
 * 미리보기가 되지 않은 문서(앞 문서가 있어야 하는 문서 등) 앞까지만 먼저 적용하고, 적용한 뒤 나머지를 다시 미리보기 한다.
 */
export function useK8sBatch(target: K8sTarget, ssoProfile: string, onApplied: (changes: K8sChange[]) => void) {
  const flow = usePendingFlow<Batch, () => void>(JSON.stringify(target));
  const patch = (rev: number, index: number, fields: Partial<BatchItem>) => {
    const batch = flow.pendingRef.current;
    if (!batch || batch.rev !== rev) return;
    flow.commit({ ...batch, items: batch.items.map((item, i) => (i === index ? { ...item, ...fields } : item)) });
  };
  const load = async (rev: number, index: number, change: K8sChange) => {
    patch(rev, index, { change, loading: true, error: null, preview: null, typed: "" });
    try {
      patch(rev, index, { preview: await k8sApi.preview(target, change, ssoProfile), loading: false });
    } catch (error) {
      patch(rev, index, { error: errorMessage(error), loading: false });
    }
  };
  const start = (entries: BatchEntry[], undo = false, notice: string | null = null) => {
    const rev = ++flow.seq.current;
    flow.commit({ rev, undo, items: entries.map(entryOf), phase: "ready", notice });
    entries.forEach((entry, index) => void load(rev, index, entry.change));
  };

  const apply = async () => {
    const batch = flow.pendingRef.current;
    if (!batch || batch.phase !== "ready" || flow.inFlight.current) return;
    const run = applicableItems(batch.items);
    if (run.length === 0 || !run.every((index) => confirmed(batch.items[index]))) return;
    flow.inFlight.current = true;
    const { rev } = batch;
    flow.commit({ ...batch, phase: "applying", notice: null });
    const applied: K8sChange[] = [];
    let failed = false;
    try {
      for (const index of run) {
        const item = flow.pendingRef.current?.items[index];
        if (!item?.preview) break;
        try {
          const result = await k8sApi.apply(target, item.change, item.preview.confirmName ? item.typed : null, item.undoOf, ssoProfile);
          applied.push(item.change);
          patch(rev, index, { status: "applied", logId: result.logId });
        } catch (error) {
          patch(rev, index, { status: "failed", applyError: errorMessage(error) });
          failed = true;
          break;
        }
      }
    } finally {
      flow.inFlight.current = false;
    }
    const after = flow.pendingRef.current;
    if (after && after.rev === rev) {
      const items = after.items.map((item) => (failed && item.status === "pending" ? { ...item, status: "skipped" as const } : item));
      const done = items.every((item) => item.status === "applied");
      flow.commit({ ...after, items, phase: failed ? "stopped" : done ? "finished" : "ready" });
      if (!failed && !done) {
        items.forEach((item, index) => {
          if (item.status === "pending") void load(rev, index, item.change);
        });
      }
    }
    if (applied.length > 0 && flow.alive.current) onApplied(applied);
  };

  /** 적용한 문서를 거꾸로 되돌리는 미리보기를 연다 */
  const undoApplied = async () => {
    const batch = flow.pendingRef.current;
    if (!batch || batch.phase === "applying") return;
    const entries: BatchEntry[] = [];
    let missing = false;
    for (const item of [...batch.items].reverse()) {
      if (item.status !== "applied" || !item.logId) continue;
      try {
        entries.push({ change: (await k8sApi.undo(item.logId)).change, undoOf: item.logId });
      } catch {
        missing = true;
      }
    }
    if (flow.pendingRef.current?.rev !== batch.rev) return;
    if (entries.length === 0) flow.commit({ ...batch, notice: t.BATCH_UNDO_UNAVAILABLE });
    else start(entries, true, missing ? t.BATCH_UNDO_UNAVAILABLE : null);
  };

  const api: BatchApi = {
    start,
    apply: () => void apply(),
    undoApplied: () => void undoApplied(),
    cancel: flow.cancel,
    retry: (index: number) => {
      const batch = flow.pendingRef.current;
      if (batch && batch.phase === "ready") void load(batch.rev, index, batch.items[index].change);
    },
    /** 충돌한 문서를 강제로 다시 미리보기 한다 */
    force: (index: number) => {
      const batch = flow.pendingRef.current;
      const change = batch?.items[index].change;
      if (batch && batch.phase === "ready" && change?.type === "apply") void load(batch.rev, index, { ...change, force: true });
    },
    typed: (index: number, text: string) => patch(flow.pendingRef.current?.rev ?? 0, index, { typed: text }),
  };
  return { batch: flow.pending, api };
}

const STATUS_LABEL = { applied: t.BATCH_APPLIED, failed: t.BATCH_FAILED, skipped: t.BATCH_SKIPPED, pending: "" } as const;

interface Props {
  batch: Batch;
  api: BatchApi;
}

/** 문서별 미리보기 목록. 문서마다 호출·차이·경고·확인 이름이 따로 있다. */
export function BatchDialog({ batch, api }: Props) {
  const { sheetRef, trapTab, cancelRef } = useSheetFocus(batch.phase, api.cancel);
  const run = applicableItems(batch.items);
  const pending = batch.items.filter((item) => item.status === "pending").length;
  const ready = run.length > 0 && run.every((index) => confirmed(batch.items[index]));
  const applying = batch.phase === "applying";
  const closed = batch.phase === "stopped" || batch.phase === "finished";
  const anyApplied = batch.items.some((item) => item.status === "applied" && item.logId);
  const title = batch.undo ? t.BATCH_UNDO_TITLE : t.BATCH_TITLE;
  return (
    <div className="modal">
      <div className="sheet wide cp" role="dialog" aria-modal="true" aria-label={title} ref={sheetRef} onKeyDown={trapTab}>
        <div className="cp-body">
          <h3>{title}</h3>
          {batch.items.map((item, index) => (
            <section key={index} className="k8s-sect" aria-label={t.batchItem(index + 1, item.change.kind.kind, item.change.name)}>
              <h4>
                {t.batchItem(index + 1, item.change.kind.kind, item.change.name)}
                {item.change.namespace ? ` (${item.change.namespace})` : ""}{" "}
                {item.status !== "pending" && <span className="k8s-chip">{STATUS_LABEL[item.status]}</span>}
              </h4>
              {item.loading && <p>{t.BATCH_LOADING}</p>}
              {item.error && (
                <>
                  <p className="err">{t.BATCH_PREVIEW_FAILED}: {item.error}</p>
                  {batch.phase === "ready" && <button className="btn small tone-secondary" onClick={() => api.retry(index)}>{t.CHANGE_RETRY}</button>}
                </>
              )}
              {item.preview && (
                <PreviewBody preview={item.preview} typed={item.typed} onTyped={(text) => api.typed(index, text)}
                  locked={applying || item.status !== "pending"} onForce={batch.phase === "ready" && item.status === "pending" ? () => api.force(index) : undefined} />
              )}
              {item.applyError && <p className="err">{t.CHANGE_FAILED}: {item.applyError}</p>}
            </section>
          ))}
        </div>
        <div className="foot">
          {batch.notice && <span className="cp-hint err">{batch.notice}</span>}
          {batch.phase === "stopped" && <span className="cp-hint err">{t.BATCH_STOPPED}</span>}
          {batch.phase === "finished" && <span className="cp-hint">{t.BATCH_DONE}</span>}
          {batch.phase === "ready" && pending > run.length && run.length > 0 && <span className="cp-hint">{t.BATCH_PARTIAL(run.length)}</span>}
          <button ref={cancelRef} className="btn tone-ghost" disabled={applying} onClick={api.cancel}>
            {closed ? t.BATCH_CLOSE : t.CHANGE_CANCEL}
          </button>
          {closed && !batch.undo && anyApplied && (
            <button className="btn tone-warn" onClick={api.undoApplied}>{t.BATCH_UNDO_APPLIED}</button>
          )}
          {!closed && (
            <button className="btn tone-primary" disabled={!ready || applying} onClick={api.apply}>
              {applying ? t.CHANGE_APPLYING : t.BATCH_APPLY(run.length)}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
