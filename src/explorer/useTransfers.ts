import { useCallback, useEffect, useRef, useState } from "react";
import { explorerApi, onTransferProgress } from "./api";
import type { TransferEvent, TransferRequest } from "./types";

export interface TransferItem {
  request: TransferRequest;
  event: TransferEvent;
}

const queued = (id: string): TransferEvent => ({ id, status: "queued", transferred: 0, total: null, error: null });

export function useTransfers(profile: string | null, onSettled: (req: TransferRequest) => void) {
  const [items, setItems] = useState<TransferItem[]>([]);
  const itemsRef = useRef<TransferItem[]>([]);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;

  const apply = (next: TransferItem[]) => {
    itemsRef.current = next;
    setItems(next);
  };

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void onTransferProgress((ev) => {
      const current = itemsRef.current;
      const item = current.find((i) => i.request.id === ev.id);
      if (!item) return;
      apply(current.map((i) => (i.request.id === ev.id ? { ...i, event: ev } : i)));
      if (ev.status === "done") settledRef.current(item.request);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const enqueue = useCallback(
    async (requests: TransferRequest[]) => {
      if (!profile || requests.length === 0) return;
      apply([...itemsRef.current, ...requests.map((request) => ({ request, event: queued(request.id) }))]);
      await explorerApi.startTransfers(profile, requests);
    },
    [profile],
  );

  const retry = useCallback(
    async (id: string) => {
      const item = itemsRef.current.find((i) => i.request.id === id);
      if (!profile || !item) return;
      apply(itemsRef.current.map((i) => (i.request.id === id ? { ...i, event: queued(id) } : i)));
      await explorerApi.startTransfers(profile, [item.request]);
    },
    [profile],
  );

  const clearFinished = useCallback(() => {
    apply(itemsRef.current.filter((i) => i.event.status !== "done"));
  }, []);

  return { items, enqueue, retry, clearFinished };
}

export type Transfers = ReturnType<typeof useTransfers>;
