import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { errorMessage } from "../api/errors";
import { invoke } from "../api/invoke";
import type { AppError } from "../api/types";
import { DescribePretty } from "./DescribePretty";
import { parseDescribe } from "./describeParse";
import { targetKey, kindKey } from "./targets";
import type { K8sObjectView, K8sTarget, ObjectRef } from "./types";
import { DESCRIBE_FALLBACK, DESCRIBE_LOADING, DESCRIBE_MODE, DESCRIBE_PRETTY, DESCRIBE_RAW, DESCRIBE_REFRESH, DESCRIBE_SECRET } from "./text";

export function fallbackDescribe(view: K8sObjectView): string {
  const fields = Object.entries(view.row.values).map(([key, value]) => `${key}: ${value}`);
  return [
    `Name: ${view.row.name}`,
    ...(view.row.namespace ? [`Namespace: ${view.row.namespace}`] : []),
    `Kind: ${view.kind.kind}`,
    ...fields,
    ...(view.secretKeys ? ["", "Data:", ...view.secretKeys.map((key) => `  ${key.key}: ${key.size} bytes`)] : []),
    "", "Conditions:",
    ...view.conditions.map((c) => `  ${c.type}: ${c.status}${c.reason ? ` (${c.reason})` : ""}${c.message ? ` ${c.message}` : ""}`),
    "", "Containers:",
    ...view.containers.map((c) => `  ${c.name}: ${c.image} ${c.state}${c.reason ? ` (${c.reason})` : ""}`),
    "", "Events:",
    ...view.events.map((e) => `  ${e.type} ${e.reason} ${e.message} (${e.count})`),
  ].join("\n");
}

export function DescribeView({ target, context, objectRef, resourceVersion, ssoProfile, live, view, onRefreshObject, toolbar }: {
  target: K8sTarget; context: string | null; objectRef: ObjectRef; resourceVersion: string | null;
  ssoProfile: string; live: boolean; view: K8sObjectView; onRefreshObject: () => void; toolbar: HTMLElement | null;
}) {
  const secret = objectRef.kind.group === "" && objectRef.kind.kind === "Secret";
  const queryClient = useQueryClient();
  const queryKey = ["k8s", targetKey(target), "describe", context, kindKey(objectRef.kind), objectRef.namespace, objectRef.name];
  const cached = queryClient.getQueryState(queryKey);
  const lastRead = useRef(Math.max(cached?.dataUpdatedAt ?? 0, cached?.errorUpdatedAt ?? 0));
  const query = useQuery<string, AppError>({
    queryKey,
    queryFn: () => {
      lastRead.current = Date.now();
      return invoke<string>("k8s_describe", { target, kind: objectRef.kind, namespace: objectRef.namespace, name: objectRef.name, profile: ssoProfile });
    },
    enabled: live && context !== null && !secret,
    staleTime: 10_000,
    retry: false,
    retryOnMount: false,
  });
  const lastVersion = useRef(resourceVersion);
  useEffect(() => {
    if (lastVersion.current === resourceVersion) return;
    lastVersion.current = resourceVersion;
    if (!live || context === null || secret) return;
    const delay = Math.max(0, 10_000 - (Date.now() - lastRead.current));
    const timer = setTimeout(() => void query.refetch(), delay);
    return () => clearTimeout(timer);
  }, [resourceVersion, live, context, secret, query.dataUpdatedAt, query.refetch]);
  const [raw, setRaw] = useState(false);
  const text = secret || query.isError ? fallbackDescribe(view) : query.data;
  const nodes = useMemo(() => (text === undefined || raw ? null : parseDescribe(text)), [text, raw]);
  return (
    <section>
      {toolbar && createPortal(
        <>
          <div className="k8s-seg" role="group" aria-label={DESCRIBE_MODE}>
            <button aria-pressed={!raw} onClick={() => setRaw(false)}>{DESCRIBE_PRETTY}</button>
            <button aria-pressed={raw} onClick={() => setRaw(true)}>{DESCRIBE_RAW}</button>
          </div>
          <button className="btn tone-refresh" onClick={() => secret ? onRefreshObject() : void query.refetch()} disabled={!secret && query.isFetching}>{DESCRIBE_REFRESH}</button>
        </>,
        toolbar,
      )}
      {secret ? <p>{DESCRIBE_SECRET}</p> : query.isError && <p role="alert">{errorMessage(query.error)} — {DESCRIBE_FALLBACK}</p>}
      {!secret && query.isPending && !query.isError ? <p>{DESCRIBE_LOADING}</p> : nodes ? <DescribePretty nodes={nodes} /> : <pre className="k8s-wrap">{text}</pre>}
    </section>
  );
}
