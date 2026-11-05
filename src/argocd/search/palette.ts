import type { QueryClient } from "@tanstack/react-query";
import { clusterOf, clusterText } from "../argoGroup";
import { argoKeys } from "../queries";
import type { ArgoAppRow, ArgocdServer, ArgoJump } from "../types";
import { buildIndex, focusOf } from "./argoIndex";
import { cachedTrees } from "./useArgoIndex";

/** ⌘K에 보이는 ArgoCD 항목 하나: 앱, 또는 앱이 보는 리소스(앱마다 하나씩) */
export interface ArgoPaletteItem {
  key: string;
  serverName: string;
  /** 고르면 ArgoCD 탭으로 보낼 곳 */
  jump: ArgoJump;
  /** 보이는 이름: 앱 이름 또는 리소스 이름 */
  name: string;
  /** 리소스의 종류. 앱이면 null */
  kind: string | null;
  /** 이름 옆에 흐리게: 앱은 배포 대상, 리소스는 네임스페이스 */
  where: string;
  /** 리소스를 보는 앱 이름. 앱 항목이면 null */
  app: string | null;
  /** 퍼지 검색 칸(중요한 것부터) */
  fields: (string | null | undefined)[];
}

/**
 * 앱 목록이 캐시에 있는 서버만 항목을 만든다(없는 서버를 위해 ArgoCD를 부르지 않는다). 리소스는 앱 목록의 요약과 이미 열어 본 트리에서 온다.
 * 같은 리소스를 여러 앱이 보면 앱마다 항목이 하나씩이라, 어느 앱으로 열지 고를 수 있다.
 */
export function argoPaletteItems(qc: QueryClient, servers: readonly ArgocdServer[]): ArgoPaletteItem[] {
  const items: ArgoPaletteItem[] = [];
  for (const server of servers) {
    const apps = qc.getQueryData<ArgoAppRow[]>(argoKeys.apps(server.url));
    if (!apps) continue;
    for (const app of apps) {
      const where = [clusterText(clusterOf(app)), app.values.destNamespace].filter(Boolean).join("/");
      items.push({
        key: `${server.url}|app|${app.namespace}|${app.name}`,
        serverName: server.name,
        jump: { url: server.url, namespace: app.namespace, name: app.name, resource: null },
        name: app.name,
        kind: null,
        where,
        app: null,
        fields: [app.name, app.values.destNamespace, app.values.project, server.name],
      });
    }
    for (const e of buildIndex(apps, cachedTrees(qc, server.url))) {
      for (const ref of e.refs) {
        items.push({
          key: `${server.url}|res|${e.id}|${ref.app.namespace}|${ref.app.name}`,
          serverName: server.name,
          jump: { url: server.url, namespace: ref.app.namespace, name: ref.app.name, resource: focusOf(e) },
          name: e.name,
          kind: e.kind,
          where: e.namespace ?? "",
          app: ref.app.name,
          fields: [e.name, e.kind, e.namespace, ref.app.name, server.name],
        });
      }
    }
  }
  return items;
}
