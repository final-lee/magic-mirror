import { useEffect, useMemo, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { argoKeys, useApps } from "../queries";
import type { ArgoTreeNode } from "../types";
import { buildIndex, type TreeInput } from "./argoIndex";

/** 서버 하나의 캐시에 있는 리소스 트리. 앱마다 가장 최근에 읽은 것 하나만(트리 키에는 앱 버전이 붙어 있어 여러 개일 수 있다) */
export function cachedTrees(qc: QueryClient, url: string): TreeInput[] {
  const latest = new Map<string, { at: number; input: TreeInput }>();
  for (const query of qc.getQueryCache().findAll({ queryKey: [...argoKeys.data(url), "tree"] })) {
    const nodes = query.state.data as ArgoTreeNode[] | undefined;
    const [, , , , namespace, name] = query.queryKey as readonly unknown[];
    if (!Array.isArray(nodes) || typeof namespace !== "string" || typeof name !== "string") continue;
    const key = `${namespace}/${name}`;
    const seen = latest.get(key);
    if (!seen || query.state.dataUpdatedAt > seen.at) latest.set(key, { at: query.state.dataUpdatedAt, input: { app: { namespace, name }, nodes } });
  }
  return [...latest.values()].map((v) => v.input);
}

/** 이 서버의 트리 캐시가 바뀔 때마다 숫자가 올라간다 */
export function useTreeVersion(url: string): number {
  const qc = useQueryClient();
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const tree = [...argoKeys.data(url), "tree"];
    return qc.getQueryCache().subscribe((event) => {
      const key = event.query.queryKey;
      if (event.type === "updated" && event.action.type === "success" && tree.every((part, i) => key[i] === part)) setVersion((v) => v + 1);
    });
  }, [qc, url]);
  return version;
}

/** 이 서버의 전체 리소스 색인: 앱 목록의 리소스 요약 + 지금까지 열어 본 앱의 트리. 추가로 서버를 부르지 않는다(앱 목록만 읽는다). */
export function useArgoIndex(url: string, live: boolean) {
  const qc = useQueryClient();
  const apps = useApps(url, live);
  const version = useTreeVersion(url);
  const entries = useMemo(() => buildIndex(apps.data ?? [], cachedTrees(qc, url)), [apps.data, qc, url, version]);
  return { apps, entries };
}
