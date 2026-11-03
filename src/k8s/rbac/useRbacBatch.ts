import { errorMessage } from "../../api/errors";
import { usePendingFlow } from "../../iam/useApplyFlow";
import { applyGate } from "../../iam/useIamChange";
import { k8sApi } from "../api";
import { gatedOf } from "../ChangeFlow";
import type { K8sChange, K8sPreview, K8sTarget } from "../types";
import { rbacApi } from "./api";
import { cartRemoveApplied } from "./cart";
import * as t from "./text";
import type { RbacEffect, RbacItemStatus } from "./types";

export interface RbacBatchEntry {
  change: K8sChange;
  /** 되돌리기 미리보기면 되돌릴 변경의 기록 번호 */
  undoOf: string | null;
}

export interface RbacBatchItem extends RbacBatchEntry {
  preview: K8sPreview | null;
  /** 계획하지 못한 이유 */
  error: string | null;
  /** 입력해 둔 확인 이름 */
  typed: string;
  status: "pending" | RbacItemStatus;
  logId: string | null;
  applyError: string | null;
}

export interface RbacBatch {
  rev: number;
  undo: boolean;
  items: RbacBatchItem[];
  total: RbacEffect | null;
  /** loading: 미리보기 중 · ready: 확인을 기다림 · applying: 적용 중 · stopped: 실패로 멈춤 · finished: 모두 적용함 */
  phase: "loading" | "ready" | "applying" | "stopped" | "finished";
  /** 적용 전 재확인에서 미리보기와 달라져 아무것도 적용하지 못했다 */
  stale: boolean;
  notice: string | null;
}

/** 적용할 수 있는가: 모든 항목이 계획됐고 이름 입력이 필요한 항목은 입력했다 */
export function applicable(batch: RbacBatch): boolean {
  return (
    batch.phase === "ready" &&
    !batch.stale &&
    batch.items.length > 0 &&
    batch.items.every((item) => item.status === "pending" && !!item.preview && applyGate(gatedOf(item.preview), item.typed).ok)
  );
}

export interface RbacBatchApi {
  /** 변경들을 한 번에 미리보기하고 창을 연다. undo면 되돌리기 미리보기다 */
  start: (entries: RbacBatchEntry[], undo?: boolean, notice?: string | null) => void;
  apply: () => void;
  undoApplied: () => void;
  cancel: () => void;
  retry: () => void;
  typed: (index: number, text: string) => void;
}

/**
 * 변경 여러 개를 한 번에 미리보기하고 적용한다. 미리보기는 변경을 앞 변경이 적용된 상태에서 차례로 계획하고, 적용은 백엔드가 전체를 다시 계획해
 * 미리보기와 같을 때만 하나씩 보낸다(첫 실패에서 멈춤). 적용한 것은 변경 기록의 되돌리기로 거꾸로 되돌리는 미리보기를 연다.
 */
export function useRbacBatch(target: K8sTarget, ssoProfile: string, onApplied: (changes: K8sChange[]) => void) {
  const flow = usePendingFlow<RbacBatch, () => void>(JSON.stringify(target));

  const load = async (rev: number, entries: RbacBatchEntry[], undo: boolean, notice: string | null) => {
    const base: RbacBatch = {
      rev,
      undo,
      items: entries.map((entry) => ({ ...entry, preview: null, error: null, typed: "", status: "pending", logId: null, applyError: null })),
      total: null,
      phase: "loading",
      stale: false,
      notice,
    };
    flow.commit(base);
    try {
      const result = await rbacApi.previewBatch(target, entries.map((e) => e.change), ssoProfile);
      if (flow.pendingRef.current?.rev !== rev) return;
      flow.commit({
        ...base,
        phase: "ready",
        total: result.total,
        items: base.items.map((item, i) => ({ ...item, preview: result.items[i]?.preview ?? null, error: result.items[i]?.error ?? null })),
      });
    } catch (error) {
      if (flow.pendingRef.current?.rev !== rev) return;
      flow.commit({ ...base, phase: "ready", notice: errorMessage(error), items: base.items.map((item) => ({ ...item, error: errorMessage(error) })) });
    }
  };

  const start = (entries: RbacBatchEntry[], undo = false, notice: string | null = null) => {
    const rev = ++flow.seq.current;
    void load(rev, entries, undo, notice);
  };

  const apply = async () => {
    const batch = flow.pendingRef.current;
    if (!batch || !applicable(batch) || flow.inFlight.current) return;
    flow.inFlight.current = true;
    const { rev } = batch;
    flow.commit({ ...batch, phase: "applying", notice: null });
    try {
      const result = await rbacApi.applyBatch(
        target,
        batch.items.map((i) => i.change),
        batch.items.map((i) => (i.preview?.confirmName ? i.typed : null)),
        batch.items.map((i) => i.undoOf),
        ssoProfile,
      );
      const items = batch.items.map((item, i) => ({
        ...item,
        status: result.items[i]?.status ?? "skipped",
        logId: result.items[i]?.logId ?? null,
        applyError: result.items[i]?.error ?? null,
      }));
      const failed = items.some((item) => item.status === "failed" || item.applyError);
      const applied = items.filter((item) => item.status === "applied").map((item) => item.change);
      if (flow.pendingRef.current?.rev === rev) flow.commit({ ...batch, items, phase: failed ? "stopped" : "finished", notice: null });
      if (!batch.undo) cartRemoveApplied(target, applied);
      if (applied.length > 0 && flow.alive.current) onApplied(applied);
    } catch (error) {
      // 아무것도 적용되지 않았다: 미리보기 이후 바뀌었거나(재확인) 확인이 모자란다. 다시 미리보기를 받아야 한다.
      if (flow.pendingRef.current?.rev === rev) flow.commit({ ...batch, phase: "ready", stale: true, notice: errorMessage(error) });
    } finally {
      flow.inFlight.current = false;
    }
  };

  /** 적용한 변경을 거꾸로 되돌리는 미리보기를 연다 */
  const undoApplied = async () => {
    const batch = flow.pendingRef.current;
    if (!batch || batch.phase === "applying") return;
    const entries: RbacBatchEntry[] = [];
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

  const api: RbacBatchApi = {
    start,
    apply: () => void apply(),
    undoApplied: () => void undoApplied(),
    cancel: flow.cancel,
    retry: () => {
      const batch = flow.pendingRef.current;
      if (batch && (batch.phase === "ready" || batch.phase === "loading")) start(batch.items.map(({ change, undoOf }) => ({ change, undoOf })), batch.undo);
    },
    typed: (index: number, text: string) => {
      const batch = flow.pendingRef.current;
      if (batch) flow.commit({ ...batch, items: batch.items.map((item, i) => (i === index ? { ...item, typed: text } : item)) });
    },
  };
  return { batch: flow.pending, api };
}
