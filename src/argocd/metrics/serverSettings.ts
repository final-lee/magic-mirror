import { useSettings } from "../../api/queries";
import { normalizeUrl } from "../servers";
import type { ArgocdServer } from "../types";

/** 서버 항목에 바꿀 칸을 덮어쓴 사본. undefined로 주면 그 칸을 뺀다 */
export function patchServer(server: ArgocdServer, changes: Partial<ArgocdServer>): ArgocdServer {
  const next: ArgocdServer = { ...server, ...changes };
  for (const key of Object.keys(changes) as (keyof ArgocdServer)[]) if (changes[key] === undefined) delete next[key];
  return next;
}

/** 이 ArgoCD 서버의 설정 항목(ArgoCD 네임스페이스·알림). 바꾸면 설정에 저장한다. */
export function useServerSettings(url: string) {
  const { settings, update } = useSettings();
  const server = settings?.argocdServers?.find((s) => normalizeUrl(s.url) === normalizeUrl(url)) ?? null;
  const patch = (changes: Partial<ArgocdServer>) => {
    if (!settings?.argocdServers) return;
    update({ argocdServers: settings.argocdServers.map((s) => (normalizeUrl(s.url) === normalizeUrl(url) ? patchServer(s, changes) : s)) });
  };
  return { server, patch };
}
