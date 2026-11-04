import { useQuery } from "@tanstack/react-query";
import { errorMessage } from "../api/errors";
import { invoke } from "../api/invoke";
import type { AppError } from "../api/types";
import { targetKey, kindKey } from "./targets";
import type { K8sObjectView, K8sTarget, ObjectRef } from "./types";

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

export function DescribeView({ target, context, objectRef, resourceVersion, ssoProfile, live, view, onRefreshObject }: {
  target: K8sTarget; context: string | null; objectRef: ObjectRef; resourceVersion: string | null;
  ssoProfile: string; live: boolean; view: K8sObjectView; onRefreshObject: () => void;
}) {
  const secret = objectRef.kind.group === "" && objectRef.kind.kind === "Secret";
  const query = useQuery<string, AppError>({
    queryKey: ["k8s", targetKey(target), "describe", context, kindKey(objectRef.kind), objectRef.namespace, objectRef.name, resourceVersion],
    queryFn: () => invoke<string>("k8s_describe", { target, kind: objectRef.kind, namespace: objectRef.namespace, name: objectRef.name, profile: ssoProfile }),
    enabled: live && context !== null && !secret,
    retry: false,
  });
  return (
    <section>
      <div className="k8s-actions k8s-toolbar"><button className="btn tone-secondary" onClick={() => secret ? onRefreshObject() : void query.refetch()} disabled={!secret && query.isFetching}>다시 읽기</button></div>
      {secret ? <p>Secret은 값을 가려서 앱이 만든 describe를 보여요.</p> : query.isError && <p role="alert">{errorMessage(query.error)} — 앱의 요약으로 대신 보여요.</p>}
      {!secret && query.isPending && !query.isError ? <p>읽는 중…</p> : <pre className="k8s-wrap">{secret || query.isError ? fallbackDescribe(view) : query.data}</pre>}
    </section>
  );
}
