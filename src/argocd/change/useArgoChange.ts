import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { argoKeys } from "../queries";
import { changeApi } from "./api";
import type { ArgoChange, ArgoPreview, ArgoTarget } from "./types";
export function useArgoChange(url: string) {
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState<string | null>(null);
  const run = async <T,>(fn: () => Promise<T>): Promise<T> => {
    setPending(true); setError(null); setMessage(null);
    try { return await fn(); } catch (e) { setError(e); throw e; } finally { setPending(false); }
  };
  const preview = (target: ArgoTarget, change: ArgoChange) => run(() => changeApi.preview(url, target, change));
  const apply = (target: ArgoTarget, change: ArgoChange, preview: ArgoPreview | null, confirmName: string | null = null) => run(async () => {
    const result = await changeApi.apply(url, target, change, preview?.expectedVersion ?? null, confirmName);
    await qc.invalidateQueries({ queryKey: argoKeys.data(url) });
    setMessage(result.message); return result;
  });
  return { preview, apply, pending, error, message };
}
